# The working architecture

How scan validation is currently understood to work. This is the design as it
stands, not a history — for what was tried and discarded see
[](exploration.md), and for why each choice was made see [](decisions.md).

Anything marked **open** is not settled; the ranked list is in
[](open-questions.md).

## The problem

A scan moves several motors along a trajectory. Two things can go wrong that
ordinary limit-checking will not catch:

1. **Collision.** Parts of the diffractometer, the detector, the sample
   environment and the hutch can reach each other. Clearances are of order
   millimetres to tens of millimetres.
2. **Branch selection.** A diffractometer's inverse kinematics is multi-valued:
   several joint configurations reach the same reciprocal-space point. Which one
   you pick determines whether the rest of the scan is reachable, and it has to
   be chosen consistently across devices.

Both need answering *before* the scan runs, so a user is not told at 3 a.m. that
the scan they queued cannot work. Both also need re-checking *while* it runs,
because the beamline can change underneath a decision made earlier.

## Components

```{mermaid}
flowchart TB
    Script["Script<br/><i>for: scan</i>"]
    GUI["Mapping GUI"]
    Script -- "insert and wait" --> Q
    GUI -- "insert" --> Q
    Q{{"Queue<br/>a verdict per entry<br/>⏳ &nbsp; ✓ &nbsp; ✗ &nbsp; ?"}}

    Q -- "scan to validate, held ⏳<br/>↑ ✓ / ✗ / ? + certificate" --> VS
    Q -- "task + certificate<br/>↑ abort on failure" --> ES

    subgraph BA ["blueapi"]
        subgraph V ["VALIDATOR &mdash; read-only, non-blocking"]
            VS["sample scan function<br/>~10 Hz (open)"]
        end
        subgraph E ["EXECUTOR &mdash; owns the devices"]
            ES["sample scan function<br/>5 kHz"]
        end
        KIN["<b>Transform</b><br/>pure sync maths, no I/O"]
    end

    AN["analysis"]
    AC["<b>ANTI-COLLISION SERVICE</b><br/>external, owns the geometry<br/>coarse tier every point<br/>exact tier on flagged pairs"]

    VS --> KIN
    ES --> KIN
    ES -- "RunStart document with<br/>serialized Transform" --> AN
    KIN -- "joint arrays, batched<br/>↑ per-point verdicts" --> AC
```

*The validator's sample rate is **open** — 10 Hz is the current premise and is
measured to be unsound; see [](open-questions.md).

### Queue

Holds scans with a validation verdict per entry. Four states, not two:

| state | meaning |
|---|---|
| ⏳ | queued for validation, or being validated |
| ✓ | validated — will probably run |
| ✗ | validation failed |
| ? | not validatable — the plan is adaptive and cannot be listified in advance |

⏳ comes first because it is where every entry starts, and it is **the queue's
own bookkeeping** — the queue holds an entry at ⏳ while the validator works on
it. The validator never returns ⏳. It returns exactly one of ✓, ✗ or ?.

That split is worth keeping straight: the validator produces *results*, the
queue tracks *progress*. It is the same division that makes validation state
queue state.

**? has exactly one source.** The validator is the only thing that listifies a
plan, so it is the only thing that can discover a plan cannot be listified.
Which means an entry cannot be marked ? at insertion — the queue has no way to
know. Every plan goes to the validator and is held at ⏳ until it either
validates, fails, or turns out to be unlistifiable. There is no shortcut for
adaptive plans, and no way to declare one in advance.

Verdicts are **applied after insertion** and **revoked when control leaves the
queue** — if anyone moves the beamline outside the queue, every tick disappears
and scans are rechecked. That makes validation state queue state, which is why
the queue and validation questions are not separable.

The last row matters: an adaptive plan can never be validated up front, and must
still run. So the unvalidated path is the base case and the certificate is an
optimisation on top of it, not a prerequisite.

### Validator

A separate worker process running under blueapi, seeing PVs through a
**read-only gateway**. It has to be separate because the task worker runs one
task at a time in the process that owns the devices, and validation must work
while a scan is running.

**It does not execute the plan — it iterates it and inspects the messages.**
That is the key to how it works, and it is why the validator needs no solver at
all:

- `Msg("prepare", pmac, spec)` does **not** call `pmac.prepare(spec)`. The
  validator stashes the spec.
- `Msg("kickoff", pmac)` then transforms the stashed values through the pmac's
  own transforms and sends the result to the anti-collision service.
- If it meets a message whose effect it cannot predict, it raises — and that is
  where **?** comes from.

