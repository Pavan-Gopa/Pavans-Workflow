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
Task-agent definitions list primary first and backup second, which creates an
OMP-native per-spawn retry chain. The launcher builds the equivalent concrete
fallback chain for Main. Agent Hub shows the model actually running.

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
AI_Workflow_Kit/script/workflow_models.sh status
omp models find <name>
```

Existing workers keep their current resolved model. New workers receive the
updated pair. Relaunch Main after changing either Orchestrator alias.

## Failover behavior

- OMP retries transient failures and applies fallback on persistent `429`,
  quota-wall, or provider-outage errors.
- `fallbackRevertPolicy: never` pins that session to the backup after failover.
- A fresh worker starts by trying its primary again.
- Failover does not repair invalid prompts, failing tests, context overflow, or
  logically incorrect output; those remain workflow failures.
- Direct `.omp/config.yml` editing remains a scripted-setup fallback only.
