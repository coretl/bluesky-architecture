# 7. Branch enumeration is device-scoped; selection is machine-scoped

## Status

Accepted

## Context

A diffractometer's inverse kinematics is multi-valued. Each device knows its own
kinematics and can list its candidate branches. Choosing between them is a
different problem: two diffractometers give 8×8 combinations per window, and a
combination can work when neither device's locally preferred choice does.

Separately, a device can need collision checking without having anything to
choose — a two-jack system has a single-valued inverse but can still crash.

## Decision

Devices enumerate their own branches. A machine-scoped **solver** takes a
window's derived targets across all participating devices and returns one
consistent assignment.

The solver hook is for **collision-constrained** devices, not multi-valued ones.
The null case is an explicit solver that raises, never `None`.

## Consequences

Devices with injected solvers are not standalone. Sim and unit tests inject a
trivial solver; production injects the real one. This is a departure from how
ophyd-async devices work today and should be an explicit decision rather than an
implementation detail. The forward path stays pure, so monitor updates, analysis
and descriptors are unaffected.

`None` would conflate "single-valued, nothing to choose" with "must not move" —
two states with opposite required behaviour, where getting it wrong means an
unchecked move. Hence the explicit null solver.

There is a loop hazard: the validation process instantiates devices, and if
devices reference a solver, and the solver is what the process exists to serve,
that is a cycle. It is broken by the validator injecting the null solver, since
it needs devices for state rather than for setting.

Failures have two shapes and the user's next action differs: **infeasible** (the
collision involves only choice-free devices, so no search helps — report
immediately, and check it first because it is cheap) and **unsatisfiable**
(choices exist but no assignment works — report after the search, naming the
window and the binding constraint).
