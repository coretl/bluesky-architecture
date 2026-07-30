# Measurements

Everything that has been measured, what each figure establishes, and how to
reproduce it. Figures without a runnable artefact are marked as such — that
distinction earned itself, see [](reversals.md).

Two rules learned the hard way:

- **Every number needs a script or a label.** The one figure the architecture
  was sized against without an artefact turned out to be unreproducible *and*
  wrong in premise.
- **Container timings, single machine, no GPU.** Ratios are more trustworthy
  than absolutes. Re-measure on real hardware before sizing anything.

## Kinematics

Settled, and unchanged since the strawman. Kinematics is not a constraint
anywhere in this design.

### diffcalc, as the baseline

Si lattice, identity U.

| operation | cost |
|---|---|
| `get_hkl` (angles → hkl) | 83 µs |
| `get_position` (hkl → angles) | 4162 µs, **8 solutions** |
| `HklCalculation` construction | 51 µs |

A ~50× asymmetry falling along the line that matters. The ~520 µs per solution
is largely Python object overhead, which is what suggested the branch-fixed
inverse would be cheap.

Incidentally: `_make_transform_from_readings` rebuilds the `Transform` on every
reading, so the monitor path pays 51 µs + 83 µs each time. Caching the instance
while its parameter readings are unchanged is a cheap win.

### The branch-fixed inverse is closed-form

Three independent lines of evidence:

1. **diffcalc contains no numerical root-finding in the inverse.** The only
   `scipy.optimize` use in the package is UB refinement. So the 4.2 ms is object
   overhead and enumeration, not iteration.
2. **A closed-form inverse round-trips to 1e-15** over 496 reflections, all four
   branches, bisecting mode.
3. **Cost is flat per point** — 0.101 µs at both 10k and 100k points. Iteration
   would not do that, and there is a test asserting the property.

The branch structure is two independent binary sign choices, `delta_sign` and
`chi_flip`. Note that `delta_sign` changes the chi/phi solve, not merely the
sign of delta — getting that wrong produced two branches that silently failed to
round-trip, and the property test caught it.

### Vectorised throughput

| operation | 10,000-point chunk |
|---|---|
| branch-fixed inverse, vectorised | **1.0 ms** |
| diffcalc scalar inverse, same work | 41,600 ms |
| forward, vectorised | 5.9 ms |
| whole-scan insertion, 1-hour scan @10 Hz | 44 ms |

A 41,000× speedup over the scalar path puts inverse kinematics at 0.2% of a
500 ms budget. *Reproduce:* `python -m bluesky_architecture.strawman.bench`.

## Collision — geometry and scale

Read out of the anti-collision service's own beamline configs.

| | movable joints | links | meshes | triangles |
|---|---|---|---|---|
| i16 | 10 | 10 | 18 | 233,034 |
| i19 | 4 | 9 | 12 | — |

Small. Body count was never going to be the constraint.

## Collision — per-pair cost by regime

Both implementations classify the i16 scene identically — 110 AABB-disjoint
pairs, 28 overlapping-but-clear, 15 intersecting — which cross-checks that they
do the same work.

| regime | JS default (CENTER) | JS tuned (SAH) | coal/FCL | ratio |
|---|---|---|---|---|
| AABB reject, disjoint | 0.5 µs | 0.3 µs | 0.2 µs | 1.5× |
| BVH descent, **no** intersection | 2302 µs | ~1550 µs | 250 µs | **6.2×** |
| BVH descent, intersecting | 965 µs | ~735 µs | 51 µs | 14× |
| exact distance | — | — | 2593 µs | — |

**Proving two meshes don't touch is the expensive case.** A real collision exits
at the first intersecting triangle; a near miss forces exhaustive descent of
both trees. A well-optimised scan is almost entirely near misses, so the worst
case is the normal case.

*Reproduce:* `micro.mjs`, `bench_fcl.py`.

## Collision — the coarse tier

| approach, 15,000-point batch | time |
|---|---|
| spheres, naive all-pairs (17,721 pairs) | 9.3 s |
| spheres, sound hierarchical broad phase | **1.1–1.6 s** |
| spheres vs 200,000-point cloud, KD-tree | **0.16 s** |
| fitted spheres on articulated i16, 136 pairs | 7–24 µs/pose |

The point-cloud environment check — the part that sounded hardest — is the
cheapest thing here, and insensitive to cloud size because KD-tree queries are
logarithmic.

*Reproduce:* `bench_coarse.py`, `bench_coarse2.py`, `bench_twotier.mjs`.

## Collision — coarse model fit quality

**The binding constraint on the design.** Sphere surface points sampled against
the mesh BVH, asking how far the real surface is:

| spheres/mesh | total | mean error | p95 | max |
|---|---|---|---|---|
| 4 | 72 | 173 mm | 673 mm | 1283 mm |
| 8 | 144 | 143 mm | 563 mm | 1263 mm |
| 32 | 576 | 82 mm | 347 mm | 1223 mm |
| 64 | 1152 | 63 mm | 275 mm | 1158 mm |

Against 3.3 mm of motion padding at 200 Hz, the fit error dominates by 20–50×
and barely improves with count. Caveat: this fitter is poor — k-means over
triangle centroids with the radius grown to the farthest vertex bulges badly on
thin plates and open frames, which is exactly what a diffractometer is. A
medial-axis sphere tree should do better. That is the open question.

