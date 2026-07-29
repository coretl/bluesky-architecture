"""Same geometry, same question, C++ instead of JavaScript.

Loads the real i16 GLB, builds FCL BVH models for every mesh, and times the
three regimes measured in node: AABB reject, BVH descent proving no
intersection, and BVH descent finding one. Directly comparable to the
three-mesh-bvh numbers.
"""

import sys
import time

import fcl
import numpy as np
import trimesh

path = sys.argv[1]
scene = trimesh.load(path, process=False)
geoms = {n: g for n, g in scene.geometry.items() if isinstance(g, trimesh.Trimesh)}
transforms = {n: scene.graph[n][0] for n in scene.graph.nodes_geometry}
node_geom = {n: scene.graph[n][1] for n in scene.graph.nodes_geometry}

print(
    f"{path.split('/')[-1]}: {len(geoms)} geometries, "
    f"{sum(len(g.faces) for g in geoms.values()):,} triangles"
)

# Build one BVH per placed node, as the JS code does per mesh.
objs = {}
aabbs = {}
build0 = time.perf_counter()
for node in scene.graph.nodes_geometry:
    gname = node_geom[node]
    g = geoms.get(gname)
    if g is None or len(g.faces) == 0:
        continue
    m = fcl.BVHModel()
    m.beginModel(len(g.vertices), len(g.faces))
    m.addSubModel(
        np.asarray(g.vertices, dtype=np.float64), np.asarray(g.faces, dtype=np.int64)
    )
    m.endModel()
    T = transforms[node]
    objs[node] = fcl.CollisionObject(m, fcl.Transform(T[:3, :3], T[:3, 3]))
    # world AABB the same way js/collision.js fastWorldAABB does it: 8 corners
    # of the local bounding box pushed through the world matrix
    lo, hi = g.bounds
    corners = np.array(
        [
            [x, y, z]
            for x in (lo[0], hi[0])
            for y in (lo[1], hi[1])
            for z in (lo[2], hi[2])
        ]
    )
    world = corners @ T[:3, :3].T + T[:3, 3]
    aabbs[node] = (world.min(axis=0), world.max(axis=0))
build = time.perf_counter() - build0
print(f"BVH build (all): {build * 1e3:.0f} ms  ({len(objs)} objects)")

names = list(objs)
req = fcl.CollisionRequest(enable_contact=False)

# Classify pairs the way the JS run did.
reject, clear, hit = [], [], []
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = objs[names[i]], objs[names[j]]
        (alo, ahi), (blo, bhi) = aabbs[names[i]], aabbs[names[j]]
        disjoint = bool(np.any(ahi < blo) or np.any(bhi < alo))
        if disjoint:
            reject.append((a, b))
            continue
        res = fcl.CollisionResult()
        (hit if fcl.collide(a, b, req, res) else clear).append((a, b))

print(
    f"pairs: {len(reject)} AABB-disjoint, {len(clear)} overlapping-AABB-but-clear, "
    f"{len(hit)} intersecting"
)


def timeit(pairs, label, iters):
    if not pairs:
        print(f"  {label:<34} (none)")
        return
    t0 = time.perf_counter()
    for _ in range(iters):
        for a, b in pairs:
            res = fcl.CollisionResult()
            fcl.collide(a, b, req, res)
    per = (time.perf_counter() - t0) / (iters * len(pairs))
    print(f"  {label:<34} {len(pairs):>3} pairs  {per * 1e6:>9.1f} us/pair")


timeit(reject, "AABB reject (disjoint)", 200)
timeit(clear, "BVH descent, no intersection", 50)
timeit(hit, "BVH descent, intersecting", 50)

# Distance queries - what you need for a margin/padding check rather than a
# boolean. This is the FCL feature that replaces "pad the geometry".
dreq = fcl.DistanceRequest()
if clear:
    t0 = time.perf_counter()
    for _ in range(20):
        for a, b in clear:
            dres = fcl.DistanceResult()
            fcl.distance(a, b, dreq, dres)
    per = (time.perf_counter() - t0) / (20 * len(clear))
    print(
        f"  {'exact distance (clear pairs)':<34} {len(clear):>3} pairs  "
        f"{per * 1e6:>9.1f} us/pair"
    )
