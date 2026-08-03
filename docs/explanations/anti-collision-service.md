# The anti-collision service

Everything known about [`garethnisbet/Robot`](https://github.com/garethnisbet/Robot),
gathered in one place so it can be worked through with its author. Read at
`f7875dd` on `master` — see [](pinned-references.md) for exact line references.

```{note}
This page was written to prepare a technical conversation with Gareth Nisbet,
who wrote the service. **Most of what is below has not yet been put to him.**
Findings are marked ⚑ where they have not, and should be read as questions from
someone who has read the code from outside rather than as conclusions about it.
Several are likely to have answers that are not visible in the source.
```

The wider survey of what collision libraries do generally is in
[](exploration/collision-libraries.md); the numbers are in
[](exploration/measurements.md). This page is about *this* service.

## What it is today

An interactive three.js viewer and control panel for robots and diffractometers,
with a WebSocket remote-control API. ~8.9k lines of JavaScript, ~7.3k of Python.
Single author, 50 commits, April–July 2026. CI builds a container; Helm deploys
it at `robots.diamond.ac.uk`.

It grew anti-collision out of a visualiser, which is worth holding in mind
throughout: the parts that are excellent are the ones a visualiser needs, and
that is not a criticism of them.

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

**The committed code does something different from that description**, and the
most likely explanation is that the description is of intent rather than of the
current state. The collision path calls exactly two geometric tests —
`intersectsGeometry` (triangle-triangle BVH) and `closestPointToPoint` (point
cloud) — plus a floor check. The string "capsule" appears in no JavaScript file.
The only raycasting is VR controller pointing and click-to-select. Both other
branches (`Dev`, `Developement`) are the same.

The two accounts are closer than they look: `closestPointToPoint` with a 40 mm
threshold *is* a sphere-vs-mesh proximity query, and both it and raycasting are
three-mesh-bvh tree queries. "Capsules and rays" is a fair informal account of
"40 mm radii and BVH queries". **Worth confirming which is the plan of record**,
because the two have different soundness properties and the design depends on
what the fine tier ends up being.

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
already models i16 and i19. It is the natural interface between the two halves
of any split.

## What we measured

All on real i16 geometry: 18 meshes, 233,034 triangles. Tables in
[](exploration/measurements.md).

**It runs headless.** node 18 with the pinned three 0.168 and three-mesh-bvh
0.7.8, loading `i16_scene.glb`, building BVHs and checking all 153 pairs with no
WebGL context and no DOM. The apparent dependency was on `render()`'s side
effect of refreshing world matrices — `scene.updateMatrixWorld()`, 2.5 µs of
pure CPU maths. That removes what looked like a blocking obstacle to reusing the
engine outside a browser.

**The collision maths is CPU, not GPU.** three-mesh-bvh is a CPU BVH library,
the Web Worker is a CPU thread, and the Helm chart requests `cpu: 4000m` with no
GPU resource. GPU appears only in `js/vr.js` and `js/stl.js` — rendering. Noted
because we had been reasoning as though the GPU was why the service had to be
external. It is not, though there remain good reasons for it to be.

**Proving two meshes don't touch is the expensive case** — a collision exits at
the first triangle, a near miss forces exhaustive descent of both trees. A
well-optimised scan is almost entirely near misses, so the worst case is the
normal case. `strategy: SAH` is a one-line change worth ~1.5× on that dominant
case.

**Descending the BVH deeper is free.** Rejection improves 71.3% → 82.2% from
depth 0 to 6 at flat cost, because the descent prunes. Depth 3–4 is the knee and
halves the false positives for nothing. Today the code stops at depth 0 — one
box per mesh — then jumps to leaves. This looks like the cheapest available
improvement to the code as it stands.

**Rejection saturates after depth 3–4**, which says the limit is the bounding
volume's *shape*: three-mesh-bvh nodes are axis-aligned in the mesh's local
frame, so a rotated arm's world box inflates however finely you subdivide.

**Ray casting as a fine pass has an inverted error direction.** At 8.3 µs/ray,
16,384 rays costs 137 ms per pose and can still miss a 31 mm feature at 1 m —
larger than the 20 mm detector-to-sample clearance this exists to enforce. Rays
sample; the fine tier gets the last word, so false negatives there are
confidently-cleared real collisions. This is the strongest reason to pin down
the "rays" question below.

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
batch would be 15,000 round trips. This is the single most important item, and
it is cheapest to influence now, while the API is being written.

**Per-point verdicts that name the implicated pair**, not a boolean. Without the
pair, the exact tier cannot be restricted to what the coarse tier flagged, and
the tiering buys nothing — measured, ~105 s versus a few seconds per batch. This
is ADR-0006, and it is the load-bearing requirement on the contract.

**Padding as a request parameter.** Insertion-time and runtime want very
different margins against the same geometry; two models that can drift apart is
strictly worse than one model with two margins. `coal`'s `security_margin` is
exactly this shape, if the engine ever moves there.

**Defined behaviour on timeout or unavailability.** The executor fails closed
and stops the motors. A watchdog was considered and rejected — there is not
enough stopping distance to abort usefully once a collision is detected — so
there is no backstop behind this.

**A version or hash for the geometry**, recorded alongside a verdict. If the
model changes, a scan validated against the old geometry is stale and nothing
currently detects that.

## Findings to raise

All ⚑ — read from the source, not yet discussed, and quite possibly with answers
we cannot see from outside.

**⚑ The point-cloud decimation and the threshold it feeds are set
independently.** `stride = floor(count / 20000)` is purely count-based, while
the check is "within 40 mm". On a 200,000-point cloud that discards 90% of
points. It is conservative provided post-decimation spacing stays under 40 mm —
plausible for a dense scan of a small region, less obviously so for a large or
non-uniform cloud — but nothing in the code relates the two numbers. **What was
the 40 mm chosen against?** If there is a known cloud spacing behind it, the
relationship is worth writing down; if not, it is worth deriving.

**⚑ Turning off splat display disables environment collision.** The check
filters on `mesh.visible`, and the splat's collision proxy has its visibility
tied to the splat display toggle. Entirely reasonable for a viewer; it becomes a
footgun once this is a machine-protection input, because a display setting would
silently change a safety-adjacent answer.

**⚑ Runtime CDN dependency.** The worker imports three and three-mesh-bvh from
`esm.sh` at run time, which will not work on a beamline network. Vendoring fixes
it, and going headless makes it moot, since node resolves both from
`node_modules`.

**⚑ AABBs are recomputed per pair rather than per mesh.** With 18 meshes each
AABB is rebuilt ~17 times per pose, 8 matrix-vector transforms each. Hoisting is
free and it is in the hot path.

**⚑ Licensing and tests.** There is no LICENSE file and no test suite. Both need
resolving before this is a runtime dependency of flyscan execution — not as a
criticism of a prototype, which needs neither, but because what we are proposing
to depend on would no longer be one.

## Questions for the author

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

**What is the exemption set?** The articulated i16 reports 8–12 exact triangle
collisions per pose *at the demoPose the config ships as valid* — permanently
touching parts the link-level adjacency rules do not cover. Until this is
settled, no false-positive rate measured against this model means anything, and
several of our results are held back by it. Q2 in [](open-questions.md).

**Can the coarse model be tightened automatically?** Fitted spheres leave
63–173 mm of error on these meshes against 3.3 mm of motion padding, so this is
the binding constraint on the whole design. Candidates: a medial-axis sphere
tree, or the mesh's own BVH nodes at depth 3–4. Q1 in [](open-questions.md).

**Are `i16_config.json` and `i19_config.json` production geometry or demos?**

**How do the config's joint names map to dodal devices and PVs?** `Gamma`,
`Merlin`, `Crystal` are recognisable but tied to nothing. Q15 in
[](open-questions.md).

## A suggested shape for the conversation

1. The batch API contract, since it is being written now and is cheapest to
   influence before it exists.
2. The exemption set, because it gates every false-positive number either of us
   can produce.
3. Whether the coarse model can be derived automatically and how tight it gets —
   half a day on one detector arm would answer it.
4. Rays along motion versus rays at a mesh, and whether GPU is coming.
5. The ⚑ findings above, which are all cheap fixes.

Roles worth proposing: the three.js application stays the **viewer and
model-authoring tool**, which is what it is good at and what it was built to be,
and the checking engine becomes headless against the same configs and GLBs. The
`*_config.json` + `*_scene.glb` pair is already the interface between the two.
