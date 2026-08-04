# 3. Validation runs in a second, read-only process

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

Validation runs in a second blueapi worker process, seeing PVs through a
**read-only gateway**. It creates devices, but only for introspection and
reading.

Crucially it **iterates the plan and inspects the messages rather than executing
them**. `Msg("prepare", pmac, spec)` does not call `pmac.prepare(spec)`; the
validator stashes the spec, and `Msg("kickoff", pmac)` then transforms the
stashed values through the pmac's transforms and sends them to the
anti-collision service.

## Consequences

The validator sees live PVs, so mid-scan it sees a machine in flight. It must
therefore validate against the **projected end state** of the running task, not
the instantaneous one.

**It needs no solver.** Because it interprets messages rather than executing
them, it never calls a device's write path, so the question of injecting a
solver into validator-side devices does not arise. This also removes the loop
that would otherwise exist between devices and the service the validator exists
to serve.

**If it meets a message whose effect it cannot predict, it raises**, and that is
the sole origin of the "not validatable" verdict.

Channel-access footprint is not a concern.

The validator is a **blocking call**, but the queueing service does not block
waiting on the result — it holds the entry at ⏳ and carries on. So the queue
needs that state, and a rule for whether an entry may run before it resolves.
