import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	MAIN_ORCHESTRATOR_ALIAS,
	planMainAliasRepair,
	shouldRepairMainAlias,
} from "../lib/workflow-main-model-sync.ts";

assert.deepEqual(planMainAliasRepair(MAIN_ORCHESTRATOR_ALIAS), { kind: "noop" });
assert.deepEqual(planMainAliasRepair(undefined), { kind: "restore-alias", previousValue: undefined });
assert.deepEqual(planMainAliasRepair("provider/model:high"), {
	kind: "restore-alias",
	previousValue: "provider/model:high",
});

assert.equal(shouldRepairMainAlias(true), true, "interactive Main may repair the managed alias");
assert.equal(shouldRepairMainAlias(false), false, "headless/task workers must never repair Main roles");

const extensionPath = fileURLToPath(new URL("../extensions/workflow-main-model-sync.ts", import.meta.url));
const extensionSource = readFileSync(extensionPath, "utf8");
const executableSource = extensionSource.replace(/^\s*\/\/.*$/gm, "");
assert.doesNotMatch(executableSource, /setInterval\s*\(/, "Main model guard must not poll while OMP selectors are open");
assert.doesNotMatch(executableSource, /pi\.setModel\s*\(/, "OMP DEFAULT owns the live model switch");
assert.doesNotMatch(executableSource, /setThinkingLevel\s*\(/, "OMP DEFAULT owns effort selection");
assert.match(extensionSource, /session_start/);
assert.match(extensionSource, /session_switch/);

const configPath = fileURLToPath(new URL("../config.yml", import.meta.url));
const configSource = readFileSync(configPath, "utf8");
assert.match(configSource, /workflow_orchestrator:\s*["']@default["']/);
assert.match(
	configSource,
	/modelTags:[\s\S]*?workflow_orchestrator:[\s\S]*?hidden:\s*true/,
	"managed orchestrator alias must be hidden from Alt+M Roles",
);

console.log("OK workflow-main-model-sync no-race selftest");
