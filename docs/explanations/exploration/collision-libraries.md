# Collision libraries: survey and re-architecture

Research into what to build the anti-collision service out of, prompted by
three questions: is there a JavaScript capsule library we should use, should
the triangle-level check be a Python library, and what does the rest of the
industry do.

**The measurements themselves live in [](measurements.md)** — every table below
is quoted from there rather than repeated, so there is one place to correct if a
number changes. Conclusions that were later overturned are catalogued in
[](reversals.md), and everything specific to the DLS anti-collision service is
in [](../anti-collision-service.md). What this page keeps is the survey of what
exists *outside* DLS, and the re-architecture that follows from it.

All measurements are on the **real i16 geometry** from `garethnisbet/Robot`
(`i16_scene.glb`, 18 meshes, 233,034 triangles), in a container, single machine.
Directional, not final — the caveats at the end matter.

## Conclusions first

1. **Split the tiers by geometry type, not by language or process.** Spheres
   and capsules for every point of a trajectory; triangle meshes only for the
   points that tier flags. This is what every fast implementation does. Now
   ADR-0005.
2. **The coarse tier fits the batch budget in plain numpy** — 1.1–1.6 s for a
   15,000-point batch, single core, with a sound hierarchical broad phase. No
   GPU required to meet the deadline for the tier that runs on every point.
3. **The fine tier is flag-rate driven, not pair-count driven.** An earlier
   version of this document said it "does not fit in any language" on the basis
   of ~105 s per 15,000-point batch. That measured triangle checking on *every
   pair at every pose*, which is not the design and which nobody proposed. The
   cost is (flagged points) × (pairs per flag), and the binding unknown is the
   coarse tier's false-positive rate, not its speed.
4. **Use `coal`, but for its bounding volumes rather than its speed.** It is
   ~6× faster than tuned JavaScript on the dominant case — itself a correction;
   the first version of this document said 9× and was partly measuring
   three-mesh-bvh's default split strategy. The stronger argument is that
   `coal`'s `OBBRSS` nodes are *oriented* boxes and rectangle-swept-spheres,
   which rotate exactly, where three-mesh-bvh's axis-aligned nodes inflate. That
   attacks the binding term rather than the fast one.
5. **Nobody should be authoring a coarse model by hand.** Mech engineers export
   meshes and every CAD revision would need re-authoring, so the coarse model
   must be derived automatically. That rules out hand-built capsules and makes
   the mesh's own BVH nodes attractive: conservative by construction, no second
   artefact to version, and incapable of drifting out of sync. Now ADR-0006.
6. **The binding constraint is coarse-model fit quality, not speed.** Fitted
   spheres leave 63–173 mm of error on i16 meshes against 3.3 mm of motion
   padding at 200 Hz. Until something automatic gets that into single digits,
   tuning sample rates and checking methods is optimising the wrong term. Now
   Q1 in [](../open-questions.md).
7. **The velocity padding is unnecessary, but CCD is not why.** Measured, CCD is
   worth 2–3×, not the order of magnitude assumed. The real findings are that
   the executor at 5 kHz is already sound by 12–100×, and that the validator at
   10 Hz misses up to 32% of collisions. Raising the validator's rate fixes it
   without CCD.

## What the measurements established

The tables are in [](measurements.md). What they *mean*, which is this page's
job:

**Proving two meshes don't touch is the expensive case.** A real collision exits
at the first intersecting triangle; a near miss forces exhaustive descent of
both trees. A well-optimised scan consists almost entirely of near misses, so
the worst case is the normal case. Exact distance is 10× worse again, which
rules out "just compute clearance per point" as an alternative to a margin.

**The JS column was originally measured with three-mesh-bvh's default `CENTER`
split strategy.** Switching to `SAH` is a one-line change worth ~1.5× on the
dominant case, and it moves the language gap from 9.2× to 6.2×. The first
number in this document was partly measuring my own defaults. Both sides return
the same verdict on every one of the 153 pairs, and both are warmed up before
timing.

