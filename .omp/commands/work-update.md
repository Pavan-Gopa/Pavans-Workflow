---
description: Fast alias to update the workflow framework to the latest release
argument-hint: [check] [--ref <tag>] [--refresh-graphify]
---

Run the canonical workflow updater (the Alt+W extension registers the same
command and runs it directly when available):

```bash
bash AI_Workflow_Kit/script/workflow_update.sh $ARGUMENTS
```

`check` prints the plan without changing anything. `apply` (default) installs
the newest `vX.Y.Z` release from AI_Workflow_Kit/framework.manifest, removes
framework files the release deleted, preserves model assignments, project
state, and custom files, runs `workflow_migrate.sh apply` and
`workflow_doctor.sh`. Framework files are backed up and restored automatically
if the framework step fails; migration and doctor failures are reported. Tell the Human to restart OMP afterwards; do not continue
product routing in the same command.
