# 11. Collision checking is a plan preprocessor and a Certified value wrapper

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

It is also **the solver**. Selection and checking are not separate concerns:
selection is checking with a search over branches. The preprocessor considers
transforms with branches, position limits, velocity limits, and — optionally —
an anti-collision service.

The same component runs in **three modes**, differing only in the state they
read: the validator over a whole plan against projected state, the preprocessor
inline against live state, and a direct call for interactive use.

## Consequences

**A standard `bps.mv` plan works unmodified.** `RunEngine.__call__` composes
preprocessors over every plan, so the checker sees the `set` messages without
the plan knowing it exists. A plan author cannot forget to opt in, which for a
safety-adjacent property is the requirement. It is forget-proof rather than
tamper-proof — the list is public and mutable — and the device-side raise is
what makes it robust rather than conventional.

**The branch and its target cannot desync.** Because the decision travels *as*
the value rather than beside it, the failure mode where a branch prepared for
one window is applied at a different position becomes unrepresentable. The
machinery that previously guarded against it — recording the coordinates a
certificate entry was solved for, asserting a match on `set`, clearing a stashed
branch after one use — is no longer needed.

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

**The three modes must never differ in algorithm, only in state.** If the
validator picks one branch and the preprocessor would pick another, the
certificate is worthless — the executor either ignores it or moves somewhere
nothing checked. Same transforms, same targets, same limits ⟹ same branch. That
is a property test, not a convention, and it should exist from the start because
this kind of agreement decays silently.

**The preprocessor reads the certificate when there is one**, taking the branch
decision rather than repeating the search. That makes the certificate an
optimisation on the unvalidated path rather than a prerequisite — which it has
to be, since adaptive plans never have one.

**The service is optional.** Without it, the same component still does
transforms, branch selection and limit checking, with selection falling back to
limits plus continuity. So branch selection is not solely a collision concern,
and the preprocessor can be deployed before anti-collision exists on a beamline.

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
