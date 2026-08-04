# A merged blueapi and bluesky-queueserver

What the merged system looks like, what its HTTP surface should be, and what the
superset of the two validation stacks actually is.

Read at the revisions in [](../pinned-references.md): blueapi `b7676359`,
bluesky-queueserver `0a084cf`, bluesky-httpserver `d53d171`. How each works
today is traced in [](queueing-traces.md).

## Architecture

```{mermaid}
flowchart TB
    QSC["qserver CLI / GUI"]
    BAC["blueapi CLI"]
    SW["SynchWeb"]

    QSC -- "HTTP" --> API
    BAC -- "HTTP" --> API
    SW -- "writes plans" --> ISPYB[("ISPyB")]

    API["<b>HTTP API</b><br/>queueserver surface<br/>+ verdicts + sources"]
    API --> MGR

    subgraph M ["MANAGER &mdash; rust"]
        MGR["queue, entry state, verdicts<br/>⏳ &nbsp; ✓ &nbsp; ✗ &nbsp; ?"]
        SRC{{"source plugin"}}
    end

    STORE[("queue store<br/>Redis or SQL")]
    MGR -- "entries + verdicts<br/>↑ persisted state" --> STORE
    MGR --> SRC
    ISPYB -- "next collection" --> SRC
    STORE -- "next entry" --> SRC

    SRC -- "item to validate<br/>↑ ✓ / ✗ / ? + certificate" --> VW
    SRC -- "item + certificate<br/>↑ result, abort on failure" --> EW

    subgraph W ["WORKERS &mdash; python"]
        VW["<b>VALIDATION</b><br/>read-only devices<br/>args · timing · collisions"]
        EW["<b>EXECUTION</b><br/>owns devices, RunEngine"]
    end

    VW -- "joint arrays, batched<br/>↑ per-point verdicts" --> AC
    EW -- "joint arrays, batched<br/>↑ per-point verdicts" --> AC
    AC["anti-collision service<br/>stateless"]
```

Three claims in that picture carry the design.

**The manager owns entry state, and it is the only thing that does.** Verdicts
live on entries because they are revoked when control leaves the queue — see
[](../decisions/0003-validation-state-is-owned-by-the-queue.md). Neither system
can do this today.

**The source plugin sits between the manager and the workers**, not in front of
the queue. Switching from queue to ISPyB to manual changes where the *next item*
comes from, without changing anything downstream. An ISPyB collection and a
queued plan reach the validation worker identically.

**Two workers, one codebase.** The validation worker is the execution worker
with read-only devices and message interpretation instead of execution
(ADR-0004). Not a second implementation — same plan loading, same registries,
same parameter model.

## The HTTP interface

bluesky-httpserver exposes **65 routes** today. blueapi exposes 19. The
queueserver surface is the larger and better-shaped of the two and should be the
base.

### Keep as-is

The queue, run-engine and environment verbs are the reason to start from this
surface: `/queue/item/{add,add/batch,get,move,move/batch,remove,remove/batch,update,execute}`,
`/queue/{get,start,stop,stop/cancel,clear,mode/set,autostart}`,
`/re/{pause,resume,stop,abort,halt,runs,metadata}`,
`/environment/{open,close,update}`, `/history/{get,clear}`,
`/{plans,devices}/{allowed,existing}`, `/permissions/{get,set,reload}`,
`/lock`, `/unlock`, `/lock/info`, `/status`, `/ping`, `/task/{status,result}`.

That is a complete queue API, and blueapi has no equivalent for most of it.

### Add, for validation

Validation is not a call the client makes — it happens on insertion. What the
API needs is a way to *see* the result, and a way to ask before committing.

| route | purpose |
|---|---|
| `GET /queue/item/get` *(extended)* | return `verdict` (⏳/✓/✗/?), `certificate` and `verdict_reason` on the item |
| `GET /queue/get` *(extended)* | the same fields per entry, so a GUI can render the queue with ticks |
| `POST /queue/item/validate` | validate a candidate item **without inserting it** |
| `GET /validation/status` | is the validation worker up, and what is its backlog |
| `POST /queue/item/revalidate` | force revalidation, for when the world changed and the automatic rule did not catch it |

`POST /queue/item/validate` exists in neither system and is worth the most: it
puts validation before commitment, which is where a user actually wants it.

