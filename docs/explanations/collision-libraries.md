# Collision checking: library survey and re-architecture

Research into what to build the anti-collision service out of, prompted by
three questions: is there a JavaScript capsule library we should use, should
the triangle-level check be a Python library, and what does the rest of the
industry do.

All measurements below are on the **real i16 geometry** from
`garethnisbet/Robot` (`i16_scene.glb`, 18 meshes, 233,034 triangles), in a
container, single machine. Directional, not final — the caveats at the end are
load-bearing.

## Conclusions first

1. **Split the tiers by geometry type, not by language or process.** Spheres
   and capsules for every point of a trajectory; triangle meshes only for the
   points that tier flags. This is what every fast implementation does.
2. **The coarse tier fits the batch budget in plain numpy** — 1.1-1.6 s for a
   15,000-point batch, single core, with a sound hierarchical broad phase. No
   GPU required to meet the deadline for the tier that runs on every point.
3. **The fine tier is flag-rate driven, not pair-count driven.** An earlier
   version of this document said it "does not fit in any language" on the basis
   of ~100 s per 15,000-point batch. That measured triangle checking on *every
   pair at every pose*, which is not the design and which nobody proposed. In
   the design the coarse tier names the implicated pair and the fine tier runs
   only on that. The cost is (flagged points) x (pairs per flag), and the
   binding unknown is the coarse tier's false-positive rate, not its speed.
4. **Use `coal` for both tiers.** It has capsules and meshes, it is ~6× faster
   than tuned JavaScript on the case that dominates, and it carries the two
   features that fix outstanding design problems (below). Note that 6× is a
   correction: the first version of this document said 9×, which was measuring
   three-mesh-bvh's default BVH split strategy rather than the language.
5. **Don't write capsules in JavaScript.** The coarse tier should not be in
   the browser at all.
6. **The velocity padding is unnecessary, but CCD is not why.** Measured, CCD
   is worth 2-3x, not the order of magnitude assumed. The real findings are
   that the executor at 5 kHz is already sound by 12-100x, and that the
   validator at 10 Hz misses up to 32% of collisions. Raising the validator's
   rate fixes it without CCD. D18's compromise goes away either way.

## Measurements

### Per-pair cost, by regime

Both implementations classify the i16 scene identically — 110 AABB-disjoint
pairs, 28 with overlapping AABBs but no intersection, 15 intersecting — which
is a useful cross-check that they are doing the same work.

| regime | JS, default (CENTER) | JS, tuned (SAH) | coal/FCL | ratio tuned:FCL |
|---|---|---|---|---|
| AABB reject, disjoint | 0.5 µs | 0.3 µs | 0.2 µs | 1.5× |
| BVH descent, **no** intersection | 2302 µs | ~1550 µs | 250 µs | **6.2×** |
| BVH descent, intersecting | 965 µs | ~735 µs | 51 µs | 14× |
| exact distance | — | — | 2593 µs | — |
| `scene.updateMatrixWorld()` per pose | 2.5 µs | 1.8 µs | — | — |

**The JS column was originally measured with three-mesh-bvh's default `CENTER`
split strategy.** Switching to `SAH` is a one-line change worth ~1.5× on the
dominant case, and it moves the language gap from 9.2× to 6.2×. The first
number in this document was partly measuring my own defaults. Both sides return
the same verdict on every pair, and both are warmed up before timing.

The counterintuitive result is that **proving two meshes don't touch is the
expensive case**. A real collision exits at the first intersecting triangle; a
near miss forces exhaustive descent of both trees. A well-optimised scan
consists almost entirely of near misses, so the worst case is the normal case.

Exact distance is 10× worse again, which rules out "just compute clearance per
point" as an alternative to a margin.

### Batch of 15,000 poses (a few seconds at 5 kHz)

