---
html_theme.sidebar_secondary.remove: true
---

```{include} ../README.md
:start-after: <!-- index start
:end-before: <!-- README only content
```

## Where to start

These documents are meant to be readable with nobody to ask. Each links to the
evidence behind it, so if a claim looks wrong you can go and check it rather
than take it on trust.

**If you have twenty minutes**, read [](explanations/architecture.md). It is the
design as it currently stands, and it is self-contained.

**If you are here about queueing**, read
[](explanations/decisions/0008-validation-state-is-owned-by-the-queue.md) first.
It is the finding with the widest blast radius outside this project: validation
verdicts turn out to be queue state, which makes validation and queueing
inseparable and promotes reconciliation with the existing queuing service from a
late task to an early architectural decision. Then the *Queue* section of
[](explanations/architecture.md), and Q9 in [](explanations/open-questions.md),
which is the rule nobody has written down yet.

**If you want to know what is not settled**, read
[](explanations/open-questions.md). It is ranked by how much each answer would
move the design, and the top three are each worth about an afternoon of
somebody's time.

**If you are about to disagree with something**, read
[](explanations/exploration/reversals.md) first. There is a fair chance the
disagreement is already in there, along with whatever settled it.

```{toctree}
:maxdepth: 2

explanations/architecture
explanations/decisions
explanations/exploration
```
