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
	{ provider: "moonshot", id: "kimi-k3" },
];

const quickConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "@default",
		workflow_coder: "@workflow_orchestrator",
		workflow_reviewer: "@workflow_orchestrator",
		workflow_tester: "@workflow_orchestrator",
		workflow_architect: "@workflow_orchestrator",
		workflow_security: "@workflow_orchestrator",
		workflow_design_advisor: "@workflow_reviewer",
		workflow_designer: "@workflow_architect",
	},
	availableModels: catalog,
};

const quickEval = evaluateModelSetup(quickConfig);
assert.equal(quickEval.mainReady, true);
assert.equal(quickEval.executionReady, true);
assert.equal(quickEval.qualityReady, true);
assert.equal(quickEval.fullTeamReady, true);
assert.equal(quickEval.fullyResilient, false);
assert.equal(quickEval.designAdvisoryReady, true);
assert.equal(quickEval.designImplementationReady, true);
assert.equal(quickEval.sharedWithMainCount, 7);
assert.equal(quickEval.configuredBackupsCount, 0);
assert.equal(quickEval.configuredPrimaryCount, 8);
assert.equal(quickEval.totalRoles, 8);

const effortConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "openai/gpt-5.6-sol:medium",
		workflow_coder: "@workflow_orchestrator:high",
	},
	availableModels: catalog,
};
assert.equal(resolveConcreteRole("workflow_coder", effortConfig.roles), "openai/gpt-5.6-sol:high");

const cyclicConfig: ModelRoleConfig = {
	roles: {
		workflow_orchestrator: "@workflow_coder",
		workflow_coder: "@workflow_orchestrator",
	},
	availableModels: catalog,
};
assert.equal(resolveConcreteRole("workflow_orchestrator", cyclicConfig.roles), undefined);
assert.equal(evaluateModelSetup(cyclicConfig).mainReady, false);

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
		workflow_design_advisor: "google/gemini-3.6-flash:high",
		workflow_design_advisor_backup: "openai/gpt-5.6-sol:high",
		workflow_designer: "moonshot/kimi-k3:max",
		workflow_designer_backup: "anthropic/claude-opus-5:high",
	},
	availableModels: catalog,
};

const diverseEval = evaluateModelSetup(diverseConfig);
assert.equal(diverseEval.fullTeamReady, true);
assert.equal(diverseEval.fullyResilient, true);
assert.equal(diverseEval.designAdvisoryReady, true);
assert.equal(diverseEval.designImplementationReady, true);
assert.equal(diverseEval.sharedWithMainCount, 0);
assert.equal(diverseEval.configuredBackupsCount, 8);
assert.equal(diverseEval.configuredPrimaryCount, 8);

const sameProviderEval = evaluateModelSetup({
	roles: {
		workflow_orchestrator: "openai/gpt-5.6-sol",
		workflow_orchestrator_backup: "openai/gpt-5.6-luna",
	},
	availableModels: catalog,
});
assert.equal(sameProviderEval.roles.orchestrator.sameProvider, true);
assert.match(sameProviderEval.roles.orchestrator.status, /same-provider warning/);

const unavailableEval = evaluateModelSetup({
	roles: { workflow_orchestrator: "nonexistent/fake-model" },
	availableModels: catalog,
});
assert.equal(unavailableEval.roles.orchestrator.primaryOk, false);
assert.match(unavailableEval.roles.orchestrator.status, /primary unavailable/);

console.log("workflow model readiness selftest: PASS");
console.log("  core readiness remains independent of optional design roles");
console.log("  optional: advisor and edit-capable Designer aliases resolve independently");
console.log("  resolution: effort override, cycle detection, provider warnings");
