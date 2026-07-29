"""Property tests for the decisions in docs/explanations/handover.md.

Each test names the decision it protects. Several of these would have caught
errors made while designing this — the round-trip test found a genuine bug in
the delta_sign branches of the inverse.
"""

from __future__ import annotations

import numpy as np
import pytest
from diffcalc.hkl.calc import HklCalculation
from diffcalc.hkl.constraints import Constraints
from diffcalc.hkl.geometry import Position
from diffcalc.ub.calc import UBCalculation

from bluesky_architecture.strawman.certificate import (
    Preconditions,
    PreconditionViolation,
    WindowChoice,
)
from bluesky_architecture.strawman.collision import (
    FineModel,
    SimpleModel,
    assert_conservative,
    demo_geometry,
)
from bluesky_architecture.strawman.runtime import DerivedAxisDevice, StaleBranch
from bluesky_architecture.strawman.solver import (
    LocalSolver,
    NullSolver,
    SolverError,
    Unsatisfiable,
)
from bluesky_architecture.strawman.transform import (
    DiffBranch,
    SingleBranch,
    SixCircleTransform,
    TransformStack,
    TwoJackTransform,
)


@pytest.fixture(scope="module")
def ubcalc():
    ub = UBCalculation("t")
    ub.set_lattice("Si", 5.431)
    ub.n_hkl = (0, 0, 1)
    ub.set_u(np.identity(3))
    return ub


@pytest.fixture(scope="module")
def sixc(ubcalc):
    return SixCircleTransform(ub=np.asarray(ubcalc.UB, float).tolist(), wavelength=1.0)


@pytest.fixture(scope="module")
def hkls(sixc):
    rng = np.random.default_rng(7)
    hkl = rng.integers(-2, 3, size=(3, 300)).astype(float)
    ok = sixc.reachable(h=hkl[0], k=hkl[1], l=hkl[2]) & (
        np.linalg.norm(hkl, axis=0) > 0
    )
    return hkl[:, ok]


# -- D7: array-safety --------------------------------------------------------


def test_forward_scalar_matches_array(sixc):
    a = {"mu": 0.1, "delta": 0.4, "nu": 0.05, "eta": 0.2, "chi": 0.3, "phi": 0.6}
    scalar = sixc.raw_to_derived(**a)
    arr = sixc.raw_to_derived(**{k: np.array([v]) for k, v in a.items()})
    for axis in "hkl":
        assert np.allclose(scalar[axis], arr[axis][0])
        assert np.shape(scalar[axis]) == ()


def test_two_jack_is_array_safe_for_free():
    """The cheap case needs no special handling - it is arithmetic."""
    t = TwoJackTransform(distance=2.0)
    s = t.raw_to_derived(jack1=1.0, jack2=3.0)
    a = t.raw_to_derived(jack1=np.arange(5.0), jack2=np.arange(5.0) + 2.0)
    assert s == {"height": 1.0, "angle": 1.0}
    assert np.allclose(a["angle"], 1.0)


# -- forward correctness against the oracle ---------------------------------


def test_forward_matches_diffcalc(sixc, ubcalc):
    ref = HklCalculation(ubcalc, Constraints({"qaz": 90, "a_eq_b": True, "mu": 0}))
    rng = np.random.default_rng(3)
    ang = rng.uniform(-0.6, 0.6, size=(6, 100))
    got = sixc.raw_to_derived(
        mu=ang[0], delta=ang[1], nu=ang[2], eta=ang[3], chi=ang[4], phi=ang[5]
    )
    for i in range(ang.shape[1]):
        exp = np.array(ref.get_hkl(Position(*np.degrees(ang[:, i])), 1.0))
        act = np.array([got[a][i] for a in "hkl"])
        assert np.allclose(exp, act, atol=1e-12)


# -- O1: the inverse is closed-form, and every branch is a real solution -----


@pytest.mark.parametrize("sign", [1, -1])
@pytest.mark.parametrize("flip", [False, True])
def test_inverse_round_trips(sixc, hkls, sign, flip):
    h, k, l = hkls
    b = DiffBranch(delta_sign=sign, chi_flip=flip)
    raw = sixc.derived_to_raw(branch=b, h=h, k=k, l=l)
    back = sixc.raw_to_derived(**raw)
    for axis, want in zip("hkl", (h, k, l), strict=True):
        assert np.allclose(back[axis], want, atol=1e-9)


