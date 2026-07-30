[![CI](https://github.com/coretl/bluesky-architecture/actions/workflows/ci.yml/badge.svg)](https://github.com/coretl/bluesky-architecture/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/coretl/bluesky-architecture/branch/main/graph/badge.svg)](https://codecov.io/gh/coretl/bluesky-architecture)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

# bluesky_architecture

Validation architecture for Bluesky at Diamond: insertion-time and runtime scan validation

Design work for validating scans before and during execution: checking that a
scan can run without a collision, choosing the kinematic branch it will run on,
and re-checking that decision against the machine while it executes.

The deliverable is the architecture decision records in `docs/explanations/`.
The Python package is supporting evidence, not a product — a strawman built to
settle questions that argument was not settling, kept because its measurements
are the reason several decisions went the way they did.

What            | Where
:---:           | :---:
Source          | <https://github.com/coretl/bluesky-architecture>
Documentation   | <https://coretl.github.io/bluesky-architecture>
Releases        | <https://github.com/coretl/bluesky-architecture/releases>

Start with **Where we are** in `docs/explanations/`, which is the current
bottom line in a page. Behind it sit the original handover (kept for its
reasoning, with twelve conclusions since reversed and marked inline) and a
survey of collision libraries measured against real beamline geometry.

Where a decision has reasoning attached, the reasoning matters more than the
conclusion — most conclusions here were reversed at some point, and the
reasoning usually survived the reversal. Reversals are recorded next to what
they reverse rather than edited away.

Every number should have a script behind it or be labelled an estimate. The one
figure that got sized against without an artefact turned out to be both
unreproducible and wrong in premise, which is why `benchmarks/` exists.

```
tox -e tests                                  # strawman property tests
python -m bluesky_architecture.strawman.bench # kinematics benchmarks
cat benchmarks/README.md                      # collision benchmarks
```

<!-- README only content. Anything below this line won't be included in index.md -->

See https://coretl.github.io/bluesky-architecture for more detailed documentation.
