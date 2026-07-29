"""The coarse tier at production scale, on the real i16 geometry.

Three questions, all sized against one batch = 15,000 poses (a few seconds of
motion at 5 kHz):

  A. self-collision, robot spheres vs robot spheres, vectorised numpy
  B. environment, robot spheres vs a static point cloud, via a KD-tree
  C. how many spheres a real mesh needs before the approximation is tight

Sphere decomposition here is deliberately crude (voxel centres inside the mesh,
radius = half the voxel diagonal, which is a guaranteed cover). A production
version would use a medial-axis sphere tree; the point is the query cost, which
depends on sphere *count*, not on how they were chosen.
"""

import sys
import time

import numpy as np
import trimesh
from scipy.spatial import cKDTree

rng = np.random.default_rng(0)
POSES = 15_000

scene = trimesh.load(sys.argv[1], process=False)
geoms = [
    g
    for g in scene.geometry.values()
    if isinstance(g, trimesh.Trimesh) and len(g.faces)
]
print(
    f"{sys.argv[1].split('/')[-1]}: {len(geoms)} meshes, "
    f"{sum(len(g.faces) for g in geoms):,} triangles\n"
)

# -- C. sphere decomposition -------------------------------------------------
print("C. conservative sphere cover per mesh")
bodies = []
for g in geoms:
    extent = g.extents.max()
    pitch = extent / 4.0  # ~4 spheres across the longest axis
    try:
        vox = g.voxelized(pitch=pitch).fill()
        centres = np.asarray(vox.points, dtype=float)
    except Exception:
        centres = np.atleast_2d(g.bounds.mean(axis=0))
    if len(centres) == 0:
        centres = np.atleast_2d(g.bounds.mean(axis=0))
    radius = float(np.sqrt(3) * pitch / 2)  # covers the voxel -> conservative
    bodies.append((centres, radius))
counts = [len(c) for c, _ in bodies]
print(
    f"   spheres per body: min {min(counts)}, median {int(np.median(counts))}, "
    f"max {max(counts)}, total {sum(counts)}\n"
)

# Cap per body so the totals stay representative of a hand-built model.
MAX_PER_BODY = 12
spheres, body_id = [], []
for i, (c, r) in enumerate(bodies):
    sel = (
        c
        if len(c) <= MAX_PER_BODY
        else c[rng.choice(len(c), MAX_PER_BODY, replace=False)]
    )
    spheres.append(np.c_[sel, np.full(len(sel), r)])
    body_id.append(np.full(len(sel), i))
S = np.vstack(spheres)
body_id = np.concatenate(body_id)
n_s = len(S)
print(f"   using {n_s} spheres total (cap {MAX_PER_BODY}/body)\n")

# -- A. self-collision, vectorised over the whole batch ----------------------
print(f"A. self-collision, {n_s} spheres, {POSES:,}-pose batch, vectorised numpy")
iu, ju = np.triu_indices(n_s, k=1)
keep = body_id[iu] != body_id[ju]  # skip intra-body pairs
iu, ju = iu[keep], ju[keep]
print(f"   sphere pairs after intra-body exemption: {len(iu):,}")

# Simulate a batch: each pose perturbs sphere centres (stands in for FK output).
centres = S[:, :3]
radii = S[:, 3]
thresh = (radii[iu] + radii[ju]) ** 2

for chunk in (1_000, 5_000):
    batch = centres[None, :, :] + rng.normal(0, 0.05, (chunk, n_s, 3))
    t0 = time.perf_counter()
    d = batch[:, iu, :] - batch[:, ju, :]
    hit = np.einsum("pij,pij->pi", d, d) < thresh
    any_hit = hit.any(axis=1)
    dt = time.perf_counter() - t0
    print(
        f"   {chunk:>6,} poses: {dt * 1e3:8.1f} ms  "
        f"-> {POSES:,}-pose batch = {dt / chunk * POSES:6.2f} s "
        f"({any_hit.sum()} colliding)"
    )
print()

# -- B. environment, spheres vs static point cloud ---------------------------
for n_cloud in (20_000, 200_000):
    cloud = rng.uniform(-1.5, 1.5, (n_cloud, 3))
    t0 = time.perf_counter()
    tree = cKDTree(cloud)
    build = time.perf_counter() - t0
    print(
        f"B. environment: {n_s} spheres vs {n_cloud:,}-point cloud "
        f"(KD-tree build {build * 1e3:.0f} ms, one-off)"
    )

    for chunk in (200, 1_000):
        q = centres[None, :, :] + rng.normal(0, 0.05, (chunk, n_s, 3))
        qf = q.reshape(-1, 3)
        t0 = time.perf_counter()
        dist, _ = tree.query(qf, k=1, workers=-1)
        clear = dist.reshape(chunk, n_s) > np.max(radii)
        dt = time.perf_counter() - t0
        per_pose = dt / chunk
        print(
            f"   {chunk:>6,} poses ({len(qf):,} queries): {dt * 1e3:8.1f} ms  "
            f"-> {POSES:,}-pose batch = {per_pose * POSES:6.2f} s  "
            f"[{dt / len(qf) * 1e9:.0f} ns/query, 24 threads]"
        )
    print()
