export const MAIN_DEFAULT_ROLE = "default";
export const MAIN_ORCHESTRATOR_ROLE = "workflow_orchestrator";
export const MAIN_ORCHESTRATOR_ALIAS = "@default";

export type MainModelScope = "project" | "global";
export type MainRoleMutation =
	| { kind: "passthrough" }
	| {
			kind: "paired";
			scope: MainModelScope;
			defaultOperation: "set" | "clear";
			defaultValue?: string;
			orchestratorValue: typeof MAIN_ORCHESTRATOR_ALIAS;
			syncLive: boolean;
	  }
	| { kind: "alias-only"; scope: MainModelScope };

export function planMainRoleMutation(
	scope: MainModelScope,
	operation: "set" | "clear",
	role: string,
	value?: string,
): MainRoleMutation {
	if (role !== MAIN_DEFAULT_ROLE && role !== MAIN_ORCHESTRATOR_ROLE) return { kind: "passthrough" };
	if (role === MAIN_ORCHESTRATOR_ROLE && operation === "set" && value === MAIN_ORCHESTRATOR_ALIAS) {
		return { kind: "alias-only", scope };
	}
	if (operation === "clear") {
		return {
			kind: "paired",
			scope,
			defaultOperation: "clear",
			orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
			syncLive: role === MAIN_ORCHESTRATOR_ROLE,
		};
	}
	if (!value) return { kind: "passthrough" };
	return {
		kind: "paired",
		scope,
		defaultOperation: "set",
		defaultValue: value,
		orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
		syncLive: role === MAIN_ORCHESTRATOR_ROLE,
	};
}

/**
 * Project extensions are inherited by task/headless subagent sessions. Main
 * model synchronization must never retarget a worker model, so only the
 * top-level interactive session is allowed to attach the reconciliation loop.
 */
export function shouldAttachMainModelSync(hasUI: boolean): boolean {
	return hasUI;
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

export function explicitThinkingLevel(roleValue: string | undefined): string | undefined {
	const match = roleValue ? roleValue.match(THINKING_SUFFIX) : undefined;
	return match && match[1] ? match[1].toLowerCase() : undefined;
}
