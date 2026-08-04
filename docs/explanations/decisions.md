# Decisions

What has been settled, and what has not.

[](open-questions.md) comes first, because what is still open shapes how to read
what is decided. The ADRs follow in numerical order, in
[Nygard format](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions):
context, decision, consequences. The consequences section is the useful part —
it is where the cost of each choice is written down.

If you are reading the ADRs all the way through, start at ADR-0002. It is the
classification everything else is licensed by. ADR-0007 is the one that bears on
queueing.

```{toctree}
:maxdepth: 1

open-questions
decisions/0001-record-architecture-decisions
decisions/0002-anti-collision-is-soft-machine-protection
decisions/0003-validation-runs-in-a-second-read-only-process
decisions/0004-transform-is-pure-synchronous-maths
decisions/0005-two-tier-collision-checking
decisions/0006-the-coarse-model-must-be-derived-automatically
decisions/0007-validation-state-is-owned-by-the-queue
decisions/0008-checking-is-a-plan-preprocessor
decisions/0009-the-checker-is-the-solver
```

## A note on the numbering

Three ADRs have been removed since these were first written, and the rest
renumbered around them.

Two were superseded during the design and are folded into the ones that
superseded them, with **what they decided recorded as a note there** rather than
deleted — the superseded reasoning is usually why the current decision has the
shape it does. The certificate ADR is now part of ADR-0008; the
machine-scoped-solver ADR is now part of ADR-0009.

The third recorded the adoption of a project template. It was never a decision
about scan validation and is gone without a trace, because there is nothing in
it worth carrying.

**Renumbering is now closed.** From here an ADR keeps its number, and a
superseded one is marked superseded in place — never removed, never renumbered.
Both passes happened while the only reader was the person writing them.

Note that blueapi has its own ADR-0003, "No Queues", which is a different
document from this project's. ADR-0007 discusses it and always names it
explicitly.
