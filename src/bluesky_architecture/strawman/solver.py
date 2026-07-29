"""The solver: branch selection plus anti-collision.

Separated from Transform because they scale differently (D11). Enumeration is
device-scoped — each device knows its own kinematics and can list candidates.
**Selection is machine-scoped**: two diffractometers give 8x8 combinations per
window, and a combination can work when neither device's locally preferred
choice does. So the solver takes a window's derived targets across all
participating devices and returns one consistent assignment.

The solver is where async lives if it ever needs to (D5). Transform stays
sync pure maths; `select` is the thing that may one day be a network call to a
scaled compute service. Note that nothing in this module's *interface* assumes
in-process execution.
"""

from __future__ import annotations

import itertools
from typing import Protocol, runtime_checkable

import numpy as np
import numpy.typing as npt

from .certificate import WindowChoice
from .collision import SimpleModel
from .transform import Branch, Transform

Array = npt.NDArray[np.float64]


class SolverError(RuntimeError):
    """Base for solver failures."""


class Infeasible(SolverError):
    """Collision involves only choice-free devices. No search can help.

    Distinct from Unsatisfiable because the user's next action differs: this
    scan cannot be made to work by choosing differently, so report it
    immediately rather than after a search. Also a pruning strategy — check
    the choice-free geometry first, since it is cheap and rules out the
    expensive enumeration entirely.
    """


class Unsatisfiable(SolverError):
    """Choices exist but no assignment works. Name the window and the constraint."""


@runtime_checkable
class Solver(Protocol):
    """Injected into devices that are collision-constrained.

    Note the hook is for *collision-constrained* devices, not multi-valued
    ones (D12). A two-jack system has nothing to choose but still needs its
    `set` checked, so it still goes through here.
    """

    def select(
        self,
        targets: dict[str, dict[str, Array]],
        *,
        window: int = 0,
        static: dict[str, Array] | None = None,
    ) -> WindowChoice: ...


class NullSolver:
    """Raises on any attempt to solve.

    Injected into the read-only validation subprocess (D16), which needs
    devices for *state*, not for *setting*. Distinct from `None`: absence of a
    solver must raise, never fall back to unchecked motion. `None` would
    conflate "single-valued, nothing to choose" with "must not move", which
    have opposite required behaviours and where getting it wrong means an
    unchecked move.
    """

    def __init__(self, reason: str = "no solver injected"):
        self.reason = reason

    def select(self, targets, *, window=0, static=None) -> WindowChoice:
        raise SolverError(
            f"{self.reason}: refusing to derive raw positions without "
            "collision checking"
        )


class LocalSolver:
    """In-process solver. Enumerates branch combinations and checks collisions.

    Whether this can stay in-process or must become an external scaled
    service is O2, and depends entirely on the measured cost of the
    branch-fixed inverse over a chunk. The interface is the same either way,
    which is the point of writing it this way now.
    """

    def __init__(
        self,
        transforms: dict[str, Transform],
        model: SimpleModel,
        *,
        max_combinations: int = 256,
    ):
        self.transforms = transforms
        self.model = model
        self.max_combinations = max_combinations

    # -- helpers ----------------------------------------------------------

    def _raw_for(self, assignment: dict[str, Branch], targets) -> dict[str, Array]:
        raw: dict[str, Array] = {}
        for device, derived in targets.items():
            raw |= self.transforms[device].derived_to_raw(
                branch=assignment[device], **derived
            )
        return raw

    def _check_choice_free(self, static: dict[str, Array]) -> None:
        """Prune: if the choice-free geometry already collides, stop (D13)."""
        if not static:
            return
        n = max((np.size(v) for v in static.values()), default=1)
        padded = {
            k: np.broadcast_to(np.asarray(v, float), (n,)) for k, v in static.items()
        }
        # place only what we have; a partial scope is still a valid check
        try:
            hit = self.model.check(padded)
        except Exception:
            return
        if np.all(hit):
            raise Infeasible(
                "collision among devices with no branch choice - "
                "no assignment can fix this; the scan is impossible as specified"
            )

    # -- interface --------------------------------------------------------

    def select(
        self,
        targets: dict[str, dict[str, Array]],
        *,
        window: int = 0,
        static: dict[str, Array] | None = None,
    ) -> WindowChoice:
        static = static or {}
        self._check_choice_free(static)

        devices = sorted(targets)
        candidates = [self.transforms[d].branches() for d in devices]
        n_comb = int(np.prod([len(c) for c in candidates]))
        if n_comb > self.max_combinations:
            raise SolverError(
                f"{n_comb} branch combinations exceeds cap {self.max_combinations}"
            )

        first_error: str | None = None
        for combo in itertools.product(*candidates):
            assignment = dict(zip(devices, combo, strict=True))
            raw = self._raw_for(assignment, targets) | static
            if np.any(~np.isfinite(np.stack(list(raw.values())))):
                first_error = first_error or "unreachable reflection at this wavelength"
                continue
            if not self.model.check(raw).any():
                return WindowChoice(
                    window=window,
                    branches=assignment,  # type: ignore[arg-type]
                    targets={
                        d: {k: float(np.ravel(v)[0]) for k, v in t.items()}
                        for d, t in targets.items()
                    },
                )
            first_error = first_error or "collision in every branch combination"

        raise Unsatisfiable(f"window {window}: {first_error}")


class CountingSolver(LocalSolver):
    """LocalSolver that records how much work it did. Used by the benchmark."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.combinations_tried = 0
        self.calls = 0

    def _raw_for(self, assignment, targets):
        self.combinations_tried += 1
        return super()._raw_for(assignment, targets)

    def select(self, *a, **kw):
        self.calls += 1
        return super().select(*a, **kw)
