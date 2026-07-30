# 4. Validation runs in a second, read-only process

## Status

Accepted

## Context

blueapi's task worker runs one task at a time, in the process that holds the
devices. Validation has to work while a scan is running, so it cannot share that
process.

Validation also cannot work from a serialised description of the scan.
`check_limits_async` iterates the real plan generator against real device
objects; no serialised representation substitutes for that. So the validator
needs devices.

## Decision

Validation runs in a second blueapi process which instantiates devices but is
**read-only**: it uses them for state, never to move them.

## Consequences

The validator sees live PVs, so mid-scan it sees a machine in flight. It must
therefore validate against the **projected end state** of the running task, not
the instantaneous one.

Devices in the validator are injected with a **null solver that raises** on any
inverse call. Absence of a solver must raise rather than silently falling
through to unchecked motion, so "no solver" and "nothing to choose" have to be
distinguishable — see ADR-0006.

This interacts with blueapi ADR-0005 ("connect all dodal devices during
startup"): a second process connecting everything doubles the channel-access
footprint. That probably needs a device-subset concept, which blueapi does not
currently have.

Validation is non-blocking. Scans can be queued, and can start, before it
finishes — so the queue needs a state for "not yet validated" and a rule for
whether such an entry may run.
