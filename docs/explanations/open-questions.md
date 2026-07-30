# Open questions

Ranked by how much they would move the design. Answered ones are kept at the
bottom because knowing a question is closed is worth as much as knowing it is
open.

## Blocking

**Q1. How tight can an automatically-derived coarse model be?**
The binding constraint on the whole design. Fitted spheres leave 63–173 mm of
error on i16 meshes, against 3.3 mm of motion padding at 200 Hz — so the coarse
model, not the sample rate or the checking method, is what decides whether
validation rejects legitimate scans. Hand-authored capsules are ruled out on
cost: mech engineers export meshes and every CAD revision would need
re-authoring. Candidates are medial-axis sphere trees and the mesh's own BVH
nodes at depth 3–4. *Half a day: one detector arm, both approaches, same error
metric.*

**Q2. What is the exemption set?**
The articulated i16 reports 8–12 exact triangle collisions per pose *at the
demoPose its own config ships as valid* — permanently touching parts, mounting
faces, base against first stage, which the config's link-level adjacency rules
do not cover. Until this is right, no false-positive rate measured on that model
means anything, and both the two-tier and temporal-tree results are held back by
it. *A conversation with whoever owns the CAD and the config, not a
computation.*

**Q3. What are the actual joint angular velocities?**
Every padding and sample-rate figure scales linearly with it, and the two
regimes tested (1.6 vs 8 rad/s) swing the required validator rate by 8×. *An
afternoon with whoever owns the motion controllers.*

## Architectural

**Q4. Oriented vs axis-aligned coarse volumes.** BVH-depth rejection saturates
at 80–82% by depth 3–4, which says the limit is the volume's *shape*, not the
count — `three-mesh-bvh` nodes are axis-aligned in the mesh's local frame, so a
rotated arm's world box inflates however finely you subdivide. `coal`'s `OBBRSS`
nodes are oriented boxes and rectangle-swept-spheres, which rotate exactly.
Measuring an OBB descent is the strongest remaining argument for `coal` over the
JavaScript stack.

**Q5. The batch API contract.** Input shape and units, per-point verdicts rather
than a boolean, request-time padding, whether coarse-then-fine happens in one
call, statefulness, transport and concurrency. Being added by the service
author; cheapest to influence now.

**Q6. Where does a replacement certificate come from mid-scan?** If the executor
mints its own, the validator/executor split blurs and the executor is now
solving. If it calls the validator, mid-scan execution depends on a process
that is meant to be non-blocking. Currently unstated either way.

**Q7. Fallback budget cap.** Needs a hard cap plus defined behaviour on
exceeding it — almost certainly "treat as collision and pause". This may be the
*answer* to Q1 rather than a detail: a cap converts an unmeasurable
false-positive rate into a bounded cost, so the design does not need the rate to
be small, only to stay correct when it is not.

**Q8. Latency budget decomposition.** Batches are a few seconds of motion at
5 kHz checked ahead of execution, so the budget is roughly one batch period —
an order of magnitude more headroom than the original 500 ms premise. Still
needs numbers against RTT, queueing, compute and margin.

**Q9. Can a `?` scan start?** Validation is asynchronous and happens after
insertion, so unvalidated entries exist. Adaptive plans can never be validated
and must still run. The rule for when the queue may start an unvalidated entry
is not written down.

## Component-level

**Q10. Raw motors in collision scope have no `DerivedSignalFactory`**, so there
is nowhere to inject a solver, and `bps.mv(raw_motor, x)` inside the scope gets
no checking. Two mechanisms and you want one: per-device injection (invasive,
easy to miss one) or a plan-level `Msg('set')` preprocessor (uniform and
bluesky-native, but a derived `set` decomposes into raw sets *inside*
`set_derived`, below the Msg layer). Settle on a strawman, not a whiteboard.

**Q11. Constraint set as a `Transform` field.** The strawman hardcodes bisecting
mode. Production needs the constraint set carried as a field with dispatch to
the right closed form. This *is* legitimately `Transform` state — it changes the
mapping — whereas branch is not, since it selects among solutions of a fixed
mapping. They look alike and are not.

**Q12. Branch count is mode-dependent.** diffcalc returns 8 solutions for
`{qaz:90, a_eq_b:True, mu:0}`; bisecting mode has 4. Machine-scoped combination
growth depends on this: two devices at 8 branches is 64 per window, three is
512.

**Q13. Does deferred move on the PMAC give coordinated *finish*, not just
synchronised start?** The straight-line-in-joint-space model requires axes to
start and stop together. If each runs at its own velocity, fast axes arrive
early and the path has corners in exactly the region being checked. Too obvious
to mention, and therefore survives review unexamined.

**Q14. Where `Transform` lives** — `ophyd_async.core` today, which means an
analysis pipeline must install ophyd-async to convert angles to hkl. Argues for
extraction into a dependency-light package both depend on. Decide before
transforms proliferate across dodal.

**Q15. Mapping collidable axis names to dodal devices and PVs.** The service
names them (`Gamma`, `Merlin`, `Crystal`, …) and they are recognisable, but
nothing ties them to devices. Small config artefact, needs an owner.

**Q16. `prepare`-per-point overhead in step scans.** One extra Msg per point.
Free in wall-clock terms, but it means the diffractometer participates in every
step, which affects whether a plain `scan()` works unmodified.

**Q17. Does `bps.mv(hkl, ...)` stay?** Confirmed required and must be checked.
It moves to opaque joint values under the hood; consider whether a plan stub
carrying both intent and precomputed values is wanted for readability.

## Answered

**Is the branch-fixed inverse closed-form?** Yes — three independent lines of
evidence, including a flat 0.1 µs/point from 10k to 100k. Demonstrated for
bisecting mode on a six-circle; other constraint modes are analytic in diffcalc
too but each needs its own closed form written and tested.

**Is the vectorised inverse fast enough to stay in-process?** Yes, by a wide
margin — 1.0 ms per 10,000-point chunk, 41,000× the scalar path. Kinematics is
not a constraint anywhere.

**How many bodies are in a real beamline collision model?** Small — i16 has 18
meshes and 10 movable joints, i19 has 9 links and 4. It was the wrong question;
fit quality (Q1) is what binds.

**Is there a sound broad phase?** Two, both measured. A hierarchical sphere
broad phase took a 15,000-point batch from 9.3 s to ~1.3 s; a depth-limited
descent of the mesh's own BVH needs no second model at all and costs the same at
any depth.

**Who declares the collision scope?** The anti-collision service, as a set of
"collidable" axes. Only the mapping to dodal devices remains (Q15).

**Chunk lookahead vs deceleration.** Checking runs ahead of motion, so lookahead
equals batch duration — seconds. Remaining: pin the pipeline depth and confirm
`check latency + stop time ≤ batch duration`.

**Can the collision service run headless?** Yes — proven on real geometry with
no WebGL context and no DOM. The apparent dependency was on `render()`'s side
effect of refreshing world matrices, which is one line of pure CPU maths.
