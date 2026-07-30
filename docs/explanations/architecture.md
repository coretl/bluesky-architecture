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

A second, read-only blueapi process. It has to be separate because the task
worker runs one task at a time in the process that owns the devices, and
validation must work while a scan is running.

Consequences of being a live second process:

- It sees live PVs, so mid-scan it sees a machine in flight. It must validate
  against the **projected end state** of the running task, not the instantaneous
  one.
- It instantiates devices for their *state*, never to move them, so it is
  injected with a null solver that raises on any inverse call. Absence of a
  solver must raise, never silently fall through to unchecked motion.
- It interacts with blueapi ADR-0005 ("connect all dodal devices during
  startup"): a second process connecting everything doubles the CA footprint,
  which probably needs a device-subset concept blueapi does not have.

It is **non-blocking**. Scans can be queued and can start before validation
finishes.

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
