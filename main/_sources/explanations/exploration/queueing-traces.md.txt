# blueapi and bluesky-queueserver, traced

How a scan gets from a client to a RunEngine in each of the two systems, in
matching notation, plus what each one does and does not provide.

**Descriptive, not a recommendation.** This page does not argue for either. It
exists because "blueapi and queueserver both queue scans" is true at a level of
detail that hides every difference that matters, and because the two are usually
compared from memory.

Read at the revisions pinned in [](../pinned-references.md): blueapi
`b7676359`, bluesky-queueserver `0a084cf` (tagged v0.0.25). Both were re-fetched
and checked out at those SHAs to write this; queueserver's `main` is still
exactly the pinned commit.

```{note}
Everything here is read from source. That establishes **what calls what, where
state is held, and what the API surface is**. It does not establish behaviour
under concurrency, failure or restart, except where that behaviour is written
down in the code — those cases are called out. Nothing here was run.
```

## blueapi

Two processes: a FastAPI service, and one subprocess holding the devices and the
RunEngine. `set_start_method("spawn", force=True)` at [`service/runner.py:25`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/service/runner.py#L25), and
the pool is `Pool(initializer=_init_worker, processes=1)` at [`:57`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/service/runner.py#L57) — one
subprocess, not a pool of many.

The shape to notice is that **submitting and starting are two separate calls.**

```{mermaid}
sequenceDiagram
    autonumber
    participant C as client
    participant A as FastAPI<br/>service process
    participant D as WorkerDispatcher<br/>Pool(processes=1)
    participant W as TaskWorker<br/>subprocess
    participant RE as RunEngine

    C->>A: POST /tasks {name, params}
    A->>D: run(submit_task)
    D->>W: submit_task(task)
    W->>W: prepare_params — raises if params invalid
    W->>W: _pending_tasks[uuid4] = TrackableTask
    W-->>A: task_id
    A-->>C: 201, Location: /tasks/{task_id}

    Note over C,RE: nothing is running. A second, explicit call starts it.

    C->>A: PUT /worker/task {task_id}
    A->>D: run(get_active_task)
    A-->>C: 409 Conflict, if a task is active and incomplete
    A->>D: run(begin_task)
    D->>W: begin_task(task_id)
    W->>W: raise WorkerBusyError unless state is IDLE
    W->>W: _task_channel.put(task) — Queue(maxsize=1)
    W->>RE: task.do_task(ctx)
    RE-->>W: result, or exception
    W->>W: _pending_tasks.pop → _completed_tasks
```

**There is no queue, and that is deliberate** — it is blueapi's own ADR-0003,
"No Queues". `_pending_tasks` at [`worker/task_worker.py:96`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/worker/task_worker.py#L96) is a `dict`, not an
ordered structure, and `_task_channel` at [`:140`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/worker/task_worker.py#L140) is `Queue(maxsize=1)`: a handoff
slot for the task currently being started, not a backlog. A submitted task waits
until a client explicitly starts it, and if one is already running the start call
raises `WorkerBusyError` at [`:298`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/worker/task_worker.py#L298).

**Parameters are validated at submit time**, before a task_id is returned —
`task.prepare_params(self._ctx)` at [`:274`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/worker/task_worker.py#L274), commented "Will raise if parameters
are invalid". So an invalid plan fails at `POST /tasks`, not later.

**Tasks live in the subprocess and do not survive its reload.**
`DELETE /environment` ([`service/main.py:223`](https://github.com/DiamondLightSource/blueapi/blob/b767635920d1675bc4db58c6bbf80c29378aa3f7/src/blueapi/service/main.py#L223)) schedules `runner.reload()`, which
stops and restarts the subprocess. `_pending_tasks` is ordinary process memory,
so anything submitted and not yet started is gone. Nothing persists tasks
anywhere else.

## bluesky-queueserver

Three processes, plus Redis. `WatchdogProcess` ([`start_manager.py:28`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/start_manager.py#L28)) supervises
`RunEngineManager` ([`manager.py:179`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/manager.py#L179)), which in turn drives `RunEngineWorker`
([`worker.py:90`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/worker.py#L90)). Clients speak 0MQ to the manager at `tcp://*:60615`
([`manager.py:255`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/manager.py#L255)), optionally encrypted with a private key. The HTTP interface
is a separate package, `bluesky-httpserver`, and is not in this repo.

```{mermaid}
sequenceDiagram
    autonumber
    participant C as client<br/>qserver / httpserver
    participant M as RE Manager<br/>0MQ process
    participant Q as Redis<br/>plan queue
    participant W as RE Worker<br/>process
    participant RE as RunEngine

    C->>M: 0MQ queue_item_add {item}
    M->>M: validate_plan vs allowed_plans / allowed_devices
    M->>Q: add_item_to_queue(pos / before_uid / after_uid)
    Q-->>M: item, with uid
    M-->>C: success, qsize

    Note over C,RE: the item is in Redis. It outlives the manager process.

    C->>M: 0MQ queue_start
    M->>Q: process_next_item → set_next_item_as_running
    Q-->>M: item, also written to the running_plan key
    M->>W: run the plan (JSON-RPC over a pipe)
    W->>RE: RE(plan)
    RE-->>W: result, or exception
    W-->>M: plan result
    M->>Q: append to plan_history, clear running_plan
    M->>Q: take the next item, until the queue is empty or stopped
```

**The queue is the point, and it is in Redis.** `PlanQueueOperations`
([`plan_queue_ops.py:13`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L13)) holds the queue, the `running_plan` key ([`:85`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L85)) and
`plan_history` ([`:87`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L87)) under a `qs_default` name prefix. That is what makes the
queue outlive the manager process, and it is the structural difference from
blueapi rather than a feature difference.

**Position is a first-class argument.** `add_item_to_queue` at [`:968`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L968) takes
`pos`, `before_uid` and `after_uid`; there are `pop_item_from_queue` ([`:780`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L780)) and
a batch form ([`:847`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/plan_queue_ops.py#L847)). Items have uids, so a client can address, move and remove
a specific entry.

**Validation happens on add**, against the allowed-plans and allowed-devices
lists — `validate_plan(...)` at [`manager.py:2263`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/manager.py#L2263).

**Starting is a queue-level verb, not a per-item one.** `queue_start` begins
processing and keeps going; its docstring notes items can be added while it runs.
`queue_stop` lets the running plan finish and does not start the next one. There
is also an autostart mode, persisted to Redis ([`manager.py:346`](https://github.com/bluesky/bluesky-queueserver/blob/0a084cfb722308f384847c24e6a43a8f572f302e/src/bluesky_queueserver/manager/manager.py#L346)), where adding an
item is enough to begin execution.

## Side by side

Descriptive. "—" means the mechanism does not exist, not that it could not be
added.

| | blueapi `b7676359` | bluesky-queueserver `0a084cf` |
|---|---|---|
| processes | 2: service + 1 subprocess | 3: watchdog, manager, worker |
| client transport | HTTP/REST, FastAPI | 0MQ, optionally encrypted |
| HTTP front end | built in | separate package (`bluesky-httpserver`) |
| where submitted work lives | `dict` in subprocess memory | Redis |
| survives a process restart | no | yes |
| ordered queue | — | yes |
| reorder / insert at position | — | `pos`, `before_uid`, `after_uid` |
| address one entry | task_id (uuid4) | item uid |
| params validated at submit | yes, `prepare_params` | yes, `validate_plan` |
| what starts execution | explicit `PUT /worker/task` per task | `queue_start` for the queue, or autostart |
| concurrent tasks | one; `WorkerBusyError` / 409 | one; queue serialises |
| completed-work record | `_completed_tasks` in memory | `plan_history` in Redis |
| per-entry state a caller can set | — | — |

The last row is the one to look at twice, and it is the same answer for both:
neither has a place to hang arbitrary per-entry state set by something other than
the submitter. queueserver has *somewhere it could live* — entries are addressable
by uid and stored in Redis — where blueapi's `_pending_tasks` dict is process
memory keyed by task_id. What neither has today is an API for a third party to
attach state to an entry and have it revoked on a condition.

That matters here because of [](../decisions/0003-validation-state-is-owned-by-the-queue.md),
and working out what it would take in either system is not attempted on this
page.

## What this does not cover

- **`daq-queuing-service`** — DLS's own queuing service, which ADR-0003 names as
  the obvious place for verdicts to live. Reachable, not read. A three-way
  comparison was scoped out of this page rather than done badly.
- **Failure and restart behaviour** beyond what the code states. Redis
  persistence is a code fact; whether a queue survives a *worker* crash
  mid-plan in practice is not.
- **Authorisation.** blueapi has OIDC and OPA hooks visible in `service/main.py`;
  queueserver has a lock-key mechanism on queue-mutating calls. Neither was
  traced.
- **Anything run.** No process was started, no plan executed.