**The point-cloud environment check is the cheapest thing here**, which is not
what anyone expected. Cost is insensitive to cloud size — 20k and 200k points
measure the same — because a KD-tree query is logarithmic. 194 spheres × 15,000
poses is 2.9M queries in 0.16 s across 24 threads.

**The broad phase is sound, in a specific sense.** Each body gets a bounding
sphere that provably encloses all its leaf spheres, and a body pair is skipped
only when those bounding spheres are separated. No leaf pair is skipped for any
other reason. An earlier sketch skipped intra-group pairs, which was not sound;
this does not.

**Sphere count barely matters; sphere placement does.** K=4 and K=16 per mesh
flag 55.2 and 52.1 pairs per pose. Tightness comes from where the spheres are,
not how many, and a medial-axis sphere tree would beat the Lloyd-relaxed
clustering used here. The fine tier confirms the same collision count at both K,
which is the check that the coarse tier changes only the amount of work, not the
answer.

**Descending the BVH deeper is free, and saturates.** Cost is flat because the
descent prunes — extra nodes are visited only where boxes already overlap — so
depth 3–4 halves the false positives for nothing. That it then stops improving
says the limit is the *shape* of the bounding volume rather than the count:
three-mesh-bvh nodes are axis-aligned in the mesh's local frame, so a rotated
arm's world AABB is loose however finely the tree is subdivided. That is exactly
what `coal`'s `OBBRSS` nodes fix. Measuring an OBB-node descent is the strongest
remaining argument for coal over the JavaScript stack, and is Q4.

**Depth alone does not make exact checking viable at 200 Hz.** Sixteen near-miss
pairs per pose at coal's 250 µs is 4 ms/pose, and 720,000 intervals in an
hour-long scan is roughly an hour of compute. The coarse tier has to flag far
less than that.

**The false-positive rate is what decides the fine tier, and this model cannot
measure it.** The articulated i16 reports 8–12 exact triangle collisions per
pose even at the `demoPose` its config ships as valid — almost certainly
permanently-touching parts, mounting faces, the base against the first rotating
stage, which the config's link-level adjacency rules do not cover. With the
machine "in collision" at rest, any false-positive figure is meaningless, so the
85% measured is not reported as a finding. This is Q2, and it is a conversation
with whoever owns the CAD, not a computation.

It may not need answering. Q7 calls for a hard cap on fallback work, which
converts an unmeasured cost into a bounded one: if the coarse tier flags more
than N points in a batch, treat it as a collision and stop rather than trying to
clear them all. **The design should not depend on the false-positive rate being
small — it should stay correct when it is not.**

## What the industry does

**NVIDIA cuRobo** approximates the robot as a set of spheres attached to links
and queries them against the world as meshes, cuboids, nvblox maps or ESDF
voxel grids. Collision checkers take spheres shaped `[batch, horizon, n, 4]`,
where `horizon` is the trajectory of a sphere — the batch API we have been
sketching, already designed. It ships mesh-to-sphere approximation tooling and
reports ~30 ms end-to-end on an RTX 4090, ~60× faster than CPU planners.
The relevant point is not the speed: **the fastest GPU collision checker in
robotics represents the robot as spheres, not triangles.**

**Collision-Affording Point Trees** (Kavraki Lab, RSS 2024) is a SIMD-amenable
structure for sphere-vs-point-cloud queries reporting <10 ns per query on
scenes of thousands of points, plus a space-filling-curve filter that decimates
clouds while preserving structure. Our static environment is a point cloud, so
this is directly applicable and roughly 100× better than the scipy KD-tree
measured above. A Rust implementation exists.

**MoveIt** began on FCL and added Bullet specifically because FCL lacked
continuous collision detection. **Tesseract** (ROS-Industrial) uses Bullet for
both discrete and continuous checking of convex-convex and convex-concave
shapes. **Drake** uses FCL. **Pinocchio** and the Humanoid Path Planner use
`coal`, an FCL fork with dedicated GJK/EPA implementations, support for safety
margins, and a Nesterov-accelerated variant reporting up to 2× over FCL.

