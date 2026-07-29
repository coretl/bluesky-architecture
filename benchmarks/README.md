# Benchmarks

The scripts behind the numbers in `docs/explanations/collision-libraries.md`.

They exist because the handover records a measurement (M5) whose only artefact
was a chat transcript, and which turned out to be the number the whole
architecture was being sized against. Every figure in that document should be
reproducible by running something here.

## Geometry

All of these need the real beamline geometry from
[`garethnisbet/Robot`](https://github.com/garethnisbet/Robot), which is not
vendored here:

```
git clone https://github.com/garethnisbet/Robot /tmp/Robot
```

The relevant files are `i16_scene.glb` / `i16_config.json` (10 movable joints,
9 links) and `i19_scene.glb` / `i19_config.json` (4 movable joints, 8 links).

## JavaScript — the prototype's own stack

`probe.mjs` establishes that the collision path runs with no WebGL context and
no DOM. `micro.mjs` decomposes the per-pair cost into AABB reject, BVH descent
proving no intersection, and BVH descent finding one.

Needs node 18+ and the same versions the prototype pins:

```
mkdir -p headless && cd headless
printf '{"type":"module"}' > package.json
for p in three/-/three-0.168.0 three-mesh-bvh/-/three-mesh-bvh-0.7.8; do
  n=${p%%/*}
  curl -sSL "https://registry.npmjs.org/$p.tgz" | tar xz -C node_modules/$n --strip-components=1
done
node ../probe.mjs /tmp/Robot/i16_scene.glb
node ../micro.mjs /tmp/Robot/i16_scene.glb
```

## Python — the candidate stack

```
uv venv -p 3.12 && uv pip install trimesh python-fcl coal scipy numpy
python bench_fcl.py     /tmp/Robot/i16_scene.glb   # triangle tier, C++ vs JS
python bench_coarse.py  /tmp/Robot/i16_scene.glb   # coarse tier, naive all-pairs
python bench_coarse2.py /tmp/Robot/i16_scene.glb   # coarse tier, sound broad phase
```

`bench_fcl.py` classifies pairs the same way the JavaScript does, which is what
makes the two directly comparable — both find 110 disjoint, 28 near-miss and 15
intersecting on i16.

## What these do not measure

Poses are synthetic offsets rather than real forward kinematics, the sphere
decomposition is voxel-based rather than a medial-axis sphere tree, and the
prototype's kinematic-adjacency exemptions are not reproduced. Per-pair costs
do not depend on any of that. Whole-scene throughput does, and over-counts
collisions as a result.

Nothing here has been run on a GPU, so the cuRobo and CAPT figures quoted in
the survey are from their published reports, not reproduced.
