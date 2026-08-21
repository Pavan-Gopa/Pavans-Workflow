import assert from "node:assert/strict";
import {
	explicitThinkingLevel,
	MAIN_DEFAULT_ROLE,
	MAIN_ORCHESTRATOR_ALIAS,
	MAIN_ORCHESTRATOR_ROLE,
	planMainRoleMutation,
	shouldAttachMainModelSync,
} from "../extensions/workflow-main-model-sync.ts";

const fromDefault = planMainRoleMutation("project", "set", MAIN_DEFAULT_ROLE, "openai-codex/gpt-5.6-sol:medium");
assert.deepEqual(fromDefault, {
	kind: "paired",
	scope: "project",
	defaultOperation: "set",
	defaultValue: "openai-codex/gpt-5.6-sol:medium",
	orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
	syncLive: false,
});

const fromOrchestrator = planMainRoleMutation(
	"project",
	"set",
	MAIN_ORCHESTRATOR_ROLE,
	"google-antigravity/gemini-3.1-pro:high",
);
assert.deepEqual(fromOrchestrator, {
	kind: "paired",
	scope: "project",
	defaultOperation: "set",
	defaultValue: "google-antigravity/gemini-3.1-pro:high",
	orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
	syncLive: true,
});

assert.deepEqual(planMainRoleMutation("project", "set", MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS), {
	kind: "alias-only",
	scope: "project",
});

assert.deepEqual(planMainRoleMutation("project", "clear", MAIN_ORCHESTRATOR_ROLE), {
	kind: "paired",
	scope: "project",
	defaultOperation: "clear",
	orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
	syncLive: true,
});

assert.deepEqual(planMainRoleMutation("global", "set", "workflow_coder", "openai-codex/gpt-5.6-luna:max"), {
	kind: "passthrough",
});

assert.equal(explicitThinkingLevel("openai-codex/gpt-5.6-sol:xhigh"), "xhigh");
assert.equal(explicitThinkingLevel("google-antigravity/gemini-3.1-pro"), undefined);
assert.equal(explicitThinkingLevel("vendor/model:unknown"), undefined);

assert.equal(shouldAttachMainModelSync(true), true, "interactive Main attaches model sync");
assert.equal(shouldAttachMainModelSync(false), false, "headless/task workers must never attach Main model sync");

console.log("OK workflow-main-model-sync deterministic selftest");
