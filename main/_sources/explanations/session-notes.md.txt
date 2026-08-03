# Where the work stands

What state this design is in, what is unfinished, and what is waiting on other
people. Everything technical is in the other documents; this is the part that
lives between them, and it is the page most likely to be out of date.

## How far it has got

The design conclusions are in [](architecture.md) and the ADRs. What was
measured is in [](exploration/measurements.md), and the fourteen conclusions
reversed along the way are in [](exploration/reversals.md).

Broadly: the shape of validation is settled, the mechanism by which checking
hooks into bluesky is settled, and the geometry underneath it is not. The three
questions in [](open-questions.md) that would actually move the design are all
in that last category or adjacent to it.

## What is not finished

**The architecture document has been reviewed unevenly.** The sections up to
*Execution contract* have had more scrutiny than the ones after it. The
checker/solver consolidation and the `Certified` wrapper were worked out late
and have had the least.

**Two things from the original plan were never started.** Sequence-diagram
traces of blueapi and bluesky-queueserver in matching notation, with a
capability comparison; and the reconciliation with
`DiamondLightSource/daq-queuing-service`. The second has been promoted in
importance since it was first listed, because validation state turning out to be
queue state makes *where the queue lives* an early architectural decision rather
than a late one.

**The round-trip property test has not been ported into ophyd-async.** It found
two real bugs in a few hundred lines of carefully written code, and it is cheap.

## The three things that would move the design

Unchanged from [](open-questions.md), repeated because they are the point.

1. **Can an automatically-derived coarse model be tight enough?** Fitted spheres
   leave 63–173 mm of error against 3.3 mm of motion padding. Half a day: one
   detector arm, a medial-axis sphere tree and `coal`'s OBB/RSS BVH nodes, same
   error metric on both.
2. **What is the exemption set?** The reference model reports 8–12 collisions
   per pose at its own nominal-valid pose, so no false-positive number measured
   on it means anything. A conversation, not a computation.
3. **What are the real joint velocities?** Every padding and rate figure scales
   linearly with it, and the two regimes tested differ by 8×.

## Waiting on other people

**Gareth Nisbet (anti-collision service)** — everything known about the service,
what has been asked, what was answered, and what is still open is gathered in
[](anti-collision-service.md), which ends with a suggested shape for the next
conversation. Most of the findings in it have not yet been raised with him, and
the page marks which.

**bluesky** — `RE.preprocessors` composition order in the code disagrees with
the docstring at `run_engine.py:235`. A checker must be outermost, so this is
not academic. Worth an issue either way.

**blueapi** — `register_device` gates on `is_bluesky_compatible_device`, so a
non-device collaborator (a trigger strategy) cannot be registered. Whether
extending that is small or large is an hour's reading and has not been done.

## Practical notes for anyone picking this up

The benchmarks need real geometry that is not vendored — see
`benchmarks/README.md`, which also lists the methodological traps specific to
this domain. Several cost a full measurement each to discover.

Diagrams are mermaid, and sphinx does not validate them: a broken or badly
laid-out diagram builds clean and fails only in a browser. Use
`tools/render_diagram.sh` rather than iterating blind. This was learned the
expensive way.
