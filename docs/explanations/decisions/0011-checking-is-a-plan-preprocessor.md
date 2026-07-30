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

**Interactive use needs `certified_move` to be a one-liner.** If the sanctioned
route is more awkward than a raw `caput`, the bypass wins and is worse than what
was banned. Ergonomics here is a design requirement, not documentation.

**There is no backstop for motion outside this RunEngine** — another hutch,
engineering mode, a direct `caput`. A service-side watchdog was considered and
rejected: there is not enough stopping distance to abort usefully once a
collision is detected. The design is a gatekeeper with nothing behind it, which
is defensible only under the classification in ADR-0003.

**Per-beamline wiring is unsolved.** The preprocessor and `certified_move` both
need to know which axes are collidable and which service owns them, and the same
shape recurs for a generic `scanspec_scan` needing a beamline's devices and
triggering strategy. blueapi already resolves `Device`-typed plan parameters
from names against a per-process context; extending that to non-device
collaborators would solve both, and would give the validator substitution for
free. But `register_device` currently rejects anything that is not a bluesky
protocol, so this is not free today.
