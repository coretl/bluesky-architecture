"""Benchmarks for O2 and the runtime chunk budget.

Run: ``python -m bluesky_architecture.strawman.bench``

Everything here is synthetic geometry in a container. Good for orders of
magnitude and for the in-process-vs-service decision; not valid as a design
input for a real beamline.
"""

from __future__ import annotations

import time

import numpy as np

from .collision import FineModel, SimpleModel, demo_geometry
from .runtime import ChunkValidator
from .solver import CountingSolver
from .transform import DiffBranch, SixCircleTransform


def _ub():
    from diffcalc.ub.calc import UBCalculation

    ub = UBCalculation("b")
    ub.set_lattice("Si", 5.431)
    ub.n_hkl = (0, 0, 1)
    ub.set_u(np.identity(3))
    return np.asarray(ub.UB, float)


def _timed(fn, n=5):
    best = float("inf")
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


def bench_inverse(t: SixCircleTransform) -> None:
    print("== O2: branch-fixed inverse, vectorised ==")
    b = DiffBranch()
    for n in (1, 100, 1_000, 10_000, 100_000):
        rng = np.random.default_rng(0)
        hkl = rng.uniform(-1.5, 1.5, size=(3, n))
        # bind hkl explicitly: _timed calls the lambda within this iteration, so
        # late binding would be harmless, but the linter cannot know that
        dt = _timed(lambda q=hkl: t.derived_to_raw(branch=b, h=q[0], k=q[1], l=q[2]))
        print(
            f"  n={n:7d}  total {dt * 1e3:8.3f} ms   per point {dt / n * 1e6:8.3f} us"
        )

    print("\n  diffcalc scalar inverse for comparison: 4162 us/point, 8 solutions")
    print("  -> 10k-point chunk: diffcalc 41.6 s vs branch-fixed vectorised above")


def bench_forward(t: SixCircleTransform) -> None:
    print("\n== forward, vectorised (analysis + monitor path) ==")
    for n in (1, 10_000, 1_000_000):
        rng = np.random.default_rng(1)
        a = rng.uniform(-0.5, 0.5, size=(6, n))
        dt = _timed(
            lambda q=a: t.raw_to_derived(
                mu=q[0], delta=q[1], nu=q[2], eta=q[3], chi=q[4], phi=q[5]
            )
        )
        print(
            f"  n={n:9d}  total {dt * 1e3:8.3f} ms   per point {dt / n * 1e6:8.3f} us"
        )
    print("  diffcalc scalar forward for comparison: 83 us/point")


def bench_chunk(t: SixCircleTransform) -> None:
    print("\n== runtime chunk: IK + simple + fine fallback (budget 500 ms) ==")
    geo = demo_geometry()
    v = ChunkValidator(
        transform=t,
        simple=SimpleModel(geo, sampling_gap=0.001, following_error=0.005),
        fine=FineModel(geo),
    )
    b = DiffBranch()
    for rate, secs in ((5_000, 0.5), (20_000, 0.5), (20_000, 1.0)):
        n = int(rate * secs)
        rng = np.random.default_rng(2)
        hkl = rng.uniform(-1.2, 1.2, size=(3, n))
        r = v.validate(
            branch=b,
            derived={"h": hkl[0], "k": hkl[1], "l": hkl[2]},
            static={"beamstop_z": np.float64(0.25)},
        )
        print(f"  {rate / 1000:4.0f} kHz x {secs:.1f}s -> {r.summary()}")


def bench_insertion(t: SixCircleTransform) -> None:
    print("\n== insertion: solver.select per window ==")
    geo = demo_geometry()
    model = SimpleModel(geo, sampling_gap=0.02, following_error=0.005)

    one = CountingSolver({"dif": t}, model)
    rng = np.random.default_rng(3)
    windows = rng.uniform(-1.0, 1.0, size=(3, 200))
    t0 = time.perf_counter()
    ok = 0
    for i in range(windows.shape[1]):
        try:
            one.select(
                {"dif": {a: np.array([windows[j, i]]) for j, a in enumerate("hkl")}},
                window=i,
                static={"beamstop_z": np.array([0.25])},
            )
            ok += 1
        except Exception:
            pass
    dt = time.perf_counter() - t0
    print(
        f"  1 diffractometer, 200 windows: {dt * 1e3:7.1f} ms "
        f"({dt / 200 * 1e3:.3f} ms/window, {ok} solved, "
        f"{one.combinations_tried} combos tried)"
    )

    two = CountingSolver({"dif": t, "dif2": t}, model, max_combinations=256)
    t0 = time.perf_counter()
    ok = 0
    for i in range(200):
        try:
            two.select(
                {
                    "dif": {a: np.array([windows[j, i]]) for j, a in enumerate("hkl")},
                    "dif2": {a: np.array([windows[j, i]]) for j, a in enumerate("hkl")},
                },
                window=i,
                static={"beamstop_z": np.array([0.25])},
            )
            ok += 1
        except Exception:
            pass
    dt = time.perf_counter() - t0
    print(
        f"  2 diffractometers, 200 windows: {dt * 1e3:7.1f} ms "
        f"({dt / 200 * 1e3:.3f} ms/window, {ok} solved, "
        f"{two.combinations_tried} combos tried)"
    )
    print("  note: 4x4 = 16 combinations per window here; a real 6-circle with 8")
    print("        branches each would be 64, and three devices 512 (D11)")


def bench_full_scan(t: SixCircleTransform) -> None:
    print("\n== whole-scan insertion at 10 Hz sampling (D-insertion) ==")
    geo = demo_geometry()
    model = SimpleModel(geo, sampling_gap=0.02, following_error=0.005)
    solver = CountingSolver({"dif": t}, model)
    for duration_s in (60, 600, 3600):
        n = duration_s * 10
        rng = np.random.default_rng(4)
        hkl = rng.uniform(-1.0, 1.0, size=(3, n))
        # single fly window: one branch for the whole sweep, checked over all points
        t0 = time.perf_counter()
        solver.select(
            {"dif": {a: hkl[j] for j, a in enumerate("hkl")}},
            window=0,
            static={"beamstop_z": np.full(n, 0.25)},
        )
        dt = time.perf_counter() - t0
        print(f"  {duration_s:5d}s scan ({n:6d} pts @10Hz): {dt * 1e3:8.1f} ms")


if __name__ == "__main__":
    t = SixCircleTransform(ub=_ub().tolist(), wavelength=1.0)
    bench_inverse(t)
    bench_forward(t)
    bench_chunk(t)
    bench_insertion(t)
    bench_full_scan(t)
