# Project Context

> Fill this once when dropping the kit into a new repo.  
> Orchestrator and workers treat this as the map of the territory.

## Identity

| | |
|--|--|
| **Product** | _(title)_ |
| **One-liner** | _(what it is)_ |
| **Platform** | _(e.g. macOS 14+, web, Linux CLI, …)_ |
| **Stack** | _(languages, frameworks, package manager)_ |
| **Current train / version** | _(optional)_ |
| **Project prefix** (git tags) | `proj` _(change to a short slug)_ |
| **Master plan file** | _(path, or “STEPS.md only”)_ |

## Architecture (one-liner)

_(e.g. UI → domain services → storage / engines → workers)_

## Repo map

```text
<PROJECT_ROOT>/
├── AI_Workflow_Kit/          # this orchestration kit
├── …                         # your sources, tests, scripts
└── graphify-out/             # optional knowledge graph output
```

Fill a real tree when you know it:

```text
# e.g.
# src/
# tests/
# script/
```

**Git layout:** nested repo root / monorepo subfolder _(pick one and note the stage path for checkpoints)_.

## OMP workflow

Launch from this project root:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Project agents and primary/backup model aliases live in `.omp/`. The Human may
change any `modelRoles.workflow_*` mapping through `Alt+M` without changing role
instructions.

## Build / test commands

Always `cd` into the project root first:

```bash
cd "<PROJECT_ROOT>"

# Primary tests
# e.g. swift test | npm test | cargo test | pytest

# Dev run (if any)
#

# Surface / contract QA (if any)
# e.g. ./script/qa/run_all.sh
```

## Key constraints

| Allowed | Forbidden |
|---------|-----------|
| _(e.g. native runtimes)_ | _(e.g. secrets in git, forbidden deps)_ |

Additional hard rules for this product:

- …
- …

## Workflow docs priority

1. Master plan file (if any)
2. `AI_Workflow_Kit/docs/AI/STATE.yaml`
3. `AI_Workflow_Kit/docs/STEPS.md`
4. `AI_Workflow_Kit/docs/DECISIONS.md`
5. This file

## Graphify

```bash
cd "<PROJECT_ROOT>"
bash AI_Workflow_Kit/script/graphify_rebuild.sh
graphify query "…" --graph graphify-out/graph.json
```

The rebuild attempts semantic extraction and falls back to local AST code-only
indexing when no supported LLM backend is configured.
