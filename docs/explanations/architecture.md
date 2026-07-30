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

### Solver

Branch **enumeration** is device-scoped — each device knows its own kinematics.
Branch **selection** is machine-scoped, because two diffractometers give 8×8
combinations per window and a combination can work when neither device's locally
preferred choice does.

The solver hook is for **collision-constrained** devices, not multi-valued ones.
A two-jack system has nothing to choose but still needs its `set` checked. "Zero
branches" and "no checking" are different states, so the null case is an
explicit solver that raises, not `None`.

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
new one. Entries carry the derived values they were solved for, and `set`
asserts the request matches before applying, so a stale branch raises rather
than moving somewhere plausible and wrong.

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

The checker is a plan preprocessor, added to `RE.preprocessors` at startup by
the beamline's configuration. `RunEngine.__call__` composes it over every plan
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

For interactive use there is a `certified_move` helper, so the sanctioned path
is a one-liner. That matters: if the blessed route is more awkward than the
bypass, people will find the bypass, and it will be worse than what was banned.

### Per-beamline wiring

Both the preprocessor and `certified_move` need beamline-specific knowledge —
which axes are collidable, which service owns them. The same problem exists for
a generic `scanspec_scan`, which needs a beamline's devices and triggering
strategy while the rest of the plan stays generic.

blueapi already solves this shape for devices: a plan parameter typed as a
`Device` is submitted over the API as a *name* and resolved server-side against
that beamline's context, with the JSON schema enumerating valid names. Extending
the same name-resolution to non-device collaborators — a trigger strategy, a
collision scope — would let generic plans declare what they need in their
signature and have the beamline supply it, without global state.

Name resolution against a per-process context also gives the validator
substitution for free: it registers different implementations under the same
names and runs the same plans unchanged.

**Open:** blueapi's `Device` is a union of bluesky protocols and
`register_device` rejects anything failing `is_bluesky_compatible_device`, so a
strategy or scope object cannot be registered today. Whether that is a small
extension or a rewrite is unmeasured — see [](open-questions.md).

## Execution contract

```
for window in scan:
    prepare(device, window, certificate[window])
    if window.moving_axes:  kickoff / complete
    else:                   set(hkl) / trigger / read
```

```{mermaid}
sequenceDiagram
    autonumber
    participant P as plan
    participant D as device
    participant S as solver
    participant AC as anti-collision

    Note over P,AC: prepared path — certificate already validated this point
    P->>D: prepare(window, certificate[window])
    D->>D: store branch (consumed, not sticky)
    P->>D: set(h, k, l)
    D->>D: assert request matches what the branch was solved for
    D->>D: derived_to_raw(branch, hkl) — closed form
    D-->>P: raw setpoints, no check needed

    Note over P,AC: unprepared path — bps.mv, or an adaptive plan
    P->>D: set(h, k, l)
    D->>S: select(targets)
    S->>AC: check candidate joint positions
    AC-->>S: verdict per candidate
    S-->>D: consistent branch assignment
    D-->>P: raw setpoints

    Note over P,AC: stale branch — prepare, then something intervenes
    P->>D: prepare(window 7)
    P->>D: set(different hkl)
    D--xP: StaleBranch — refuses rather than moving somewhere plausible
```

`set` with a prepared branch applies it and skips checking, because the
certificate already validated that point and the path to it. `set` without a
prepared branch selects and checks now — which is what `bps.mv(h, k, l)` does,
so it keeps working with no special handling.

`prepare` is **consumed, not sticky**: it clears after one `set`, so an
unprepared `set` always falls through to select-and-check. Without that, a
prepare for window 7 followed by an intervening move would apply window 7's
branch at a different position and fail silently.

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
