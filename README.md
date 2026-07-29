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

Start with the handover in `docs/explanations/`, which records what is decided,
what is measured, and what is still open. Where a decision has reasoning
attached, the reasoning matters more than the conclusion — several conclusions
here were reversed when an assumption turned out to be wrong, and the reversals
are recorded alongside the decisions.

Run the strawman's tests and benchmarks with:

```
tox -e tests
python -m bluesky_architecture.strawman.bench
```

<!-- README only content. Anything below this line won't be included in index.md -->

See https://coretl.github.io/bluesky-architecture for more detailed documentation.
