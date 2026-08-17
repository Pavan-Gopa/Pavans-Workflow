import assert from "node:assert/strict";
import {
	migrateStateSource,
	migrateStepsSource,
	migrationCheck,
	scanStepIds,
} from "../lib/workflow-migration.ts";

const legacySteps = `# Step cards

## How to write a card

\`\`\`markdown
## S1 — Short title

**Do:**
- [ ] first semantically verifiable work item
\`\`\`

---

## S0 — Ready + context

**Goal:** Orchestrator has read the workflow.

**Do:**
- [ ] Orchestrator confirms: ready to work with this process.
- [ ] Human provides project context.

**Out of scope:**
- Large product implementation before plan exists

## Verification

### Objective gates

- [ ] PROJECT_CONTEXT contains real project information

### Judgment gates

- [ ] next step or Architect path is clear

**Stop-gate:** Human agrees with the plan path

---

## S1 — _(title)_

**Goal:** _(fill)_

**Do:**
- [ ] first semantically verifiable work item

## Verification

### Objective gates

- [ ]
- [ ] project tests green

### Judgment gates

- [ ]

**Stop-gate:** (Reviewer APPROVED | review explicitly skipped by Human)
`;

// 1. IDs are added to real cards only; fenced template and placeholder cards untouched.
const migrated = migrateStepsSource(legacySteps);
assert.equal(migrated.changed, true);
assert.match(migrated.output, /- \[ \] \[S0\.D1\] Orchestrator confirms: ready to work with this process\./);
assert.match(migrated.output, /- \[ \] \[S0\.D2\] Human provides project context\./);
assert.match(migrated.output, /- \[ \] \[S0\.O1\] PROJECT_CONTEXT contains real project information/);
assert.match(migrated.output, /- \[ \] \[S0\.J1\] next step or Architect path is clear/);
// The `_(title)_` placeholder card is a template: excluded, like the dashboard parser.
assert.doesNotMatch(migrated.output, /\[S1\.D1\]/);
assert.match(migrated.output, /## S1 — _\(title\)_\n\n\*\*Goal:\*\* _\(fill\)_\n\n\*\*Do:\*\*\n- \[ \] first semantically verifiable work item/);
// Fenced template block is untouched.
assert.match(migrated.output, /```markdown\n## S1 — Short title\n\n\*\*Do:\*\*\n- \[ \] first semantically verifiable work item\n```/);
// Empty template checkboxes stay empty.
assert.match(migrated.output, /### Objective gates\n\n- \[ \]\n- \[ \] project tests green/);
assert.match(migrated.output, /\*\*Goal:\*\* Orchestrator has read the workflow\./);
assert.match(migrated.output, /\*\*Stop-gate:\*\* Human agrees with the plan path/);
// Checkbox state never flipped.
assert.doesNotMatch(migrated.output, /- \[x\]/);

// 2. Idempotency: second run is a no-op.
const second = migrateStepsSource(migrated.output);
assert.equal(second.changed, false);
assert.equal(second.output, migrated.output);

// 3. Existing IDs are preserved and numbering continues around them.
const partial = `## S3 — Config import

**Do:**
- [ ] [S3.D1] Add import
- [ ] Add error handling
- [ ] Add regression tests
`;
const partialMigrated = migrateStepsSource(partial);
assert.match(partialMigrated.output, /\[S3\.D1\] Add import/);
assert.match(partialMigrated.output, /\[S3\.D2\] Add error handling/);
assert.match(partialMigrated.output, /\[S3\.D3\] Add regression tests/);

// 4. Text with regex-special and $ replacement characters survives verbatim.
const tricky = `## S4 — Tricky

**Do:**
- [ ] Handle $100 price and $& marker
`;
const trickyMigrated = migrateStepsSource(tricky);
assert.match(trickyMigrated.output, /\[S4\.D1\] Handle \$100 price and \$& marker/);

// 5. scanStepIds sees the migrated shape.
const scanned = scanStepIds(migrated.output);
const s0 = scanned.find(card => card.stepId === "S0");
assert.ok(s0);
assert.deepEqual(
	s0.items.map(item => item.id),
	["S0.D1", "S0.D2", "S0.O1", "S0.J1"],
);

// 6. STATE.yaml migration: schema_version + current_work_item_id, unambiguous fill.
const legacyState = `# Live orchestration state
project_prefix: proj
onboarding:
  status: pending
  model_pairs_confirmed: false
current_step: S0
current_work_item: Human provides project context.
completed_steps: []
implementation:
  status: pending
`;
const stateMigrated = migrateStateSource(legacyState, migrated.output);
assert.equal(stateMigrated.changed, true);
assert.match(stateMigrated.output, /^schema_version: 2$/m);
assert.match(stateMigrated.output, /^current_work_item_id: S0\.D2$/m);
// schema_version lands before the first top-level key.
assert.ok(stateMigrated.output.indexOf("schema_version: 2") < stateMigrated.output.indexOf("project_prefix:"));

// 7. Idempotency for state.
const stateSecond = migrateStateSource(stateMigrated.output, migrated.output);
assert.equal(stateSecond.changed, false);
assert.equal(stateSecond.output, stateMigrated.output);

// 8. Ambiguous text leaves the ID null with a warning.
const ambiguousSteps = `## S5 — Dupes

**Do:**
- [ ] [S5.D1] Same text here
- [ ] [S5.D2] Same text here
`;
const ambiguousState = migrateStateSource(
	"schema_version: 2\ncurrent_step: S5\ncurrent_work_item: Same text here\ncurrent_work_item_id: null\n",
	ambiguousSteps,
);
assert.match(ambiguousState.output, /^current_work_item_id: null$/m);
assert.ok(ambiguousState.notes.some(note => note.code === "work_item_id_ambiguous"));

// 9. check: legacy file warns; migrated file is clean; duplicates fail.
const legacyCheck = migrationCheck(legacyState, legacySteps);
assert.equal(legacyCheck.schemaVersion, null);
assert.ok(legacyCheck.findings.some(f => f.code === "schema_version_missing"));
assert.ok(legacyCheck.findings.some(f => f.code === "ids_missing"));

const cleanCheck = migrationCheck(stateMigrated.output, migrated.output);
assert.equal(cleanCheck.schemaVersion, 2);
assert.ok(!cleanCheck.findings.some(f => f.level === "fail"), JSON.stringify(cleanCheck.findings));
assert.ok(!cleanCheck.findings.some(f => f.code === "ids_missing"));

const dupSteps = `## S6 — Dupes

**Do:**
- [ ] [S6.D1] One
- [ ] [S6.D1] Two
`;
const dupCheck = migrationCheck("schema_version: 2\ncurrent_step: S6\ncurrent_work_item: null\n", dupSteps);
assert.ok(dupCheck.findings.some(f => f.code === "duplicate_id" && f.level === "fail"));

// 10. check: wrong-step ID prefix warns.
const wrongStep = `## S7 — Wrong

**Do:**
- [ ] [S9.D1] Borrowed ID
`;
const wrongCheck = migrationCheck("schema_version: 2\ncurrent_step: S7\ncurrent_work_item: null\n", wrongStep);
assert.ok(wrongCheck.findings.some(f => f.code === "id_wrong_step"));

// 11. check: resolvable text without ID key warns.
const unsetCheck = migrationCheck(
	"schema_version: 2\ncurrent_step: S0\ncurrent_work_item: Human provides project context.\n",
	migrated.output,
);
assert.ok(unsetCheck.findings.some(f => f.code === "work_item_id_unset"));

// 12. check: unknown enum warns.
const enumCheck = migrationCheck(
	"schema_version: 2\ncurrent_step: S0\ncurrent_work_item: null\nimplementation:\n  status: exploded\n",
	migrated.output,
);
assert.ok(enumCheck.findings.some(f => f.code === "enum_unknown"));

console.log("workflow migration selftest: PASS");
console.log("  steps: ID assignment, template/fence exclusion, idempotency, text preservation");
console.log("  state: schema_version, current_work_item_id fill, ambiguity, idempotency");
console.log("  check: legacy warnings, duplicate IDs, wrong-step IDs, enums");