### Add, for sources

| route | purpose |
|---|---|
| `GET /source` | current source, and what is available |
| `POST /source/set` | switch between `queue`, `ispyb`, `manual` |
| `GET /source/{name}/status` | backlog and health for one source |

Deliberately not "an ISPyB endpoint". A source is a plugin with three
operations — *peek*, *claim*, *report* — so ISPyB is one implementation and the
Redis queue is another. Anything that can offer work becomes a source without
the manager changing.

### Problematic, and what to do about them

**Remove: the test surface.** `/test/manager/kill`, `/test/server/sleep`,
`/test/set_delay`, `/test/set_info`, `/test/set_instrument` and
`/testing_custom_router_1` — six routes that exist for the test suite and ship
in the production API. They should not be reachable on a beamline.

**Reconsider: arbitrary code injection.** `/script/upload` and
`/function/execute` load code into the worker namespace and call into it. They
are useful, and they are also a hole straight through everything else here — a
queue of validated plans means nothing if a client can upload a script that
moves motors directly. They cannot simply be deleted, because they are used, but
they need permissioning separate from queue submission and they need to be
visible in the manager's state, so that "the beamline is under queue control"
stays a statement that can be checked. Same class of problem as the
uncertified-value ban in [](../decisions/0008-checking-is-a-plan-preprocessor.md).

**Consolidate: console output.** `/console_output`, `/console_output/uid`,
`/console_output_update` and `/stream_console_output` are four routes for one
concern; blueapi uses a message bus instead. One streaming endpoint.

**Move out: `/queue/upload/spreadsheet`.** Parsing a spreadsheet into queue
items is a client concern that has ended up in the server. It becomes a client
calling `/queue/item/add/batch`.

**Merge: `/environment/destroy` into `/environment/close`** with a `force` flag.

## Validation compared, by level

Both systems validate. They do it in different processes, against different
things, and catch different failures.

### What each actually does

**blueapi** builds a pydantic model from the **live plan function's type
annotations** at registration — `create_model(plan.__name__, **self._type_spec_for_function(plan))`
in `core/context.py:355`. Submitting a task runs
`TypeAdapter(model).validate_python(task.params)` in `worker/task.py`.

Device-typed parameters are wrapped in a generated `Reference` type
(`core/context.py:366`) whose validator calls `find_device(value)`, checks the
result against the declared protocol via `is_compatible(val, origin, args)`, and
**returns the device object**. Deserialisation and validation are one step.

**bluesky-queueserver** validates against a **serialised description** of the
plan signature, downloaded from the worker into the manager as `allowed_plans`.
`validate_plan` (`profile_ops.py:2550`) checks the plan name is permitted, then
`_validate_plan_parameters` binds arguments with `inspect.Signature.bind` and
validates them against a pydantic model built from the description —
`pydantic_construct_model_class(parameters)`.

Device names are checked **as names**, against `allowed_devices` patterns. They
become objects later, in the worker, in `prepare_plan` (`profile_ops.py:845`),
which takes `devices_in_nspace` and converts names at execution time.

### The comparison

| | blueapi | queueserver | superset |
|---|---|---|---|
| **where it runs** | worker subprocess | manager | **validation worker** |
| **validated against** | live function annotations | serialised signature description | live annotations |
| **when** | on `POST /tasks` | on `queue_item_add` | asynchronously, after insertion |
| **argument binding** | pydantic model fields | `inspect.Signature.bind` | bind, then types |
| **type checking** | pydantic, real annotations | pydantic, from description | pydantic, real annotations |
| **name → device** | during validation, via `Reference` | names matched to patterns; resolved at execution | during validation |
| **protocol conformance** | yes, `is_compatible` against `Movable[float]` | none | **blueapi's** |
| **device exists** | yes, `find_device` | pattern match only | **blueapi's** |
| **device connected** | at environment build only | not checked | **neither is enough** |
| **per-group permissions** | OPA, coarse | `allowed_plans`/`allowed_devices`, fine-grained | **queueserver's, in the manager** |
| **scanspec / nested models** | works; any pydantic model is a valid parameter | depends on the description round-tripping the annotation | **blueapi's** |
| **plan feasibility** | none | none | **new** — the validation worker |