| approach | time | verdict |
|---|---|---|
| ~~triangle meshes on every pair, every pose~~ | ~~105 s~~ | **measures the wrong architecture — see below** |
| spheres, naive all-pairs (17,721 pairs) | 9.3 s | ✗ memory-bound, 2 GB intermediates |
| **spheres, sound hierarchical broad phase** | **1.1-1.6 s** | ✓ |
| **spheres vs 200,000-point cloud, KD-tree** | **0.16 s** | ✓ |

The point-cloud environment check — the part that sounded hardest — is the
cheapest thing here. Cost is insensitive to cloud size (20k and 200k points
measure the same) because a KD-tree query is logarithmic. 194 spheres × 15,000
poses is 2.9M queries in 0.16 s across 24 threads.

The sound broad phase is the difference between 9.3 s and ~1.3 s. It is sound in
the sense O13 asked for: each body gets a bounding sphere that provably
encloses all its leaf spheres, and a body pair is skipped only when those
bounding spheres are separated. No leaf pair is skipped for any other reason.
The unsound sketch in the handover skipped intra-group pairs; this does not.

### The two tiers, measured together

`benchmarks/bench_twotier.mjs` builds a properly articulated i16 — joint chain
from `restPos`/`restQuat`/`parent`, link meshes reparented onto rot groups,
statics kept as world obstacles, the viewer's `buildAdjacencyPairs` exemption
reproduced — fits conservative spheres to each mesh, and runs the fine BVH only
on pairs the sphere tier flags.

**The coarse tier is very cheap.** 67–198 spheres over 136 pairs costs
**7–24 µs per pose**, so a 15,000-point batch is **0.1–0.4 s**. That is the
robust result here and it comfortably fits the budget.

**The false-positive rate is what decides the fine tier, and this model cannot
measure it.** The articulated i16 reports 8–12 exact triangle collisions per
pose even at the `demoPose` the config ships as a valid configuration. Those
are almost certainly permanently-touching parts — mounting faces, the base
against the first rotating stage — that the production system must exempt and
that the config's link-level adjacency rules do not cover. With the machine
"in collision" at rest, any false-positive figure is meaningless, so the 85%
measured is not reported as a finding.

Two consequences:

- Getting a trustworthy fine-tier cost needs either a real scan trajectory or
  the complete exemption set, ideally both. This is a question for whoever owns
  the model, not something to derive from the GLB.
- **It may not need answering.** O6 already calls for a hard cap on fallback
  work. A cap converts an unmeasured cost into a bounded one: if the coarse
  tier flags more than N points in a batch, treat it as a collision and stop
  rather than trying to clear them all. The design should not depend on the
  false-positive rate being small — it should stay correct when it isn't.

The sphere count barely matters over the range tested — K=4 and K=16 per mesh
flag 55.2 and 52.1 pairs per pose respectively. Tightness comes from where the
spheres are, not how many, and a medial-axis sphere tree would do better than
the Lloyd-relaxed clustering used here. Note the fine tier confirms exactly the
same collision count at both K, which is the consistency check that the coarse
tier is not changing the answer, only the amount of work.

### Rejection rate vs BVH depth

If hand-authored capsule models are unaffordable — mech engineers export
meshes, and every CAD revision would need re-authoring — the coarse tier has to
be derived automatically. A mesh's BVH already is a fitted hierarchy of
bounding volumes: built automatically, conservative by construction, and
incapable of drifting out of sync because it *is* the mesh's structure.

So the coarse tier becomes a depth knob on the existing BVH: descend both trees
together, and flag the pair if the boxes still overlap at the limit. Depth 0 is
exactly what the prototype does today. `benchmarks/bench_bvhdepth.mjs`,
articulated i16, 136 pairs after exemption:

| depth | nodes/mesh | rejected | flagged/pose | ms/pose |
|---|---|---|---|---|
| 0 | 1 | 71.3% | 39.1 | ~0.12 |
| 1 | 3 | 76.5% | 32.0 | 0.115 |
| 2 | 7 | 78.2% | 29.7 | 0.112 |
| 3 | 15 | 80.2% | 27.0 | 0.127 |
| 4 | 28 | 81.1% | 25.7 | ~0.12 |
| 6 | 94 | 82.2% | 24.2 | ~0.12 |

