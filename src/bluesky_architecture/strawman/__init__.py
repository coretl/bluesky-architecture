"""Strawman for the Transform / Solver / Certificate split.

Built to settle two questions that reasoning was not settling: whether the
branch-fixed inverse is closed-form (O1) and whether it is fast enough to stay
in-process. Both are answered — see ``docs/explanations/exploration/``.

**Read this before using any of it as a design input.** The modules divide into
two halves with very different status:

Live
    ``transform``, ``solver``, ``certificate``, ``runtime``. The kinematics
    results stand: the branch-fixed inverse is closed-form, round-trips to
    1e-15 over 496 reflections in all four branches, and costs 0.1 us/point
    flat from 10k to 100k points. Kinematics is not the constraint, and the
    Transform/branch/certificate separation those results support is unchanged.

Superseded
    ``collision``. It models a two-tier in-process check over six spheres,
    sized against a body count nobody had measured. Both premises are now
    known to be wrong. The real model is a point cloud for static geometry
    plus CAD meshes for movable bodies, checked by an external service
    (``garethnisbet/Robot``), so nothing here is on the runtime path. It is
    kept because the *shape* of the two-tier argument survived even though the
    implementation did not, and because ``assert_conservative`` is the test
    that the coarse tier must pass — it just has to run against real geometry
    in the service rather than against spheres here.

The body count that ``collision`` was written to explore turned out to be
readable straight out of the service's beamline configs: i16 has 10 movable
bodies, i19 has 9. That is an order of magnitude below the in-process
crossover this module measured, which is a good illustration of why the
measurement should have come before the model.

Nothing here is async. The solver interface is written so that ``select``
could become a remote call, which is what it is now going to be.
"""
