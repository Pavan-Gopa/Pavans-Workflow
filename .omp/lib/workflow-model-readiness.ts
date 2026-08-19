// Pure TypeScript evaluator for model role readiness and progressive onboarding.
// Mirrors workflow_models.sh logic for memory-fast Alt-W dashboard rendering and unit tests.

export type ModelCatalogItem = {
	provider: string;
	id: string;
};

export type ModelRoleConfig = {
	roles: Record<string, string>;
	availableModels: ModelCatalogItem[];
	defaultModel?: string;
};

export type RoleEvaluation = {
	key: string;
	label: string;
	primaryAlias: string;
	backupAlias: string;
	primary?: string;
	backup?: string;
	primaryOk: boolean;
	backupOk: boolean;
	sameProvider: boolean;
	optional: boolean;
	status: string;
};

export type ModelSetupSummary = {
	mainReady: boolean;
	executionReady: boolean;
	qualityReady: boolean;
	fullTeamReady: boolean;
	fullyResilient: boolean;
	designAdvisoryReady: boolean;
	designImplementationReady: boolean;
	sharedWithMainCount: number;
	configuredBackupsCount: number;
	configuredPrimaryCount: number;
	totalRoles: number;
	roles: Record<string, RoleEvaluation>;
};

export const CORE_ROLES = ["orchestrator", "coder", "reviewer", "tester", "architect", "security"] as const;
export const OPTIONAL_ROLES = ["design_advisor", "designer"] as const;
export const ORDERED_ROLES = [...CORE_ROLES, ...OPTIONAL_ROLES] as const;

export const ROLE_LABELS: Record<string, string> = {
	orchestrator: "Main",
	coder: "Coder",
	reviewer: "Reviewer",
	tester: "Tester",
	architect: "Architect",
	security: "Security",
	design_advisor: "Design Advisor",
	designer: "Designer",
};

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "auto"]);

export function resolveConcreteRole(
	name: string,
	roles: Record<string, string>,
	defaultModel?: string,
	stack: string[] = [],
): string | undefined {
	const raw = roles[name];
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const trimmed = raw.trim();
	const match = trimmed.match(/^@([^:]+)(?::(minimal|low|medium|high|xhigh|max|auto))?$/);
	if (!match) return trimmed;
	const target = match[1];
	const override = match[2];
	let resolved: string | undefined;
	if (target === "default") {
		resolved = defaultModel;
	} else if (stack.includes(target)) {
		return undefined;
	} else {
		resolved = resolveConcreteRole(target, roles, defaultModel, [...stack, name]);
	}
	if (!resolved || !override) return resolved;
	const parts = resolved.split("/");
	if (parts.length < 2) return undefined;
	let modelId = parts.slice(1).join("/");
	for (const effort of EFFORTS) {
		const suffix = `:${effort}`;
		if (modelId.endsWith(suffix)) {
			modelId = modelId.slice(0, -suffix.length);
			break;
		}
	}
	return `${parts[0]}/${modelId}:${override}`;
}

export function isSelectorAvailable(selector: string | undefined, available: Set<string>): boolean {
	if (!selector || !selector.includes("/")) return false;
	if (available.has(selector)) return true;
	const match = selector.match(/^(.+)\/([^:]+):([a-z]+)$/);
	if (match && EFFORTS.has(match[3])) {
		return available.has(`${match[1]}/${match[2]}`);
	}
	return false;
}

export function providerOf(selector: string | undefined): string | undefined {
	return selector && selector.includes("/") ? selector.split("/")[0] : undefined;
}

export function evaluateModelSetup(config: ModelRoleConfig): ModelSetupSummary {
	const availableSet = new Set(config.availableModels.map(model => `${model.provider}/${model.id}`));
	const defaultSelector =
		config.defaultModel ??
		(config.availableModels.length > 0
			? `${config.availableModels[0].provider}/${config.availableModels[0].id}`
			: undefined);

	const roleEvals: Record<string, RoleEvaluation> = {};
	let sharedWithMain = 0;
	let backupsCount = 0;
	let primariesCount = 0;
	const mainPrimary = resolveConcreteRole("workflow_orchestrator", config.roles, defaultSelector);

	for (const key of ORDERED_ROLES) {
		const label = ROLE_LABELS[key];
		const primaryAlias = `workflow_${key}`;
		const backupAlias = `workflow_${key}_backup`;
		const primary = resolveConcreteRole(primaryAlias, config.roles, defaultSelector);
		const backup = resolveConcreteRole(backupAlias, config.roles, defaultSelector);
		const primaryOk = isSelectorAvailable(primary, availableSet);
		const backupOk = isSelectorAvailable(backup, availableSet);
		const sameProvider = Boolean(primaryOk && backupOk && providerOf(primary) === providerOf(backup));
		const optional = OPTIONAL_ROLES.includes(key as (typeof OPTIONAL_ROLES)[number]);

		if (primaryOk) primariesCount += 1;
		if (backupOk) backupsCount += 1;
		if (key !== "orchestrator" && primary && mainPrimary && primary === mainPrimary) sharedWithMain += 1;

		const notes: string[] = [];
		if (!primary) notes.push(optional ? "primary missing (optional)" : "primary missing");
		else if (!primaryOk) notes.push("primary unavailable");
		if (!backup) notes.push("backup missing (optional)");
		else if (!backupOk) notes.push("backup unavailable");
		if (sameProvider) notes.push("same-provider warning");

		roleEvals[key] = {
			key,
			label,
			primaryAlias,
			backupAlias,
			primary,
			backup,
			primaryOk,
			backupOk,
			sameProvider,
			optional,
			status: notes.length > 0 ? notes.join(", ") : "ready",
		};
	}

	const mainReady = roleEvals.orchestrator.primaryOk;
	const executionReady = mainReady && roleEvals.coder.primaryOk;
	const qualityReady = executionReady && roleEvals.reviewer.primaryOk && roleEvals.tester.primaryOk;
	const fullTeamReady = qualityReady && roleEvals.architect.primaryOk && roleEvals.security.primaryOk;
	const fullyResilient = fullTeamReady && CORE_ROLES.every(key => roleEvals[key].backupOk);

	return {
		mainReady,
		executionReady,
		qualityReady,
		fullTeamReady,
		fullyResilient,
		designAdvisoryReady: roleEvals.design_advisor.primaryOk,
		designImplementationReady: roleEvals.designer.primaryOk,
		sharedWithMainCount: sharedWithMain,
		configuredBackupsCount: backupsCount,
		configuredPrimaryCount: primariesCount,
		totalRoles: ORDERED_ROLES.length,
		roles: roleEvals,
	};
}