**Cost is flat with depth.** Descending deeper is free, because the descent
prunes as it goes — the extra nodes are only visited where boxes already
overlap. Depth 3-4 is the knee.

Against 8.01 genuinely-colliding pairs per pose in this model, false positives
fall from 31.1 to 16.2 — **halved, for nothing**. That is worth taking, and it
is a small change to code that already exists rather than a new subsystem.

But it does not on its own make exact checking viable at 200 Hz. Sixteen
near-miss pairs per pose at coal's 250 us is 4 ms/pose, and 720,000 intervals
in an hour-long scan is roughly an hour of compute. The coarse tier has to flag
far less than that.

**The saturation is the interesting part.** Rejection stops improving after
depth 3-4, which says the limit is the *shape* of the bounding volume rather
than how many of them there are. `three-mesh-bvh` nodes are axis-aligned in the
mesh's local frame, so a rotated arm's world AABB is loose no matter how finely
the tree is subdivided. That is precisely what `coal`'s `OBBRSS` nodes fix:
oriented boxes and rectangle-swept-spheres rotate exactly instead of inflating.
Measuring an OBB-node descent is the obvious next step, and it is the strongest
remaining argument for coal over the JavaScript stack.

Caveat: the 8.01 collisions per pose are the permanently-touching parts this
model has at its own demoPose, so absolute false-positive rates here remain
untrustworthy. The *relative* improvement with depth, and the flat cost, do not
depend on that.

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
regime, and the measurements below show it changes the answer.

## Answering the three questions

### Is there a JS library we should use for capsules?

Rapier (Rust compiled to WASM, with maintained JS bindings) has capsule
colliders and shape casting, and is the strongest option if capsules must live
in JavaScript. Jolt and Ammo.js (Bullet) are alternatives.

**But the recommendation is not to do this.** The coarse tier is the one that
runs on every point of every trajectory, in a service the executor depends on
to keep motors moving. Putting it in a browser runtime adds a WASM boundary, a
JS event loop and a deployment story, to reach a tier that plain numpy already
runs inside the budget. The measurements above do not justify it.

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
with early exit, which is much cheaper than the 2.6 ms exact distance query
while still answering "how close did it get".

One caveat against it: **`coal` has dropped continuous collision detection.**
`python-fcl` still exposes `continuousCollide`, `CCDMotionType` and
`CCDSolverType`; `coal` exposes none of them. On the measurements below that
does not matter much for the coarse tier, where swept checking is a
segment-segment distance we can write in six lines of numpy, but it would
matter if the fine tier ever needed swept mesh checks.

Note that `curobo` on PyPI (version 0.2, "A simple python package") is **not**
NVIDIA's cuRobo, which installs from source. Worth knowing before someone pip
installs it.

### Do the two worlds actually agree?

The reason for considering headless JavaScript in the first place was
convention drift — euler angle order, units, axis handedness — between the
three.js scene and anything reimplementing it in Python. If the two disagree
about where a body is, a faster checker is worse than useless.

Measured directly: load `i16_scene.glb` in three.js and in trimesh, compute
each mesh's world AABB, and compare.

**They agree to 1.55e-15 m — floating point noise, across all 18 meshes.**

That is expected once you look at why: glTF stores node transforms as matrices
or explicit TRS with a fixed specification, so there is no euler convention to
get wrong. Both loaders reproduce the same scene graph.

Two practical wrinkles, neither affecting placement:

- **Node naming differs.** three.js sanitises (`detector carriage` becomes
  `detector_carriage`) and exposes mesh names; trimesh uses node names with
  hash suffixes for uniqueness (`base_10b53f`). The name sets do not intersect
  for 11 of 18 meshes. Any cross-implementation check must match on geometry,
  not on names — matching by name silently pairs the wrong bodies, which is how
  this comparison first appeared to show a 1.77 m disagreement.
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
real-geometry numbers in the table above are the ones to use.

