"""Transform: pure, serialisable, array-safe maths.

Deliberate properties, each load-bearing for a decision in HANDOVER.md:

- **sync** (D5) — the forward direction is called from the monitor callback
  path, and the whole class must be usable from analysis code with no event
  loop.
- **array-safe** (D7) — the same expression works on scalars and on arrays.
  This is what lets `set` (N=1) and `kickoff` (N=10,000) share one
  implementation.
- **no device references** — a Transform is data plus maths. It can be
  serialised into RunStart and reconstructed in a post-processing pipeline
  that has never heard of EPICS.
- **branch-free** (D6) — the branch is an *argument* to the inverse, never a
  field, because the instance is what gets serialised into RunStart and the
  branch must not reach analysis.
"""

from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

import numpy as np
import numpy.typing as npt
from pydantic import BaseModel, ConfigDict, Field

FloatOrArray: TypeAlias = float | npt.NDArray[np.float64]


# --------------------------------------------------------------------------
# rotation helpers, shaped (..., 3, 3) so scalars and arrays share one path
# --------------------------------------------------------------------------


def _rot(axis: int, th: FloatOrArray) -> npt.NDArray[np.float64]:
    """Rotation about `axis` (0=x, 1=y, 2=z), broadcasting over `th`.

    Returns (3, 3) for scalar input and (..., 3, 3) for array input. Matches
    diffcalc's convention (diffcalc/util.py x_rotation/y_rotation/z_rotation).
    """
    th = np.asarray(th, dtype=float)
    c, s = np.cos(th), np.sin(th)
    m = np.zeros(th.shape + (3, 3))
    i, j = [(1, 2), (2, 0), (0, 1)][axis]
    m[..., axis, axis] = 1.0
    m[..., i, i] = c
    m[..., j, j] = c
    m[..., i, j] = -s
    m[..., j, i] = s
    return m


def _matvec(m: npt.NDArray[np.float64], v: npt.NDArray[np.float64]):
    return np.einsum("...ij,...j->...i", m, v)


def _matmat(a: npt.NDArray[np.float64], b: npt.NDArray[np.float64]):
    return np.einsum("...ij,...jk->...ik", a, b)


# --------------------------------------------------------------------------
# base
# --------------------------------------------------------------------------


class Transform(BaseModel):
    """Base for all transforms.

    Mirrors ophyd_async.core.Transform but adds the two things it currently
    lacks (D8): a discriminator so a receiver can reconstruct the class from
    JSON, and an explicit statement that methods must be array-safe.
    """

    model_config = ConfigDict(extra="forbid")

    def raw_to_derived(self, **raw: FloatOrArray) -> dict[str, FloatOrArray]:
        raise NotImplementedError

    def derived_to_raw(
        self, *, branch: Branch, **derived: FloatOrArray
    ) -> dict[str, FloatOrArray]:
        raise NotImplementedError

    def branches(self) -> list[Branch]:
        """Candidate branches. Single-valued transforms return exactly one."""
        raise NotImplementedError


