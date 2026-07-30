"""Continuous vs discrete collision checking for the coarse tier.

The question: the current plan samples discretely and pads the coarse model for
typical joint velocity over 0.1 s, knowingly accepting that a fast segment can
slip between samples. Continuous collision detection checks the motion between
samples instead. Is it sound, and what does it cost?

Three methods, all on sphere-approximated bodies:

  discrete   sphere vs sphere at each sample.  Point-point distance.
  swept      the volume a sphere sweeps between two samples is exactly a
             capsule, so swept-vs-swept is segment-segment distance.
             Conservative: swept volumes overlapping does not prove the
             bodies were ever there at the same time.
  relative   under linear interpolation the relative position is linear in t,
             so the exact test is point-to-segment on the relative motion.
             Exact for linear motion, and cheaper than swept.

The catch, quantified at the end: joints rotate, so sphere centres travel on
arcs, not chords. The deviation is the sagitta, and unlike a velocity guess it
is computable and shrinks quadratically with sample rate.

Nothing here is trusted without a check: the vectorised distance routines are
validated against brute-force dense sampling before any of it is timed.
"""

import time

import numpy as np

rng = np.random.default_rng(0)


# ---------------------------------------------------------------------------
# vectorised distance primitives
# ---------------------------------------------------------------------------


def seg_seg_dist2(p0, p1, q0, q1):
    """Squared distance between segments p0->p1 and q0->q1, batched.

    Ericson, Real-Time Collision Detection, ch. 5.1.9.
    """
    d1 = p1 - p0
    d2 = q1 - q0
    r = p0 - q0
    a = np.einsum("...i,...i->...", d1, d1)
    e = np.einsum("...i,...i->...", d2, d2)
    f = np.einsum("...i,...i->...", d2, r)
    c = np.einsum("...i,...i->...", d1, r)
    b = np.einsum("...i,...i->...", d1, d2)

    denom = a * e - b * b
    tiny = 1e-30

    s = np.where(
        denom > tiny, (b * f - c * e) / np.where(denom > tiny, denom, 1.0), 0.0
    )
    s = np.clip(s, 0.0, 1.0)

    t = (b * s + f) / np.where(e > tiny, e, 1.0)
    t = np.where(e > tiny, t, 0.0)

    # re-clamp s where t left [0, 1]
    t_lo = t < 0.0
    t_hi = t > 1.0
    s = np.where(t_lo, np.clip(-c / np.where(a > tiny, a, 1.0), 0.0, 1.0), s)
    s = np.where(t_hi, np.clip((b - c) / np.where(a > tiny, a, 1.0), 0.0, 1.0), s)
    t = np.clip(t, 0.0, 1.0)

    diff = (p0 + s[..., None] * d1) - (q0 + t[..., None] * d2)
    return np.einsum("...i,...i->...", diff, diff)


def point_seg_dist2(a0, a1):
    """Squared distance from the origin to segment a0->a1, batched.

    Used for the relative-motion test: if the relative displacement is linear,
    the bodies touch iff this drops below (r1 + r2)^2.
    """
    d = a1 - a0
    dd = np.einsum("...i,...i->...", d, d)
    t = -np.einsum("...i,...i->...", a0, d) / np.where(dd > 1e-30, dd, 1.0)
    t = np.clip(np.where(dd > 1e-30, t, 0.0), 0.0, 1.0)
    c = a0 + t[..., None] * d
    return np.einsum("...i,...i->...", c, c)


# ---------------------------------------------------------------------------
# validation - do not trust the maths above until it agrees with brute force
# ---------------------------------------------------------------------------