The pattern across all of them: primitives (spheres, capsules, convex hulls)
for anything on a hot path, and meshes reserved for final verification. They
also favour continuous over discrete checking — but note that those libraries
are built for planners searching sparse configuration space, where samples are
far apart. We are handed a dense trajectory at 5 kHz, which is a different
regime, and it changes the answer.

## Answering the three questions

### Is there a JS library we should use for capsules?

Rapier (Rust compiled to WASM, with maintained JS bindings) has capsule
colliders and shape casting, and is the strongest option if capsules must live
in JavaScript. Jolt and Ammo.js (Bullet) are alternatives.

**But the recommendation is not to do this.** The coarse tier is the one that
runs on every point of every trajectory, in a service the executor depends on
to keep motors moving. Putting it in a browser runtime adds a WASM boundary, a
JS event loop and a deployment story, to reach a tier that plain numpy already
runs inside the budget. The measurements do not justify it.

### Should the triangles be a Python library?

Yes, but by less than first reported. `coal` (`pip install coal`, 3.0.3 on
PyPI) is ~6× faster than *tuned* three-mesh-bvh on near misses and ~14× on
intersections, and it is the same library Pinocchio uses. `python-fcl` is the
older binding and measures the same within noise.

Six times is worth having but it is not the difference between viable and not,
and it should be weighed against the convention risk of maintaining a second
implementation. See the note on geometry agreement below.

Two features make it a better fit than raw speed suggests:

**`security_margin` is a request-time parameter, not baked into geometry.**
This answers the padding question directly — insertion-time validation and
runtime checking use *one* geometry model with two margins, rather than two
models that can drift apart. It also removes the need for the strawman's
`assert_conservative` in its current form: conservatism becomes a property of a
parameter, not of a separately-maintained model.

**`enable_distance_lower_bound` and `break_distance`** give a clearance bound
with early exit, much cheaper than the 2.6 ms exact distance query while still
answering "how close did it get".

One caveat against it: **`coal` has dropped continuous collision detection.**
`python-fcl` still exposes `continuousCollide`, `CCDMotionType` and
`CCDSolverType`; `coal` exposes none of them. That does not matter much for the
coarse tier, where swept checking is a segment-segment distance we can write in
six lines of numpy, but it would matter if the fine tier ever needed swept mesh
checks.

Note that `curobo` on PyPI (version 0.2, "A simple python package") is **not**
NVIDIA's cuRobo, which installs from source. Worth knowing before someone pip
installs it.

### Do the two worlds actually agree?

The reason for considering headless JavaScript in the first place was
convention drift — euler angle order, units, axis handedness — between the
three.js scene and anything reimplementing it in Python. If the two disagree
about where a body is, a faster checker is worse than useless.

Measured directly: load `i16_scene.glb` in three.js and in trimesh, compute each
mesh's world AABB, and compare. **They agree to 1.55e-15 m across all 18
meshes** — floating point noise.

That is expected once you look at why: glTF stores node transforms as matrices
or explicit TRS with rotation as a quaternion, so there is no euler convention
to get wrong. Both loaders reproduce the same scene graph.

Two practical wrinkles, neither affecting placement:

- **Node naming differs.** three.js sanitises (`detector carriage` becomes
  `detector_carriage`) and exposes mesh names; trimesh uses node names with
  hash suffixes (`base_10b53f`). The name sets do not intersect for 11 of 18
  meshes. Any cross-implementation check must match on geometry, not on names —
  matching by name silently pairs the wrong bodies, which is how this comparison
  first appeared to show a 1.77 m disagreement.
- The convention risk is real but it lives in the **hand-written WebSocket API**
  (degrees, millimetres, Z-up, orientation relative to a home of `[0, 90, 0]`)
  and in the joint definitions in `*_config.json`, not in the GLB.

So consuming the GLB directly carries no convention risk, and that argument for
headless JavaScript does not survive contact with the measurement. The argument
that does survive is having one implementation rather than two — which is about
maintenance, not correctness.

