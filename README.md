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

The documentation is in three parts:

- **The working architecture** — how scan validation is currently understood to
  work, and what it rests on.
- **Decisions** — ADRs for the load-bearing choices, with their consequences.
- **Exploration** — what was measured, and the fourteen conclusions that were
  argued confidently and then reversed. Reversals are recorded next to what they
  reverse rather than edited away, because the reasoning usually survives the
  reversal and is worth reading.

Plus a ranked list of what is still open. The binding question is whether a
coarse collision model derived automatically from CAD meshes can be made tight
enough — not kinematics, not body count, not the sample rate.

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