### Three findings

**1. The validator does all of it, and the manager needs no pydantic.**

The level difference is real: blueapi validates against live objects and so can
only run where they are, while queueserver validates against a description and
so can run in the manager with no environment open. The tempting conclusion is
to keep both — a cheap description check in the manager, a live check in the
worker.

That is the wrong conclusion, and an earlier version of this page drew it. It
reconciles the two designs rather than choosing between them, and it buys one
thing (synchronous rejection) at the price of maintaining a second
representation of every plan signature forever.

**Once the validation worker checks arguments, the manager has no reason to.**
It keeps two jobs, neither of which needs a schema library:

- **Permissions.** Is this plan name, and are these device names, allowed for
  this user group? String set membership. It stays in the manager precisely
  because it is an authorisation decision, and authorisation should not be
  delegated to the process that loads user-adjacent code.
- **The catalogue.** `/plans/allowed` and `/devices/allowed` still have to be
  served so clients can populate a GUI. The validator publishes it; the manager
  caches and serves it as **opaque JSON**, without interpreting it.

**2. Which removes the description-format problem entirely.** The earlier
version of this page called it the largest unknown: a description would have to
round-trip a recursive discriminated union to express something like
`Spec[Movable]`, and if it could not, manager-side validation would silently
degrade to "some object was supplied".

There is now nothing to round-trip. The validator holds the live function and
its real annotations, which is where blueapi already validates today. The
catalogue still describes plans well enough for a client to render a form, but
nothing depends on that description being *sound* — only on it being useful.

**3. Connection is checked by neither, and it is the one that bites.** blueapi
connects devices when the environment is built (`context.py:276`,
`build_and_connect`) and reports connection errors then. queueserver does not
check. Neither re-checks at submission or before execution, so a device that
dropped an hour ago passes every existing check and fails at the first `set`.

The validation worker holds the devices open read-only, so it can check
connectivity while validating — and it should, because a scan that will die on a
dead device is exactly what insertion-time validation is for.

### What the superset is

In the manager, synchronously, on `queue_item_add`:

1. plan name in `allowed_plans` for the user group *(queueserver)*
2. device names permitted by `allowed_devices` patterns *(queueserver)*

Both are string matching against lists the validator published. Nothing else is
rejected at insertion — the item enters the queue at ⏳.

In the validation worker, asynchronously, with read-only devices:

3. arguments bind to the real signature *(blueapi + queueserver)*
4. types validate against the real annotations *(blueapi)*
5. names resolve to real devices *(blueapi)*
6. devices satisfy the declared protocols *(blueapi)*
7. **devices are connected** *(new)*
8. **the plan is feasible** — argument semantics, scan timing, limits, branch
   selection, anti-collision *(new; the subject of the rest of this repo)*

Steps 3–8 produce the verdict that lands on the entry, which sits at ⏳ until
they finish.

**Making all validation asynchronous is a simplification, not a concession.**
ADR-0003 already says every plan goes to the validator and is held at ⏳ — so
rejecting *some* items synchronously was the inconsistency. Two further
properties fall out:

- **Insertion never fails for validation reasons.** If the validation worker is
  down, items still queue and sit at ⏳ until it returns. Queueing does not
  depend on the validator being up, only on getting a verdict does.
- **There is one place where a plan can be judged wrong**, so there is no second
  implementation to drift from the first — the failure this project has hit most
  often (ADR-0009).

A client that wants an answer before committing calls
`POST /queue/item/validate`, which routes to the same validator and returns the
same verdict without inserting anything.

## What is not settled

- **Migration.** Both systems are in production; neither community can take a
  flag day.
- **Whether the validator needs its own environment open to check arguments.**
  Steps 3–4 need only the plan signature; steps 5–8 need devices. If the
  validator can answer 3–4 with no devices connected, most malformed items are
  still caught while the beamline is down, which is most of what synchronous
  manager-side checking was buying.
- **How the catalogue stays current.** The manager serves what the validator
  published, so there is a staleness question when plans are reloaded — smaller
  than the description-format problem it replaces, but not nothing.

The Rust question is no longer on this list. With no schema validation in the
manager, its jobs are queue state, string-set permissions, opaque JSON caching
and routing, none of which argue for or against any particular language.