### A discarded experiment

To separate "JavaScript is slower" from "three-mesh-bvh's `intersectsGeometry`
is a weaker algorithm" — it restarts a traversal from the root of B's tree at
every leaf of A, rather than descending both trees together — I decimated the
meshes to 500/2000/8000/20000 triangles and timed both sides on byte-identical
geometry. That experiment said JavaScript was *faster* than FCL above 1000
triangles, contradicting the full-scene result.

It is discarded. Taking every k-th face scatters triangles across the original
surface and destroys spatial coherence, and the two libraries degrade
differently under that: FCL fits oriented boxes, three-mesh-bvh axis-aligned
ones. The measurement was of the decimation, not of the libraries. The
real-geometry numbers are the ones to use.

The algorithmic question is therefore still open. It matters, because if the
gap is `intersectsGeometry` rather than the language, it is fixable in place.

## The padding is unnecessary, but not because of CCD

The design this replaced padded the coarse model for *typical* joint velocity
over 0.1 s, knowingly accepting that a fast segment could slip between samples
and be caught later by the fine check — a deliberate trade of soundness for
usability, defensible only under the ADR-0002 classification.

I expected continuous collision detection to remove the trade, and predicted it
would let the validator stay at 10 Hz. **Measured, that prediction is wrong in
its reasoning and right in its conclusion.**

A sphere swept along a straight line is exactly a capsule, so swept checking is
segment-segment distance and needs no library; under linear interpolation the
relative displacement is also linear, so the exact test is point-to-segment on
the relative motion. Rates and costs are tabulated in
[](measurements.md). On rate × per-point cost, **CCD wins by
2× at diffractometer speeds and 3× at robot speeds** — real, but nothing like
the order of magnitude assumed. It does not on its own justify rebuilding the
coarse tier around swept volumes.

The useful findings are the other two:

**The executor is already sound and the padding there is redundant.** Discrete
checking needs 50 Hz at diffractometer speeds and 400 Hz at robot speeds. The
executor samples at 5 kHz — 12× to 100× more than soundness requires. Whatever
the padding is protecting against at 5 kHz, it is not the sampling gap.

**The validator at 10 Hz is where the problem actually is.** Discrete checking
at 10 Hz missed 9 of 850 real collisions at diffractometer speeds and 538 of
1689 — 32% — at robot speeds. That is what the velocity padding is compensating
for, and it is compensating for a lot.

The fix does not require CCD. Sampling the validator at 50–400 Hz instead of
10 Hz is sound by measurement, and validation is offline and non-blocking, so
5–40× more points is affordable. Either way the velocity-guess padding
disappears and a tick can mean "will run" rather than "probably" — which was the
predicted conclusion, reached by a different route.

### Sound padding, and the bound that is actually rigorous

A sphere on a rotating link sweeps an arc, so the exact swept volume is a torus
segment. Bounding the arc by its chord plus a radius inflation turns it back
into a capsule and the test into segment-segment distance. Rates and inflations
are in [](measurements.md).

**The obvious inflation is wrong.** The single-arc sagitta,
`Σⱼ dⱼ(1 − cos(Δθⱼ/2))` over ancestor joints, is *not* conservative for a chain:
rotating an upstream joint also moves the downstream axes, so individual arc
deviations do not compose additively. Measured, it is violated by up to 3.9 mm
on i16. The check caught this before it was written down.

What is rigorous is the path-length bound. A point `q` on a path of length `L`
from `p₀` to `p₁` satisfies `|q−p₀| + |q−p₁| ≤ L`, so its distance to the chord
is at most `L/2`. With `L = Σⱼ dⱼ|Δθⱼ|` that gives an inflation which held at
every rate tested, worst-case overshoot −0.0074 mm.

Two things follow.

**The current scheme is under-padded, not over-padded.** At 10 Hz the sound
inflation reaches 263 mm. Padding ~50 mm for typical velocity is roughly 5×
short in the worst case, which is the concrete content of "the tick means it
will probably run".

