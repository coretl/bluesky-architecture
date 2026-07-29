"""Anti-collision, in joint space, over raw axis values.

Key structural point (D10): this module does not import Transform and never
will. The model consumes a vector of *raw* axis values and places bodies. A
raw motor with no derived signal on top is the base case, not an exception —
which is why the beamstop below participates on equal terms with the
diffractometer.

Two tiers (D18):

- `SimpleModel` is a strict over-approximation. It must never produce a false
  negative, because "simple says clear -> skip fine" is only sound if it
  can't miss anything. `assert_conservative()` checks that property against
  the fine model rather than trusting it.
- `FineModel` is a **false-positive filter**, not a safety net. It recovers
  configurations the conservative model over-flags. It is never consulted to
  find something the simple model missed.

Everything is vectorised over a leading points axis (D20). A per-point Python
loop is not a slow implementation of this interface, it is a non-implementation:
measured at 673 ms for 10k points against 92 ms vectorised.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt

Array = npt.NDArray[np.float64]


@dataclass(frozen=True)
class Body:
    """A sphere attached to a frame, in that frame's local coordinates."""

    name: str
    frame: str
    offset: tuple[float, float, float]
    radius: float


@dataclass
class BeamlineGeometry:
    """Places bodies in the lab frame given raw axis values.

    Deliberately crude — real geometry would come from a CAD-derived model.
    What matters for the strawman is the *interface*: raw axis values in,
    body centres and radii out, vectorised, with no knowledge of hkl.
    """

    bodies: list[Body]
    #: bodies that may never be checked against each other (same rigid group)
    exempt_pairs: set[tuple[str, str]] = field(default_factory=set)

    def frames(self, raw: dict[str, Array]) -> dict[str, tuple[Array, Array]]:
        """Return (origin (...,3), rotation (...,3,3)) per named frame."""
        n = np.broadcast_shapes(*(np.shape(v) for v in raw.values()))
        eye = np.broadcast_to(np.eye(3), n + (3, 3))
        zero = np.zeros(n + (3,))

        def rot_y(th):
            th = np.asarray(th, float)
            c, s = np.cos(th), np.sin(th)
            m = np.zeros(th.shape + (3, 3))
            m[..., 0, 0] = c
            m[..., 0, 2] = s
            m[..., 1, 1] = 1.0
            m[..., 2, 0] = -s
            m[..., 2, 2] = c
            return m

        def rot_z(th):
            th = np.asarray(th, float)
            c, s = np.cos(th), np.sin(th)
            m = np.zeros(th.shape + (3, 3))
            m[..., 0, 0] = c
            m[..., 0, 1] = -s
            m[..., 1, 0] = s
            m[..., 1, 1] = c
            m[..., 2, 2] = 1.0
            return m

        out: dict[str, tuple[Array, Array]] = {"lab": (zero, eye)}

        # sample stage: chi about y, then phi about z
        if "chi" in raw and "phi" in raw:
            r = np.einsum("...ij,...jk->...ik", rot_y(raw["chi"]), rot_z(raw["phi"]))
            out["sample"] = (zero, r)

        # detector arm: delta about z, then nu about x, at fixed radius
        if "delta" in raw and "nu" in raw:
            arm = 0.5
            d, nu = np.asarray(raw["delta"], float), np.asarray(raw["nu"], float)
            origin = np.stack(
                [
                    arm * np.sin(d) * np.cos(nu),
                    arm * np.cos(d) * np.cos(nu),
                    arm * np.sin(nu),
                ],
                axis=-1,
            )
            out["detector"] = (origin, rot_z(d))

        # a raw motor with no derived signal on top (D10)
        if "beamstop_z" in raw:
            bz = np.asarray(raw["beamstop_z"], float)
            out["beamstop"] = (
                np.stack([np.zeros_like(bz), np.zeros_like(bz), bz], -1),
                eye,
            )

        return out

    def place(self, raw: dict[str, Array]) -> tuple[Array, Array, list[str]]:
        """-> centres (..., n_bodies, 3), radii (n_bodies,), names."""
        frames = self.frames(raw)
        centres, radii, names = [], [], []
        for b in self.bodies:
            if b.frame not in frames:
                continue
            origin, rot = frames[b.frame]
            off = np.asarray(b.offset, float)
            centres.append(origin + np.einsum("...ij,j->...i", rot, off))
            radii.append(b.radius)
            names.append(b.name)
        return np.stack(centres, axis=-2), np.asarray(radii), names


