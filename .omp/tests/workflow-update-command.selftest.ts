import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UPDATER_SCRIPT, updaterInvocation } from "../lib/workflow-update-command.ts";

assert.deepEqual(updaterInvocation(""), { mode: "apply", argv: [UPDATER_SCRIPT, "apply"], errors: [] });
assert.deepEqual(updaterInvocation("check").argv, [UPDATER_SCRIPT, "check"]);
assert.deepEqual(updaterInvocation("  dry-run ").argv, [UPDATER_SCRIPT, "check"]);
assert.deepEqual(updaterInvocation("--refresh-graphify").argv, [UPDATER_SCRIPT, "apply", "--refresh-graphify"]);
assert.deepEqual(updaterInvocation("check --refresh-graphify").argv, [UPDATER_SCRIPT, "check"], "check never refreshes");
assert.deepEqual(updaterInvocation("--ref v3.5.0").argv, [UPDATER_SCRIPT, "apply", "--ref", "v3.5.0"]);
assert.deepEqual(updaterInvocation("--ref=main check").argv, [UPDATER_SCRIPT, "check", "--ref", "main"]);
assert.deepEqual(updaterInvocation("--ref ;rm").errors, ["invalid --ref value: ;rm"]);
assert.deepEqual(updaterInvocation("--ref").errors, ["invalid --ref value: <missing>"]);
assert.deepEqual(updaterInvocation("bogus").errors, ["unknown argument: bogus"]);

// Regression guard for v3.4.x: the extension must always call the canonical
// updater, never the removed experiment bridge.
const extension = readFileSync(fileURLToPath(new URL("../lib/workflow-dashboard-extension.ts", import.meta.url)), "utf8");
assert.doesNotMatch(extension, /workflow_experiment/, "no experiment bridge in the update command");
assert.match(extension, /updaterInvocation\(/, "update command uses updaterInvocation");

console.log("OK workflow update command selftest");
