# Kinematics: what exists, and what we would have to write

Prompted by three questions. Are we the first to want a generic kinematics
library — obviously not, so what is out there? How much should be written here
versus called out to? And where do the physical assembly parameters come from?

**Descriptive.** This catalogues what each geometry already has and what the
field offers. It does not pick.

## The four geometries in scope

Each already has a correct implementation somewhere. That turns out to be the
most useful thing on this page, so it is first.

### Diffractometer

`diffcalc` here, `hklpy` (over `libhkl`) at NSLS-II. Multi-valued: 8 solutions
for `{qaz:90, a_eq_b:True, mu:0}`, 4 in bisecting mode. Once a branch is fixed
the inverse is closed-form and vectorises — measured at 0.1 µs/point, flat from
10k to 100k.

ADR-0004 already records that diffcalc's API is scalar and loops internally, so
it works as a **round-trip test oracle** rather than as the implementation.

### Robot arm

`GNKinematics/kinematics.py` in [`garethnisbet/Robot`](https://github.com/garethnisbet/Robot),
468 lines, its own package directory. A 6-DOF serial arm with **off-centre base
rotation**.

It is **closed-form, not iterative** — cosine-rule triangle solves, with
`NUM_CANDIDATES = 8` configurations enumerated and a `strategy` choosing between
them (`minimum_movement`, `minimum_movement_weighted`).

That structure is worth naming, because it is this project's vocabulary arrived
at independently: **8 candidates are branches, and `strategy` is branch
selection.** `minimum_movement` is precisely the continuity fallback ADR-0009
describes — stay on the branch you are on — reached from the robotics side
rather than the beamline side.

One thing the code already flags in its own comments: the analytic solver emits
spurious roots, and the strategy can select one, so roots are filtered before
the strategy runs.

`from_home_positions(v0…v4, motor_limits, centre_offset, tool_offset, …)`
constructs the link vectors and motor offsets from **joint positions at the home
pose**. That is a direct answer to the assembly-parameter question, and it is
below.

### Two- and three-jack tables

`CS_2jack.pmc`, `CS_3jack.pmc` and `CS_3jack_mirror.pmc` in
[`epicsdeb/pmaccoord`](https://github.com/epicsdeb/pmaccoord/tree/master/pmacCoordApp/pmc).
Fully parameterised on jack positions — `$(J1X)`, `$(J1Z)` and so on are
substituted at build time, nothing is hard-coded.

The forward transform takes two vectors between jacks, crosses them for the
surface normal, and reads pitch and roll off it, with height from the plane
equation. The inverse builds the normal from pitch and roll and applies the
plane equation per jack.

**Single-valued: a plane through three points is unique**, so a jack table has
no branches. It is the degenerate case the design already describes — a
transform with a one-member branch set that can still collide.

In the literature this is a **tip-tilt-piston parallel manipulator**, closely
related to the 3-PRS mechanism, and closed-form direct and inverse kinematics
are published. Nobody needs to derive it.

### DCM energy

`CS_accel_dcm.pmc` and `CS_IDT_sagital_dcm.pmc` in the same repository. Not read
in detail here.

## Where the maths lives today, and why that is the finding

All four already have a correct closed form written down: in diffcalc, in
`GNKinematics`, and in the `.pmc` coordinate-system files. **The work is not
deriving the maths.** It is putting existing, correct forms into one
representation, in one place, at the bluesky layer.

The `.pmc` files are worth treating the way ADR-0004 treats diffcalc — as an
oracle. They are correct for the cases they cover, so a generalised `Transform`
can be tested against them rather than re-derived from scratch. They are also
expanded scalar arithmetic, because PMAC has no matrix type, which is why they
read as they do.

## What the field offers

| | what it is | fit here |
|---|---|---|
| [Pinocchio](https://github.com/stack-of-tasks/pinocchio) | rigid-body kinematics and dynamics, C++ with Python bindings, analytical derivatives, handles closed-loop mechanisms | the serious option; already the library `coal` belongs to, which the collision survey recommends |
| [KDL](https://www.orocos.org/kdl.html) | kinematic chains, long-established | older, chain-oriented |
| [PlaCo](https://github.com/Rhoban/placo) | task-space IK and dynamics for whole-body control | aimed at control, not at closed forms |
| [Drake](https://drake.mit.edu/) | full modelling and simulation stack | large dependency for what is wanted |
| [robotics-toolbox-python](https://github.com/petercorke/robotics-toolbox-python) | Corke's toolbox, complete and readable | good reference, teaching-oriented |
| [ikpy](https://github.com/Phylliade/ikpy) | small URDF-driven IK | numeric only |
| `libhkl` / `hklpy`, `xrayutilities` | diffractometer-specific | overlaps diffcalc |

The pattern: these libraries solve **numeric inverse kinematics on serial chains
described by URDF, usually iteratively, usually one pose per call**, for motion
planning.

What this design needs is different in kind, not in quality — a **closed-form,
branch-fixed inverse, vectorised across a whole trajectory, pure and
serialisable** so it reaches analysis and the collision service (ADR-0004). A
general numeric IK solver satisfies none of those, and the one number we have
says why it matters: diffcalc's general solve is 4.2 ms enumerating 8 solutions,
against 0.1 µs/point for the branch-fixed closed form.

So the plausible split is: **borrow the model, write the maths.** A
URDF-or-similar link and joint description, frame composition and forward
kinematics are all well served by an existing library. The closed-form inverses
are ours, because they already exist and because the properties the design needs
are not what the libraries optimise for.

That is not a recommendation yet. It is where the evidence points, and the
counter-argument — that maintaining closed forms per geometry is a long-term
cost that a numeric solver would avoid — has not been costed.

## Where assembly parameters come from

Today: ask a mechanical engineer to measure a model. Wanted: ask them to export
a model, and measure it here.

Two precedents already exist, and they answer different halves:

- **`from_home_positions`** takes joint positions at the home pose and derives
  link vectors and motor offsets. So the parameters can be *measured positions*
  rather than a hand-built kinematic description.
- **The `.pmc` macros** parameterise jack coordinates and substitute them at
  build time — the same values, reached by a different route, and a reminder
  that these numbers already live in at least two places per beamline.

If the model is exported CAD, and the anti-collision service already consumes
`*_config.json` + `*_scene.glb` with joint axes and rest poses, then the same
artefact could supply the assembly parameters.

**The CAD is nominal.** Components are surveyed in to a tolerance during
installation, but those survey figures are not recorded anywhere, so nominal is
all there is. Any model derived from exported CAD therefore carries an
unquantified as-built error, and there is no artefact to reconcile it against.

How much that matters depends on what the model is for, and the two answers are
far apart:

- **For collision checking, it is currently in the noise.** Coarse-model fit
  error is 63–173 mm (Q1). Whatever the survey tolerance is, it is not that. If
  Q1 is ever answered and the coarse model gets tight, this becomes the next
  error term to deal with rather than a rounding difference.
- **For positioning, nominal is not enough** — and for diffractometers it never
  was. UB refinement exists precisely to calibrate the real geometry out of a
  nominal description, and it is the only `scipy.optimize` use in diffcalc.

There is no equivalent of UB refinement for the non-diffractometer geometries,
and **for jack tables that is fine** — the tolerances on what is mounted on them
are not tight enough to need it. Nominal jack positions are good enough for the
job the transform does.

If it is ever needed, the shape of the answer is already known and is the same
shape UB refinement has: **fit against detector data to produce new parameters
for the transform, and apply those in bluesky.** That falls out of the design
rather than needing anything new, because a `Transform` already carries its
geometry parameters as serialised state (ADR-0004) — refinement writes those
numbers, it does not change the maths.

Worth noting `from_home_positions` as the contrasting approach already in use:
it takes *measured* joint positions rather than nominal ones. So two starting
points are in play across the geometries one library would have to cover, even
if neither currently needs a refinement step on top.

Whatever the source, the parameters have to end up **serialised inside the
`Transform`**, because that is what reaches analysis and the collision service.
And they have to round-trip: the same numbers must reconstruct a model that
visibly moves correctly.

That last requirement is Q19, one layer down. You cannot confirm a kinematic
model is right by reading it — you confirm it by watching it move. Which is why
the visualisation and the maths cannot be allowed to drift, and why the options
listed under Q19 apply here too.

## What is not established

- The size of the nominal-to-as-built error, for any geometry. It is not
  recorded, so it cannot currently be looked up. Judged not to matter for jack
  tables; unexamined for the others.
- The DCM coordinate-system files, beyond their existence.
- Whether Pinocchio's model representation is a comfortable host for
  closed-form inverses, or fights them.
- The long-term maintenance cost of hand-written closed forms per geometry,
  which is the strongest argument against the split suggested above.
- Anything about `GNKinematics` beyond what its source says. Its novelty is not
  assessed here.

## Sources

- [Pinocchio: a fast and flexible implementation of Rigid Body Dynamics algorithms](https://github.com/stack-of-tasks/pinocchio)
- [Pinocchio overview](https://stack-of-tasks.github.io/pinocchio/)
- [PlaCo — Rhoban planning and control](https://github.com/Rhoban/placo)
- [robotics-toolbox-python](https://github.com/petercorke/robotics-toolbox-python)
- [Direct and Inverse Kinematics of a Novel Tip-Tilt-Piston Parallel Manipulator](https://ntrs.nasa.gov/api/citations/20040171839/downloads/20040171839.pdf) (NASA, 2004)
- [Constraint and Inverse Kinematic Analysis of 3-PRS Parallel Manipulator](https://www.academia.edu/69708187/Constraint_and_Inverse_Kinematic_Analysis_of_3_PRS_Parallel_Manipulator)
- [`epicsdeb/pmaccoord` coordinate-system programs](https://github.com/epicsdeb/pmaccoord/tree/master/pmacCoordApp/pmc)
- [`garethnisbet/Robot`](https://github.com/garethnisbet/Robot)
