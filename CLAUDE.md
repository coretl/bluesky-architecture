# Working in this repo

Design work for validating bluesky scans before and during execution. The
deliverable is documentation and evidence, not a product — the Python package is
a strawman kept for its measurements.

## Where things go

| | |
|---|---|
| `docs/explanations/architecture.md` | how the design works now. Not a history. |
| `docs/explanations/decisions/` | ADRs, Nygard format, numbered — see below |
| `docs/explanations/open-questions.md` | what is not settled, ranked by impact |
| `docs/explanations/exploration/` | what was measured, and what was wrong |
| `benchmarks/` | the script behind every number |
| `src/bluesky_architecture/strawman/` | superseded sketch, kept for its results |

If you learn something, put it in the place that matches its kind. A new
measurement goes in `exploration/measurements.md` *and* gets a script. A
reversal goes in `exploration/reversals.md`. A settled choice becomes an ADR and
is reflected in `architecture.md`.

## ADR numbers are permanent

They were renumbered twice, in two single passes: once before the repo was first
pushed, when two superseded ADRs were folded into the ones that superseded them,
and once just after, when the project-template ADR was dropped. Both times the
reasoning from a removed ADR was preserved as a note in its successor.

**Renumbering is now closed.** From here an ADR keeps its number, and a
superseded one is marked superseded in place — never deleted, never renumbered,
never quietly rewritten. Amendments go at the end of an ADR under their own
heading, saying what changed and why, rather than editing the original decision.
The rationale is in `decisions.md`.

Note that blueapi has its own ADR-0003 ("No Queues"), a different document from
this project's. It is referenced from ADR-0007. Always write "blueapi ADR-0003"
when you mean theirs.

## The one rule

**Every number needs a runnable script or an explicit label saying it is an
estimate.**

This is not pedantry. The figure this architecture was originally sized against
lived only in a chat transcript, was never reproducible, and turned out to be
wrong in premise. `benchmarks/` exists so that cannot recur.

## How to be useful here

**Check, don't reason.** Fourteen conclusions in this project were argued
confidently and then reversed. Every single reversal came from a fact or a
measurement; none came from further argument. If a claim is checkable, check it
before writing it down — reading the actual source, or running something.

**Record reversals next to what they reverse.** Do not quietly edit a wrong
conclusion away. The reasoning that led to it usually survives and is worth
reading; the reversal is often more instructive than the correction.

**Say what a measurement does not establish.** Every table in this repo that is
contaminated says so. Coarse-tier timings are trustworthy; absolute
false-positive rates on the reference model are not, because it reports
collisions at its own nominal-valid pose.

**Prefer the specific over the general.** "i16 has 18 meshes and 233,034
triangles" beats "the model is large". File and line references beat
descriptions.

## Commands

```
uv run pytest              # 25 tests
uv run ruff check .        # lint
uv run pyright src tests   # strict
tox -p                     # everything CI runs
uv run sphinx-build --fresh-env --fail-on-warning docs build/html
```

Benchmarks need real geometry that is not vendored — see `benchmarks/README.md`,
which also lists the methodological traps specific to this domain. Read it
before writing a new one; several are non-obvious and cost a full measurement
each.

## Conventions worth knowing

- **Docs are markdown via myst.** Mermaid is available (`{mermaid}` directive).
  Cross-references are `[](file.md)`; a bad target fails the build, since docs
  are built with `--fail-on-warning`.
- **Sphinx does not validate mermaid.** It embeds the source for client-side
  rendering, so a broken or badly-laid-out diagram builds clean and fails only
  in a browser. `tools/render_diagram.sh diagram.mmd out.png` renders one so
  you can look at it. Do not
  iterate on layout blind — dagre's ranking is not obvious, and back edges
  (anything pointing "up" the flow) will invert the whole diagram. Prefer
  encoding returns as `↑` in a forward edge's label over drawing a real
  return edge.
- **The strawman is excluded from pyright and from three ruff rules.** The
  reasoning is in `pyproject.toml` next to each exclusion. Anything promoted out
  of `strawman/` loses the exemption.
- **`N806`, `E741`, `N818` are off in strawman and benchmarks** because rotation
  matrices are capitals, `l` is a Miller index, and `Infeasible`/`Unsatisfiable`
  are the ADR's vocabulary. Domain notation wins over the linter, but only where
  it is genuinely notation.
- **Commit messages carry the reasoning**, including what turned out to be
  wrong. They are part of the record here, not just a changelog.
