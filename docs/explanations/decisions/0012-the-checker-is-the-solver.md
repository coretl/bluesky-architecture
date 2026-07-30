# 12. The checker is the solver, and runs in three modes

## Status

Accepted

## Context

The design carried two components that looked different. A **solver** performed
machine-scoped branch selection subject to collision constraints. A **checker**
verified that a move was safe. Separately, a **validator** walked a whole plan
offline to produce a verdict and a certificate.

All three take the same inputs — transforms, current state, targets, limits —
consult the same anti-collision service, and produce answers of the same shape.

## Decision

They are one component.

Selection *is* checking with a search over branches, so there is no separate
solver. That component runs in three modes, which differ **only in the state
they read**:

| mode | reads | emits | on failure |
|---|---|---|---|
| validator | whole plan, projected state | certificate + verdict | ✗ or ? |
| preprocessor | Msg stream, live state | wrapped values | raise |
| interactive | one call, live state | the move | raise |

It considers four things, only the last of which is remote:

- transforms with branches, projecting derived targets into joint space
- position limits
- velocity limits
- an anti-collision service, **optionally**

## Consequences

**The modes must never differ in algorithm.** If the validator picks one branch
and the preprocessor would pick another, the certificate is worthless: the
executor either ignores it or moves somewhere nothing checked. Same transforms,
same targets, same limits ⟹ same branch, whichever mode is running.

That is a property test rather than a convention, and it should exist from the
start. Two implementations of the same logic drifting apart is the single
failure mode this project has hit most often, and it is silent.

**Branch selection is not solely a collision concern.** With the service
optional, the same component still does transforms, selection and limit
checking. Without a service, selection falls back to position limits plus
continuity — stay on the branch you are on.

That gives a deployment path the separate framing did not: the preprocessor can
go to every beamline, with collision checking lighting up where the service
exists.

**Velocity limits are shared with the padding calculation.** The swept-path
inflation needs the commanded Δθ per segment, which comes from velocity. Once
the component has that number, checking velocity limits is nearly free — but the
two uses must share it rather than each fetching it, or they can disagree about
how fast the machine is about to move.

**Enumeration stays device-scoped, selection stays machine-scoped.** Each device
knows its own kinematics and lists its candidate branches; choosing across
devices is a joint constraint-satisfaction problem, because two diffractometers
give 8×8 combinations per window and a combination can work when neither
device's locally preferred choice does. Living at the message layer makes that
structural — it is the only place the whole machine is visible.

**The failure taxonomy is unchanged and still matters.** *Infeasible* means the
collision involves only choice-free devices, so no search helps — report
immediately, and check it first because it is cheap. *Unsatisfiable* means
choices exist but no assignment works — report after the search, naming the
window and the binding constraint. The user's next action differs.

**Registration takes two overlapping sets**, not one: every `DerivedSignalFactory`
with branches, so it can project; and the collidable scope, so it knows what to
check. A single-valued transform outside the scope is in neither; a raw
collidable motor is only in the second.
