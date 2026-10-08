# Recommended models by role

These are defaults and intent guidelines, not hard bindings. Runtime selection
is controlled through project aliases in `.omp/config.yml` and **Alt+M -> Roles**.

## Role table

| Role | Intent | Notes |
|---|---|---|
| Orchestrator | Strong, reliable routing and evidence synthesis | Keep one stable hub model |
| Coder | Fast, accurate implementation | Ponytail autoloads only here |
| Reviewer | Independent correctness judgment | Prefer a different family from Coder |
| Tester | Careful runtime and coverage gap-hunt | Not a cheap cosmetic pass |
| Architect | Deep research, trade-offs, and Grilling | Use only when justified |
| Security | Maximum-quality one-time audit | Offer near release, do not force every step |
| Design Advisor | Lower-cost concrete UI/UX brief | Read-only; may alias Reviewer by default |
| Designer | Strong visual implementation model | Kimi or another capable visual/frontend model is a good fit |

## OMP aliases

| Role | Primary | Failover backup |
|---|---|---|
| Main | `@workflow_orchestrator` | `@workflow_orchestrator_backup` |
| Coder | `@workflow_coder` | `@workflow_coder_backup` |
| Reviewer | `@workflow_reviewer` | `@workflow_reviewer_backup` |
| Tester | `@workflow_tester` | `@workflow_tester_backup` |
| Architect | `@workflow_architect` | `@workflow_architect_backup` |
| Security | `@workflow_security` | `@workflow_security_backup` |
| Design Advisor | `@workflow_design_advisor` | `@workflow_design_advisor_backup` |
| Designer | `@workflow_designer` | `@workflow_designer_backup` |

The updater adds missing design aliases as references to existing roles.
**Role-alias values beginning with `@` must be quoted in YAML**:

```yaml
workflow_design_advisor: "@workflow_reviewer"
workflow_designer: "@workflow_architect"
workflow_design_advisor_backup: "@workflow_reviewer_backup"
workflow_designer_backup: "@workflow_architect_backup"
```

`workflow_config_repair.py` quotes bare aliases automatically. If OMP already
moved an invalid project configuration to `.omp/config.yml.broken-*`, the
updater restores the newest project mapping before the doctor runs.

The aliases make the optional path immediately usable without overwriting any
existing selection. Assign a dedicated model later through Alt+M. For example,
select the available Kimi K3 catalogue entry for `workflow_designer` and
optionally a cheaper model for `workflow_design_advisor`. The workflow
intentionally does not hard-code a provider-specific Kimi selector because
catalogue IDs vary.

## Readiness levels

```bash
bash AI_Workflow_Kit/script/workflow_models.sh validate-level main
bash AI_Workflow_Kit/script/workflow_models.sh validate-level execution
bash AI_Workflow_Kit/script/workflow_models.sh validate-level quality
bash AI_Workflow_Kit/script/workflow_models.sh validate-level full
bash AI_Workflow_Kit/script/workflow_models.sh validate-level design
```

`full` remains the original six-role core team. `design` validates the optional
Advisor/Designer pair. `validate` checks every configured primary/backup pair.

## Cost discipline

- Do not call Designer automatically for ordinary functional work.
- Prefer Design Advisor when the Human wants direction and ordinary Coder can
  implement it.
- Use direct Designer implementation when the Human explicitly wants a visual
  overhaul or the component has repeatedly failed aesthetic acceptance.
- Reuse a core role through aliases until a dedicated visual model is worth the
  cost.
- On a primary model/provider failure Main fails over to the role's backup automatically, but only to a
  backup that resolves to a different model than the failed primary; the Fast Coder has no backup and escalates
  to the Coder. The Human is asked only when no distinct backup is configured or the backup run also fails (R16).

## Changing a role

1. Start OMP from the project root.
2. Press **Alt+M** and open **Roles**.
3. Assign the primary and optional backup alias.
4. Run:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh status
bash AI_Workflow_Kit/script/workflow_models.sh validate-role designer
```

Existing workers keep their resolved model. New workers use the updated alias.

## Model independence (R17)

```bash
python3 AI_Workflow_Kit/script/workflow_model_diversity.py
```

The doctor runs this check and warns when:

- the Reviewer uses the same model as the Coder primary **or the Coder backup**
  (after a failover the Reviewer would grade its own model's work);
- a role's backup is on the same provider as its primary;
- one provider backs up most core roles and also runs a core primary, so one
  outage removes both.

It is advisory: model choice stays with the Human.