It creates devices, but only for introspection and reading. CA footprint is not
a concern.

It still sees live PVs, so mid-scan it sees a machine in flight, and must
validate against the **projected end state** of the running task rather than the
instantaneous one.

The validator is a **blocking call**. The queueing service does not block
waiting on the result — it holds the entry at ⏳ and carries on.

### Executor

The normal blueapi task worker. It samples the same continuous scan function at
the servo rate (5 kHz typical, up to 20 kHz), runs the kinematics with the
branch taken from the certificate, and submits batches of a few seconds of
motion to the collision service.

Checking runs **ahead of the motion**: the first batch is validated while the
motors move to start, and each subsequent batch while the previous one executes.
Lookahead therefore equals batch duration — seconds, comfortably more than
deceleration time.

If the collision service is unavailable the executor fails and stops the motors
on the way out.

### Kinematics — `Transform`

Pure, synchronous, array-safe maths shared by both processes. No device
references, no I/O.

- **Forward** (`raw_to_derived`) is called from the monitor callback path, so it
  cannot be async without putting task scheduling and backpressure on every
  derived signal update. It is also what analysis needs, which is why the
  executor serialises the `Transform` into the RunStart document — carrying the
  forward maths and its geometry parameters (UB, wavelength, offsets) to
  everything downstream.

  **Analysis only ever runs `raw_to_derived`.** It reads recorded raw values and
  converts them to derived coordinates. It never runs the inverse, and the
  inverse is not part of the analysis contract — a conflation worth naming
  because it recurred repeatedly while this was being designed.
- **Inverse** (`derived_to_raw`) is closed-form once the branch is fixed —
  measured at 0.1 µs/point, flat from 10k to 100k points. Keeping it sync
  enforces that a `Transform` is pure maths: portable to analysis, cacheable,
  testable without hardware.
- **Branch is an argument, never a field**, because the instance is what gets
  serialised and the branch must not reach analysis.

Transforms stack rather than merge — hkl→cartesian and cartesian→joint stay
separate, so the collision model never needs to know hkl was involved. The same
`Transform` classes are reused across beamlines: a robot-arm diffractometer
stacks three, a kappa geometry stacks two.

### Checker — selection and checking are one component

Branch **enumeration** is device-scoped: each device knows its own kinematics.
Branch **selection** is machine-scoped, because two diffractometers give 8×8
combinations per window and a combination can work when neither device's locally
preferred choice does.

Selection and collision checking are **the same component**, because selection
*is* checking with a search over branches — same inputs, same service, same
answer shape. There is no separate solver.

One component with three modes, differing **only in the state they read**:

| mode | reads | emits | on failure |
|---|---|---|---|
| validator | whole plan, projected state | certificate + verdict | ✗ or ? |
| preprocessor | Msg stream, live state | wrapped values | raise |
| interactive | one call, live state | the move | raise |

That constraint is a testable property rather than a convention: same
transforms, same targets, same limits ⟹ same branch, whichever mode is running.
If the validator picks one branch and the preprocessor would pick another, the
certificate is worthless — the executor either ignores it or moves somewhere
nothing checked.

It considers four things, only the last of which is remote:

- **transforms with branches** — projecting derived targets to joint space
- **position limits**
- **velocity limits** — also needed to compute the swept-path inflation, so the
  two uses should share the number rather than each fetching it
- **an anti-collision service, optionally**

The service being optional matters for deployment: a beamline gets transforms,
branch selection and limit checking from the same preprocessor whether or not
anti-collision exists there yet. Without a service, selection falls back to
limits plus continuity — stay on the branch you are on — which means branch
selection is not solely a collision concern.

Failure has two shapes, and the user's next action differs:

- **Infeasible** — the collision involves only choice-free devices. No search
  helps. Report immediately, and check it first because it is cheap.
- **Unsatisfiable** — choices exist but no assignment works. Report after the
  search, naming the window and the binding constraint.

### Certificate

What the validator emits and the executor consumes — but not directly. The
validator returns it to the **queue**, where it is held against the entry
alongside the verdict, and the queue pushes it down to the executor with the
task. The certificate is part of an entry's validation state, so it is revoked
by the same rule that revokes the tick.

It carries **branch selection only**, per window.

It is a **recipe, not a result**. It does not carry joint positions, because for
a fly scan they do not exist yet — an hour at 20 kHz is ~72M points, chunk N+1
is generated while N executes, and densification happens at runtime by
construction. So the branch must reach runtime IK; it cannot be resolved away at
insertion.

It is invalidated by any state change in the collision scope. If invalid, get a
new one.

