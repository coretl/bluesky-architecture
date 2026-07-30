# The anti-collision service

Everything known about [`garethnisbet/Robot`](https://github.com/garethnisbet/Robot),
gathered in one place so it can be worked through with its author. Read at
`f7875dd` on `master` — see [](pinned-references.md) for exact line references.

The wider survey of what other collision libraries do is in
[](exploration/collision-libraries.md); this page is about *this* service.

## What it is today

An interactive three.js viewer and control panel for robots and diffractometers,
with a WebSocket remote-control API. ~8.9k lines of JavaScript, ~7.3k of Python.
Single author, 50 commits, April–July 2026. CI builds a container; Helm deploys
it at `robots.diamond.ac.uk`. No LICENSE file, no tests.

It grew anti-collision out of a visualiser, which is worth holding in mind: the
parts that are excellent are the ones a visualiser needs.

### Two collision implementations, in different languages

| | browser | headless |
|---|---|---|
| where | `js/collision.js` + `js/collision-worker.js`, in a Web Worker | `planner.py`, numpy |
| model | triangle meshes | **capsules** + sphere/AABB obstacles |
| broad phase | AABB | none |
| narrow phase | three-mesh-bvh | segment-segment distance |
| point cloud | cloud samples vs mesh BVH, 40 mm threshold | not supported |
| driven by | every rendered frame, current pose only | RRT-Connect path planning |

Gareth describes `planner.py` as a failed experiment awaiting deletion, and the
intended design as **capsules first, ray casting second**.

**What is committed does neither.** The collision path calls exactly two
geometric tests — `intersectsGeometry` (triangle-triangle BVH) and
`closestPointToPoint` (point cloud) — plus a floor check. The string "capsule"
appears in no JavaScript file. The only raycasting is VR controller pointing and
click-to-select. Both other branches (`Dev`, `Developement`) are the same.

Most likely explanation: `closestPointToPoint` with a 40 mm threshold *is* a
sphere-vs-mesh proximity query, and both it and raycasting are three-mesh-bvh
tree queries. Described loosely from memory by someone who did not write the
code, "capsules and rays" is a fair account of "40 mm radii and BVH queries".

### Things it already gets right

**Self-collision exemption by kinematic adjacency** — links sharing a joint or
in a parent-child relation are skipped, links on separate branches always
checked. Worth taking wholesale.

**It fails closed.** If either geometry lacks a `boundsTree`, the mesh test
returns *collision* rather than clear. Easy to get backwards; worth not
breaking.

**A CPU geometry proxy for splats.** The splat binary is parsed on the CPU into
a `THREE.Points` with `visible = false`, and *that* — not the rendered splat —
is what collision consumes. Someone solved the headless problem on purpose.

**The config format is a good artefact.** `*_config.json` + `*_scene.glb` is a
portable scene description that a viewer and a checker can both consume, and it
already models i16 and i19.

## What we measured

All on real i16 geometry: 18 meshes, 233,034 triangles.

**It runs headless.** node 18 with the pinned three 0.168 and three-mesh-bvh
0.7.8, loading `i16_scene.glb`, building BVHs and checking all 153 pairs with no
WebGL context and no DOM. The apparent dependency was on `render()`'s side
effect of refreshing world matrices — `scene.updateMatrixWorld()`, 2.5 µs of
pure CPU maths.

**It is not GPU.** three-mesh-bvh is a CPU BVH library, the Web Worker is a CPU
thread, and the Helm chart requests `cpu: 4000m` with no GPU resource. GPU
appears only in `js/vr.js` and `js/stl.js` — rendering.

**Per-pair cost**, and the counterintuitive part is which case is expensive:

| regime | JS default | JS with SAH | coal/FCL |
|---|---|---|---|
| AABB reject | 0.5 µs | 0.3 µs | 0.2 µs |
| BVH descent, **no** intersection | 2302 µs | ~1550 µs | 250 µs |
| BVH descent, intersecting | 965 µs | ~735 µs | 51 µs |

Proving two meshes *don't* touch is the expensive case — a collision exits at
the first triangle, a near miss forces exhaustive descent of both trees. A
well-optimised scan is almost entirely near misses.

Note `strategy: SAH` is a one-line change worth ~1.5× on the dominant case.

**Descending the BVH deeper is free.** Rejection improves 71.3% → 82.2% from
depth 0 to 6 at flat cost, because the descent prunes. Depth 3–4 is the knee and
halves the false positives for nothing. Today the code stops at depth 0 — one
box per mesh — then jumps to leaves.

**Rejection saturates after depth 3–4**, which says the limit is the bounding
volume's *shape*: three-mesh-bvh nodes are axis-aligned in the mesh's local
frame, so a rotated arm's world box inflates however finely you subdivide.

**Ray casting as a fine pass has an inverted error direction.** At 8.3 µs/ray,
16,384 rays costs 137 ms per pose and can still miss a 31 mm feature at 1 m —
larger than the 20 mm detector-to-sample clearance this exists to enforce. Rays
sample; the fine tier gets the last word, so false negatives there are
confidently-cleared real collisions.

**glTF carries no convention risk.** three.js and trimesh place all 18 meshes
identically to 1.55e-15 m, because glTF stores transforms as matrices or
translation/rotation/scale with rotation as a *quaternion*. The drift risk is in
the WebSocket API (degrees, mm, Z-up, Euler relative to a home of `[0,90,0]`)
and in the configs — whose `restQuat` is `[w,x,y,z]`, the opposite ordering from
glTF's `xyzw`.

## What the design needs from it

**A batch API.** The executor submits a few seconds of motion at the servo rate
— order 15,000 points — checked ahead of the motion. The current WebSocket
vocabulary is `setJoints` (one pose) and `getCollisions` (current pose), so a
batch would be 15,000 round trips through a browser. This is the single most
important thing.

**Per-point verdicts that name the implicated pair**, not a boolean. Without the
pair, the exact tier cannot be restricted to what the coarse tier flagged, and
the tiering buys nothing — measured, ~105 s versus a few seconds per batch.

**Padding as a request parameter.** Insertion-time and runtime want very
different margins against the same geometry; two models that can drift apart is
strictly worse than one model with two margins.

**Defined behaviour on timeout or unavailability.** The executor fails closed
and stops the motors. A watchdog was considered and rejected — there is not
enough stopping distance to abort usefully once a collision is detected — so
there is no backstop behind this.

**A version or hash for the geometry**, recorded alongside a verdict. If the
model changes, a scan validated against the old geometry is stale and nothing
currently detects that.

## Findings worth raising

**The point-cloud decimation has no relationship to the threshold it feeds.**
`stride = floor(count / 20000)` is purely count-based, while the check is
"within 40 mm". On a 200,000-point cloud that discards 90% of points. It is
conservative only if post-decimation spacing stays under 40 mm — true for a
dense scan of a small region, not for a large or non-uniform cloud, and nothing
in the code relates the two numbers. **Was 40 mm chosen against a known cloud
spacing, or to look right in the viewer?**

**Turning off splat display disables environment collision.** The check filters
on `mesh.visible`, and the splat's collision proxy has its visibility tied to
the splat display toggle. Fine for a viewer; a footgun once this is a
machine-protection input.

**Runtime CDN dependency.** The worker imports three and three-mesh-bvh from
`esm.sh` at run time. Not deployable on a beamline network, and trivially fixed
by vendoring — headless makes it moot, since node resolves both from
`node_modules`.

**AABBs are recomputed per pair rather than per mesh.** With 18 meshes each
AABB is rebuilt ~17 times per pose, 8 matrix-vector transforms each. Hoisting is
free and it is in the hot path.

**No LICENSE file**, and no tests, on something becoming a runtime dependency of
flyscan execution.

## Open questions

**Which is it: rays along the motion direction, or rays sprayed at a mesh?**
Casting along the direction of travel to find time-of-impact is a legitimate CCD
formulation. Spraying rays to test overlap is a sampling estimate with false
negatives. Completely different soundness properties, and the answer decides
whether the fine tier can be trusted to *clear* a flagged point.

**Is there a GPU implementation planned that is not in this repo?** If the fine
pass becomes ray casting, RT cores are purpose-built for it, and
[RTCD](https://arxiv.org/abs/2409.09918) reports 3–9× over GPU sphere-based
methods at almost exactly i16's scale. That would be the first coherent GPU
argument for this project — and notably its continuous variant still uses a
sphere robot representation.

**What is the exemption set really?** The articulated i16 reports 8–12 exact
triangle collisions per pose *at the demoPose the config ships as valid* —
permanently touching parts the link-level adjacency rules do not cover. Until
this is right, no false-positive rate measured against this model means
anything, and several of our results are held back by it.

**Can the coarse model be tightened automatically?** Hand-authored capsules are
ruled out on cost — mech engineers export meshes and every CAD revision would
need redoing. Fitted spheres leave 63–173 mm of error on these meshes against
3.3 mm of motion padding, so the coarse model is the binding constraint on the
whole design. Candidates: a medial-axis sphere tree, or the mesh's own BVH nodes
at depth 3–4, which are conservative by construction and impossible to drift out
of sync.

**Are `i16_config.json` and `i19_config.json` production geometry or demos?**

**How do the config's joint names map to dodal devices and PVs?** `Gamma`,
`Merlin`, `Crystal` are recognisable but tied to nothing.

## A suggested shape for the conversation

1. The batch API contract, since it is being written now and is cheapest to
   influence before it exists.
2. The exemption set, because it gates every false-positive number either of us
   can produce.
3. Whether the coarse model can be derived automatically and how tight it gets —
   half a day on one detector arm would answer it.
4. Rays along motion versus rays at a mesh, and whether GPU is coming.
5. The smaller findings above, which are all cheap fixes.

Roles worth proposing: the three.js application stays the **viewer and
model-authoring tool**, which is what it is good at, and the checking engine
becomes headless against the same configs and GLBs. The `*_config.json` +
`*_scene.glb` pair is already the interface between the two.
