# OMP Workflow Contract

This project runs its established workflow inside one OMP session.

## Role boundary

- The OMP `Main` session is the Orchestrator when launched through `/workflow` or `AI_Workflow_Kit/script/omp_workflow.sh`.
- A task subagent follows its `.omp/agents/` role and assignment. It never manages routing or workflow state.
- Only `Main` may change `AI_Workflow_Kit/docs/**`, `PIPELINE.md`, `README.md`, `ORCHESTRATOR_FIRST_PROMPT.md`, or `.omp/**` during workflow execution.
- Workers never commit, tag, push, invoke another worker, or send work directly to another worker. Their only normal handoff is their structured task result to `Main`.
- Run one specialized worker at a time. Every retry is a new task agent session.

## Onboarding and model failover

- Before the first worker, Main completes the `STATE.yaml` onboarding gate.
- `Alt+M` configures paired `workflow_<role>` and
  `workflow_<role>_backup` aliases through OMP's native Roles selector.
- Worker agent definitions list primary then backup; OMP performs runtime
  failover for quota walls, repeated `429` responses, and provider outages.
- `omp_workflow.sh` resolves the Orchestrator backup into a runtime fallback
  chain. Relaunch Main after changing either Orchestrator alias.
- Main never interprets failover as task success; repository and test
  verification remain mandatory.


## Source of truth

Conversation history is not authoritative. Before every routing or stage transition, `Main` rereads:

1. authoritative plan files named in `AI_Workflow_Kit/docs/PROJECT_CONTEXT.md`;
2. `AI_Workflow_Kit/docs/AI/STATE.yaml`;
3. `AI_Workflow_Kit/docs/STEPS.md` and `AI_Workflow_Kit/docs/DECISIONS.md`;
4. the latest feedback/report files relevant to the current gate;
5. repository status, real source, diff, and test evidence.

On conflict, follow `AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md`. Do not infer success from a worker exiting.

## Orchestration loop

1. Reconstruct the current step from files.
2. Incorporate the Human's latest instruction, then reread affected source-of-truth files.
3. Select exactly one next role from the existing workflow.
4. Spawn it with `task`, its project agent name, a fresh unique run name, and a self-contained assignment: goal, step, allowed paths, exclusions, acceptance criteria, verification commands, and source-of-truth paths. Never pass the Main conversation transcript.
5. When its structured result arrives, inspect the actual diff/source/test output yourself.
6. Only after verification, write the canonical entry to `FEEDBACK.md`, `REPORT.md`, `BUG_REPORT.md`, or `SECURITY_REPORT.md`, update `STATE.yaml`, and route the next role.

Default step flow remains `workflow-coder -> Main verification -> workflow-reviewer -> Main verification -> workflow-tester -> Main verification`. Reviewer is required unless the Human explicitly skips it. Tester is enabled unless the Human opts out. Security is offered once near release and runs only after Human approval. Architect is used for unclear design, plan/code conflict, deep grilling, or implementation thrash.

If the same gate fails three times without material progress, stop automatic retries. Record the blocker in `STATE.yaml` and ask the Human for direction or route once to `workflow-architect` when the workflow permits it.

## Graphify

Use `GRAPHIFY -> FIND; SOURCE -> VERIFY`:

1. If `graphify-out/graph.json` exists, start with focused `graphify query`, `path`, `explain`, or `affected` calls.
2. Read the smallest relevant real source/doc slice before editing or making a consequential claim.
3. If the graph is missing or stale, `Main` runs `AI_Workflow_Kit/script/graphify_rebuild.sh`. Workers report staleness rather than rebuilding it.
4. Never wander through the repository without a task-specific reason.

## Grilling

The existing `grilling/` skill is discovered through `.omp/config.yml`.

- Quick mode stays in `Main`.
- Deep mode uses `workflow-architect` with the `grilling` skill autoloaded. The Architect returns questions or an Architecture Package but never persists it.
- `Main` alone persists approved plans, ADRs, glossary changes, and downstream steps.

## Human control

The Human may interrupt or redirect `Main` at any time. `Alt+W` opens the
read-only workflow/agent/model/quota dashboard. `Alt+A` opens Agent Hub to
inspect, steer, revive, or kill the current worker. After any intervention,
`Main` rereads repository and workflow files before continuing.