**The preprocessor reads it to avoid repeating the validator's work.** Given a
certificate it takes the branch decision straight from it rather than searching
again; without one it searches. That is what makes the certificate an
optimisation on the unvalidated path rather than a prerequisite for it — which
matters, because adaptive plans never have one.

Nothing guards against a branch being applied at a position it was not solved
for, because nothing needs to: the decision travels wrapped around the value it
applies to rather than stashed beside it, so that desync is unrepresentable.

### Anti-collision service

External, and a hard runtime dependency of flyscan execution. It owns the
geometry:

- **static environment** as a point cloud, from scans of the hutch
- **movable bodies** as CAD meshes, articulated by a joint chain from config
- a declaration of which axes are **collidable** — typically a handful per
  beamline

Two tiers, split by geometry type rather than by language or process:

| tier | runs on | primitive |
|---|---|---|
| coarse | every trajectory point | conservative bounding volumes |
| exact | only pairs the coarse tier flags | triangle meshes |

The coarse tier must report **which pair** is implicated, not a boolean per
point. Otherwise the exact tier cannot be restricted to flagged pairs and the
tiering buys nothing — measured, that distinction is ~105 s versus a few seconds
per batch.

Which primitive the coarse tier uses is **open**, and is the binding constraint
on the whole design. Hand-authored capsule models are ruled out on cost, so it
must be derived automatically from the mesh.

Everything known about the service as it exists — what the prototype does, what
was measured against it, and what remains to settle with its author — is in
[](anti-collision-service.md).

## How checking is hooked in

Collision checking has to cover **every** move of a collidable axis, whether it
comes from a scan, a `bps.mv`, or someone at a terminal. Kinematics and branch
selection only apply to derived axes; checking applies to all of them. So a raw
motor is the *degenerate* case rather than a special one — an axis whose
projection is the identity and whose branch set has one member.

### The `Certified` wrapper

Values passed to `set` and `prepare` are wrapped:

```python
class Certified(Generic[T]):
    value: T
    async def check_valid(self) -> None:
        """Raise if the preconditions this certification assumed no longer hold."""
```

`check_valid()` is **cheap and local** — PV values compared against thresholds.
It does not call the anti-collision service. The only service traffic on the
runtime path is chunk checking.

Wrapping the value rather than stashing the decision alongside it is what makes
the branch and its target inseparable. They cannot desync, so the class of bug
where a branch prepared for one window gets applied at a different position —
moving somewhere plausible and wrong — is not representable.

`StandardMovable` and `StandardFlyable` gain support for it, so
`Certified[HorizontalMirrorDerived]` carries a deferred coordinated move the
same way `Certified[float]` carries a single axis.

### Installed on `RE.preprocessors`

The checker is a **class**, instantiated with the beamline's scope and exported
from the beamline module the way devices already are, so there is one instance
by construction rather than an instruction to hold a reference. Its instance is
added to `RE.preprocessors` at startup. `RunEngine.__call__` composes it over every plan
it runs, so **a standard `bps.mv` plan works unmodified** — the preprocessor
sees the `set` messages, certifies them as a group, and passes the wrapped
values down.

This is deliberately not a per-plan parameter. A plan author cannot forget to
opt in, which for a safety-adjacent property is the requirement. It is
forget-proof rather than tamper-proof: the list is public and mutable, and the
device-side raise on an uncertified value is what makes it robust rather than
merely conventional.

Grouping is why this lives at the message layer rather than on the device.
`bps.mv(m1, x, m2, y)` is *one* motion; checking each `set` independently would
check states the machine never occupies and reject legitimate moves.

### Uncertified values are rejected, not self-certified

A collidable axis given a bare value raises. There is no fallback to the device
certifying itself, because that path is only sound when a single device moves
at a time: two devices each certifying in isolation would each check against the
other's *current* position rather than its *target*, and two individually-safe
moves can collide. Nothing inside a device can detect that condition.

Non-collidable axes are unaffected — the ban is scoped by the collision-scope
declaration, so existing plans that move things which cannot reach anything keep
working.

For interactive use the same object provides the move:

```python
from dodal.beamlines.i16 import checker
await checker.set(mirror, HorizontalMirrorDerived(x=3, roll=12))
```

One object, one policy, no second implementation to drift. That the sanctioned
route is a one-liner matters: if the blessed path is more awkward than a raw
`caput`, the bypass wins and is worse than what was banned.

It does bypass the RunEngine, which is right for interactive use but means it
cannot see a scan in flight — live PVs say where things are now, not where a
running scan is about to put them. Either the checker holds a reference to the
RE and refuses while a plan is running, or that is a documented hazard.

