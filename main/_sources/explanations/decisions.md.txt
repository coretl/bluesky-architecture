# Decisions

What has been settled, and what has not.

[](open-questions.md) comes first, because what is still open shapes how to read
what is decided. The ADRs follow in numerical order, which is also the order they
read in, in [Nygard format](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions):
context, decision, consequences. The consequences section is the useful part —
it is where the cost of each choice is written down.

Start at ADR-0002. It is the classification everything else is licensed by.
ADR-0003 is the one that bears on queueing.

```{toctree}
:maxdepth: 1
:glob:

open-questions
decisions/*
```

```{important}
**Ask before editing an existing ADR in this repo.** Amendments go at the end
under their own heading, saying what changed and why; the original decision and
its reasoning stay where they are.
```

Note that blueapi has its own ADR-0003, "No Queues", which is a different
document from this project's. ADR-0003 here discusses it and always names it
explicitly as blueapi's.
