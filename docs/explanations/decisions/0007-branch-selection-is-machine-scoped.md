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

> **Amended by ADR-0011.** This originally required a solver to be *injected
> into each device*, and noted that this made devices non-standalone — a
> departure from how ophyd-async works. That is no longer the mechanism.
> Selection happens in a plan preprocessor and the chosen branch reaches the
> device wrapped around the value it applies to, so devices receive a branch
> rather than owning a solver and stay standalone. The claim below that
> selection is machine-scoped is unchanged and is now structural: the message
> layer is the only place the whole machine is visible.

The forward path stays pure regardless, so monitor updates, analysis and
descriptors are unaffected.

`None` would conflate "single-valued, nothing to choose" with "must not move" —
two states with opposite required behaviour, where getting it wrong means an
unchecked move. Hence the explicit null solver.

The loop hazard that motivated a null solver — the validation process
instantiates devices, which reference a solver, which is what the process exists
to serve — no longer exists. The validator interprets messages rather than
executing them, so it never reaches a device's write path at all.

Failures have two shapes and the user's next action differs: **infeasible** (the
collision involves only choice-free devices, so no search helps — report
immediately, and check it first because it is cheap) and **unsatisfiable**
(choices exist but no assignment works — report after the search, naming the
window and the binding constraint).
