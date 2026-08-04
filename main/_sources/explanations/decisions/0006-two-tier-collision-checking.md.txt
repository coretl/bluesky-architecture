# 6. Collision checking is two tiers, and the service answers two questions

## Status

Accepted

## Context

Exact triangle-level checking cannot run on every point of a trajectory. Measured
on real i16 geometry, proving two meshes do not touch costs 250 µs in C++ and
~1550 µs in JavaScript, and a batch is 15,000 points. Every fast implementation
in the field — cuRobo, CAPT, MoveIt, Tesseract — uses cheap primitives on the
hot path and reserves meshes for verification.

Separately, the interface to the service needs settling. The service owns the
geometry and the checker owns transforms, branches, soft limits and windows, so
what passes between them should be as narrow as that division allows.

## Decision

**Two tiers, split by geometry type.** A **coarse** tier of conservative
bounding volumes runs on every trajectory point. An **exact** triangle tier runs
only on the pairs the coarse tier flags. The coarse tier must report **which
pair** is implicated, not a boolean per point.

**The service is stateless and answers exactly two questions:**

1. *Given an axis, what can it ever collide with?* Over every position of every
   axis the model permits, not at the current pose.
2. *Given this set of axis moves, do they collide?* Full state supplied by the
   caller.

## Consequences

### The tiering

**Naming the pair is the whole of the first decision.** If the coarse tier
returns only "something collided at this point", the exact tier cannot be
restricted to the implicated pair and has to re-check everything — measured at
~105 s per batch against a few seconds for the correct arrangement. The contract
is `(point, body_a, body_b)` triples.

The tiers split by *geometry type*, not by language or process. Both can live in
the same service; neither implies a machine boundary.

The exact tier's cost is therefore **flag-rate driven**, and the coarse tier's
false-positive rate is the quantity that matters. That rate is currently
unmeasurable — the reference model reports collisions at its own nominal-valid
pose — so the design must not depend on it being small. The mechanism is a
**hard cap on fallback work** with defined behaviour on exceeding it: treat as
collision and stop. A cap converts an unmeasurable cost into a bounded one,
which is a stronger position than obtaining the number.

**The two collision problems are not symmetric.** Self-collision can escalate
from coarse to exact because the CAD mesh is ground truth. Environment collision
cannot: the environment is a point cloud, already a sampling of the real
surface, so its proximity threshold *is* the model rather than padding on top of
one.

### The first question: a reachability relation

**The answer is an axis-to-axis relation**, and it exists to bound the second
question. To check a move of one axis, the checker gathers the positions of the
axes that can ever interact with it rather than the whole machine. It must never
omit a pair that can touch; extra pairs cost only state gathering, so an
over-approximation is acceptable, and it is expected to be trimmed by hand at
first.

**The relation has a static half and a transient half**, and only one of them
holds still:

- **Axis against axis** is derived from the CAD model and the limit-switch
  positions. It changes when the machine is rebuilt.
- **Axis against environment** depends on the point cloud, which is a LIDAR scan
  of the hutch capturing transient contents — racks, cables, user kit. It
  changes between experiments while the machine does not, and a re-scan can only
  *add* things an axis might reach, so it can invalidate a relation that was
  correct when it was computed.

**The version hash therefore covers geometry, limit switches and the point
cloud.** All three move the relation. The point cloud is why staleness is an
operational concern rather than a theoretical one, and what follows from that —
re-scan cadence, whether queued verdicts survive a re-scan — is Q20.

**The relation is computed after the exemption set**, so permanently-touching
pairs are absent from it. That makes it depend on an unsettled question, and on
a robot arm an exemption is not simply a property of a pair: a self-touching
pair *can* collide if the elbow rotates transversely with cable management
attached. That is Q18.

### The second question: statelessness

**Statelessness is what keeps validation correct.** A service holding "current
pose" would answer about live PVs, and the validator has to ask about the
*projected end state* of a running task (ADR-0004). It also makes the batch API
a pure function of its request, so it is cacheable and testable without a
machine.

**Limit-switch positions belong to the service; soft limits do not.** The
relation is computed from limit switches, so they are part of the model. Soft
limits are applied by the checker at validation time and the service never
learns them, which means tightening one cannot silently invalidate anything the
service holds.

See [](../open-questions.md) for Q18 and Q20, both of which this decision
depends on and neither of which is settled.
