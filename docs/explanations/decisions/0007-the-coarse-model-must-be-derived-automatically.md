# 7. The coarse model must be derived automatically from the mesh

## Status

Accepted

## Context

The coarse tier needs conservative bounding volumes for every body. The
conventional robotics answer is a hand-authored sphere or capsule model, which
is what cuRobo and most manipulator setups assume.

Mechanical engineers deliver CAD exports. Hand-authoring a capsule model would
cost engineer time per part, and again on **every CAD revision**. That cost is
not available.

## Decision

The coarse model is derived automatically from the mesh. No hand-authored
geometry.

## Consequences

This rules out the conventional approach and favours anything computed from the
mesh — a medial-axis sphere tree, or the mesh's own BVH nodes at a limited
depth.

The BVH-node option has three properties the others lack:

- **No second artefact.** Coarse and exact tiers are the same structure at
  different depths, so they cannot drift apart. When a part is re-exported, both
  update together.
- **Conservative by construction.** A BVH node's bounds contain its triangles
  because that is what a BVH is. Nothing has to be proved or re-proved per
  revision, which removes the whole `assert_conservative` obligation on the
  robot side.
- **One tunable parameter** — depth — rather than a modelling exercise.

Measured, descending deeper costs nothing (the descent prunes) and halves the
false positives. But rejection saturates around depth 3–4, which indicates the
limit is the bounding volume's *shape* rather than the count: axis-aligned nodes
inflate under rotation however finely the tree is subdivided.

That is an argument for oriented volumes. `coal`'s `OBBRSS` nodes are oriented
boxes and rectangle-swept-spheres, which rotate exactly — and a
rectangle-swept-sphere is precisely the fitted capsule-like primitive that
cannot be afforded by hand, computed automatically from the mesh.

**Whether anything automatic reaches single-digit millimetre fit error on
plate-like and open-frame geometry is not yet known, and is the binding open
question for the design.**