*Reproduce:* `bench_spherefit.mjs`.

## Collision — BVH depth as the coarse tier

Using the mesh's own BVH instead of a separate model. Conservative by
construction, no second artefact, nothing to author.

| depth | nodes/mesh | rejected | flagged/pose | ms/pose |
|---|---|---|---|---|
| 0 *(current prototype)* | 1 | 71.3% | 39.1 | ~0.12 |
| 3 | 15 | 80.2% | 27.0 | 0.127 |
| 6 | 94 | 82.2% | 24.2 | ~0.12 |

**Cost is flat with depth** — the descent prunes, so extra nodes are visited
only where boxes already overlap. Against 8.01 real collisions per pose, false
positives halve for nothing.

Rejection saturates by depth 3–4, which says the limit is the volume's *shape*,
not the count: axis-aligned nodes inflate under rotation however finely you
subdivide. *Reproduce:* `bench_bvhdepth.mjs`.

## Continuous checking

Lowest sample rate at which each method missed nothing, against dense-sampled
ground truth over 20,000 random intervals:

| | discrete | swept | relative |
|---|---|---|---|
| diffractometer speeds (\|ω\| ≤ 1.6 rad/s) | 50 Hz | ≤10 Hz | ≤10 Hz |
| robot-arm speeds (\|ω\| ≤ 8 rad/s) | 400 Hz | 25 Hz | 100 Hz |

Continuous checking costs 2.5× (relative) to 5.1× (swept) per point, so on
rate × cost it wins by only 2–3×. The useful findings were elsewhere: the
executor at 5 kHz is already sound by 12–100×, and the validator at 10 Hz misses
up to 32% of real collisions.

*Reproduce:* `bench_ccd.py`.

## Sound padding for the validator

Swept capsules with a rigorous path-length bound, checked against dense ground
truth at every rate (worst overshoot −0.0074 mm; the bound holds).

| validator rate | inflation mean | max | 1-hour scan |
|---|---|---|---|
| 10 Hz | 66 mm | **263 mm** | 1.6 s |
| 50 Hz | 13 mm | 53 mm | 5.7 s |
| 200 Hz | 3.3 mm | 13 mm | 32 s |
| 1000 Hz | 0.66 mm | 2.6 mm | 117 s |

At 10 Hz the *sound* padding reaches 263 mm against the ~50 mm currently
applied. The scheme is under-padded, not over-padded. Inflation scales as
1/rate and cost as rate, so the product is fixed and the only decision is where
to sit on that line.

Assumes \|ω\| ≤ 1.6 rad/s; everything scales linearly with joint speed.
*Reproduce:* `bench_validator.mjs`.

## A temporal BVH

A binary tree over the time axis: leaves are per-interval swept boxes, internal
nodes are unions of their children. Soundness only has to hold at the leaves,
because a union of correct boxes is correct — so the arc correction is paid once
at 1/256 s and propagates upward free.

Over 8 s at 256 Hz on a real scan trajectory:

| | tests each | vs flat (2047) |
|---|---|---|
| 53 pairs that never come near | 5.6 | **363× fewer** |
| 83 pairs that do come near | 2272 | 0.90× — slightly worse |

The structure works as designed; its value is set entirely by the fraction of
pairs that never interact. Here only 39%, because permanently-touching parts
flag at every interval. *Reproduce:* `bench_temporal.mjs`.

## Two things that are not performance

**The collision service runs headless.** Real i16 geometry, 233k triangles,
BVHs built and all 153 pairs checked with no WebGL context and no DOM. The
apparent dependency was on `render()`'s side effect of refreshing world
matrices, which is `scene.updateMatrixWorld()` — pure CPU, 2.5 µs.
*Reproduce:* `probe.mjs`.

**glTF carries no Euler convention.** Loading `i16_scene.glb` in three.js and in
trimesh places all 18 meshes identically to **1.55e-15 m**. glTF stores node
transforms as a matrix or as translation/rotation/scale with rotation as a
*quaternion*, so there is no axis order to disagree about. The convention risk
lives in the hand-written WebSocket API (degrees, mm, Z-up, Euler relative to a
home of `[0,90,0]`) and in the joint configs — whose `restQuat` is `[w,x,y,z]`,
the opposite ordering from glTF's `xyzw`.

Worth knowing: the two loaders *name* nodes differently — three.js sanitises and
uses mesh names, trimesh uses node names with hash suffixes, and the sets
disagree for 11 of 18 meshes. Matching by name pairs the wrong bodies, which is
how this comparison first appeared to show a 1.77 m disagreement.

## Superseded

**"Collision checking is the binding constraint, and it is O(n²)."** A table
extrapolating in-process sphere all-pairs to a crossover at ~1000 pairs /
47 bodies. It has **no runnable artefact** — it lived only in a chat transcript,
despite being the number the architecture was then sized against. It is also
wrong in premise: it models pair count, and the real constraint is coarse-model
fit quality.

**"Vectorised vs per-point, 92 ms vs 673 ms per 10k points."** Still true, but it
measured in-process per-point collision checking, which is no longer the design.
What remains on the per-point path is the coarse tier, which is still
emphatically vectorisation-bound.
