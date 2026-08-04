# 6. Collision checking is two tiers, split by geometry type

## Status

Accepted

## Context

Exact triangle-level checking cannot run on every point of a trajectory. Measured
on real i16 geometry, proving two meshes do not touch costs 250 µs in C++ and
~1550 µs in JavaScript, and a batch is 15,000 points. Every fast implementation
in the field — cuRobo, CAPT, MoveIt, Tesseract — uses cheap primitives on the
hot path and reserves meshes for verification.

## Decision

A **coarse** tier of conservative bounding volumes runs on every trajectory
point. An **exact** triangle tier runs only on the pairs the coarse tier flags.

The coarse tier must report **which pair** is implicated, not a boolean per
point.

## Consequences

That last sentence is the whole decision. If the coarse tier returns only
"something collided at this point", the exact tier cannot be restricted to the
implicated pair and has to re-check everything — which measured ~105 s per batch
against a few seconds for the correct arrangement. The contract is
`(point, body_a, body_b)` triples.

The tiers split by *geometry type*, not by language or process. Both can live in
the same service; neither implies a machine boundary.

The exact tier's cost is therefore **flag-rate driven**, and the coarse tier's
false-positive rate is the quantity that matters. That rate is currently
unmeasurable (the reference model reports collisions at its own nominal-valid
pose), so the design must not depend on it being small.

The mechanism for that is a **hard cap on fallback work**, with defined
behaviour on exceeding it — treat as collision and stop. A cap converts an
unmeasurable cost into a bounded one, which is a stronger position than
obtaining the number.

Note the asymmetry between the two collision problems. Self-collision can
escalate from coarse to exact because the CAD mesh is ground truth. Environment
collision cannot: the static world is a point cloud, which is already a sampling
of the real surface, so its proximity threshold *is* the model rather than
padding on top of one.

## Amendment: the service is stateless, and answers two questions

Added after the original decision. This settles the interface rather than the
tiering, and is recorded here because it is the same boundary — the service owns
the geometry, the checker owns everything else.

**The service holds no state about where anything is.** It answers exactly two
questions:

1. **Given an axis, what can it *ever* collide with?** Over every position of
   every axis the model permits, not at the current pose. Statically knowable
   from the geometry and the limit-switch positions.
2. **Given this set of axis moves, do they collide?** Full state supplied by
   the caller.

**The first answer is an axis-to-axis relation**, and it exists to bound the
second. To check a move of one axis, the checker gathers the positions of the
axes that can ever interact with it rather than the whole machine. It must never
omit a pair that can touch; extra pairs cost only state gathering, so an
over-approximation is acceptable and is expected to be trimmed by hand at first.

**Statelessness is what makes validation correct.** A service holding "current
pose" would answer about live PVs, and the validator has to ask about the
*projected end state* of a running task (ADR-0004). Statelessness also makes the
batch API a pure function of its request, so it is cacheable and testable
without a machine.

**Limit-switch positions belong to the service; soft limits do not.** The
relation is computed from limit switches, so they are part of the model and are
covered by the same version hash as the geometry. Soft limits are applied by the
checker at validation time and the service never learns them — which means
tightening one cannot silently invalidate a cached relation.

**The relation is computed after the exemption set**, so permanently-touching
pairs are absent from it. That makes it depend on an unsettled question, and on
a robot arm the exemption is not simply a property of a pair: a self-touching
pair *can* collide if the elbow rotates transversely and cable management is
attached to it. See [](../open-questions.md).
