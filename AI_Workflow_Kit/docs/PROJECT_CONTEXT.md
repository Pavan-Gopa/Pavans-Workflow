# Project Context

> Fill this once when dropping the kit into a new repo.  
> Orchestrator and workers treat this as the map of the territory.

## Identity

| | |
|--|--|
| **Product** | OMP Dust provider extension |
| **One-liner** | Expose Dust workspace agents as selectable OMP models. |
| **Platform** | macOS CLI |
| **Stack** | TypeScript OMP extension + Dust HTTP API |
| **Current train / version** | Login reliability repair |
| **Project prefix** (git tags) | `omp-dust` |
| **Master plan file** | `AI_Workflow_Kit/docs/STEPS.md` |

## Architecture (one-liner)

OMP provider registry → credential storage → Dust agent discovery/conversation API → OMP event stream.

## Repo map

```text
~/.omp/agent/extensions/
└── dust-provider.ts          # Global provider adapter

<PROJECT_ROOT>/
├── AI_Workflow_Kit/          # Orchestration state and reports
├── .omp/                     # Workflow roles and project configuration
└── graphify-out/             # Knowledge graph
```

**Git layout:** workflow repository in the current project root; the global
extension is user configuration outside the repository and must never contain
the API key.

## OMP workflow

Launch from this project root:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Project agents and primary/backup model aliases live in `.omp/`. The Human may
change any `modelRoles.workflow_*` mapping through `Alt+M` without changing role
instructions.

## Build / test commands

Always run from the project root:

```bash
cd "<PROJECT_ROOT>"

# Provider/model discovery
omp models find dust --json

# Non-interactive provider smoke (with a configured credential)
omp --no-session --approval-mode yolo --model dust/<agent-id> -p "Reply with OK."
```

Login and region-fallback verification uses a local HTTP fixture; no live API
key is printed or committed.

## Key constraints

| Allowed | Forbidden |
|---------|-----------|
| OMP credential vault, Dust US/EU APIs, local mock server | API keys in source, logs, workflow docs, or test fixtures |

Additional hard rules for this product:

- Keep legacy raw Dust credentials readable during clean cutover.
- A failed regional probe must not silently fall through on `401` or `403`.
- Persist the validated workspace ID and API region with the opaque credential.

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
