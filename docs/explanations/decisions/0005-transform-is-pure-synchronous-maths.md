# 5. Transform is pure, synchronous, array-safe maths

## Status

Accepted

## Context

`Transform` converts between raw axis values and derived coordinates. Both
directions are used, in different places and for different reasons, and the
temptation to make either async has come up more than once.

The forward direction is called from the monitor callback path
(`_make_derived_readings`, `get_locations`). The inverse is called from
user-supplied `set_derived` implementations.

## Decision

Both directions stay synchronous, and a `Transform` holds no device references
and performs no I/O. The same expression must work on scalars and on arrays.

The branch is an **argument to the inverse, never a field**.

## Consequences

These are two decisions that look like one, and they rest on different grounds:

- **Forward is forced.** Async on the monitor path means task scheduling,
  ordering and backpressure on every derived signal update.
- **Inverse is chosen.** Once branch and constraints are fixed the inverse is
  closed-form. Sync enforces that a `Transform` is pure maths: portable to
  analysis, cacheable, testable without hardware, runnable in a subprocess.
  Admitting I/O makes every downstream assumption conditional.

If the inverse is ever revisited, that should not drag the forward into the
discussion.

Branch stays out of the class because the instance is what gets serialised into
RunStart, and the branch must not reach analysis. Constraint mode, by contrast,
*is* legitimate `Transform` state — it changes the mapping, whereas branch
selects among solutions of a fixed mapping. They look alike and are not.

Array-safety holds for free via numpy broadcasting for simple transforms. It
does **not** hold for diffcalc, whose API is scalar and loops internally — so a
diffractometer's forward transform should be the maths written directly in
numpy, with diffcalc as a round-trip test oracle rather than as the
implementation.

A framework-level round-trip property test over every registered transform is
worth more than asking each implementer to remember: writing one found two real
bugs in a few hundred lines of carefully-written code.

`Transform` also needs a type discriminator. `model_dump_json()` currently
produces `{"distance": 2.0}` with no type tag, so analysis receiving JSON cannot
reconstruct the class — the `discriminated_union_of_subclasses` pattern scanspec
already uses would fix it. And because `Transform` lives in `ophyd_async.core`,
an analysis pipeline must install ophyd-async to convert angles to hkl, which
argues for extraction into a dependency-light package. Both are worth settling
before transforms proliferate across dodal.