def validate(n=2000, samples=4001):
    p0, p1, q0, q1 = (rng.normal(0, 1, (n, 3)) for _ in range(4))

    got = np.sqrt(seg_seg_dist2(p0, p1, q0, q1))
    u = np.linspace(0, 1, 201)
    pa = p0[:, None, :] + u[None, :, None] * (p1 - p0)[:, None, :]
    qa = q0[:, None, :] + u[None, :, None] * (q1 - q0)[:, None, :]
    brute = np.sqrt(
        ((pa[:, :, None, :] - qa[:, None, :, :]) ** 2).sum(-1).min(axis=(1, 2))
    )
    # The analytic answer is a true minimum; brute force samples a subset of
    # the segments, so it can only ever overestimate. The correct check is
    # therefore one-sided: analytic must never exceed brute force, and must
    # not undershoot by more than the sampling resolution can explain.
    over = (got - brute).max()
    under = (brute - got).max()
    print(
        f"  seg-seg vs brute force ({n} pairs): "
        f"overshoot {over:.2e} (must be ~0), undershoot {under:.2e} (sampling)"
    )
    assert over < 1e-9, "segment-segment distance exceeds a known upper bound"

    a0, a1 = rng.normal(0, 1, (n, 3)), rng.normal(0, 1, (n, 3))
    got = np.sqrt(point_seg_dist2(a0, a1))
    t = np.linspace(0, 1, samples)
    pts = a0[:, None, :] + t[None, :, None] * (a1 - a0)[:, None, :]
    brute = np.sqrt((pts**2).sum(-1).min(axis=1))
    over = (got - brute).max()
    under = (brute - got).max()
    print(
        f"  point-seg vs brute force ({n} pairs): "
        f"overshoot {over:.2e} (must be ~0), undershoot {under:.2e} (sampling)"
    )
    assert over < 1e-9, "point-segment distance exceeds a known upper bound"


# ---------------------------------------------------------------------------
# soundness: how often does discrete sampling miss a real collision?
# ---------------------------------------------------------------------------


def soundness(trials=20000, truth_rate=40000, wmax=8.0, label=""):
    """Two spheres on rotating arms. Ground truth by very dense sampling.

    Each trial is one sampling interval. We ask: over that interval, did the
    spheres ever touch, and does each method say so?

    Returns the lowest tested rate at which each method missed nothing, which
    is what the cost comparison needs - a method is only cheaper if it is
    cheaper *at a rate where it is sound*.
    """
    print(f"\nB. soundness{label} - miss rate vs sample rate, |w| <= {wmax} rad/s")
    print(
        f"   {trials:,} random intervals, ground truth = {truth_rate // 1000} kHz dense"
    )

    r1 = r2 = 0.05
    sep = r1 + r2
    arm1, arm2 = 0.5, 0.45
    first_sound = {"discrete": None, "swept": None, "relative": None}

    print(f"   {'rate':>8} {'real':>7} {'discrete':>10} {'swept':>10} {'relative':>10}")

    for rate in (10, 25, 50, 100, 200, 400, 1000, 5000):
        dt = 1.0 / rate
        # random phase and angular velocity per trial, rad/s
        ph1 = rng.uniform(0, 2 * np.pi, trials)
        ph2 = rng.uniform(0, 2 * np.pi, trials)
        w1 = rng.uniform(-wmax, wmax, trials)
        w2 = rng.uniform(-wmax, wmax, trials)
        off = rng.normal(0, 0.06, (trials, 3))  # arm base offset, makes some near

        def pos(ph, w, arm, t):
            a = ph[:, None] + w[:, None] * t[None, :]
            return np.stack(
                [arm * np.cos(a), arm * np.sin(a), np.zeros_like(a)], axis=-1
            )

        # ground truth over the interval
        nt = max(8, int(truth_rate * dt))
        tt = np.linspace(0.0, dt, nt)
        pa = pos(ph1, w1, arm1, tt)
        qa = pos(ph2, w2, arm2, tt) + off[:, None, :]
        truth = np.linalg.norm(pa - qa, axis=-1).min(axis=1) < sep

        p0, p1 = pa[:, 0, :], pa[:, -1, :]
        q0, q1 = qa[:, 0, :], qa[:, -1, :]

        # discrete: endpoints only
        d_hit = (np.linalg.norm(p0 - q0, axis=-1) < sep) | (
            np.linalg.norm(p1 - q1, axis=-1) < sep
        )
        # swept: capsule vs capsule
        s_hit = seg_seg_dist2(p0, p1, q0, q1) < sep**2
        # relative: exact for linear motion
        rel_hit = point_seg_dist2(p0 - q0, p1 - q1) < sep**2

        n_true = int(truth.sum())
        misses = {
            "discrete": int((truth & ~d_hit).sum()),
            "swept": int((truth & ~s_hit).sum()),
            "relative": int((truth & ~rel_hit).sum()),
        }
        for k, v in misses.items():
            if v == 0 and first_sound[k] is None:
                first_sound[k] = rate
        print(
            f"   {rate:>5} Hz {n_true:>7} {misses['discrete']:>10} "
            f"{misses['swept']:>10} {misses['relative']:>10}"
        )

    print(f"   lowest rate with zero misses: {first_sound}")
    return first_sound


# ---------------------------------------------------------------------------
# cost
# ---------------------------------------------------------------------------


