# Benchmarks

The scripts behind the numbers in `docs/explanations/collision-libraries.md`.

They exist because one early measurement's only artefact
was a chat transcript, and which turned out to be the number the whole
architecture was being sized against — and to be wrong in premise. Every figure
in that document should be reproducible by running something here.

## Geometry

All of these need the real beamline geometry from
[`garethnisbet/Robot`](https://github.com/garethnisbet/Robot) (pinned at
`f7875dd`), which is not vendored here:

```
git clone https://github.com/garethnisbet/Robot /tmp/Robot
```

The relevant files are `i16_scene.glb` / `i16_config.json` (18 meshes, 233,034
triangles, 10 movable joints) and the i19 equivalents.

## Setup

```
# JavaScript — the same versions the prototype pins
mkdir -p headless/node_modules && cd headless
printf '{"type":"module"}' > package.json
for p in three/-/three-0.168.0 three-mesh-bvh/-/three-mesh-bvh-0.7.8; do
  n=${p%%/*}; mkdir -p node_modules/$n
  curl -sSL "https://registry.npmjs.org/$p.tgz" | tar xz -C node_modules/$n --strip-components=1
done

# Python
uv venv -p 3.12 && uv pip install trimesh python-fcl coal scipy numpy
```

## What each one establishes

| script | question it answers |
|---|---|
| `probe.mjs` | does the collision path run with no WebGL and no DOM? (yes) |
| `micro.mjs` | per-pair cost by regime: AABB reject, BVH clear, BVH hit |
| `bench_fcl.py` | the same three regimes in C++, for the language comparison |
| `bench_raycast.mjs` | ray casting as a fine pass — speed, and what it misses |
| `bench_coarse.py` | coarse tier at batch scale, naive all-pairs |
| `bench_coarse2.py` | coarse tier with a *sound* hierarchical broad phase (O13) |
| `bench_ccd.py` | discrete vs swept vs relative CCD: soundness and cost |
| `bench_articulated.mjs` | AABB survival on a properly articulated i16 |
| `bench_twotier.mjs` | the real architecture: spheres flag, BVH only on flagged |
| `bench_validator.mjs` | swept capsules with a rigorous arc bound, vs sample rate |
| `bench_spherefit.mjs` | how much conservatism the sphere approximation adds |
| `bench_bvhdepth.mjs` | rejection rate vs BVH depth — coarse tier with no new model |
| `bench_temporal.mjs` | a BVH over time as well as space, on a real trajectory |

Several take environment variables — `K` (spheres per mesh), `RATE`, `WMAX`
(rad/s), `DELTA`, `POSES`, `SECONDS`, `MAXD`. Read the header comment.

## Methodological notes, learned the hard way

**Build BVHs with `strategy: SAH` and warm up before timing.** The default
`CENTER` split is ~1.5x slower on the dominant case, and the first version of
`micro.mjs` reported a language gap that was partly a tuning gap.

**Articulate the model, don't pose meshes arbitrarily.** `bench_articulated.mjs`
onwards build the joint chain from the config the way `js/device.js` does and
reproduce the adjacency exemption. Earlier scripts do not, and their whole-scene
numbers over-count collisions as a result.

**Random joint angles are not a trajectory.** They put a densely packed
diffractometer in collision most of the time (~12 real collisions per pose), and
a temporal structure built over them shows no benefit because the boxes are huge
at every level. `bench_temporal.mjs` sweeps axes smoothly instead.

**Validate the maths one-sidedly.** `bench_ccd.py` checks its distance routines
against brute force by asserting the analytic answer never *exceeds* a sampled
minimum. A two-sided assertion fails on brute force's own discretisation error.

## Two scripts kept as negative results

`bench_lang_prep.py` + `bench_lang.mjs` compare languages on byte-identical
decimated meshes. **The result is discarded**: taking every k-th face destroys
spatial coherence and FCL (oriented boxes) and three-mesh-bvh (axis-aligned)
degrade differently under it, so it measured the decimation. Kept so nobody
repeats it.

## What none of these establish

The articulated model reports 8-12 exact collisions per pose even at the
`demoPose` its own config ships as valid — permanently touching parts that
production must exempt and that these scripts do not. **Coarse-tier timings and
relative comparisons are trustworthy; absolute false-positive rates are not.**

Nothing here has run on a GPU, so the cuRobo and CAPT figures quoted in the
survey are from their published reports.
