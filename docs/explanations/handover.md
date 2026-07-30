# Handover — validation architecture for Bluesky at DLS

Seed document for `coretl/bluesky-architecture`. Written across a web session
that worked out the shape of insertion-time and runtime scan validation, then
built a strawman to settle the two load-bearing unknowns.

Where a decision has reasoning attached, the reasoning matters more than the
conclusion — many conclusions here were reversed when an assumption turned out
to be wrong, and the reasoning usually survived the reversal.

:::{admonition} Status: partially superseded
:class: warning

This is the **original seed document**, kept for its reasoning. Since it was
written, twelve of its conclusions have been reversed — six by facts from Tom,
six by measurement on real beamline geometry. Superseded passages are marked
inline; the reversals are catalogued under *Corrections*, and the evidence is
in [](collision-libraries.md) with runnable scripts in `benchmarks/`.

**The two biggest reversals:** the queue and validation questions are *not*
orthogonal (see Scope note), and the collision model's binding constraint is
neither kinematics nor body count but the tightness of the coarse geometric
model (see D18, O12, O18).
:::

---

## Pinned references

| Thing | Version / SHA |
|---|---|
| blueapi | `b767635920d1675bc4db58c6bbf80c29378aa3f7` |
| bluesky-queueserver | `0a084cfb722308f384847c24e6a43a8f572f302e` |
| scanspec `v2-dev` | `9a1d6364e09ce85788db0fa2839b638a143ba455` |
| ophyd-async | 0.20.1 |
| bluesky | 1.15.1 |
| diffcalc-core | as on PyPI, July 2026 |
| anti-collision service (`garethnisbet/Robot`) | `f7875dd`, master |

Use these for permalinks so meeting attendees are looking at the same code.

---

## Scope note

The task as set was "add queueing to blueapi, plus validation". What emerged is
that ~~the queue question and the validation question are nearly orthogonal~~.

> **Superseded (correction 8).** They are not orthogonal. Validation verdicts
> are held *on queue entries* and are revoked when control leaves the queue, so
> validation state is owned by the queue. That makes it stateful and
> queue-coupled, and it is the strongest available argument for superseding
> blueapi ADR-0003 — stronger than "users want queueing", because you cannot
> express "this scan is validated, and here is what would invalidate it"
> without somewhere stateful to hang it. It also promotes the
> `daq-queuing-service` reconciliation from last on the list to an early
> decision, since that is the obvious place for the verdicts to live.

The substance of the design does still sit in ophyd-async and scanspec rather
than in blueapi, and the piece with real design risk is still not the one on
the ticket. That part stands.

---

## Decisions taken

### D1. Validation runs in a second, read-only subprocess

blueapi's task worker runs one task at a time in the subprocess that holds the
devices. Validation must work while a scan runs, so it needs its own process.

Consequences:
- It sees **live** PVs, so mid-scan it sees a machine in flight. Insertion
  validation must therefore validate against the *projected end state* of the
  running task, not the instantaneous state.
