export const MAIN_ORCHESTRATOR_ROLE = "workflow_orchestrator";
export const MAIN_ORCHESTRATOR_ALIAS = "@default";

export type MainAliasRepair =
	| { kind: "noop" }
	| { kind: "restore-alias"; previousValue?: string };

/**
 * workflow_orchestrator is an implementation alias, not a second editable
 * Main-model slot. DEFAULT is the sole authority because OMP applies the model
 * and its thinking/effort selection to the active session as one native flow.
 */
export function planMainAliasRepair(roleValue: string | undefined): MainAliasRepair {
	if (roleValue === MAIN_ORCHESTRATOR_ALIAS) return { kind: "noop" };
	return { kind: "restore-alias", previousValue: roleValue };
}

/** Project extensions are inherited by workers; only interactive Main repairs the alias. */
export function shouldRepairMainAlias(hasUI: boolean): boolean {
	return hasUI;
}