**Sample rate is the lever, not the checking method.** Inflation scales as
1/rate and cost as rate, so the product is fixed and the only choice is where on
that line to sit. 200 Hz gives 3.3 mm mean inflation for 32 s per 1-hour scan —
sound, tight enough not to reject real scans, and trivially affordable because
validation is offline. Feasibility in JavaScript is not in question: 32–45 µs
per interval in plain three.js with no BVH involved.

### The arc correction, when the chord is used anyway

Both CCD variants assume the sphere travels in a straight line between samples.
Unlike a velocity guess, the error is **computable**, and it shrinks
quadratically with rate:

| sample rate | ω = 1 rad/s | ω = 8 rad/s | the velocity padding it replaces |
|---|---|---|---|
| 10 Hz | 625 µm | 39469 µm | 50 mm |
| 200 Hz | 1.6 µm | 100 µm | 50 mm |
| 5000 Hz | 0.0 µm | 0.2 µm | 50 mm |

At any rate above ~200 Hz the exact arc correction is micrometres against a
50 mm guess. The padding term should be this expression, evaluated per segment
from the actual commanded velocity, not a constant. At ω = 8 rad/s and 10 Hz the
sagitta is 39 mm, which dwarfs the geometry — which is why swept checking still
missed 26 intervals in that regime.

### The number this all hinges on

The answer swings by 8× between the two velocity regimes, and **nobody has told
us what DLS diffractometer axes actually do**. Maximum and typical angular
velocity per axis, per beamline: an afternoon for whoever owns the motion
controllers, and it decides the validator's sample rate. This is Q3.

## Ray casting as the fine pass

Gareth describes the intended design as capsules first, ray casting second.
Capsules first is right and agrees with everything above. Ray casting second
needs care, because its error direction is the opposite of the one the two-tier
scheme assumes.

Note first what is committed today: the collision path calls
`intersectsGeometry` (triangle-triangle BVH) and `closestPointToPoint` (point
cloud). The string "capsule" does not appear in any JavaScript file — capsules
exist only in `planner.py`. The only raycasting is VR controller pointing and
click-to-select. So this is a description of intent, not of the current code.

**Ray casting samples.** It finds what a ray happens to hit, and a feature
between two rays is invisible to it. Measured on the i16 geometry
(`benchmarks/bench_raycast.mjs`, 8.3 µs/ray against the largest mesh, objects
reused and the BVH called directly):

| rays/pose | time/pose | angular spacing | feature it can miss at 1 m |
|---|---|---|---|
| 256 | 2.1 ms | 7.17° | 252 mm |
| 1024 | 8.5 ms | 3.58° | 125 mm |
| 4096 | 34 ms | 1.79° | 63 mm |
| 16384 | 137 ms | 0.90° | 31 mm |

**At any affordable ray density the missable feature is larger than the
clearances this system exists to enforce.** "The detector must stay 20 mm from
the sample" is one of the motivating constraints in ADR-0002; 16,384 rays per
pose costs 137 ms and can still miss 31 mm.

This matters because of what the fine tier is *for*. The coarse tier
over-approximates and flags; the fine tier clears the ones flagged only because
of padding. The fine tier therefore gets the last word, and a technique with
false negatives will confidently clear real collisions. Triangle-triangle
intersection is exact, so "fine says clear" is trustworthy. Ray casting is a
sampling estimate, so it is not — unless the ray spacing is bounded against the
smallest feature in the model, which is a geometry-dependent argument that has
to be made explicitly rather than assumed.

There is a sound use for rays here: casting *along the direction of motion* to
find time-of-impact is a legitimate CCD formulation, and is what the literature
below does. That is a different thing from spraying rays at a mesh to test
overlap.

### The first coherent GPU argument