def test_branches_are_distinct(sixc):
    sols = [
        tuple(
            round(float(sixc.derived_to_raw(branch=b, h=1.0, k=1.0, l=1.0)[a]), 9)
            for a in ("mu", "delta", "nu", "eta", "chi", "phi")
        )
        for b in sixc.branches()
    ]
    assert len(set(sols)) == len(sols) == 4


def test_inverse_is_not_iterative(sixc, hkls):
    """Cost must be flat per point - evidence it is closed form, not a search."""
    import time

    h, k, l = hkls
    b = DiffBranch()
    for n in (10, 1000):
        big = {
            a: np.tile(v, n)[: len(v) * n]
            for a, v in zip("hkl", (h, k, l), strict=True)
        }
        t0 = time.perf_counter()
        sixc.derived_to_raw(branch=b, **big)
        per_point = (time.perf_counter() - t0) / (len(h) * n)
        assert per_point < 5e-6, f"{per_point * 1e6:.2f} us/point suggests iteration"


# -- D6: the branch never reaches RunStart ----------------------------------


def test_transform_stack_is_branch_free(sixc):
    stack = TransformStack(layers=[sixc])
    dumped = stack.model_dump_json()
    assert "branch" not in dumped
    assert "delta_sign" not in dumped
    assert "chi_flip" not in dumped


# -- D8: discriminated serialisation, reconstructable by analysis ------------


def test_transform_round_trips_through_json(sixc):
    stack = TransformStack.model_validate_json(
        TransformStack(layers=[sixc]).model_dump_json()
    )
    assert isinstance(stack.layers[0], SixCircleTransform)
    got = stack.raw_to_derived(mu=0.0, delta=0.3, nu=0.0, eta=0.15, chi=0.2, phi=0.4)
    exp = sixc.raw_to_derived(mu=0.0, delta=0.3, nu=0.0, eta=0.15, chi=0.2, phi=0.4)
    assert all(np.allclose(got[a], exp[a]) for a in "hkl")


def test_mixed_stack_discriminates():
    js = TransformStack(layers=[TwoJackTransform(distance=2.0)]).model_dump_json()
    assert '"type":"two_jack"' in js.replace(" ", "")
    assert isinstance(
        TransformStack.model_validate_json(js).layers[0], TwoJackTransform
    )


# -- D18: the simple model must never miss anything -------------------------


def test_simple_model_is_conservative():
    geo = demo_geometry()
    simple = SimpleModel(geo, sampling_gap=0.02, following_error=0.005)
    fine = FineModel(geo)
    rng = np.random.default_rng(11)
    raw = {
        "chi": rng.uniform(-np.pi, np.pi, 20000),
        "phi": rng.uniform(-np.pi, np.pi, 20000),
        "delta": rng.uniform(-np.pi, np.pi, 20000),
        "nu": rng.uniform(-0.5, 0.5, 20000),
        "beamstop_z": rng.uniform(-0.3, 0.3, 20000),
    }
    assert_conservative(simple, fine, raw)


def test_unpadded_simple_model_would_be_unsound():
    """Why 'maybe we need an unpadded version' is the wrong instinct."""
    geo = demo_geometry()
    fine = FineModel(geo, margin=0.01)
    unpadded = SimpleModel(geo, sampling_gap=0.0, following_error=0.0, inflation=-0.005)
    rng = np.random.default_rng(12)
    raw = {
        "chi": rng.uniform(-np.pi, np.pi, 20000),
        "phi": rng.uniform(-np.pi, np.pi, 20000),
        "delta": rng.uniform(-np.pi, np.pi, 20000),
        "nu": rng.uniform(-0.5, 0.5, 20000),
        "beamstop_z": rng.uniform(-0.3, 0.3, 20000),
    }
    with pytest.raises(AssertionError, match="false negatives"):
        assert_conservative(unpadded, fine, raw)


# -- D12/D16: null solver, and the two meanings of "no solver" ---------------


def test_null_solver_raises_rather_than_moving(sixc):
    dev = DerivedAxisDevice("dif", sixc, NullSolver("validation subprocess"))
    with pytest.raises(SolverError, match="refusing"):
        dev.set(h=1.0, k=1.0, l=1.0)