class Branch(BaseModel):
    """A discrete choice made while inverting.

    Kept outside Transform (D6) and outside RunStart. Lives only in the
    certificate, and only until execution consumes it.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    def label(self) -> str:
        return ",".join(f"{k}={v}" for k, v in self.model_dump().items()) or "only"


class SingleBranch(Branch):
    """The one branch of a single-valued transform (e.g. two jacks).

    Exists so that "no choice" is representable. A device with a single-valued
    inverse still needs collision checking (D12), so it still goes through the
    solver — it just never has anything to choose.
    """


# --------------------------------------------------------------------------
# two jacks — the cheap, single-valued case
# --------------------------------------------------------------------------


class TwoJackTransform(Transform):
    """Height/angle from two vertical jacks.

    The reference cheap transform. Note that nothing here is written for
    arrays: it is array-safe purely because it is arithmetic. That is the
    "write the maths once" property (D7) doing its job for free.
    """

    type: Literal["two_jack"] = "two_jack"
    distance: float = Field(gt=0)

    def raw_to_derived(self, *, jack1, jack2):  # type: ignore[override]
        return {"height": jack1, "angle": (jack2 - jack1) / self.distance}

    def derived_to_raw(self, *, branch, height, angle):  # type: ignore[override]
        return {"jack1": height, "jack2": height + angle * self.distance}

    def branches(self):
        return [SingleBranch()]


# --------------------------------------------------------------------------
# six-circle diffractometer
# --------------------------------------------------------------------------


class DiffBranch(Branch):
    """Sign choices in the analytic inverse.

    For bisecting mode there are two independent binary choices, so four
    branches. This is the whole of the multi-valuedness — see O1 in
    HANDOVER.md. Because they are *choices* rather than search directions,
    fixing them makes the inverse a closed-form expression.
    """

    delta_sign: Literal[-1, 1] = 1
    chi_flip: bool = False


class SixCircleTransform(Transform):
    """You (1999) 4S+2D six-circle geometry.

    Forward is the full six-circle calculation and matches diffcalc exactly
    (see tests). Inverse is bisecting mode only: mu = nu = 0, eta = delta/2.
    That is enough to answer O1; a production version would carry the
    constraint set as a field and dispatch.

    Convention taken from diffcalc/hkl/geometry.py and diffcalc/hkl/calc.py:

        q_lab = (NU @ DELTA - I) @ [0, 2*pi/wavelength, 0]
        hkl   = inv(UB) @ inv(PHI) @ inv(CHI) @ inv(ETA) @ inv(MU) @ q_lab

    with MU = Rx(mu), DELTA = Rz(-delta), NU = Rx(nu), ETA = Rz(-eta),
    CHI = Ry(chi), PHI = Rz(-phi).
    """

    type: Literal["six_circle"] = "six_circle"
    ub: list[list[float]]
    wavelength: float = Field(gt=0)

    # -- helpers ----------------------------------------------------------

    @property
    def _ub(self) -> npt.NDArray[np.float64]:
        return np.asarray(self.ub, dtype=float)

    @property
    def _k(self) -> float:
        return 2.0 * np.pi / self.wavelength

    # -- forward ----------------------------------------------------------

    def raw_to_derived(self, *, mu, delta, nu, eta, chi, phi):  # type: ignore[override]
        """angles (rad) -> hkl. Broadcasts over any common shape."""
        mu, delta, nu, eta, chi, phi = np.broadcast_arrays(
            *(np.asarray(a, dtype=float) for a in (mu, delta, nu, eta, chi, phi))
        )
        MU, DELTA = _rot(0, mu), _rot(2, -delta)
        NU, ETA = _rot(0, nu), _rot(2, -eta)
        CHI, PHI = _rot(1, chi), _rot(2, -phi)

        kin = np.zeros(mu.shape + (3,))
        kin[..., 1] = self._k
        q_lab = _matvec(_matmat(NU, DELTA), kin) - kin

        # inverse of a rotation is its transpose, so no linalg.inv needed
        v = _matvec(np.swapaxes(MU, -1, -2), q_lab)
        v = _matvec(np.swapaxes(ETA, -1, -2), v)
        v = _matvec(np.swapaxes(CHI, -1, -2), v)
        v = _matvec(np.swapaxes(PHI, -1, -2), v)
        hkl = _matvec(np.linalg.inv(self._ub), v)
        return {"h": hkl[..., 0], "k": hkl[..., 1], "l": hkl[..., 2]}

    # -- inverse ----------------------------------------------------------

    def derived_to_raw(self, *, branch: DiffBranch, h, k, l):  # type: ignore[override]
        """hkl -> angles (rad), bisecting mode, branch fixed.

        Closed form. No iteration, no search, no enumeration — every step is
        an arithmetic expression that broadcasts. This is the claim O1 was
        about.

        Derivation, with mu = nu = 0 and eta = delta/2:

            q_phi = UB @ hkl,  Q = |q_phi|
            sin(delta/2) = Q * wavelength / (4*pi)          [Bragg]
            in the eta frame the scattering vector lies along +x, so
            chi = asin(uz), phi = atan2(uy, ux)  with u = q_phi / Q
        """
        h, k, l = np.broadcast_arrays(*(np.asarray(a, dtype=float) for a in (h, k, l)))
        hkl = np.stack([h, k, l], axis=-1)
        q_phi = _matvec(self._ub, hkl)
        Q = np.linalg.norm(q_phi, axis=-1)

        with np.errstate(invalid="ignore", divide="ignore"):
            sin_theta = Q * self.wavelength / (4.0 * np.pi)
            theta = np.arcsin(np.clip(sin_theta, -1.0, 1.0))
            u = q_phi / Q[..., None]

            s = float(branch.delta_sign)
            delta = s * 2.0 * theta
            eta = delta / 2.0

            # In the eta frame the scattering vector lies along s * +x, so
            #   sin(chi) = s * uz  and  cos(chi) = +/- s * r
            # with the sign set by whether phi is taken in its principal
            # branch or opposite. Both give valid solutions; which one you
            # want depends on joint limits and collisions, which is exactly
            # what the solver decides.
            ux, uy, uz = u[..., 0], u[..., 1], u[..., 2]
            r = np.hypot(ux, uy)
            phi0 = np.arctan2(uy, ux)

            if branch.chi_flip:
                phi = phi0 + np.pi
                chi = np.arctan2(s * uz, -s * r)
            else:
                phi = phi0
                chi = np.arctan2(s * uz, s * r)

        zero = np.zeros_like(delta)
        return {
            "mu": zero,
            "delta": delta,
            "nu": zero.copy(),
            "eta": eta,
            "chi": chi,
            "phi": phi,
        }

    def branches(self) -> list[DiffBranch]:
        return [
            DiffBranch(delta_sign=s, chi_flip=f) for s in (1, -1) for f in (False, True)
        ]

    def reachable(self, *, h, k, l) -> npt.NDArray[np.bool_]:
        """Bragg condition satisfiable at this wavelength. Vectorised."""
        hkl = np.stack(
            np.broadcast_arrays(*(np.asarray(a, float) for a in (h, k, l))), -1
        )
        Q = np.linalg.norm(_matvec(self._ub, hkl), axis=-1)
        return (Q * self.wavelength / (4.0 * np.pi)) <= 1.0


AnyTransform: TypeAlias = Annotated[
    TwoJackTransform | SixCircleTransform, Field(discriminator="type")
]


class TransformStack(BaseModel):
    """Layered transforms (D9), kept separate rather than merged.

    This is what goes into RunStart. It is branch-free by construction —
    there is nowhere in this model for a branch to live.
    """

    model_config = ConfigDict(extra="forbid")

    layers: list[AnyTransform]

    def raw_to_derived(self, **raw):
        out = dict(raw)
        for layer in self.layers:
            out = layer.raw_to_derived(**out)
        return out
