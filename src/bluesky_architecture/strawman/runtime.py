"""Execution-side contract: prepare-per-window, and chunk validation.

Sketches the device shape rather than a real ophyd-async Device — the point
is the contract, not the plumbing.

The rule (D14): `set` with a prepared branch applies it and skips checking,
because the certificate already validated that point and the path to it.
`set` without a prepared branch selects and checks now. `bps.mv(h, ...)` is
just the second case, so it keeps working and is checked, with no special
handling anywhere.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt

from .certificate import Certificate, WindowChoice
from .collision import FineModel, SimpleModel
from .solver import Solver
from .transform import Branch, Transform

Array = npt.NDArray[np.float64]


class StaleBranch(RuntimeError):
    """A prepared branch was applied to a different target than it was solved for."""


@dataclass
class DerivedAxisDevice:
    """A device presenting derived axes over raw ones.

    Carries an injected solver (D16). This is a real departure from how
    ophyd-async devices work today: a diffractometer with a multi-valued
    inverse and collision constraints is **not standalone**. Sim and unit
    tests inject a trivial solver; production injects the real one, local or
    remote.

    The forward path stays pure — monitor updates, analysis and descriptors
    are unaffected. The impurity is confined to the write path, which is
    where the checking has to be anyway.
    """

    name: str
    transform: Transform
    solver: Solver
    _prepared: WindowChoice | None = field(default=None, repr=False)

    # -- forward, pure, sync (D5) -----------------------------------------

    def read_derived(self, raw: dict[str, Array]) -> dict[str, Array]:
        return self.transform.raw_to_derived(**raw)

    # -- write path -------------------------------------------------------

    def prepare(self, choice: WindowChoice) -> None:
        """Store the branch for the next `set`. No hardware interaction."""
        self._prepared = choice

    def set(self, **derived: float) -> dict[str, float]:
        """-> raw setpoints. Checked either by certificate or by solving now."""
        prepared, self._prepared = self._prepared, None  # consumed, not sticky (D15)

        if prepared is not None:
            if not prepared.matches(self.name, derived):
                raise StaleBranch(
                    f"{self.name}: prepared branch was solved for "
                    f"{prepared.targets.get(self.name)}, got {derived}"
                )
            branch = prepared.branches[self.name]
        else:
            # the bps.mv path — select and check now
            choice = self.solver.select(
                {self.name: {k: np.asarray(v) for k, v in derived.items()}}
            )
            branch = choice.branches[self.name]

        return {
            k: float(np.ravel(v)[0])
            for k, v in self.transform.derived_to_raw(branch=branch, **derived).items()
        }


@dataclass
class ChunkValidator:
    """Runtime fine checking, one chunk at a time.

    No diffractometer maths here (D19) — forward diffcalc alone is 830 ms for
    a 10k chunk, over the whole budget. The branch comes from the certificate,
    the inverse is closed-form, and everything is vectorised (D20).

    The fallback needs a hard cap (O6). Without one, 500 ms is a best case
    rather than a bound: 200 flagged points at 5 ms each is a second of
    unbudgeted work. Exceeding the cap is treated as a collision, because you
    cannot afford to find out.
    """

    transform: Transform
    simple: SimpleModel
    fine: FineModel
    budget_s: float = 0.5
    max_fallback_points: int = 512

    def validate(
        self,
        *,
        branch: Branch,
        derived: dict[str, Array],
        static: dict[str, Array] | None = None,
    ) -> ChunkResult:
        t0 = time.perf_counter()
        raw = self.transform.derived_to_raw(branch=branch, **derived)
        if static:
            n = len(np.ravel(next(iter(raw.values()))))
            raw = raw | {
                k: np.broadcast_to(np.asarray(v, float), (n,))
                for k, v in static.items()
            }
        t_ik = time.perf_counter() - t0

        t1 = time.perf_counter()
        flagged = self.simple.check(raw)
        t_simple = time.perf_counter() - t1

        n_flagged = int(flagged.sum())
        capped = n_flagged > self.max_fallback_points
        t_fine = 0.0
        collided = flagged.copy()

        if n_flagged and not capped:
            t2 = time.perf_counter()
            subset = {k: np.asarray(v, float)[flagged] for k, v in raw.items()}
            collided[flagged] = self.fine.check(subset)
            t_fine = time.perf_counter() - t2

        total = time.perf_counter() - t0
        return ChunkResult(
            ok=not collided.any() and not capped,
            n_points=len(flagged),
            n_flagged=n_flagged,
            n_collided=int(collided.sum()),
            fallback_capped=capped,
            over_budget=total > self.budget_s,
            t_ik=t_ik,
            t_simple=t_simple,
            t_fine=t_fine,
            t_total=total,
        )


@dataclass
class ChunkResult:
    ok: bool
    n_points: int
    n_flagged: int
    n_collided: int
    fallback_capped: bool
    over_budget: bool
    t_ik: float
    t_simple: float
    t_fine: float
    t_total: float

    def summary(self) -> str:
        return (
            f"{self.n_points:6d} pts | IK {self.t_ik * 1e3:6.1f} ms | "
            f"simple {self.t_simple * 1e3:6.1f} ms | "
            f"fine {self.t_fine * 1e3:5.1f} ms | "
            f"total {self.t_total * 1e3:6.1f} ms | flagged {self.n_flagged:4d} | "
            f"{'OK' if self.ok else 'STOP'}"
        )


def check_preconditions_streaming(
    certificate: Certificate, live: dict[str, float]
) -> None:
    """Preconditions need monitoring, not a single check at start (D3).

    Called per chunk here. In production this wants to be a subscription on
    every scope device, so a mid-scan move by another hutch aborts promptly
    rather than at the next chunk boundary.
    """
    certificate.preconditions.check(live)