The algorithmic question is therefore still open. It matters, because if the
gap is `intersectsGeometry` rather than the language, it is fixable in place.

### What is the rest of the industry using?

Covered above. In short: FCL/coal and Bullet on CPU, cuRobo on GPU, spheres for
the hot path, and continuous rather than discrete checking.

## D18 revisited: the padding is unnecessary, but not because of CCD

The current plan pads the coarse model for *typical* joint velocity over 0.1 s,
knowingly accepting that a fast segment can slip between samples and be caught
later by the fine check. That is a deliberate trade of soundness for usability,
defensible only because D21 says this is soft machine protection.

I expected continuous collision detection to remove the trade, and predicted it
would let the validator stay at 10 Hz. **Measured, that prediction is wrong in
its reasoning and right in its conclusion.** `benchmarks/bench_ccd.py`.

Three methods on sphere-approximated bodies, against dense-sampled ground
truth. A sphere swept along a straight line is exactly a capsule, so swept
checking is segment-segment distance and needs no library; under linear
interpolation the relative displacement is also linear, so the exact test is
point-to-segment on the relative motion.

**Lowest sample rate at which each method missed nothing**, over 20,000 random
intervals:

| | discrete | swept | relative |
|---|---|---|---|
| diffractometer speeds (\|ω\| ≤ 1.6 rad/s) | 50 Hz | ≤10 Hz | ≤10 Hz |
| robot-arm speeds (\|ω\| ≤ 8 rad/s) | 400 Hz | 25 Hz | 100 Hz |

Cost per point, relative to discrete: relative CCD 2.5×, swept CCD 5.1×. So the
comparison that matters is rate × per-point cost, each method at a rate where it
is actually sound:

| | discrete | relative | swept |
|---|---|---|---|
| diffractometer speeds | 0.011 s/s | **0.006 s/s** | 0.012 s/s |
| robot-arm speeds | 0.090 s/s | 0.056 s/s | **0.029 s/s** |

**CCD wins by 2× at diffractometer speeds and 3× at robot speeds.** Real, but
nothing like the order of magnitude I assumed when I recommended benchmarking
it. It does not on its own justify rebuilding the coarse tier around swept
volumes.

The genuinely useful findings are the other two:

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
5–40× more points is affordable. Relative CCD at 10 Hz is roughly half the cost
again if that turns out to matter.

Either way the velocity-guess padding disappears, D18 and D21 stop being in
tension, and a tick can mean "will run" rather than "probably" — which was the
conclusion, reached by a different route than predicted.

### Sound padding for the validator, measured

`benchmarks/bench_validator.mjs` builds the articulated i16, fits spheres, and
tests swept capsules against densely-sampled ground truth at several rates.

A sphere on a rotating link sweeps an arc, so the exact swept volume is a torus
segment. Bounding the arc by its chord plus a radius inflation turns it back
into a capsule and the test into segment-segment distance.

**The obvious inflation is wrong.** The single-arc sagitta,
`d_j (1 - cos(dtheta_j/2))` summed over ancestor joints, is *not* conservative
for a chain: rotating an upstream joint also moves the downstream axes, so
individual arc deviations do not compose additively. Measured, it is violated
by up to 3.9 mm on i16. The check caught this before it was written down.

What is rigorous is the path-length bound. A point `q` on a path of length `L`
from `p0` to `p1` satisfies `|q-p0| + |q-p1| <= L`, so its distance to the chord
is at most `min(|q-p0|, |q-p1|) <= L/2`. With `L = sum_j d_j |dtheta_j|` that
gives an inflation that holds at every rate tested, worst-case overshoot
-0.0074 mm — tight, never violated.

