[![CI](https://github.com/coretl/bluesky-architecture/actions/workflows/ci.yml/badge.svg)](https://github.com/coretl/bluesky-architecture/actions/workflows/ci.yml)
[![Coverage](https://codecov.io/gh/coretl/bluesky-architecture/branch/main/graph/badge.svg)](https://codecov.io/gh/coretl/bluesky-architecture)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

<!-- index start -->

# Scan validation architecture

Design work for validating Bluesky scans at Diamond before and during
execution: checking that a scan can run without a collision, choosing the
kinematic branch it will run on, and re-checking that decision against the
machine while it executes.

**This is a design record, not software.** The deliverable is the documents and
the evidence behind them. The Python package is a strawman, built to settle
questions that argument was not settling, and kept because its measurements are
the reason several decisions went the way they did.

Every number has a script behind it or a label saying it is an estimate, and
where a conclusion was later overturned the original is kept next to the
correction rather than edited away.

<!-- README only content. Anything below this line won't be included in index.md -->

| What | Where |
|---|---|
| Source | <https://github.com/coretl/bluesky-architecture> |
| Documentation | <https://coretl.github.io/bluesky-architecture> |
| Releases | <https://github.com/coretl/bluesky-architecture/releases> |

```
uv run pytest                                 # strawman property tests
python -m bluesky_architecture.strawman.bench # kinematics benchmarks
cat benchmarks/README.md                      # collision benchmarks
```

See <https://coretl.github.io/bluesky-architecture> for the documents themselves.
