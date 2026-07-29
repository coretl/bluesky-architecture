"""The certificate: what insertion validation emits and execution consumes.

Two parts with different lifetimes and different consumers (D3):

- **choices** — per-window branch assignment. Never reaches analysis, never
  reaches RunStart, never lives on a Transform.
- **preconditions** — assumed state of every device in the collision scope,
  including devices taking no part in the scan. This is what makes
  invalidation mechanically checkable rather than a policy.

A certificate is a **recipe, not a result** (D4). It does not carry joint
positions, because for a fly scan they do not exist yet: an hour at 20 kHz is
~72M points, chunk N+1 is generated while N executes, and densification is a
runtime operation by construction.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .transform import DiffBranch, SingleBranch


class Preconditions(BaseModel):
    """Assumed raw state of the collision scope at validation time.

    Needs *monitoring*, not a single check at execution start — see the i19
    optics-hutch case, where another hutch can move shared equipment mid-scan.
    """

    model_config = ConfigDict(extra="forbid")

    values: dict[str, float]
    tolerances: dict[str, float] = Field(default_factory=dict)
    default_tolerance: float = 1e-3

    def violations(self, live: dict[str, float]) -> dict[str, tuple[float, float]]:
        """-> {axis: (assumed, actual)} for every axis outside tolerance."""
        out: dict[str, tuple[float, float]] = {}
        for axis, assumed in self.values.items():
            if axis not in live:
                out[axis] = (assumed, float("nan"))
                continue
            tol = self.tolerances.get(axis, self.default_tolerance)
            if abs(live[axis] - assumed) > tol:
                out[axis] = (assumed, live[axis])
        return out

    def check(self, live: dict[str, float]) -> None:
        bad = self.violations(live)
        if bad:
            detail = ", ".join(
                f"{a}: assumed {x:.6g}, found {y:.6g}" for a, (x, y) in bad.items()
            )
            raise PreconditionViolation(f"certificate no longer valid - {detail}")


class PreconditionViolation(RuntimeError):
    """Scope state moved since validation. The certificate is void."""


class WindowChoice(BaseModel):
    """The branch assignment for one collection window.

    `targets` records the derived values this was solved for. Execution
    asserts the request matches before applying (D15) — matching by a running
    counter breaks silently under snaking, retries or restarts, and the
    failure mode is moving to another point's joint positions.
    """

    model_config = ConfigDict(extra="forbid")

    window: int
    branches: dict[str, DiffBranch | SingleBranch]
    targets: dict[str, dict[str, float]] = Field(default_factory=dict)

    def matches(
        self, device: str, request: dict[str, float], tol: float = 1e-9
    ) -> bool:
        solved = self.targets.get(device)
        if solved is None:
            return True
        return all(
            abs(request[k] - v) <= tol for k, v in solved.items() if k in request
        )


class Certificate(BaseModel):
    """What the solver emits and the plan carries."""

    model_config = ConfigDict(extra="forbid")

    scope: list[str]
    preconditions: Preconditions
    choices: list[WindowChoice]
    #: coarse model padding used, so runtime can tell what it is trusting
    sampling_gap: float = 0.0
    following_error: float = 0.0

    def for_window(self, index: int) -> WindowChoice:
        for c in self.choices:
            if c.window == index:
                return c
        raise KeyError(f"no certificate entry for window {index}")

    def __len__(self) -> int:
        return len(self.choices)