If the fine pass is ray casting, then RTX ray-tracing cores are purpose-built
silicon for exactly that operation — and this is the first GPU justification
for this project that holds together. [Hardware-Accelerated Ray Tracing for
Discrete and Continuous Collision Detection on GPUs](https://arxiv.org/abs/2409.09918)
(ICRA 2025) reports up to 3× over state-of-the-art GPU sphere-based methods for
batched discrete-pose queries, and up to 9× for continuous, at 24k robot
triangles against 190k obstacle triangles — almost exactly i16's scale.

Two things worth noting from it. Its continuous variant uses a **sphere** robot
representation against obstacle meshes, so spheres-on-the-hot-path survives even
in the ray-traced design. And its discrete variant is *exact* mesh-to-mesh, not
a sampled overlap test, which is the distinction drawn above.

If Gareth is heading here, the GPU instinct is right — it was just explained by
scene assembly earlier, which is not where the parallelism is.

## Proposed re-architecture

Gareth's project grew anti-collision out of a visualiser, and the two roles
should be separated rather than merged:

**Keep as the viewer and model-authoring tool.** The three.js application is
good at what it was built for, and the `*_config.json` + `*_scene.glb`
pair is a portable scene description that a checker and a viewer can both
consume. That format is the interface between the two halves, and it already
exists.

**Build the checking engine headless, in Python over `coal`.** Same configs,
same GLB. Three tiers by geometry type:

| tier | geometry | when | measured |
|---|---|---|---|
| self-collision | spheres/capsules per link | every point | 1.1–1.6 s / 15k |
| environment | spheres vs point cloud (KD-tree, later CAPT) | every point | 0.16 s / 15k |
| verification | triangle meshes, `coal` | flagged points only | 250 µs/pair |

**Keep the capsule model from `planner.py`, drop the RRT planner around it.**
The geometry model is the right one and is the only component in the prototype
that can keep up with a batch. The planner solves a problem we do not have.

**Revisit GPU only if the coarse tier stops fitting.** On these numbers it fits
with room to spare, single core. The GPU case would be a real one if the fine
tier had to run per-point — but the architecture exists precisely so that it
doesn't.

## Caveats

The sphere decomposition is crude — voxel centres with a radius covering the
voxel diagonal, capped at 12 per body — not a medial-axis sphere tree. Sphere
*count* drives query cost, so the timings are representative, but a production
decomposition would be tighter for the same count.

Poses are synthetic offsets, not real forward kinematics, and I could not
reproduce the prototype's kinematic-adjacency exemptions or resolve all config
joint names to GLB nodes (i16 3/10, i19 0/4). Whole-scene throughput numbers
therefore over-count collisions; the per-pair regime costs do not depend on
that, which is why they are the ones quoted.

Container timings, single machine, no GPU available to test cuRobo or CAPT
claims directly. The standing warning applies: re-measure on real geometry
before sizing anything.

## Sources

- [coal — an extension of the Flexible Collision Library](https://github.com/coal-library/coal)
- [cuRobo: CUDA Accelerated Robot Library](https://curobo.org/)
- [cuRobo collision world representation](https://curobo.org/get_started/2c_world_collision.html)
- [cuRobo: Parallelized Collision-Free Minimum-Jerk Robot Motion Generation](https://curobo.org/reports/curobo_report.pdf)
- [Collision-Affording Point Trees: SIMD-Amenable Nearest Neighbors for Fast Collision Checking](https://arxiv.org/abs/2406.02807)
- [captree-rs — Rust implementation of the CAPT](https://github.com/KavrakiLab/captree-rs)
- [Integrating Bullet for Collision Detection — MoveIt](https://moveit.ai/bullet/collision%20detection/moveit/2020/11/18/bullet-collision.html)
- [Tesseract — Motion Planning Environment](https://github.com/tesseract-robotics/tesseract)
- [robot_collision_checking: A Lightweight ROS 2 Interface to FCL](https://joss.theoj.org/papers/10.21105/joss.07473)
- [C2A: Controlled conservative advancement for continuous collision detection](https://graphics.ewha.ac.kr/projects/details/C2A/C2A.pdf)
- [MorphIt: Flexible Spherical Approximation of Robot Morphology](https://arxiv.org/pdf/2507.14061)
- [Rapier physics engine — Collider API](https://rapier.rs/javascript3d/classes/Collider.html)
