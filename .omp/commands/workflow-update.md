---
description: Update the workflow framework safely from upstream GitHub main
argument-hint: [check|apply]
---

Run the automated workflow update script:

```bash
bash AI_Workflow_Kit/script/workflow_update.sh $ARGUMENTS
```

This pulls the latest framework files, preserves your model assignments in `.omp/config.yml` and live project memory, runs `workflow_migrate.sh apply`, and validates everything with `workflow_doctor.sh`.
