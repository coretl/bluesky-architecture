"""Coarse tier with a SOUND two-level broad phase.

An earlier broad-phase sketch was unsound
because it skipped intra-group pairs. This one is sound by construction:

  level 1: each body gets a bounding sphere that provably encloses all of its
           leaf spheres. Two bodies whose bounding spheres are separated by
           more than the sum of their radii cannot have any colliding leaf
           pair, so the whole body pair is skipped. No leaf pair is skipped
           for any other reason.
  level 2: for body pairs that survive, check every leaf sphere pair between
           them - including, crucially, all of them.

Intra-body pairs are exempt by kinematic adjacency, which is a modelling
decision (rigid bodies cannot collide with themselves), not an optimisation.

Processed in chunks so the intermediates stay in cache rather than spilling to
2 GB, which is what made the naive version memory-bound.
"""

import sys
import time

import numpy as np
import trimesh

rng = np.random.default_rng(0)
POSES = 15_000
MAX_PER_BODY = 12
CHUNK = 512

scene = trimesh.load(sys.argv[1], process=False)
geoms = [
    g
    for g in scene.geometry.values()
    if isinstance(g, trimesh.Trimesh) and len(g.faces)
]

bodies = []
for g in geoms:
    pitch = g.extents.max() / 4.0
    try:
        c = np.asarray(g.voxelized(pitch=pitch).fill().points, dtype=np.float32)
    except Exception:
        c = np.atleast_2d(g.bounds.mean(axis=0)).astype(np.float32)
    if len(c) == 0:
        c = np.atleast_2d(g.bounds.mean(axis=0)).astype(np.float32)
    if len(c) > MAX_PER_BODY:
        c = c[rng.choice(len(c), MAX_PER_BODY, replace=False)]
    bodies.append((c, np.float32(np.sqrt(3) * pitch / 2)))

n_bodies = len(bodies)
leaf_counts = [len(c) for c, _ in bodies]
print(
    f"{sys.argv[1].split('/')[-1]}: {n_bodies} bodies, {sum(leaf_counts)} leaf spheres"
)

# Precompute, per body pair, the leaf index arrays. Sound: every cross-body
# leaf pair appears in exactly one body pair's list.
body_pairs = [(i, j) for i in range(n_bodies) for j in range(i + 1, n_bodies)]
leaf_pairs_total = sum(len(bodies[i][0]) * len(bodies[j][0]) for i, j in body_pairs)
print(f"body pairs {len(body_pairs)}, leaf pairs if all descend {leaf_pairs_total:,}")


def run(sep_scale, label):
    """sep_scale spreads the bodies apart, varying how many pairs survive."""
    t_total = 0.0
    descended = 0
    n_chunks = 0
    for _ in range(0, 4096, CHUNK):
        # stand-in for FK output: per-pose rigid offset per body
        offs = rng.normal(0, sep_scale, (CHUNK, n_bodies, 3)).astype(np.float32)
        t0 = time.perf_counter()

        # level 1: body bounding spheres, provably enclosing their leaves
        bcent = np.stack(
            [offs[:, k, :] + bodies[k][0].mean(axis=0) for k in range(n_bodies)], axis=1
        )
        brad = np.array(
            [
                float(np.linalg.norm(c - c.mean(axis=0), axis=1).max() + r)
                for c, r in bodies
            ],
            dtype=np.float32,
        )

        hit = np.zeros(CHUNK, dtype=bool)
        for i, j in body_pairs:
            d = bcent[:, i, :] - bcent[:, j, :]
            near = np.einsum("pi,pi->p", d, d) < (brad[i] + brad[j]) ** 2
            if not near.any():
                continue
            descended += int(near.sum())
            # level 2: ALL leaf pairs between these two bodies, for near poses
            ci, ri = bodies[i]
            cj, rj = bodies[j]
            pi = offs[near][:, i, None, :] + ci[None, :, :]
            pj = offs[near][:, j, None, :] + cj[None, :, :]
            dd = pi[:, :, None, :] - pj[:, None, :, :]
            close = np.einsum("pabc,pabc->pab", dd, dd) < (ri + rj) ** 2
            hit[near] |= close.any(axis=(1, 2))

        t_total += time.perf_counter() - t0
        n_chunks += 1

    poses = n_chunks * CHUNK
    per = t_total / poses
    print(
        f"  {label:<26} {t_total * 1e3:7.1f} ms / {poses} poses "
        f"-> {POSES:,}-pose batch = {per * POSES:6.2f} s  "
        f"(body-pair descents {descended / poses:.1f}/pose)"
    )


print("\nsound hierarchical broad phase, varying how crowded the machine is:")
run(0.02, "tight (many near pairs)")
run(0.10, "moderate")
run(0.40, "spread (few near pairs)")
