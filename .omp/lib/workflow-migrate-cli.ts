// CLI runner for the schema v2 migration. Invoked by workflow_migrate.sh.
// Usage: node workflow-migrate-cli.ts check|apply [projectRoot]

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { migrateStateSource, migrateStepsSource, migrationCheck } from "./workflow-migration.ts";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const STEPS_PATH = "AI_Workflow_Kit/docs/STEPS.md";

const command = process.argv[2];
const root = process.argv[3] ?? process.cwd();
const stateFile = join(root, STATE_PATH);
const stepsFile = join(root, STEPS_PATH);

if (command !== "check" && command !== "apply") {
	console.error("usage: workflow-migrate-cli.ts check|apply [projectRoot]");
	process.exit(2);
}

if (!existsSync(stateFile) || !existsSync(stepsFile)) {
	console.log(`FAIL workflow files missing under ${root}`);
	process.exit(1);
}

const stateSource = readFileSync(stateFile, "utf8");
const stepsSource = readFileSync(stepsFile, "utf8");

if (command === "check") {
	const result = migrationCheck(stateSource, stepsSource);
	let failed = false;
	if (result.schemaVersion === 2) {
		console.log("OK   workflow schema v2");
	} else if (result.schemaVersion === null) {
		console.log("WARN workflow schema v1 · run workflow_migrate.sh apply");
	}
	for (const finding of result.findings) {
		const label = finding.level === "fail" ? "FAIL" : finding.level === "warn" ? "WARN" : "INFO";
		if (finding.level === "fail") failed = true;
		console.log(`${label} ${finding.message}`);
	}
	if (!failed && result.schemaVersion === 2 && result.findings.filter(f => f.level === "warn").length === 0) {
		console.log("OK   checklist IDs and state linkage consistent");
	}
	process.exit(failed ? 1 : 0);
}

// apply
const stepsEdit = migrateStepsSource(stepsSource);
const stateEdit = migrateStateSource(stateSource, stepsEdit.output);
const notes = [...stepsEdit.notes, ...stateEdit.notes];

if (!stepsEdit.changed && !stateEdit.changed) {
	console.log("OK   already migrated · no changes");
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (stepsEdit.changed) {
	copyFileSync(stepsFile, `${stepsFile}.bak-${stamp}`);
	writeFileSync(stepsFile, stepsEdit.output);
	console.log(`OK   ${STEPS_PATH} migrated (backup: ${STEPS_PATH}.bak-${stamp})`);
}
if (stateEdit.changed) {
	copyFileSync(stateFile, `${stateFile}.bak-${stamp}`);
	writeFileSync(stateFile, stateEdit.output);
	console.log(`OK   ${STATE_PATH} migrated (backup: ${STATE_PATH}.bak-${stamp})`);
}
for (const note of notes) {
	const label = note.level === "warn" ? "WARN" : "INFO";
	console.log(`${label} ${note.message}`);
}

// Re-check after applying; report remaining findings.
const after = migrationCheck(stateEdit.output, stepsEdit.output);
let failed = false;
for (const finding of after.findings) {
	if (finding.level === "fail") failed = true;
	const label = finding.level === "fail" ? "FAIL" : finding.level === "warn" ? "WARN" : "INFO";
	console.log(`${label} ${finding.message}`);
}
process.exit(failed ? 1 : 0);