def test_single_valued_device_still_needs_the_solver():
    """A two-jack system has nothing to choose but still needs checking."""
    t = TwoJackTransform(distance=2.0)
    dev = DerivedAxisDevice("mirror", t, NullSolver())
    with pytest.raises(SolverError):
        dev.set(height=1.0, angle=0.1)


# -- D14/D15: prepare is consumed, and desync raises -------------------------


def _solver(sixc):
    geo = demo_geometry()
    return LocalSolver(
        {"dif": sixc}, SimpleModel(geo, sampling_gap=0.01, following_error=0.002)
    )


def test_prepared_branch_is_applied(sixc):
    dev = DerivedAxisDevice("dif", sixc, _solver(sixc))
    choice = WindowChoice(
        window=0,
        branches={"dif": DiffBranch(delta_sign=-1)},
        targets={"dif": {"h": 1.0, "k": 1.0, "l": 1.0}},
    )
    dev.prepare(choice)
    raw = dev.set(h=1.0, k=1.0, l=1.0)
    assert raw["delta"] < 0


def test_prepare_is_consumed_not_sticky(sixc):
    dev = DerivedAxisDevice("dif", sixc, _solver(sixc))
    dev.prepare(
        WindowChoice(
            window=0,
            branches={"dif": DiffBranch(delta_sign=-1)},
            targets={"dif": {"h": 1.0, "k": 1.0, "l": 1.0}},
        )
    )
    dev.set(h=1.0, k=1.0, l=1.0)
    # second set has no prepared branch, so it must solve afresh
    raw = dev.set(h=1.0, k=1.0, l=1.0)
    assert raw["delta"] > 0  # solver's first viable branch, not the stale one


def test_stale_branch_raises_rather_than_moving(sixc):
    dev = DerivedAxisDevice("dif", sixc, _solver(sixc))
    dev.prepare(
        WindowChoice(
            window=3,
            branches={"dif": DiffBranch()},
            targets={"dif": {"h": 1.0, "k": 1.0, "l": 1.0}},
        )
    )
    with pytest.raises(StaleBranch):
        dev.set(h=2.0, k=0.0, l=0.0)


def test_mv_path_still_works_and_is_checked(sixc):
    """bps.mv(h, ...) with no certificate: selects and checks now (D14)."""
    dev = DerivedAxisDevice("dif", sixc, _solver(sixc))
    raw = dev.set(h=1.0, k=1.0, l=1.0)
    assert set(raw) == {"mu", "delta", "nu", "eta", "chi", "phi"}


# -- D3: preconditions ------------------------------------------------------


def test_precondition_violation_voids_certificate():
    pre = Preconditions(values={"beamstop_z": 0.1}, tolerances={"beamstop_z": 1e-3})
    pre.check({"beamstop_z": 0.1005})
    with pytest.raises(PreconditionViolation, match="beamstop_z"):
        pre.check({"beamstop_z": 0.2})


def test_missing_scope_device_is_a_violation():
    pre = Preconditions(values={"other_hutch_mirror": 0.0})
    with pytest.raises(PreconditionViolation):
        pre.check({})


# -- D13: failure taxonomy --------------------------------------------------


def test_unsatisfiable_names_the_window(sixc):
    geo = demo_geometry()
    # absurd padding: everything collides, but choices exist
    model = SimpleModel(geo, sampling_gap=10.0, following_error=0.0)
    solver = LocalSolver({"dif": sixc}, model)
    with pytest.raises(Unsatisfiable, match="window 5"):
        solver.select(
            {"dif": {"h": np.array([1.0]), "k": np.array([1.0]), "l": np.array([1.0])}},
            window=5,
        )


def test_two_jack_round_trips():
    """The round-trip property applied to the single-valued case.

    This test was added after the equivalent six-circle test found a real bug
    in the inverse; it then immediately found a second one here. Worth making
    a framework-level property test over every registered transform (D7).
    """
    t = TwoJackTransform(distance=2.0)
    b = SingleBranch()
    h, a = np.linspace(-1, 1, 50), np.linspace(-0.2, 0.2, 50)
    raw = t.derived_to_raw(branch=b, height=h, angle=a)
    back = t.raw_to_derived(**raw)
    assert np.allclose(back["height"], h)
    assert np.allclose(back["angle"], a)
