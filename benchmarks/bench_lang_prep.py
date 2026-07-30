"""Prepare identical geometry for the JS-vs-C++ comparison, and time the C++ side.

The earlier survey reported three-mesh-bvh as ~9x slower than coal/FCL on the
dominant near-miss case. That number confounds two things: the language, and
the fact that three-mesh-bvh's `intersectsGeometry` is not a true two-tree
descent - for every leaf of A it restarts a traversal from the root of B.

If the gap is the language it should be a roughly constant factor at any mesh
size. If it is the algorithm it should grow with triangle count. This writes
the same decimated meshes to JSON so both sides benchmark byte-identical input,
then times FCL on each size. `bench_lang.mjs` times the JS side.
"""

import json
import sys
import time

import fcl
import numpy as np
import trimesh

SIZES = [500, 2000, 8000, 20000]

path = sys.argv[1] if len(sys.argv) > 1 else "i16_scene.glb"
scene = trimesh.load(path, process=False)

placed = []
for node in scene.graph.nodes_geometry:
    T, gname = scene.graph[node]
    g = scene.geometry.get(gname)
    if g is None or len(g.faces) < max(SIZES):
        continue
    placed.append((node, g, T))
placed.sort(key=lambda r: -len(r[1].faces))


def world_aabb(g, T):
    lo, hi = g.bounds
    c = np.array(
        [
            [x, y, z]
            for x in (lo[0], hi[0])
            for y in (lo[1], hi[1])
            for z in (lo[2], hi[2])
        ]
    )
    w = c @ T[:3, :3].T + T[:3, 3]
    return w.min(0), w.max(0)


def fcl_obj(verts, faces, T):
    m = fcl.BVHModel()
    m.beginModel(len(verts), len(faces))
    m.addSubModel(
        np.asarray(verts, dtype=np.float64), np.asarray(faces, dtype=np.int64)
    )
    m.endModel()
    return fcl.CollisionObject(m, fcl.Transform(T[:3, :3], T[:3, 3]))


# Find a near-miss pair: AABBs overlap, geometry does not intersect. That is
# the regime that dominates cost for a well-optimised scan.
req = fcl.CollisionRequest(enable_contact=False)
pair = None
for i in range(len(placed)):
    for j in range(i + 1, len(placed)):
        (_, gi, Ti), (_, gj, Tj) = placed[i], placed[j]
        amin, amax = world_aabb(gi, Ti)
        bmin, bmax = world_aabb(gj, Tj)
        if np.any(amax < bmin) or np.any(bmax < amin):
            continue
        res = fcl.CollisionResult()
        if not fcl.collide(
            fcl_obj(gi.vertices, gi.faces, Ti),
            fcl_obj(gj.vertices, gj.faces, Tj),
            req,
            res,
        ):
            pair = (placed[i], placed[j])
            break
    if pair:
        break

if pair is None:
    # No natural near-miss pair at this size. Construct one: take the two
    # largest meshes and slide B along x until the AABBs still overlap but the
    # geometry does not. Same regime, deterministic, and it keeps the meshes
    # real rather than synthetic.
    (na, ga, Ta), (nb, gb, Tb) = placed[0], placed[1]
    amin, amax = world_aabb(ga, Ta)
    span = (amax - amin)[0]
    oa = fcl_obj(ga.vertices, ga.faces, Ta)
    for frac in np.linspace(0.05, 0.95, 40):
        Tb2 = Tb.copy()
        Tb2[0, 3] = Ta[0, 3] + frac * span
        bmin, bmax = world_aabb(gb, Tb2)
        if np.any(amax < bmin) or np.any(bmax < amin):
            continue
        res = fcl.CollisionResult()
        if not fcl.collide(oa, fcl_obj(gb.vertices, gb.faces, Tb2), req, res):
            Tb = Tb2
            pair = ((na, ga, Ta), (nb, gb, Tb))
            print(f"constructed near-miss by offsetting B to x={Tb[0, 3]:.3f}")
            break
    if pair is None:
        raise SystemExit("could not construct a near-miss pair")

(na, ga, Ta), (nb, gb, Tb) = pair
print(f"near-miss pair: {na} ({len(ga.faces):,} tris) vs {nb} ({len(gb.faces):,} tris)")

payload = {"pair": [na, nb], "A": {}, "B": {}, "Ta": Ta.tolist(), "Tb": Tb.tolist()}
results = {}

for n in SIZES:
    out = {}
    for key, g in (("A", ga), ("B", gb)):
        step = max(1, len(g.faces) // n)
        faces = g.faces[::step][:n]
        used = np.unique(faces)
        remap = np.zeros(used.max() + 1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        out[key] = (g.vertices[used], remap[faces])
        payload[key][str(n)] = {
            "vertices": out[key][0].ravel().tolist(),
            "faces": out[key][1].ravel().tolist(),
        }

    oa = fcl_obj(*out["A"], Ta)
    ob = fcl_obj(*out["B"], Tb)
    res = fcl.CollisionResult()
    hit = fcl.collide(oa, ob, req, res)

    iters = max(20, int(4000 / max(1, n / 500)))
    t0 = time.perf_counter()
    for _ in range(iters):
        r = fcl.CollisionResult()
        fcl.collide(oa, ob, req, r)
    per = (time.perf_counter() - t0) / iters
    results[n] = per
    print(f"  {n:>6} tris/mesh: FCL {per * 1e6:9.1f} us/pair   (intersecting={hit})")

payload["fcl_us"] = {str(k): v * 1e6 for k, v in results.items()}
with open("lang_pair.json", "w") as f:
    json.dump(payload, f)
print("\nwrote lang_pair.json - now run: node bench_lang.mjs lang_pair.json")
