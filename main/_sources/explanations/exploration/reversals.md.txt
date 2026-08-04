# What we got wrong

Fourteen conclusions that were argued confidently and then reversed. Recorded
because the pattern is consistent and anyone extending this work should assume
they will hit it too.

**The pattern:** a number or an API shape assumed rather than checked, then used
as a premise. In every case the reversal came from either a fact from someone
who knew the system, or from running something. None came from further
reasoning.

That is the whole argument for `benchmarks/` existing, and for keeping this page
rather than quietly editing the conclusions.

## From facts

These came from Tom, correcting the design as it was being written.

**1. "For a flyscan the chunk deadline is milliseconds."**
Chunking is at most 1 Hz, so ~500 ms. This was the premise for
"shared library, not a service", and that conclusion collapsed with it.

**2. "`derived_to_raw` is never called."**
It is — from `sim/_mirror_vertical.py:71` and `_mirror_horizontal.py:39`, inside
user-supplied `set_derived`. Only the *backend* does not call it.

**3. "Analysis needs sync because async needs an event loop."**
Analysis needs `raw_to_derived`, which was already sync for monitor-path
reasons. That says nothing about the inverse. The sync-inverse decision rests on
purity, not on this.

**4. "The certificate carries all positions."**
True for step scans, false for fly. Overgeneralised from one case.

**5. "The branch never needs to reach the `Transform`."**
Same error — a step-scan argument presented as general.

**6. "4.2 ms per inverse means you need a scaled external service."**
The 4.2 ms was diffcalc's *general* solve, enumerating 8 solutions with per-call
object overhead. The branch-fixed vectorised inverse is 0.101 µs/point, 41,000×
faster. The entire external-service argument rested on measuring the wrong
thing.

**7. "The external service may not be needed."**
It exists and is a hard runtime dependency of flyscan execution. Everything that
was said would disappear — fail-closed-on-timeout, backpressure, the latency
budget, the availability dependency — is back.

**8. "Queue and validation are nearly orthogonal."**
Verdicts live on queue entries and are revoked when control leaves the queue.
Validation state *is* queue state. This is the strongest available argument for
superseding blueapi ADR-0003, and it promotes the queue-service reconciliation
from last on the list to an early decision.

## From measurement

These came from running something against real beamline geometry.

**9. "GPU compute is why the collision service must be external."**
Its collision maths is three-mesh-bvh in a Web Worker — CPU — and its Helm chart
requests no GPU. The genuine GPU case is ray-traced narrow phase on RT cores,
which is a different argument. The service should still be treated as external,
but for organisational and geometric reasons, not arithmetic.

**10. "You can't make it headless."**
It runs headless on real i16 geometry with no WebGL context and no DOM. The
apparent dependency was on `render()`'s side effect of refreshing world
matrices, which is one line of pure CPU maths.

**11. "Padding for maximum velocity would over-reject; typical is the pragmatic
trade."**
The trade runs the other way. At 10 Hz the *sound* padding reaches 263 mm
against the ~50 mm applied — under-padded by ~5×, not over-padded.

**12. "The fine tier does not fit in any language"** (~105 s per batch).
That measured triangle checking on every pair at every pose — the fine tier as
the *primary* path, which nobody proposed. In the design the coarse tier names
the pair and the fine tier runs only on that, so cost is flag-rate driven. The
conclusion was circular: it assumed the thing it set out to disprove.

**13. "coal is 9× faster than the JavaScript."**
It is ~6×. The rest was three-mesh-bvh's default `CENTER` split strategy; `SAH`
is a one-line change worth ~1.5×. Part of what was reported as a property of the
language was a property of my defaults.

**14. "Continuous collision detection removes the padding compromise."**
CCD is worth 2–3×, not the order of magnitude assumed. The compromise does go
away — but because the sound sample rates are low (50–400 Hz) and the executor
at 5 kHz already exceeds them by 12–100×, not because of CCD.

## Near misses

Caught by a check rather than by review. Both would have been plausible enough
to ship.

**The natural arc bound is not conservative.** Bounding a swept sphere's arc by
its chord plus the single-arc sagitta, `Σⱼ dⱼ(1 − cos(Δθⱼ/2))`, is wrong for a
kinematic chain: rotating an upstream joint also moves the downstream axes, so
individual arc deviations do not compose additively. Violated by 3.9 mm on i16.
The path-length form `L/2` is rigorous and holds — a point on a path of length
`L` from `p₀` to `p₁` has `|q−p₀| + |q−p₁| ≤ L`, so its distance to the chord is
at most `L/2`.

**A cross-language benchmark measured its own decimation.** Comparing JS and C++
on identically decimated meshes said JavaScript was faster, contradicting the
real-geometry result. Taking every k-th face destroys spatial coherence, and FCL
(oriented boxes) and three-mesh-bvh (axis-aligned) degrade differently under it.
The scripts are kept in `benchmarks/`, labelled as discarded, so nobody repeats
the experiment.

## Two smaller ones about verification itself

**A validation assertion that was wrong, not the code.** The first version of the
distance-routine check asserted two-sided agreement with brute force and failed.
The analytic answer is a true minimum; brute force samples a subset and can only
overestimate. The correct check is one-sided — the analytic result must never
*exceed* a sampled minimum.

**A benchmark that measured the allocator.** The first temporal-BVH descent
pushed `[level, index]` arrays onto a stack and showed the tree 3× *slower* than
the flat scan it was meant to beat. With a flat `Int32Array` stack it is faster.
