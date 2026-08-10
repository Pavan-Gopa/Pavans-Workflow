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

| Role | Agent model selector |
|------|----------------------|
| Main Orchestrator | `@workflow_orchestrator` |
| Coder | `@workflow_coder` |
| Reviewer | `@workflow_reviewer` |
| Tester | `@workflow_tester` |
| Architect | `@workflow_architect` |
| Security | `@workflow_security` |

Each alias maps to a concrete provider/model selector in `.omp/config.yml`.
Change that mapping to switch one role independently. Agent instructions remain
model-agnostic. Agent Hub shows the resolved model for every active run.

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

## Changing one role

Edit only the corresponding mapping:

```yaml
modelRoles:
  workflow_coder: openai-codex/gpt-5.6-luna:max
  workflow_reviewer: google-antigravity/gemini-3.6-flash:high
```

Use an exact `provider/model-id:reasoning` selector available from:

```bash
omp models
```

Restart or start the next worker after changing the mapping. Existing running
workers keep the model they resolved at launch.
