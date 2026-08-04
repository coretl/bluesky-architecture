# A pitch: merge blueapi and bluesky-queueserver

For DLS and NSLS-II, as a **collaborative rewrite specced by both parties**,
started by DLS and owned jointly. Not a takeover of either codebase and not a
DLS-internal plan with an invitation attached.

The evidence for everything below is in [](queueing-traces.md), which traces both
systems from source at pinned revisions. This page is the argument; that one is
the reading.

## The case

Two projects solve an overlapping problem and are diverging.

**blueapi** is a FastAPI service over a single worker subprocess: 19 REST routes,
device and plan registries with server-side name resolution, OIDC and OPA
integration, and per-task metadata. It deliberately has **no queue** — that is
its own ADR-0003, "No Queues" — so submitted tasks live in a `dict` in the
worker subprocess, are started one at a time by an explicit second call, and are
lost when the environment reloads.

**bluesky-queueserver** is the queue blueapi decided not to build: 50 handlers
over 0MQ, three processes, and a Redis-backed queue whose entries have uids, can
be reordered by position or relative to another entry, survive a manager
restart, and accumulate a history. HTTP is a separate package.

Between them they nearly cover the ground. What is missing is in both:

**Neither can hold per-entry state set by something other than the submitter,
and revoked on a condition.** That is the requirement scan validation turns out
to impose — a verdict lives on a queue entry, and is revoked when control leaves
the queue — and it is why this project's ADR-0003 concludes validation state is
queue state. queueserver has somewhere such state could live; blueapi does not.

The second thing missing is anywhere to express **where work comes from**. Both
assume a client pushes work in. At DLS a large fraction of beamtime is
unattended: a user registers samples and diffraction plans in ISPyB through
SynchWeb, and collections then run without them present. That is a queue in
everything but name, owned by a different system, and today it is bridged
outside both projects.

## The proposal

**1. A new manager process, in Rust.** It speaks the existing queueserver HTTP
interface, so current clients keep working, and extends it with validation. The
manager is where queue state, entry state and validation verdicts live.

**2. One worker, with the superset of what both workers do today.** blueapi's
device and plan registries, name resolution, auth and metadata; queueserver's
allowed-plans and allowed-devices enforcement, environment lifecycle, run
control, history and task results. Neither community loses a capability.

**3. A validation worker.** Read-only, running alongside rather than in the
execution worker, doing plan-argument validation, scan timing, and the
anti-collision and branch-selection work described in the rest of this repo. Its
verdicts attach to queue entries in the manager. This is the part that does not
exist anywhere today.

**4. A plugin interface for queue sources.** The queue itself stays Redis, or
becomes SQL. What is new is that the manager consumes from a *source*, and a
source is pluggable, so an operator can switch between:

- **execute from the queue** — what queueserver does now
- **execute from ISPyB** — take the next unattended collection and run its plan
- **return to manual control** — neither, the beamline is driven directly

Making that an explicit, switchable source rather than a bridge is what turns
unattended operation from an integration into a supported mode.

## What each side gets

| | DLS | NSLS-II |
|---|---|---|
| queue with persistence and reordering | new | keeps what it has |
| validation and verdicts on entries | the reason for the work | new |
| unattended operation as a first-class source | needed now | available if wanted |
| one worker instead of two diverging ones | yes | yes |
| a typed manager | yes | yes |

## Why Rust, and what is unresolved about it

The stated reason is **the typing holes reached in Python**, in a component
whose entire job is holding state correctly across processes and restarts, and
there are developers on both sides who want to work in it.

Two things should be said plainly rather than argued around.

**The queueserver developer's view is not known.** This is a rewrite of the
component they own, and their agreement is a precondition, not a detail. If the
answer is no, the honest options are to keep the manager in Python and take the
rest of the proposal, or not to proceed.

**Rust is the most contestable claim here and should carry its own case.** The
rest of the proposal stands without it. It is worth separating the two so a
disagreement about language does not sink the merge.

## What would need agreeing first

1. **Whether the merge is wanted at all**, before any of the shape below.
2. **Who owns the result**, and where it lives.
3. **The manager's language**, as its own decision.
4. **The HTTP surface**: queueserver's existing interface plus validation, or
   the opportunity taken to change it once.
5. **Queue store**: stay on Redis, or move to SQL. The source-plugin interface
   matters more than this choice and should be settled first.
6. **Migration.** Both systems are in production. Neither community can take a
   flag day.

## What this page does not do

It does not specify the HTTP surface, the plugin interface, or the worker's
merged API. Those are the next document, and only worth writing once there is
agreement in principle.

It also assumes the reader accepts that validation state belongs on queue
entries. That is argued in
[](../decisions/0003-validation-state-is-owned-by-the-queue.md), and the whole
proposal rests on it — if it is wrong, the case for a merge is much weaker and
the two projects can reasonably stay apart.