def cost(n_pairs=17721, poses=4096, batch=15000):
    print(f"\nD. cost - {n_pairs:,} sphere pairs, timed over {poses} poses")
    # Work per pose is n_pairs distance evaluations; simulate by tiling to a
    # representative pair count in chunks that stay in cache.
    chunk = 256
    reps = max(1, n_pairs // 1000)

    def timeit(fn, label):
        t0 = time.perf_counter()
        for _ in range(0, poses, chunk):
            a = rng.normal(0, 1, (chunk, 1000, 3))
            b = rng.normal(0, 1, (chunk, 1000, 3))
            c = rng.normal(0, 1, (chunk, 1000, 3))
            d = rng.normal(0, 1, (chunk, 1000, 3))
            for _ in range(reps):
                fn(a, b, c, d)
        dt = time.perf_counter() - t0
        per_pose = dt / poses
        print(
            f"   {label:<38} {dt * 1e3:8.0f} ms / {poses} poses  "
            f"-> {batch:,}-pose batch = {per_pose * batch:6.2f} s"
        )
        return per_pose

    t_d = timeit(
        lambda a, b, c, d: np.einsum("...i,...i->...", a - c, a - c) < 0.01,
        "discrete (point-point)",
    )
    t_r = timeit(
        lambda a, b, c, d: point_seg_dist2(a - c, b - d) < 0.01,
        "relative CCD (point-segment, exact)",
    )
    t_s = timeit(
        lambda a, b, c, d: seg_seg_dist2(a, b, c, d) < 0.01,
        "swept CCD (segment-segment, conservative)",
    )
    print(f"\n   relative CCD costs {t_r / t_d:.1f}x discrete")
    print(f"   swept    CCD costs {t_s / t_d:.1f}x discrete")
    return {"discrete": t_d, "relative": t_r, "swept": t_s}


def composite(per_pose, sound_rate, label):
    """Cost per second of trajectory, each method at a rate where it is sound.

    This is the comparison that matters. CCD is only worth it if
    (cheaper rate) x (dearer per point) beats (dearer rate) x (cheap per point).
    """
    print(f"\nE. cost per second of trajectory{label}")
    print(f"   {'method':<12} {'sound at':>10} {'per point':>12} {'per second':>12}")
    best = None
    for k in ("discrete", "relative", "swept"):
        rate = sound_rate[k]
        if rate is None:
            print(f"   {k:<12} {'never':>10} {per_pose[k] * 1e6:>9.2f} us {'-':>12}")
            continue
        per_s = per_pose[k] * rate
        if best is None or per_s < best[1]:
            best = (k, per_s)
        print(
            f"   {k:<12} {rate:>7} Hz {per_pose[k] * 1e6:>9.2f} us {per_s:>10.3f} s/s"
        )
    if best:
        print(f"   -> cheapest sound option: {best[0]}")


# ---------------------------------------------------------------------------
# the arc problem: chords are not arcs, and the gap is computable
# ---------------------------------------------------------------------------


def sagitta():
    print("\nC. the arc correction (sagitta), vs the velocity-guess padding")
    print("   a sphere at radius r on a joint at w rad/s, sampled at rate R,")
    print("   deviates from the chord by r*(1-cos(theta/2)), theta = w/R")
    print()
    r = 0.5
    print(f"   {'rate':>8} {'w=1 rad/s':>12} {'w=8 rad/s':>12} {'typical-v pad':>15}")
    for rate in (10, 50, 200, 1000, 5000):
        row = []
        for w in (1.0, 8.0):
            theta = w / rate
            row.append(r * (1 - np.cos(theta / 2)))
        # the current scheme's padding: typical velocity for 0.1 s
        pad = r * 1.0 * 0.1
        print(
            f"   {rate:>5} Hz {row[0] * 1e6:>10.1f} um {row[1] * 1e6:>10.1f} um "
            f"{pad * 1e3:>12.1f} mm"
        )


if __name__ == "__main__":
    print("A. validating the vectorised distance routines")
    validate()

    # Two velocity regimes. A six-circle diffractometer axis runs at tens of
    # degrees per second (~1.6 rad/s); 8 rad/s is a fast robot arm. Which
    # regime a beamline is in decides the whole answer, and nobody has given
    # us the real number - that is O16.
    slow = soundness(wmax=1.6, label=" (diffractometer speeds)")
    fast = soundness(wmax=8.0, label=" (robot-arm speeds)")

    sagitta()
    per_pose = cost()
    composite(per_pose, slow, " (diffractometer speeds)")
    composite(per_pose, fast, " (robot-arm speeds)")
