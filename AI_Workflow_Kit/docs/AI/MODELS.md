# Recommended models by role

> Defaults, not hard bindings. Runtime selection is controlled by project
> aliases in `.omp/config.yml`.

---

## Default table

| Role | Recommended model(s) | Reasoning | Notes |
|------|----------------------|-----------|-------|
| **Orchestrator** | **Grok 4.5** · or **GPT 5.6 Soul** | Grok: **Max / High** · Soul: **Medium** | Two solid hub picks: Grok 4.5 (Max/High) for orchestration with a real brain; Soul Medium at one level for a lighter, efficient hub. |
| **Coder** | GPT 5.6 **Luna** · DeepSeek V4 **Flash** · Gemini 3.6 **Flash** | Luna/DeepSeek **Max** · Gemini **High** | Implementation volume. |
| **Reviewer** | Luna · Gemini 3.6 Flash | **Max** / **High** | **No DeepSeek** for review. Prefer a different family than Coder. |
| **Tester** | GPT 5.6 **Terra** | **Max** or **Extra High** | Careful gap-hunt; not a cheap flash pass. |
| **Architect** | Soul · or Terra | Soul **High / Extra High** · Terra **Max** | Research + plan. **Avoid Ultra.** |
| **Security** | **GLM 5.2** · or **GPT 5.6 Soul** · or **Opus 5** | **Maximum** on all | **End of project only** (offer, not force). Top models only — expensive one-time deep pass. **Not** Terra/Luna flash. |

If product renames tiers, map by intent: **strong hub** · **fast code** · **careful review** · **careful tests** · **thoughtful design** · **max security at release** — never “Ultra for every tiny step.”

Naming: **GPT 5.6 Soul** is the product/display name used in this guide; the
current OMP catalog selector is `openai-codex/gpt-5.6-sol`.

## OMP role aliases

| Role | Primary | Backup |
|------|---------|--------|
| Main Orchestrator | `@workflow_orchestrator` | `@workflow_orchestrator_backup` |
| Coder | `@workflow_coder` | `@workflow_coder_backup` |
| Reviewer | `@workflow_reviewer` | `@workflow_reviewer_backup` |
| Tester | `@workflow_tester` | `@workflow_tester_backup` |
| Architect | `@workflow_architect` | `@workflow_architect_backup` |
| Security | `@workflow_security` | `@workflow_security_backup` |

Each pair maps to concrete provider/model selectors in `.omp/config.yml`.
Primary worker definitions select only the primary alias. Manual backup
definitions (`workflow-<role>-backup`) select only the backup alias and require
an explicit Human authorization recorded by Main. Agent Hub shows the model
actually running.

---

## Cost discipline

| Anti-pattern | Prefer |
|--------------|--------|
| Ultra / max-everything for a one-line UI tweak | Luna Max (Coder) |
| Same model for Coder and Reviewer | Different family when possible |
| Ultra Architect “just in case” | Soul Extra High or Terra Max |
| Security on Terra / Luna flash | **GLM 5.2 · max** (or Soul max / Opus 5 max) |
| Security every coding step | Offer **once** near release |
| Skipping model tips on kicks | Always print model + reasoning |

---

## Changing a model pair

1. Start OMP from the project root.
2. Press **Alt+M** or run `/models`.
3. Open the **Roles** view.
4. Assign `workflow_<role>` as primary.
5. Assign `workflow_<role>_backup` as backup.
6. Return to Main and run `/workflow ready`.

Typing filters the available catalog. `modelRoleStorage: project` persists both
assignments under `modelRoles` in `.omp/config.yml`.

Use separate providers when possible. A second model on the same provider can
cover a model-specific limit but not a provider-wide outage.

For terminal inspection:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh status
omp models find <name>
```

Existing workers keep their current resolved model. New workers receive the
updated assignment. A running Main session must be switched live or relaunched
after changing its model alias.

## Failover behavior

- OMP may retry transient failures on the same active model.
- Persistent `429`, quota-wall, or provider-outage failures pause the workflow;
  automatic cross-model fallback is disabled.
- Main records the failed role/model/evidence in `STATE.yaml` and does not
  increment product-work attempts.
- Only explicit Human authorization starts the matching fresh
  `workflow-<role>-backup` agent. A failed backup pauses again.
- Main's own outage requires the Human to select
  `@workflow_orchestrator_backup` in the live model selector, then resume from
  file-backed state.
- Invalid prompts, failing tests, context overflow, tool errors, and logically
  incorrect output remain ordinary workflow failures.
- Direct `.omp/config.yml` editing remains a scripted-setup fallback only.
