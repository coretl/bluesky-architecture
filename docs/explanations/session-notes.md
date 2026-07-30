# Where the work stands

Written at the end of a working session, for whoever picks this up next —
including a future me with no memory of it. Everything technical is in the other
documents; this is the state that lives between them.

## What happened in this session

The repo went from seven loose Python files with no commits to a scaffolded,
documented design record. In order: scaffolded from the DLS copier template,
landed the strawman so it runs, surveyed collision libraries against real i16
geometry, measured a lot, restructured the docs by kind, and then worked out how
checking hooks into bluesky.

The design conclusions are in [](architecture.md) and the ADRs. What was
measured is in [](exploration/measurements.md), and the fourteen conclusions
that were reversed along the way are in [](exploration/reversals.md).

## What is not finished

**A review of `architecture.md` was in progress and may not be complete.** The
corrections raised so far have been applied — the validator interpreting
messages rather than executing them, no solver, no CA-footprint concern, the
blocking-call semantics, and analysis running only `raw_to_derived`. Whether the
whole document has been read is not recorded. Assume the sections after
*Execution contract* have had less scrutiny than the ones before it.

**The design discussion outran the review.** The checker/solver consolidation
and the `Certified` wrapper were worked out after the review started, so those
sections are newer than the ones around them and have not been read back.

## The three things that would move the design

Unchanged from [](open-questions.md), repeated because they are the point:

1. **Can an automatically-derived coarse model be tight enough?** Fitted spheres
   leave 63–173 mm of error against 3.3 mm of motion padding. Half a day: one
   detector arm, a medial-axis sphere tree and `coal`'s OBB/RSS BVH nodes, same
   error metric on both.
2. **What is the exemption set?** The reference model reports 8–12 collisions
   per pose at its own nominal-valid pose, so no false-positive number measured
   on it means anything. A conversation, not a computation.
3. **What are the real joint velocities?** Every padding and rate figure scales
   linearly with it, and the two regimes tested differ by 8×.

## Outstanding with other people

**Gareth (anti-collision service)** — everything known about the service, what
has been asked, what was answered, and what is still open is gathered in
[](anti-collision-service.md), which ends with a suggested shape for the next
conversation. Several findings in it have not yet been raised with him.

**bluesky** — `RE.preprocessors` composition order in the code disagrees with
the docstring at `run_engine.py:235`. A checker must be outermost, so this is
not academic. Worth an issue either way.

**blueapi** — `register_device` gates on `is_bluesky_compatible_device`, so a
non-device collaborator (a trigger strategy) cannot be registered. Whether
extending that is small or large is an hour's reading and has not been done.

## Things that were never started

From the original plan, still untouched: the sequence-diagram traces of blueapi
and bluesky-queueserver in matching notation with a capability comparison, and
the Phase 0 reconciliation with `DiamondLightSource/daq-queuing-service`. The
latter has been promoted in importance since it was first listed, because
validation state turning out to be queue state makes where the queue lives an
early architectural decision rather than a late one.

Also never done: porting the round-trip property test into ophyd-async. It found
two real bugs in a few hundred lines of carefully written code, and it is cheap.

## Practical notes

The benchmarks need real geometry that is not vendored — see
`benchmarks/README.md`, which also lists the traps specific to this domain.
Several cost a full measurement each to discover.

Diagrams are mermaid and sphinx does not validate them; use
`tools/render_diagram.sh` rather than iterating blind. This was learned the
expensive way.

Nothing has been pushed from this session beyond what was already on `main`.
