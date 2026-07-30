# Where we are

Orientation. The other two documents are long; this is the current bottom line
and what it rests on.

- [](handover.md) — the original seed document, ~800 lines. Kept for its
  reasoning. Twelve of its conclusions have since been reversed; the reversals
  are marked inline and catalogued at the end.
- [](collision-libraries.md) — everything measured since, on real beamline
  geometry, with scripts in `benchmarks/`.

## The shape that has survived

**Two problems, not one.** Self-collision is robot mesh against robot mesh.
Environment collision is robot against a static point cloud. They share a coarse
tier and differ after it: self-collision can escalate to exact triangles,
environment collision has nothing to escalate to, because a point cloud is
already a sampling of the real surface.

**Two tiers, split by geometry type, not by language or process.** A cheap
conservative model on every trajectory point, exact triangles only on the pairs
it flags. Every fast implementation in the field does this — cuRobo, CAPT,
MoveIt, Tesseract. Nobody does triangle-triangle at trajectory rate.

**The coarse tier must name the pair**, not return a boolean per point.
Otherwise the fine tier cannot be restricted and the tiering buys nothing.

**Kinematics is not a constraint anywhere.** The branch-fixed inverse is
closed-form at 0.1 µs/point. That result stands unchanged from the strawman.

## The bottom line, and what it turns on

The binding constraint is **how tightly the coarse model can approximate the
meshes, using something built automatically**. Not kinematics, not body count,
not the sample rate, not the language.

Hand-authored capsule models are ruled out on cost: mech engineers export
meshes, and every CAD revision would need re-authoring. So the coarse model has
to be derived from the mesh, and the measured options are not yet good enough:

| | measured on i16 |
|---|---|
| fitted spheres, 144–1152 of them | 63–173 mm mean error |
| motion padding at 200 Hz | 3.3 mm |
| BVH nodes, depth 3–4 | rejects 80–82%, saturates |

The sphere fit is 20–50× the motion padding, so tightening the sample rate is
optimising the wrong term. The BVH-depth approach costs nothing extra and halves
the false positives, but saturates — which points at the *shape* of the volume,
not the count.

## What would move it

1. **The exemption set** (O17). The articulated i16 reports 8–12 exact
   collisions per pose *at the demoPose its own config calls valid* —
   permanently touching parts the adjacency rules do not cover. Until that is
   fixed, no false-positive rate measured on this model means anything, and
   several results are held back by it. Not a computation; a conversation.
2. **Joint velocities** (O16). Every padding and rate figure scales linearly
   with it, and the two regimes tested differ by 8×.
3. **One automatic coarse model, properly** (O18/O19). One detector arm, a
   medial-axis sphere tree and `coal`'s OBB/RSS BVH nodes, same error metric on
   both. Half a day, and it decides the architecture.

## Things that are settled

- Body counts are small — i16 is 18 meshes and 10 movable joints (O12).
- A sound hierarchical broad phase exists and is measured (O13).
- Collision scope is declared by the anti-collision service; only the mapping to
  dodal devices is open (O9).
- Checking runs ahead of motion, so lookahead equals batch duration (O7).
- The collision service runs headless — no WebGL, no DOM, proven on real
  geometry.
- glTF carries no Euler convention, so three.js and trimesh place all 18 i16
  meshes identically to 1.55e-15 m. The convention risk is in the WebSocket API
  and the joint configs, not the geometry.

## Things to be careful of

The velocity padding is **under**-padded, not over-padded — 263 mm needed at
10 Hz against ~50 mm applied. D18 and D21 have to be rewritten as a pair.

Validation state is owned by the queue, so the queue and validation questions
are *not* orthogonal, and this is the strongest argument for superseding blueapi
ADR-0003.

Every number in these documents should have a script behind it or be labelled an
estimate. The one figure that was sized against without an artefact (M5) turned
out to be both unreproducible and wrong in premise.
