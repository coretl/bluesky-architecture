# 2. Anti-collision is soft machine protection, not a safety function

## Status

Accepted

## Context

Anti-collision checking sits between the user's scan request and motion on a
beamline. It is natural to read that as a safety system, and someone joining
later will read it that way unless told otherwise.

Catastrophic cases are already guarded elsewhere: at the robot controller and by
door interlocks. What this layer handles is constraints too dynamic to express
there — a detector that must stay 20 mm from the sample, entry points confined
to a 90° arc, sample environment that changes between experiments.

## Decision

This layer is **soft machine protection, not a safety function**. State it in
these words.

## Consequences

Independence of implementation is not required, which is what makes two
otherwise indefensible choices acceptable:

- Flyscan execution may depend on an external network service, with defined
  fail-closed behaviour, rather than needing a local guaranteed path.
- The coarse geometric model may be probabilistic rather than provably sound,
  trading a small false-negative rate for not rejecting legitimate scans.

Both are only acceptable under this classification. **If anyone reclassifies
this layer as a safety function, both must be revisited** — and that
reclassification is exactly the kind of thing that happens quietly, in a
meeting, without anyone revisiting the consequences.