- Interacts with blueapi **ADR-0005** ("connect all dodal devices during
  startup"). A second subprocess connecting everything doubles the CA footprint.
  Probably needs a device-subset concept, which blueapi does not have.

### D2. Insertion validation is a solver, not a validator

It does two things: coarse anti-collision against simplified models, and
selection of a kinematic branch that works across the scan. It emits state that
execution depends on. The verdict is a side effect.

### D3. The certificate has two parts

- **Choices** — per-window branch/constraint assignment, covering only the
  choice-offering devices.
- **Preconditions** — the assumed state of every device contributing to the
  collision model, including ones not participating in the scan.

Preconditions give a mechanically-checkable invalidation rule. They need
*monitoring*, not a single check at start — see the i19 optics-hutch case, where
another hutch can move shared equipment mid-scan.

Requires a declared **collision scope**: a beamline config artifact listing which
devices participate. Without it the precondition set tends toward "every device
on the beamline".

### D4. The certificate is a recipe, not a result

Precomputing all joint positions works for step scans and fails for fly, for
three independent reasons: size (an hour at 20 kHz is ~72M points × 6 axes),
streaming (chunk N+1 is generated while N executes), and densification happening
at runtime by construction.

So the branch must reach runtime IK. It cannot be resolved away at insertion.

### D5. `Transform` stays synchronous, both directions

- **Forward is forced.** `raw_to_derived` is called from the monitor callback
  path (`_make_derived_readings`, `get_locations`). Async there means task
  scheduling, ordering and backpressure on every derived signal update.
- **Inverse is chosen.** Once branch and constraints are fixed the inverse is
  believed closed-form (see O1). Sync enforces that `Transform` is pure maths:
  portable to analysis, cacheable, testable without hardware, runnable in a
  subprocess. Admitting I/O makes every downstream assumption conditional.

These are two different decisions that look like one. If the inverse is
revisited later, that should not drag the forward into the discussion.

### D6. `Transform` in RunStart; certificate separate

Transform carries forward maths plus geometry parameters (UB, wavelength,
offsets) — exactly what analysis needs. Branch is **not** a `Transform` field,
because the instance on the device is the one that gets serialised and branch
must not reach analysis.

Branch is an explicit argument at the inverse call site. The solver holds
`(transform, branch)` as a pair.

### D7. `Transform` must be array-safe

"Write the maths once, works for scalars or arrays" already holds via numpy
broadcasting for simple transforms. It does **not** hold for diffcalc, whose
Python API is scalar and loops internally.

So a diffractometer's forward transform should be **the maths written directly in
numpy**, not a call into diffcalc. This means owning a second implementation —
round-trip test against diffcalc as the oracle.

Contract change is documentation + a property test (run every registered
transform with scalars and with length-1 arrays, assert agreement), not API.

### D8. `Transform` needs a type discriminator, and probably its own package

`model_dump_json()` currently gives `{"distance": 2.0}` with no type tag.
Analysis receives JSON and must reconstruct the class. Fix: the
`discriminated_union_of_subclasses` pattern scanspec already uses.

Packaging: `Transform` lives in `ophyd_async.core`, so an analysis pipeline must
install ophyd-async to convert angles to hkl. Argues for extraction into a small
dependency-light package that both ophyd-async and analysis depend on — same
shape as scanspec. Decide before transforms proliferate across dodal.

### D9. Layered Transforms, not merged

hkl→cartesian and cartesian→joint stay separate. The collision checker works in
joint space and should not care that hkl was involved.

### D10. The collision model consumes raw axis values, not Transforms

Raw motors with no derived signals contribute geometry. So the model cannot be
built from Transforms — it takes a vector of raw positions, places bodies in a
common frame, and reports interference.

A raw motor with no Transform is the base case; derived signals are what add
something on top.

### D11. Selection is machine-scoped; enumeration is device-scoped

Each device can enumerate its own candidate branches. **Choosing** is a joint
constraint-satisfaction problem across devices — two diffractometers give 8×8
combinations per window, and a combination can work when neither device's locally
preferred choice does.

Solver interface takes a window's derived targets across all participating
devices and returns a consistent assignment.

### D12. The solver hook is for collision-constrained devices, not multi-valued ones

A 2-jack system needs no branch selection but still needs anti-collision on its
`set`. Defaulting the factory's solver to `None` for single-valued devices would
leave the hole open on exactly the devices you'd assume were safe.

**Zero branches and no checking are different states.** Use an explicit null
solver that raises, not `None`.

### D13. Failure taxonomy

- **Infeasible** — collision involves only choice-free devices. No search helps.
  Report immediately; also a pruning strategy, since it's cheap to check first.
- **Unsatisfiable** — choices exist, no assignment works. Report after search,
  naming the window and the binding constraint.

### D14. `prepare` per window, for both step and fly

scanspec2's `_step_windows` yields one Window per setpoint, so per-window branch
is per-point branch for step scans, with no special case.

```
for window in scan:
    prepare(device, window, certificate[window])
    if window.moving_axes:  kickoff / complete
    else:                   set(hkl) / trigger / read
```

Rule: `set` with a prepared branch applies it and skips checking (the certificate
already validated that point and the path to it). `set` without a prepared branch
selects and checks now. `bps.mv(h, ...)` is the second case and needs no special
handling.

### D15. `prepare` is consumed, not sticky

Stale-branch hazard: prepare for window 7, something intervenes, `set` applies
window 7's branch at a different position. Fails silently by moving somewhere
plausible and wrong.

- Certificate entries carry the hkl they were solved for; `set` asserts the
  request matches before applying, and raises on desync.
- `prepare` clears after one `set`, so an unprepared `set` always falls through
  to select-and-check.

### D16. Devices with injected solvers are not standalone

A diffractometer with a multi-valued inverse and collision constraints cannot be
pure device code. Sim and unit tests inject a trivial solver; production injects
the real one.

This is a departure from how ophyd-async devices work today and should be an
explicit decision, not an implementation detail. The forward path stays pure —
monitor updates, analysis and descriptors are unaffected.

**Loop hazard:** the validation subprocess instantiates devices; if devices
reference a solver, and the solver is what the subprocess exists to serve, that
is a cycle. It needs devices for *state*, not for *setting*, so it injects a null
solver that raises on any inverse call. Absence of a solver must raise, never
fall back to unchecked motion.

### D17. scanspec2 is the trajectory representation

`WindowGenerator.setpoints(indexes: np.ndarray) -> dict[axis, np.ndarray]`
evaluates at arbitrary fractional indexes, so you densify to 20 kHz, validate
that array, and push that same array. No second interpolator to disagree with.

`Window` is "a contiguous stretch of motion during which detectors are
triggered", windows separated by turnarounds, `calculate_turnaround` externalised
to the caller. Branch changes happen in turnarounds.

**Turnaround trajectories are in joint space and need collision checking, and
scanspec does not produce them.** Easy to forget for exactly that reason.

### D18. The simplified collision model must be conservative

The two-tier scheme (simplified fast path, fine model on flagged points) is only
sound if the simplified model never produces a false negative. So it must be a
strict over-approximation.

This reframes the fine model: **it is a false-positive filter, not a safety net.**
It recovers scans the conservative model over-flags; it does not catch what the
conservative model missed. Do not "unpad" the simplified model — that trades
soundness for a smaller fallback rate.

Padding decomposes into independent sources, and which apply differs by phase:
- **Sampling gap** — dominates at 10 Hz insertion, ~zero at 20 kHz runtime. This
  is the only component that legitimately shrinks.
- **Following error** — same at both phases, does not shrink with sample rate.
- **Geometric conservatism** — bounding volumes are already larger than the real
  bodies. Free, and it is what makes the fallback sound.

> **Amended (corrections 9, 11, 12).** The decomposition is right and the
> soundness argument is right, but three things have changed underneath it.
>
> *The production scheme deliberately breaks it.* Padding is for **typical**
> rather than maximum velocity, knowingly accepting occasional false negatives,
> because maximum-velocity padding would reject too many legitimate scans. That
> is exactly what this decision forbids, and it is defensible only because D21
> says this is soft machine protection. D18 and D21 have to be rewritten as a
> pair: D18 alone reads as a safety argument, and D21 is what licenses breaking
> it.
>
> *The trade is in the opposite direction from the one assumed.* Measured, the
> sound sampling-gap term at 10 Hz reaches **263 mm** on i16, against the ~50 mm
> the current scheme pads. The scheme is under-padded by roughly 5x in the worst
> case, not over-padded. And the sound term is *computable* per interval from
> commanded motion rather than guessed — see `bench_validator.mjs`.
>
> *Geometric conservatism is not free, and it dominates.* This bullet assumes
> bounding volumes are only slightly larger than the bodies. Measured on i16,
> approximating the meshes with fitted spheres leaves a mean error of
> **63-173 mm** depending on sphere count — 20-50x the sampling-gap term at
> 200 Hz. Whichever coarse primitive is chosen, its fit quality is the binding
> constraint, not the padding. See O18.
>
> One thing to add rather than correct: the coarse tier must report **which
> pair** is implicated, not just a boolean per point, or the fine tier cannot be
> restricted to the flagged pairs and the two-tier scheme buys nothing. The
> strawman's `SimpleModel.check()` returns `.any(axis=-1)` and gets this wrong.

### D19. No diffractometer maths at runtime, in either direction

Forward diffcalc at 83 µs/point is 830 ms for a 10k chunk — over budget on its
own. The only transform runtime can afford is forward kinematics, to place
geometry.

### D20. Vectorisation is mandatory on the runtime path

Not an optimisation. A per-point callable API is disqualified — see M2.

> **Still true, weaker justification.** M2 measured in-process per-point
> collision checking, which is no longer the design. What remains on the
> per-point path is the coarse geometric tier, and that is still emphatically
> vectorisation-bound: measured at 7-24 us/pose vectorised against milliseconds
> per pose for anything per-point.

### D21. Anti-collision here is soft machine protection, not a safety function

Catastrophic cases are guarded at the robot level and by door interlocks. This
layer handles constraints too dynamic to guard there (e.g. detector must be 20 mm
from sample, entry points within a 90° arc).

State this in the ADR in these words. It determines whether independence of
implementation is required, and it is the claim most likely to be quietly
misunderstood by someone joining later.

> **Promoted to load-bearing.** This started as a scoping remark. It is now the
> decision that licenses two others: the deliberate under-padding in D18, and
> making flyscan execution depend on an external network service. Neither is
> defensible for a safety function. If anyone ever reclassifies this layer, both
> have to be revisited — and that reclassification is exactly the kind of thing
> that happens quietly.

---

## Measurements

All taken in a container against synthetic setups. Good for order of magnitude,
**not** valid as design inputs for a real beamline. Re-measure on real geometry
before sizing anything.

### M1 — diffcalc (Si lattice, identity U)

| Operation | Cost |
|---|---|
| `get_hkl` (angles → hkl) | 83 µs |
| `get_position` (hkl → angles) | 4162 µs, **8 solutions** |
| `HklCalculation` construction | 51 µs |

~50× asymmetry, and it falls along the line that matters. The ~520 µs per
solution is largely Python object overhead, which is the evidence behind O1.

Note `_make_transform_from_readings` rebuilds the Transform on every reading, so
the monitor path currently pays 51 µs + 83 µs. Caching the instance while its
parameter readings are unchanged is a cheap win.

### M2 — vectorised vs per-point, 6-DOF chain + 10 bodies vs 8 obstacles

| | 10,000 points |
|---|---|
| vectorised FK | 20 ms |
| vectorised collision | 71 ms |
| **total** | **92 ms** |
| per-point Python loop | **673 ms** |

Budget is ~500 ms per chunk (1 Hz chunking). Vectorised fits in a fifth of it;
per-point is over budget with a *toy* model. A realistic simplified model at ~30
capsules vs ~20 obstacles is ~600 pairs rather than 80, so roughly 7× — around
500 ms, right at the limit. That is the horizontal-scaling justification.

---

## Strawman results

Code in `strawman/`. 24 tests, all passing. Built specifically to settle O1 and
O2; both are now answered, and the answer to O2 changes the architecture.

### M3 — O1 is answered: the branch-fixed inverse is closed-form

Three independent lines of evidence:

1. **diffcalc contains no numerical root-finding in the inverse.** The only
   `scipy.optimize` use in the entire package is `ub/fitting.py` — UB matrix
   refinement, not hkl→angles. So the 4.2 ms is Python object overhead and
   enumeration, not iteration.
2. **A closed-form inverse was written and round-trips to 1e-15** over 496
   reflections, for all four branches, in bisecting mode.
3. **Cost is flat per point** — 0.101 µs/point at both 10k and 100k points.
   Iteration would not do that. There is a test asserting this property.

The branch structure turned out to be two independent binary sign choices:
`delta_sign` and `chi_flip`. Note that **`delta_sign` changes the chi/phi solve**,
not just the sign of delta — the scattering vector points along −x in the eta
frame rather than +x. Getting this wrong produced two branches that silently
failed to round-trip; the property test caught it.

### M4 — O2 is answered, and the answer is not what was expected

| operation | 10,000-point chunk |
|---|---|
| branch-fixed inverse, vectorised | **1.0 ms** |
| diffcalc scalar inverse, same work | 41,600 ms |
| forward, vectorised | 5.9 ms |
| full chunk: IK + simple collision (6 bodies) | **12.2 ms** |
| whole-scan insertion, 1-hour scan @10 Hz (36k pts) | 44 ms |

**Kinematics is not the constraint.** A 41,000× speedup over the scalar path
puts IK at 0.2% of the 500 ms chunk budget.

### M5 — collision checking is the binding constraint, and it is O(n²)

Best-of-7 timings, 2,000 points, extrapolated to a 10k chunk:

| pairs | est. per 10k chunk | |
|---|---|---|
| 100 | 46 ms | fits |
| 300 | 137 ms | fits |
| 600 | 274 ms | fits |
| 1000 | 457 ms | at the limit |
| 3000 | 1371 ms | over |

**In-process crossover is ~1000 pairs, roughly 47 bodies, with naive
all-pairs.** A two-level broad-phase sketch gave 4–8×, which would move the
crossover to ~4000–8000 pairs. That sketch is *unsound* — it skips intra-group
pairs — and was written only to size the speedup.

⚠️ Container timings for collision varied up to 5× between runs and one
configuration was OOM-killed. Best-of-7 figures are reported. The IK numbers were
stable and repeatable; the collision numbers should be treated as
order-of-magnitude only.

> **Superseded, and a process lesson.** This table has **no runnable artefact** —
> it was never in `bench.py` and existed only in a chat transcript, despite
> being the number the whole architecture was then sized against. It is also
> wrong in premise: it models in-process sphere-vs-sphere all-pairs, and the
> real question turned out to be the fit quality of the coarse model, not the
> pair count. `benchmarks/` exists so this cannot recur; every figure in
> [](collision-libraries.md) has a script behind it.

### What this changes

**The external multi-process/multi-machine compute service may not be needed.**
That was assumed from diffcalc's 4.2 ms, which turned out to be the wrong number
to design against. If it is not needed, the following all disappear:

- fail-closed-on-timeout semantics in a machine-protection path
- backpressure design and its coupling to scan rate
- latency budget decomposition (O8)
- an availability dependency where the validator being down stops flyscans

That is a large simplification, and it now hinges on a single number nobody has
measured: **how many bodies are in a real DLS beamline collision model** (O12).

> **Reversed twice (corrections 7 and 10).** First: collision checking *is* an
> external GPU-backed service, decided independently of this analysis, so
> everything in the "disappears" list is back — fail-closed-on-timeout,
> backpressure, O8, and the availability dependency.
>
> Then, measured: the body count is small (i16 has 18 meshes, 10 movable
> joints), so it was never going to be the constraint. And the service's
> collision maths is CPU, not GPU — three-mesh-bvh in a Web Worker, with no GPU
> resource in its Helm chart. The genuine GPU case is ray-traced narrow-phase on
> RT cores, which is a different argument from the one originally made.
>
> The net position: the service exists and is a hard runtime dependency, so
> design for it; but the reason is organisational and geometric, not the
> arithmetic in M4/M5.

### Bugs the property tests found

Both were in code written while designing this, and both would have shipped:

1. `delta_sign=-1` branches did not round-trip — the chi/phi solve needs to
   change with the sign, which was not obvious from the derivation.
2. `TwoJackTransform.derived_to_raw` had a malformed dict merge that no test
   reached until a round-trip test was added for the single-valued case.

**Strong argument for making round-trip a framework-level property test** over
every registered transform (D7), rather than something each implementer
remembers to write.

---

## Open questions

**O1. ~~Is the branch-fixed inverse closed-form?~~ ANSWERED — yes.** See M3.
D5, D6 and the solver split stand. Caveat: demonstrated for bisecting mode on a
six-circle. Other constraint modes are analytic in diffcalc too (no root-finding
anywhere), but each needs its own closed form written and tested.

**O2. ~~Timing of the vectorised branch-fixed inverse?~~ ANSWERED — 1.0 ms per
10k-point chunk.** See M4. Kinematics is a non-issue. The question has moved to
O12.

**O12. ~~How many bodies are in a real beamline collision model?~~ ANSWERED —
small, and it was the wrong question.** Read straight out of the collision
service's own configs: i16 has 18 meshes and 10 movable joints, i19 has 9 links
and 4. Well inside anything tractable. The binding constraint turned out to be
the *fit quality* of the coarse model, not the number of bodies — see O18.

**O13. ~~Sound broad-phase implementation.~~ ANSWERED — two of them, both
measured.** A sound hierarchical sphere broad phase (body bounding sphere
provably enclosing its leaves, descend only on overlap) took a 15,000-point
batch from 9.3 s to ~1.3 s. Separately, a depth-limited descent of the mesh's
*own* BVH needs no second model at all, is conservative by construction, and
costs the same at any depth. See `bench_coarse2.py` and `bench_bvhdepth.mjs`.

**O16. What are the actual joint angular velocities on DLS diffractometers?**
*This is now the number that decides the validator.* Every padding and sample
rate figure scales linearly with it, and the answer swings the required
validator rate by 8x between the two regimes tested (1.6 vs 8 rad/s). An
afternoon with whoever owns the motion controllers.

**O17. The exemption set.** The articulated i16 reports 8-12 exact triangle
collisions per pose *at the demoPose its own config ships as valid* — permanently
touching parts, mounting faces, base against first stage. The config's
link-level adjacency rules do not cover them. Until this is right, no
false-positive rate measured on this model is trustworthy, and both the two-tier
and temporal-tree results are held back by it.

**O18. How tight can the coarse model be made, automatically?** The binding
constraint on the whole design. Fitted spheres leave 63-173 mm of error on i16
meshes, against 3.3 mm of motion padding at 200 Hz. Hand-authored capsules are
ruled out on cost — mech engineers export meshes and every CAD revision would
need re-authoring. So the coarse model must be derived automatically, and the
question is whether anything automatic reaches single-digit mm on plate-like and
open-frame geometry. Candidates: medial-axis sphere trees, and the mesh's own
BVH nodes at depth 3-4.

**O19. Oriented vs axis-aligned coarse volumes.** BVH-depth rejection saturates
at 80-82% by depth 3-4, which says the limit is the volume's *shape*, not the
count: `three-mesh-bvh` nodes are axis-aligned in the mesh's local frame, so a
rotated arm's world box inflates however finely you subdivide. `coal`'s `OBBRSS`
nodes are oriented boxes and rectangle-swept-spheres, which rotate exactly.
Measuring an OBB descent is the strongest remaining argument for coal over the
JS stack — stronger than its 6x raw speed, because it attacks the binding term.

**O14. Constraint set as a Transform field.** The strawman hardcodes bisecting
mode. Production needs the constraint set carried as a field with dispatch to the
right closed form. Note this *is* legitimately Transform state (it changes the
mapping) whereas branch is not (it selects among solutions of a fixed mapping) —
a distinction worth stating carefully, because they look alike.

**O15. Branch count is mode-dependent.** diffcalc returned 8 solutions for
`{qaz:90, a_eq_b:True, mu:0}`; bisecting mode has 4. Combination growth in the
machine-scoped solver (D11) depends on this: two devices at 8 branches each is 64
per window, three is 512. The strawman caps combinations at 256 and raises.

**O3. Raw motors in collision scope have no `DerivedSignalFactory`**, so there is
nowhere to inject a solver. `bps.mv(raw_motor, x)` inside the collision scope
gets no checking.

Two mechanisms, and you want one, not both:
- Per-device injection — invasive, easy to miss one.
- Plan-level `Msg('set')` preprocessor — uniform across raw and derived, and the
  bluesky-native idiom. But a derived `set` decomposes into raw sets *inside*
  `set_derived`, below the Msg layer, so the preprocessor sees the hkl target and
  must project it through the transform, which is the solver's job again.

Settle on the strawman, not the whiteboard.

**O4. Does deferred move on the PMAC give coordinated *finish*, not just
synchronised start?** The straight-line-in-joint-space model requires axes to
start and stop together. If each axis runs at its own velocity, fast axes arrive
early and the path has corners in exactly the region being checked. State the
answer explicitly in the ADR — it is too obvious to mention and therefore
survives review unexamined.

**O5. `prepare`-per-point overhead in step scans.** One extra Msg per point. Free
in wall-clock terms but it means the diffractometer participates in every step,
which affects whether a plain `scan()` can be used unmodified.

**O6. Fallback budget cap.** *Promoted — this may be the answer to O18 rather
than a detail.* If the simplified model flags 200 points and the fine check is
5 ms each, that is a second of unbudgeted work. Needs a hard cap plus defined
behaviour on exceeding it — almost certainly "treat as collision and pause".
Without a cap, 500 ms is a best case rather than a bound.

A cap also converts an *unmeasurable* quantity into a bounded one. The coarse
tier's false-positive rate cannot currently be measured (O17) and may never be
reliably predictable. With a cap the design does not need it to be small — it
needs to stay correct when it is not. That is a stronger position than getting
the number, and it should be stated that way in the ADR.

**O7. ~~Chunk lookahead vs deceleration.~~ LARGELY ANSWERED.** Checking happens
*ahead* of the motion: the first batch is validated while the motors move to
start, and each subsequent batch while the previous one executes. Lookahead
therefore equals batch duration, a few seconds, comfortably more than
deceleration time. What remains is pinning the pipeline depth and confirming
`check latency + stop time <= batch duration`.

**O8. Latency budget decomposition.** *Reframed and relaxed.* The budget is not
500 ms: batches are a few seconds of motion at 5 kHz (~15,000 points), checked
ahead of execution, so the budget is roughly one batch period. That is an order
of magnitude more headroom than assumed. Still needs numbers against RTT,
queueing, compute and margin before committing.

**O9. ~~Collision scope declaration~~ MOSTLY ANSWERED.** The anti-collision
service declares which axes are "collidable" — typically a handful of motors per
beamline that can reach each other; everything else is static and lives in the
point cloud. What remains open is the *mapping* from those names to dodal
devices and EPICS PVs, and who owns it. The service's config joint names
(`Gamma`, `Merlin`, `Crystal`, ...) are recognisable but not yet tied to
anything.

**O10. Where `Transform` lives** — ophyd-async vs standalone package (D8).

**O11. Does `bps.mv(hkl, ...)` stay?** Confirmed required and must be
collision-checked, which D14 handles. But it moves to opaque joint values under
the hood; consider whether a plan stub carrying both intent and precomputed
values is wanted for readability and debugging.

---

## Corrections made during the conversation

Recorded because each was argued confidently and then reversed on a fact from
Tom. Anyone extending this should assume the same failure mode.

1. **"For a flyscan the chunk deadline is milliseconds."** Wrong. Chunking is at
   most 1 Hz, so ~500 ms. This was the load-bearing premise for "shared library,
   not a service", and that conclusion collapsed with it.
2. **"`derived_to_raw` is never called."** Wrong — called in
   `sim/_mirror_vertical.py:71` and `_mirror_horizontal.py:39`, inside
   user-supplied `set_derived`. Only the *backend* does not call it.
3. **"Analysis needs sync because async needs an event loop."** Wrong — analysis
   needs `raw_to_derived` (forward), which was already sync for monitor-path
   reasons. Said nothing about the inverse. D5's inverse half rests on purity,
   not on this.
4. **"The certificate carries all positions."** True for step scans, false for
   fly. Overgeneralised from one case.
5. **"The branch never needs to reach the Transform."** Same error — a step-scan
   argument presented as general.
6. **"4.2 ms per inverse means you need a scaled external service."** The 4.2 ms
   was diffcalc's *general* solve — enumerating 8 solutions with per-call Python
   object overhead. The branch-fixed vectorised inverse is 0.101 µs/point, 41,000×
   faster, and the whole external-service argument rested on measuring the wrong
   thing. Collision checking, which nobody had measured, turned out to be the
   binding constraint. See M4/M5.

The pattern in all six: a number or an API shape assumed rather than checked,
then used as a premise. The strawman exists because reasoning was not settling
these; forty lines of code did.

### Corrections 7-12, after the seed document

7-8 came from Tom; 9-12 from measurement on real i16 geometry. Same pattern,
same lesson.

7. **"The external service may not be needed."** It exists and is a hard runtime
   dependency of flyscan execution. Everything the "What this changes" section
   said would disappear is back. *But* the stated reason — GPU compute — does
   not hold up: the service's collision maths is three-mesh-bvh in a Web Worker,
   which is CPU, and its Helm chart requests no GPU. The real GPU case is
   ray-traced narrow phase on RT cores.
8. **"Queue and validation are nearly orthogonal."** Verdicts live on queue
   entries and are revoked when control leaves the queue. Validation state is
   queue state. See the Scope note.
9. **"Padding for maximum velocity would over-reject; typical is the pragmatic
   trade."** The trade runs the other way. At 10 Hz the sound padding reaches
   263 mm against the ~50 mm actually applied, so the scheme is *under*-padded
   by ~5x, and the tick means "probably" for a bigger reason than assumed.
10. **"The fine tier does not fit in any language"** (~105 s per batch). That
    measured triangle checking on every pair at every pose — the fine tier as
    the *primary* path, which nobody proposed. In the design the coarse tier
    names the pair and the fine tier runs only on that, so the cost is flag-rate
    driven. The conclusion was circular.
11. **"coal is 9x faster than the JavaScript."** It is ~6x. The rest was
    three-mesh-bvh's default `CENTER` split strategy; `SAH` is a one-line change
    worth ~1.5x. Part of what was reported as a property of the language was a
    property of my defaults.
12. **"Continuous collision detection removes the padding compromise."** CCD is
    worth 2-3x, not the order of magnitude assumed. The compromise does go away,
    but because the sound sample rates are low (50-400 Hz) and the executor at
    5 kHz already exceeds them by 12-100x — not because of CCD.

Two further near-misses worth recording, both caught by a check rather than by
review:

- The natural arc-inflation bound, `sum_j d_j (1 - cos(dtheta_j/2))`, is **not
  conservative for a kinematic chain** — rotating an upstream joint moves the
  downstream axes, so arc deviations do not compose additively. Violated by
  3.9 mm on i16. The path-length form `L/2` is rigorous and holds.
- A cross-language comparison on decimated meshes said JavaScript beat C++,
  contradicting the real-geometry result. Taking every k-th face destroys
  spatial coherence and the two libraries degrade differently under it. The
  experiment measured the decimation; it is kept in `benchmarks/` labelled as
  discarded.

---

## Proposed ADRs

Two classes. **System ADRs** are cross-cutting and live in this repo
permanently. **Component ADRs** are destined for blueapi — draft them at the path
and number they will eventually occupy, in blueapi's Nygard template, with
`Status: Proposed`, so landing them later is a file move. blueapi's sequence ends
at 0006, so start at 0007.

System:
- Anti-collision is soft machine protection, not a safety function (D21)
- Validation requires device objects (the premise correction — `check_limits_async`
  iterates the real generator against real device objects; no serialised
  representation substitutes)
- Certificate structure: choices, preconditions, recipe-not-result (D3, D4)
- Transform/Solver split and the sync/async boundary (D5, D11, D12)
- Simplified model must be conservative; fine model is a false-positive filter
  (D18)

Staged for blueapi (`staged/blueapi/docs/explanations/decisions/`):
- 0007 — plan dry-run endpoint
- 0008 — validation subprocess and device subset (D1, and the ADR-0005
  interaction)

Also needed but with no ADR tradition to land in: the ophyd-async changes (D5–D8,
D16). These stay system ADRs here and become design proposals or issues later.

---

## Suggested order of work

> **Superseded.** The original list led with O12, which has since been answered
> and turned out to be the wrong question. Kept below for the reasoning; the
> current list is first.

### Current

1. **Get the exemption set right (O17).** Nothing downstream can be trusted
   until the model stops reporting 8-12 collisions per pose at its own valid
   pose. Every false-positive figure, the two-tier result and the temporal-tree
   result are all gated on this. It is a conversation with whoever owns the CAD
   and the config, not a computation.
2. **Get the joint velocities (O16).** One afternoon, and every padding and
   sample-rate number scales linearly with it.
3. **Try one automatic coarse model properly (O18/O19).** Take a single detector
   arm, fit it with a medial-axis sphere tree *and* read off `coal`'s OBB/RSS
   BVH nodes at depth 3-4, and run the same fit-error metric on both. This is
   the binding constraint on the whole design and it is a half-day.
4. **Write the ADRs.** Most are a page and the evidence now exists. D18 and D21
   have to be rewritten as a pair, and the failure-mode taxonomy needs the
   flag-rate framing rather than the pair-count one.
5. **Traces of blueapi and bluesky-queueserver.** Unchanged from the original
   list and still not done — mermaid sequence diagrams in identical notation,
   process boundaries marked, permalinked to the pinned SHAs, plus a capability
   comparison table. For other people's benefit, before the wider meetings.
6. **Phase 0 reconciliation with `DiamondLightSource/daq-queuing-service`.**
   Promoted from last: correction 8 makes the queue the owner of validation
   state, so where the verdicts live is an early architectural decision rather
   than a later one.
7. **Port the round-trip property test into ophyd-async.** Unchanged, still
   cheap, still worth it.

### Original

1. **Measure O12** — the body count of a real beamline collision model. It is
   now the only thing standing between you and knowing whether this is a
   single-process design or a distributed one, and it is probably a morning's
   work. Everything else is cheaper to decide once you know.
2. **Write the ADRs.** Most are a page, and the strawman has now supplied
   evidence for the two that were previously speculative. This conversation
   plus `strawman/` is the only record.
3. **Port the round-trip property test into ophyd-async.** It found two real
   bugs in a few hundred lines of carefully-written code. It is cheap, it is
   framework-level, and it will immediately reveal which existing transforms
   were only ever written in one direction.
4. **Traces of blueapi and bluesky-queueserver**, still not built. Mermaid
   sequence diagrams in identical notation, process boundaries marked,
   permalinked to the pinned SHAs, plus a capability comparison table. These are
   for other people's benefit — do them before the wider meetings, after the
   strawman.
5. **Phase 0 reconciliation with `DiamondLightSource/daq-queuing-service`**,
   raised at the start and still not done. It is an existing DLS queue-in-front-
   of-blueapi service with per-beamline "converters", ~99 commits, 21 open
   issues. Either it is the starting point for the queue work or there is a
   reasoned statement of why not.

---

## Context that has not been actioned

- **blueapi ADR-0003 "No Queues"** (2023-05-22, Accepted) says queueing is
  another service's responsibility and the API must be kept queue-free. Likely to
  be superseded, but the validation endpoint does not depend on it. Do not couple
  them.
- **bluesky-queueserver already validates twice** — at submission and immediately
  before execution. But validation is signature/type/permission checking driven
  from `existing_plans_and_devices.yaml`, deliberately namespace-free so queue
  operations work before the environment is open. The hooks exist; the
  device-aware world model does not.
- `manager.py` is 4,041 lines and `profile_ops.py` is 4,206 — largely the
  machinery for reconstructing plan signatures without the worker namespace. That
  is the price of a namespace-free validator, and the quantitative form of the
  "unwieldy" claim.
