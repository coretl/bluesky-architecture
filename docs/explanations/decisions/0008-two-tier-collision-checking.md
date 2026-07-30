# 8. Collision checking is two tiers, split by geometry type

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