| validator rate | inflation (mean) | (max) | 1-hour scan | bound |
|---|---|---|---|---|
| 10 Hz | 66 mm | **263 mm** | 1.6 s | holds |
| 50 Hz | 13 mm | 53 mm | 5.7 s | holds |
| 200 Hz | 3.3 mm | 13 mm | 32 s | holds |
| 1000 Hz | 0.66 mm | 2.6 mm | 117 s | holds |

Two things follow.

**The current scheme is under-padded, not over-padded.** At 10 Hz the sound
inflation reaches 263 mm. Padding ~50 mm for typical velocity is roughly 5x
short in the worst case, which is the concrete content of "the tick means it
will probably run".

**Sample rate is the lever, not the checking method.** Inflation scales as
1/rate and cost scales as rate, so the product is fixed and the choice is where
on that line to sit. 200 Hz gives 3.3 mm mean inflation for 32 s per 1-hour
scan — sound, tight enough not to reject real scans, and trivially affordable
because validation is offline. Swept checking costs about 2x discrete
(32-45 us/interval), which is noise at these totals.

Feasibility in JavaScript is not in question: the whole thing is 32-45 us per
interval in plain three.js with no BVH involved.

Caveat: this assumes |omega| <= 1.6 rad/s. Inflation scales linearly with joint
speed, so at robot-arm speeds every figure above is ~5x worse. The real
per-axis velocities remain unmeasured.

### The arc correction

Both CCD variants assume the sphere travels in a straight line between samples.
Joints rotate, so it travels on an arc, and the chord misses the arc by the
sagitta, `r(1 - cos(θ/2))` for `θ = ω/R`. This is why swept checking still
missed 26 intervals at 10 Hz and robot speeds — at ω = 8 rad/s the sagitta is
39 mm, which dwarfs the geometry.

Unlike a velocity guess this is **computable**, and it shrinks quadratically:

| sample rate | ω = 1 rad/s | ω = 8 rad/s | current velocity padding |
|---|---|---|---|
| 10 Hz | 625 µm | 39469 µm | 50 mm |
| 200 Hz | 1.6 µm | 100 µm | 50 mm |
| 5000 Hz | 0.0 µm | 0.2 µm | 50 mm |

At any rate above ~200 Hz the exact arc correction is micrometres against a
50 mm guess. The padding term should be this expression, evaluated per segment
from the actual commanded velocity, not a constant.

### The number this all hinges on

The answer swings by 8× between the two velocity regimes, and **nobody has told
us what DLS diffractometer axes actually do**. That is a new open question — the
maximum and typical angular velocity per axis, per beamline. It is a
one-afternoon question for whoever owns the motion controllers, and it decides
the validator's sample rate.

## Ray casting as the fine pass

Gareth describes the intended design as capsules first, ray casting second.
Capsules first is right and agrees with everything above. Ray casting second
needs care, because its error direction is the opposite of the one the
two-tier scheme assumes.

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
clearances this system exists to enforce.** D21 gives "detector must be 20 mm
from the sample" as a motivating constraint; 16,384 rays per pose costs 137 ms
and can still miss 31 mm.

This matters because of what the fine tier is *for* (D18). The coarse tier
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
genuinely good at what it was built for, and the `*_config.json` + `*_scene.glb`
pair is a portable scene description that a checker and a viewer can both
consume. That format is the interface between the two halves, and it already
exists.

**Build the checking engine headless, in Python over `coal`.** Same configs,
same GLB. Three tiers by geometry type:

| tier | geometry | when | measured |
|---|---|---|---|
| self-collision | spheres/capsules per link | every point | 1.1-1.6 s / 15k |
| environment | spheres vs point cloud (KD-tree, later CAPT) | every point | 0.16 s / 15k |
| verification | triangle meshes, `coal` | flagged points only | 250 µs/pair |

**Keep the capsule model from `planner.py`, drop the RRT planner around it.**
The geometry model is the right one and is the only component in the prototype
that can keep up with a batch. Discard the planner, which solves a problem we
do not have.

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
claims directly. The handover's own warning applies: re-measure on real
geometry before sizing anything.

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
