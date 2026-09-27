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

export type RoleStorage = "project" | "global";

type SettingsLike = {
	get?: (key: string) => unknown;
	getProjectSettings?: () => Record<string, unknown> | undefined;
	getGlobalSettings?: () => Record<string, unknown> | undefined;
};

/**
 * Where OMP persists model roles. OMP <= 17 exposed `settings.get(key)`; OMP 18
 * moved to a typed registry and only keeps the raw project/global views. Read
 * whichever exists; the workflow config itself declares `modelRoleStorage: project`.
 */
export function resolveRoleStorage(settingsLike: unknown): RoleStorage {
	const candidate = (settingsLike ?? {}) as SettingsLike;
	try {
		const value =
			typeof candidate.get === "function"
				? candidate.get("modelRoleStorage")
				: (candidate.getProjectSettings?.()?.modelRoleStorage ?? candidate.getGlobalSettings?.()?.modelRoleStorage);
		if (value === "project" || value === "global") return value;
	} catch {
		// Fall through to the workflow default below.
	}
	return "project";
}
