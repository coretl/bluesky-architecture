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
3. **The fine tier does not fit, in any language.** Triangle-level checking is
   ~100 s per 15,000-point batch even in C++. It is an exception-path tool.
4. **Use `coal` for both tiers.** It has capsules and meshes, it is 9× faster
   than the JavaScript on the case that dominates, and it carries the two
   features that fix outstanding design problems (below).
5. **Don't write capsules in JavaScript.** The coarse tier should not be in
   the browser at all.
6. **Continuous collision detection removes the padding compromise entirely.**
   This is the most consequential finding here and it reopens D18.

## Measurements

### Per-pair cost, by regime

Both implementations classify the i16 scene identically — 110 AABB-disjoint
pairs, 28 with overlapping AABBs but no intersection, 15 intersecting — which
is a useful cross-check that they are doing the same work.

| regime | three-mesh-bvh (JS) | coal/FCL (C++) | ratio |
|---|---|---|---|
| AABB reject, disjoint | 0.5 µs | 0.2 µs | 2.5× |
| BVH descent, **no** intersection | 2302 µs | 250 µs | **9.2×** |
| BVH descent, intersecting | 965 µs | 51 µs | 19× |
| exact distance | — | 2593 µs | — |
| `scene.updateMatrixWorld()` per pose | 2.5 µs | — | — |

The counterintuitive result is that **proving two meshes don't touch is the
expensive case**. A real collision exits at the first intersecting triangle; a
near miss forces exhaustive descent of both trees. A well-optimised scan
consists almost entirely of near misses, so the worst case is the normal case.

Exact distance is 10× worse again, which rules out "just compute clearance per
point" as an alternative to a margin.

### Batch of 15,000 poses (a few seconds at 5 kHz)

| approach | time | verdict |
|---|---|---|
| triangle meshes, coal/FCL, 28 near-miss pairs | ~105 s | ✗ two orders of magnitude over |
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
for anything on a hot path, meshes reserved for final verification, and
continuous checking rather than dense sampling where correctness matters.

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

Yes. `coal` (`pip install coal`, 3.0.3 on PyPI) is 9× faster than
three-mesh-bvh on near misses and 19× on intersections, and it is the same
library Pinocchio uses. `python-fcl` is the older binding and measures the same
within noise.

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

Note that `curobo` on PyPI (version 0.2, "A simple python package") is **not**
NVIDIA's cuRobo, which installs from source. Worth knowing before someone pip
installs it.

### What is the rest of the industry using?

Covered above. In short: FCL/coal and Bullet on CPU, cuRobo on GPU, spheres for
the hot path, and continuous rather than discrete checking.

## The finding that reopens D18

The current plan pads the coarse model for *typical* joint velocity over 0.1 s,
knowingly accepting that a fast segment can slip between samples and be caught
later by the fine check. That is a deliberate trade of soundness for usability
— padding for maximum velocity would reject too many legitimate scans — and it
is only defensible because D21 says this is soft machine protection.

**Continuous collision detection makes the trade unnecessary.** Instead of
checking discrete samples and padding to cover the gap, CCD checks the swept
volume between consecutive samples. It answers exactly the question the padding
was approximating, without the guess, and it is standard practice: it is why
MoveIt added Bullet, and cuRobo's `horizon` dimension exists to support it.

If this holds, the consequences are large:

- The validator can sample at 10 Hz and still be **sound**, rather than
  probabilistic, because the swept check covers the intervening motion.
- A ✓ stops meaning "probably" and starts meaning "will run, given the
  preconditions hold".
- The velocity-dependent padding parameter disappears, along with the tuning
  problem where one number serves as padding, deadband and sample gap.
- D18's soundness requirement and D21's licence to break it stop being in
  tension, because nothing needs to be traded.

This needs measuring before it is believed — swept checks cost more per pair
than discrete ones, and the whole point is that the coarse tier is cheap. But
it is the difference between a system that is sound by construction and one
that relies on a runtime backstop, and that is worth a day of benchmarking.

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
