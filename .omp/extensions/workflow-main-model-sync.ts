import { settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	MAIN_ORCHESTRATOR_ALIAS,
	MAIN_ORCHESTRATOR_ROLE,
	planMainAliasRepair,
	resolveRoleStorage,
	shouldRepairMainAlias,
	type MainAliasRepair,
	type RoleStorage,
} from "../lib/workflow-main-model-sync.ts";

function setRole(scope: RoleStorage, role: string, value: string): void {
	if (scope === "project") settings.setProjectModelRole(role, value);
	else settings.setModelRole(role, value);
}

function repairAlias(ctx: ExtensionContext): MainAliasRepair {
	const repair = planMainAliasRepair(settings.getModelRole(MAIN_ORCHESTRATOR_ROLE));
	if (repair.kind === "noop") return repair;

	setRole(resolveRoleStorage(settings), MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
	if (ctx.hasUI && repair.previousValue) {
		ctx.ui.notify(
			"Main model: workflow_orchestrator is a managed alias. Change DEFAULT in Alt+M; its model and effort are applied by OMP.",
			"warning",
		);
	}
	return repair;
}

export default function workflowMainModelSync(pi: ExtensionAPI): void {
	const attach = (ctx: ExtensionContext): void => {
		if (!shouldRepairMainAlias(ctx.hasUI)) return;
		repairAlias(ctx);
	};

	// Deliberately no polling and no pi.setModel()/setThinkingLevel() calls.
	// OMP's native DEFAULT assignment first persists the role and then completes
	// its effort picker. Mutating the live model from a timer during that staged
	// UI flow used to tear down the picker before effort could be selected.
	pi.on("session_start", async (_event, ctx) => attach(ctx));
	pi.on("session_switch", async (_event, ctx) => attach(ctx));
}
