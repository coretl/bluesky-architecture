# 9. Checking is a plan preprocessor, and the certificate is a recipe

## Status

Accepted

## Context

Every move of a collidable axis must be checked, whether it originates in a
scan, a `bps.mv`, or a terminal. Kinematics and branch selection only apply to
derived axes, but checking applies to all of them — a raw motor is the
degenerate case, an axis whose projection is the identity and whose branch set
has one member.

The obvious place to check is inside the device, which is where the earlier
design put it by injecting a solver. That has three problems. Raw motors have no
`DerivedSignalFactory` and so nowhere to inject anything. Per-device checking
cannot see that two devices are moving together, and `bps.mv(m1, x, m2, y)` is
one motion — checking each `set` independently checks states the machine never
occupies. And it made devices non-standalone, which created a loop where the
validator instantiates devices that reference the solver the validator exists to
serve.

Separately, insertion-time validation emits state that execution depends on: the
kinematic branch each window will run on. The obvious design is for it to emit
the joint positions it validated. That works for step scans and fails for fly
scans, for three independent reasons — size (an hour at 20 kHz is ~72M points ×
6 axes), streaming (chunk N+1 is generated while N executes), and densification
happening at runtime by construction.

## Decision

Checking happens in a **plan preprocessor**, installed on `RE.preprocessors` by
the beamline's configuration. It observes the message stream, certifies moves as
a group, and passes the decision down by **wrapping the value**:

```python
class Certified(Generic[T]):
    value: T
    async def check_valid(self) -> None: ...
```

`check_valid()` is cheap and local — PV values against thresholds. It does not
call the anti-collision service.

`StandardMovable` and `StandardFlyable` support wrapped values. A collidable
axis given a **bare** value raises; there is no fallback to self-certification.

The certificate the validator emits carries **branch selection per window**, not
positions. The branch must reach runtime inverse kinematics; it cannot be
resolved away at insertion. It is invalidated by any state change within the
declared collision scope, and if invalid, execution obtains a new one.

## Consequences

**A standard `bps.mv` plan works unmodified.** `RunEngine.__call__` composes
preprocessors over every plan, so the checker sees the `set` messages without
the plan knowing it exists. A plan author cannot forget to opt in, which for a
safety-adjacent property is the requirement. It is forget-proof rather than
tamper-proof — the list is public and mutable — and the device-side raise is
what makes it robust rather than conventional.

**The branch and its target cannot desync.** Because the decision travels *as*
the value rather than beside it, the failure mode where a branch prepared for
one window is applied at a different position becomes unrepresentable.

> **What this superseded, recorded rather than deleted.** The certificate was
> previously its own decision, and it guarded that desync hazard with machinery:
> certificate entries recorded the derived values they were solved for, `set`
> asserted a match before applying, and `prepare` cleared the stashed branch
> after one use. Wrapping the value in `Certified` makes the branch and its
> target one object, so none of that is needed. **The hazard was real; the guard
> is now structural rather than asserted.** The earlier version is why anyone
> thought about the hazard at all, which is the reason it is written down here
> instead of edited away.

**Runtime must be able to run the inverse cheaply**, which is only tolerable
because the branch-fixed inverse is closed-form and vectorised — measured at
0.1 µs per point.

**Devices become standalone again.** They receive a branch rather than owning a
solver, which removes the loop hazard. Selection sits at the message layer,
which is the only place the whole machine is visible — so machine-scoped
selection is now structural rather than conventional.

**Self-certification is banned rather than provided**, because it is only sound
when one device moves at a time. Two devices certifying in isolation each check
against the other's *current* position rather than its *target*, so two
individually-safe moves can collide, and nothing inside a device can detect that
condition.

**The ban is scoped to collidable axes**, via the collision-scope declaration.
Plans moving axes that cannot reach anything are unaffected, which is what makes
this deployable against an existing estate.

**Interactive use must be a one-liner.** If the sanctioned route is more awkward
than a raw `caput`, the bypass wins and is worse than what was banned.
Ergonomics here is a design requirement, not documentation.

**There is no backstop for motion outside this RunEngine** — another hutch,
engineering mode, a direct `caput`. A service-side watchdog was considered and
rejected: there is not enough stopping distance to abort usefully once a
collision is detected. The design is a gatekeeper with nothing behind it, which
is defensible only under the classification in ADR-0003.

**The preprocessor reads the certificate when there is one**, taking the branch
decision rather than repeating the search. That makes the certificate an
optimisation on the unvalidated path rather than a prerequisite — which it has
to be, since adaptive plans never have one.

**It is a class, exported from the beamline module** the way devices are, rather
than a function plus an instruction to keep a reference. One instance by
construction, and the same object serves the interactive path — one policy, no
second implementation to drift. It does bypass the RunEngine when used that way,
so it cannot see a scan in flight.

**Per-beamline wiring is narrower than it first looked.** The checker needs no
injection mechanism — it is wired at RunEngine construction and reached
interactively by import, so it is never a plan parameter. What remains is a
generic `scanspec_scan` needing a beamline's trigger strategy, for which
blueapi's existing name resolution is the obvious fit; but `register_device`
rejects anything that is not a bluesky protocol, so that is not free today.

**Where it lives.** `Transform` belongs in its own package, since analysis needs
it and should not have to install ophyd-async. The checker plausibly belongs in
ophyd-async — it is in scope there and needs `DerivedSignalFactory` internals —
and can be split out later if that turns out wrong.

Where a replacement certificate comes from mid-scan is not settled — Q6 in
[](../open-questions.md).

What the checker *is*, as opposed to how it hooks in, is ADR-0010.