### Per-beamline wiring

The checker needs beamline-specific knowledge — which axes are collidable, which
service owns them — but no mechanism to inject it: it is wired at RunEngine
construction and reached interactively by import, so it is never a plan
parameter.

What does need one is a generic `scanspec_scan`, which needs a beamline's
devices and triggering strategy while the rest of the plan stays generic.
blueapi already solves that shape for devices — a plan parameter typed as a
`Device` arrives over the API as a *name* and is resolved server-side against
that beamline's context, with the JSON schema enumerating valid names.

**Open:** blueapi's `Device` is a union of bluesky protocols and
`register_device` rejects anything failing `is_bluesky_compatible_device`, so a
trigger strategy cannot be registered today. See [](open-questions.md).

### Where it lives

`Transform` belongs in **its own package**, because analysis needs it to convert
recorded raw values to derived coordinates and should not have to install
ophyd-async to do so.

The checker plausibly belongs in **ophyd-async** — it is within scope there, and
it needs `DerivedSignalFactory` internals. It may be worth splitting out later,
but starting it there avoids inventing a package before the shape is settled.

## Execution contract

Every move of a collidable axis arrives already certified. The device checks the
certificate is still valid, applies the branch it carries, moves, and discards
it.

```{mermaid}
sequenceDiagram
    autonumber
    participant P as plan
    participant C as checker<br/>(preprocessor)
    participant D as device
    participant AC as anti-collision

    Note over P,AC: every move in a plan, certified as a group
    P->>C: Msg("set", mirror, HorizontalMirrorDerived(...))
    C->>C: project through Transform, search branches
    C->>AC: candidate joint positions
    AC-->>C: verdict
    C->>D: set(Certified(value, branch))
    D->>D: check_valid() — cheap, PVs against thresholds
    D->>D: derived_to_raw(branch, value)
    D->>D: one deferred move, then discard the certificate

    Note over P,AC: with a certificate, the search is skipped
    P->>C: Msg("set", mirror, value)
    C->>C: take the branch from the certificate
    C->>D: set(Certified(value, branch))

    Note over P,AC: bare value on a collidable axis
    P->>D: set(3.0)
    D--xP: raise — there is no self-certification
```

### Coordinated moves are one value, not several

A device that can move several axes together exposes **one** settable taking a
composite value:

```python
async def set(self, value: HorizontalMirrorDerived) -> None: ...
```

so the whole mirror moves as a single deferred move. Which means:

```python
bps.mv(mirror.x, 3, mirror.roll, 12)   # WRONG
```

This is broken for a reason that has nothing to do with collisions: it issues
two independent moves, the axes no longer start and stop together, and the path
acquires corners. Every straight-line-in-joint-space assumption in this design
depends on the composite move being used.

The certified form is therefore `Certified[HorizontalMirrorDerived]`, not a
`Certified[float]` per axis — which keeps the incentive pointing at the API that
preserves coordination, rather than nudging people toward the one that breaks
it.

### What the device does with it

`DerivedSignalFactory` extracts the branch from the certificate and applies it to
the transform; `StandardFlyable` does the same for a trajectory. That is new
plumbing in ophyd-async — the branch has to reach `derived_to_raw`, which today
takes no such argument.

The rest is nearly free: `SignalTransformer` already holds the transform class,
the raw devices and the transform parameter sources. What is missing is public
access to them, and to the derived axis names, so the checker can be told about
a `DerivedSignalFactory` and work out the rest itself.

### Registration takes two overlapping sets

The checker needs **every factory with branches**, so it can project; and the
**collidable scope**, so it knows what to check. A mirror with a single-valued
transform outside the scope is in neither. A raw collidable motor is only in the
second. Keeping them distinct in the registration API is worth doing from the
start, because assuming one list works right up until a beamline has both.

### Windows and turnarounds

scanspec2's `_step_windows` yields one window per setpoint, so per-window branch
is per-point branch for step scans with no special case.

**Turnaround trajectories are in joint space and need checking too, and scanspec
does not produce them.** Easy to forget for exactly that reason. The same
applies to the move to start.

## What this rests on

Anti-collision here is **soft machine protection, not a safety function**.
Catastrophic cases are guarded at the robot level and by door interlocks; this
layer handles constraints too dynamic to guard there. That is what licenses two
otherwise indefensible choices: making flyscan execution depend on a network
service, and accepting a coarse model that is probabilistic rather than sound.
If anyone reclassifies this layer, both have to be revisited.
