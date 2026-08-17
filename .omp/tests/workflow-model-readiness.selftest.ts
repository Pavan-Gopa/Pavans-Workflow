import assert from "node:assert/strict";
import {
	evaluateModelSetup,
	resolveConcreteRole,
	type ModelRoleConfig,
} from "../lib/workflow-model-readiness.ts";

const catalog = [
	{ provider: "openai", id: "gpt-5.6-sol" },
	{ provider: "openai", id: "gpt-5.6-luna" },
	{ provider: "openai", id: "gpt-5.6-terra" },
	{ provider: "google", id: "gemini-3.6-flash" },
	{ provider: "anthropic", id: "claude-opus-5" },
	{ provider: "zai", id: "glm-5.2" },
];

// 1. Quick Start: only @default configured, all roles point to orchestrator
const quickConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "@default",
		workflow_coder: "@workflow_orchestrator",
		workflow_reviewer: "@workflow_orchestrator",
		workflow_tester: "@workflow_orchestrator",
		workflow_architect: "@workflow_orchestrator",
		workflow_security: "@workflow_orchestrator",
	},
	availableModels: catalog,
};

const quickEval = evaluateModelSetup(quickConfig);
assert.equal(quickEval.mainReady, true);
assert.equal(quickEval.executionReady, true);
assert.equal(quickEval.qualityReady, true);
assert.equal(quickEval.fullTeamReady, true);
assert.equal(quickEval.fullyResilient, false); // No backups configured
assert.equal(quickEval.sharedWithMainCount, 5); // 5 workers share main
assert.equal(quickEval.configuredBackupsCount, 0);
assert.equal(quickEval.configuredPrimaryCount, 6);

// 2. Alias resolution with effort override
const effortConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "openai/gpt-5.6-sol:medium",
		workflow_coder: "@workflow_orchestrator:high",
	},
	availableModels: catalog,
};
const coderResolved = resolveConcreteRole("workflow_coder", effortConfig.roles);
assert.equal(coderResolved, "openai/gpt-5.6-sol:high");

// 3. Alias cycle detection returns undefined without hanging
const cyclicConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "@workflow_coder",
		workflow_coder: "@workflow_orchestrator",
	},
	availableModels: catalog,
};
assert.equal(resolveConcreteRole("workflow_orchestrator", cyclicConfig.roles), undefined);
const cyclicEval = evaluateModelSetup(cyclicConfig);
assert.equal(cyclicEval.mainReady, false);

// 4. Full diverse configuration with backups
const diverseConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "openai/gpt-5.6-sol:medium",
		workflow_orchestrator_backup: "google/gemini-3.6-flash:high",
		workflow_coder: "openai/gpt-5.6-luna:max",
		workflow_coder_backup: "google/gemini-3.6-flash:high",
		workflow_reviewer: "google/gemini-3.6-flash:high",
		workflow_reviewer_backup: "openai/gpt-5.6-sol:high",
		workflow_tester: "openai/gpt-5.6-terra:max",
		workflow_tester_backup: "google/gemini-3.6-flash:high",
		workflow_architect: "openai/gpt-5.6-sol:xhigh",
		workflow_architect_backup: "anthropic/claude-opus-5:high",
		workflow_security: "zai/glm-5.2:max",
		workflow_security_backup: "openai/gpt-5.6-sol:max",
	},
	availableModels: catalog,
};

const diverseEval = evaluateModelSetup(diverseConfig);
assert.equal(diverseEval.mainReady, true);
assert.equal(diverseEval.executionReady, true);
assert.equal(diverseEval.qualityReady, true);
assert.equal(diverseEval.fullTeamReady, true);
assert.equal(diverseEval.fullyResilient, true);
assert.equal(diverseEval.sharedWithMainCount, 0);
assert.equal(diverseEval.configuredBackupsCount, 6);
assert.equal(diverseEval.configuredPrimaryCount, 6);

// 5. Same-provider warning detected
const sameProviderConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "openai/gpt-5.6-sol",
		workflow_orchestrator_backup: "openai/gpt-5.6-luna",
	},
	availableModels: catalog,
};
const sameProviderEval = evaluateModelSetup(sameProviderConfig);
assert.equal(sameProviderEval.roles.orchestrator.sameProvider, true);
assert.match(sameProviderEval.roles.orchestrator.status, /same-provider warning/);

// 6. Unavailable model identity detected
const unavailableConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "nonexistent/fake-model",
	},
	availableModels: catalog,
};
const unavailableEval = evaluateModelSetup(unavailableConfig);
assert.equal(unavailableEval.roles.orchestrator.primaryOk, false);
assert.match(unavailableEval.roles.orchestrator.status, /primary unavailable/);

console.log("workflow model readiness selftest: PASS");
console.log("  quick: @default and alias chains to orchestrator");
console.log("  resolution: effort override, cycle detection");
console.log("  levels: main, execution, quality, full team, fully resilient");
console.log("  diagnostics: same-provider warning, unavailable model detection");
