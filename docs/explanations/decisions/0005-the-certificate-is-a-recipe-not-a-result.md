# 5. The certificate is a recipe, not a result

## Status

Accepted

## Context

Insertion-time validation does two things: coarse anti-collision, and selection
of a kinematic branch that works across the scan. It emits state that execution
depends on, so it is a solver rather than a validator — the pass/fail verdict is
a side effect.

The obvious design is for it to emit the joint positions it validated. That
works for step scans and fails for fly scans, for three independent reasons:
size (an hour at 20 kHz is ~72M points × 6 axes), streaming (chunk N+1 is
generated while N executes), and densification happening at runtime by
construction.

## Decision

The certificate carries **branch selection per window**, not positions. The
branch must reach runtime inverse kinematics; it cannot be resolved away at
insertion.

It is invalidated by any state change within the declared collision scope. If
invalid, execution obtains a new one.

## Consequences

Runtime must be able to run the inverse cheaply, which is only tolerable because
the branch-fixed inverse is closed-form and vectorised — measured at 0.1 µs per
point.

Certificate entries carry the derived values they were solved for, and `set`
asserts the request matches before applying the branch. Matching by a running
counter would break silently under snaking, retries or restarts, with the
failure mode being motion to another point's joint positions.

`prepare` is consumed rather than sticky: it clears after one `set`, so an
unprepared `set` always falls through to select-and-check.

Where a replacement certificate comes from mid-scan is not yet settled.