class _PairModel:
    """Shared vectorised sphere-sphere check."""

    def __init__(self, geometry: BeamlineGeometry, margin: float):
        self.geometry = geometry
        self.margin = margin

    def check(self, raw: dict[str, Array]) -> npt.NDArray[np.bool_]:
        """-> boolean per point, True means collision."""
        centres, radii, names = self.geometry.place(raw)
        n = len(names)
        iu, ju = np.triu_indices(n, k=1)
        keep = np.array(
            [
                (names[i], names[j]) not in self.geometry.exempt_pairs
                and (names[j], names[i]) not in self.geometry.exempt_pairs
                for i, j in zip(iu, ju, strict=True)
            ]
        )
        iu, ju = iu[keep], ju[keep]
        d = centres[..., iu, :] - centres[..., ju, :]
        thresh = radii[iu] + radii[ju] + self.margin
        return (np.einsum("...ij,...ij->...i", d, d) < thresh**2).any(axis=-1)


class FineModel(_PairModel):
    """Accurate geometry. Consulted only to clear points the simple model flags."""

    def __init__(self, geometry: BeamlineGeometry, margin: float = 0.0):
        super().__init__(geometry, margin)


class SimpleModel(_PairModel):
    """Conservative over-approximation. Must never miss a real collision.

    `margin` is the padding, and it decomposes (D18):

    - sampling gap — dominant at 10 Hz insertion, ~0 at 20 kHz runtime. The
      only component that legitimately shrinks between phases.
    - following error — the machine does not track demand exactly. Same at
      both phases.
    - geometric conservatism — bounding volumes exceed the real bodies. Free,
      and it is what makes the fallback sound.
    """

    def __init__(
        self,
        geometry: BeamlineGeometry,
        *,
        sampling_gap: float,
        following_error: float,
        inflation: float = 0.0,
    ):
        self.sampling_gap = sampling_gap
        self.following_error = following_error
        self.inflation = inflation
        super().__init__(geometry, sampling_gap + following_error + inflation)


def assert_conservative(
    simple: SimpleModel, fine: FineModel, raw: dict[str, Array]
) -> None:
    """Fail if the simple model misses anything the fine model catches.

    This is the soundness property the two-tier scheme rests on. It should be
    a permanent property test on real geometry, not a one-off check.
    """
    missed = fine.check(raw) & ~simple.check(raw)
    if missed.any():
        raise AssertionError(
            f"simple model produced {int(missed.sum())} false negatives - "
            "the fast path is unsound and must not be used to skip the fine check"
        )


def demo_geometry() -> BeamlineGeometry:
    """A diffractometer, a detector arm, and a beamstop on a bare raw motor."""
    return BeamlineGeometry(
        bodies=[
            Body("sample", "sample", (0, 0, 0), 0.03),
            Body("sample_holder", "sample", (0, 0, -0.08), 0.05),
            Body("cryo_nozzle", "sample", (0.10, 0, 0.10), 0.04),
            Body("det_face", "detector", (0, 0, 0), 0.12),
            Body("det_body", "detector", (0, 0.15, 0), 0.14),
            Body("beamstop", "beamstop", (0, 0, 0), 0.02),
        ],
        exempt_pairs={
            ("sample", "sample_holder"),
            ("sample", "cryo_nozzle"),
            ("sample_holder", "cryo_nozzle"),
            ("det_face", "det_body"),
        },
    )
