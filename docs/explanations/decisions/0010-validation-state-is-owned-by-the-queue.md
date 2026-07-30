# 10. Validation state is owned by the queue

## Status

Accepted

## Context

The original design assumed validation could be a stateless dry-run endpoint,
which would have kept it independent of queueing and avoided touching blueapi
ADR-0003 ("No Queues").

That is not how it works. A verdict is applied to a queue entry after insertion,
and is revoked when control leaves the queue — if anyone moves the beamline
outside the queue, every verdict is discarded and affected scans are rechecked.

## Decision

Validation verdicts are held on queue entries. The queue is the authority on
whether the beamline is under its control, and therefore on whether a verdict is
still meaningful.

An entry has one of four states, not two: queued or in progress (⏳), validated
(✓), failed (✗), and not validatable (?).

Every entry starts at ⏳, and **⏳ is the queue's own bookkeeping** — the queue
holds an entry there while the validator works. The validator never returns it;
it returns exactly one of ✓, ✗ or ?. The validator produces results, the queue
tracks progress.

## Consequences

**Validation is not separable from queueing.** You cannot express "this scan is
validated, and here is what would invalidate it" without somewhere stateful to
hang it. This is the strongest available argument for superseding blueapi
ADR-0003 — stronger than "users want queueing", because it is structural rather
than a feature request.

It promotes reconciliation with the existing `daq-queuing-service` from a late
task to an early architectural decision, since that service is the obvious place
for verdicts to live.

The certificate travels the same way. The validator returns it to the queue
rather than handing it to the executor, and the queue pushes it down with the
task — so it is held against the entry and revoked by the same rule that revokes
the tick. The two processes never talk to each other directly, which keeps the
validator's read-only isolation intact and means there is one place that knows
whether a scan is ready to run.

The fourth state matters more than it looks. An adaptive plan cannot be
listified in advance and so can never be validated up front (?), but it must
still run. That makes the **unvalidated path the base case** and the certificate an
optimisation on top of it — not a prerequisite. It also means the runtime check
and the select-and-check-now path carry the real weight, and must be correct on
their own.

A rule is still needed for whether the queue may start a ⏳ entry — queued for
validation, but not yet validated.
