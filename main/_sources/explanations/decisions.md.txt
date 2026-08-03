# Decisions

The load-bearing choices, in [Nygard format](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions):
context, decision, consequences. The consequences section is the useful part —
it is where the cost of each choice is written down.

If you are reading them all, read in this order. ADR-0003 first, because it is
the classification everything else is licensed by; ADR-0008 second, because it
is the one that bears on queueing.

```{toctree}
:maxdepth: 1

decisions/0003-anti-collision-is-soft-machine-protection
decisions/0008-validation-state-is-owned-by-the-queue
decisions/0004-validation-runs-in-a-second-read-only-process
decisions/0009-checking-is-a-plan-preprocessor
decisions/0010-the-checker-is-the-solver
decisions/0005-transform-is-pure-synchronous-maths
decisions/0006-two-tier-collision-checking
decisions/0007-the-coarse-model-must-be-derived-automatically
decisions/0001-record-architecture-decisions
decisions/0002-switched-to-python-copier-template
```

## A note on the numbering

These were renumbered once, in a single pass before this repo was first pushed.
Two ADRs were superseded during the design and have been folded into the ones
that superseded them, with **what they decided recorded as a note there** rather
than deleted — the superseded reasoning is usually why the current decision has
the shape it does.

- The certificate ADR is now part of ADR-0009.
- The machine-scoped-solver ADR is now part of ADR-0010.

**This will not happen again.** From the first push, an ADR keeps its number
permanently, and a superseded one is marked superseded in place — never removed,
never renumbered. The one-time exception was taken because nothing had been
published against the old numbers.
