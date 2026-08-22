export type ContextEconomyPhase =
	| "unavailable"
	| "below"
	| "armed"
	| "waiting_safe_boundary"
	| "compacting"
	| "hard_threshold"
	| "cooldown"
	| "error";

const CONTEXT_ECONOMY_PHASES = new Set<ContextEconomyPhase>([
	"unavailable",
	"below",
	"armed",
	"waiting_safe_boundary",
	"compacting",
	"hard_threshold",
	"cooldown",
	"error",
]);

export function isContextEconomyPhase(value: unknown): value is ContextEconomyPhase {
	return typeof value === "string" && CONTEXT_ECONOMY_PHASES.has(value as ContextEconomyPhase);
}

export type ContextEconomyPolicy = {
	schemaVersion: number;
	softArmPercent: number;
	hardThresholdPercent: number;
	rearmPercent: number;
	cooldownSeconds: number;
	methodOrder: string[];
	requireMainIdle: boolean;
	requireNoActiveWorker: boolean;
	requireNoPendingMessages: boolean;
};

export const DEFAULT_CONTEXT_ECONOMY_POLICY: ContextEconomyPolicy = {
	schemaVersion: 1,
	softArmPercent: 23,
	hardThresholdPercent: 28,
	rearmPercent: 18,
	cooldownSeconds: 60,
	methodOrder: ["shake", "soft"],
	requireMainIdle: true,
	requireNoActiveWorker: true,
	requireNoPendingMessages: true,
};

export type ContextUsageLike = {
	tokens: number;
	contextWindow: number;
	percent: number;
};

export type ContextEconomyRuntimeState = {
	phase: ContextEconomyPhase;
	armed: boolean;
	compacting: boolean;
	updatedAt: number;
	lastReason?: string;
	lastAction?: string;
	lastCompactionAt?: number;
	lastBeforeTokens?: number;
	lastAfterTokens?: number;
	lastError?: string;
};

export type ContextEconomyDecisionInput = {
	usage?: ContextUsageLike;
	policy: ContextEconomyPolicy;
	state: ContextEconomyRuntimeState;
	now: number;
	mainIdle: boolean;
	activeWorker: boolean;
	pendingMessages: boolean;
};

export type ContextEconomyDecision = {
	phase: ContextEconomyPhase;
	armed: boolean;
	shouldCompact: boolean;
	reason: string;
};

const finiteNumber = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

export function normalizeContextEconomyPolicy(raw: unknown): ContextEconomyPolicy {
	const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const soft = Math.min(80, Math.max(1, finiteNumber(source.softArmPercent, 23)));
	const hard = Math.min(95, Math.max(soft + 1, finiteNumber(source.hardThresholdPercent, 28)));
	const rearm = Math.min(soft - 1, Math.max(0, finiteNumber(source.rearmPercent, 18)));
	const methods = Array.isArray(source.methodOrder)
		? source.methodOrder.filter((value): value is string => typeof value === "string" && value.length > 0)
		: [];
	return {
		schemaVersion: Math.max(1, Math.trunc(finiteNumber(source.schemaVersion, 1))),
		softArmPercent: soft,
		hardThresholdPercent: hard,
		rearmPercent: rearm,
		cooldownSeconds: Math.max(0, finiteNumber(source.cooldownSeconds, 60)),
		methodOrder: methods.length > 0 ? [...new Set(methods)] : ["shake", "soft"],
		requireMainIdle: booleanValue(source.requireMainIdle, true),
		requireNoActiveWorker: booleanValue(source.requireNoActiveWorker, true),
		requireNoPendingMessages: booleanValue(source.requireNoPendingMessages, true),
	};
}

export function initialContextEconomyState(now = Date.now()): ContextEconomyRuntimeState {
	return {
		phase: "unavailable",
		armed: false,
		compacting: false,
		updatedAt: now,
	};
}

export function evaluateContextEconomy(input: ContextEconomyDecisionInput): ContextEconomyDecision {
	const { usage, policy, state, now } = input;
	if (!usage || usage.contextWindow <= 0 || usage.tokens < 0 || !Number.isFinite(usage.percent)) {
		return { phase: "unavailable", armed: state.armed, shouldCompact: false, reason: "context usage unavailable" };
	}
	if (state.compacting) {
		return { phase: "compacting", armed: true, shouldCompact: false, reason: "compaction already running" };
	}
	if (usage.percent <= policy.rearmPercent) {
		return { phase: "below", armed: false, shouldCompact: false, reason: "context is below the rearm watermark" };
	}

	const armed = state.armed || usage.percent >= policy.softArmPercent;
	if (!armed) {
		return { phase: "below", armed: false, shouldCompact: false, reason: "context is below the soft arm watermark" };
	}
	if (usage.percent >= policy.hardThresholdPercent) {
		return {
			phase: "hard_threshold",
			armed: true,
			shouldCompact: false,
			reason: "native OMP threshold maintenance owns the hard boundary",
		};
	}

	const cooldownMs = policy.cooldownSeconds * 1000;
	if (state.lastCompactionAt && now - state.lastCompactionAt < cooldownMs) {
		return { phase: "cooldown", armed: true, shouldCompact: false, reason: "compaction cooldown is active" };
	}

	const blockers: string[] = [];
	if (policy.requireMainIdle && !input.mainIdle) blockers.push("Main is active");
	if (policy.requireNoActiveWorker && input.activeWorker) blockers.push("a workflow worker is active");
	if (policy.requireNoPendingMessages && input.pendingMessages) blockers.push("messages are queued");
	if (blockers.length > 0) {
		return {
			phase: "waiting_safe_boundary",
			armed: true,
			shouldCompact: false,
			reason: blockers.join("; "),
		};
	}

	return {
		phase: "armed",
		armed: true,
		shouldCompact: true,
		reason: "first safe boundary inside the floating compaction window",
	};
}

export type ContextEconomyStatus = {
	usage?: ContextUsageLike;
	policy: ContextEconomyPolicy;
	state: ContextEconomyRuntimeState;
	activeWorker: boolean;
	pendingMessages: boolean;
	mainIdle: boolean;
};

const compactTokens = (tokens: number): string => {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(Math.round(tokens));
};

export function formatContextEconomyStatus(status: ContextEconomyStatus): string {
	const { usage, policy, state } = status;
	if (!usage) return `Context n/a | floating compact ${policy.softArmPercent}-${policy.hardThresholdPercent}%`;
	const usageText = `${usage.percent.toFixed(1)}% (${compactTokens(usage.tokens)}/${compactTokens(usage.contextWindow)})`;
	const phase = state.phase.replaceAll("_", " ");
	const last = state.lastBeforeTokens !== undefined && state.lastAfterTokens !== undefined
		? ` | last ${compactTokens(state.lastBeforeTokens)}->${compactTokens(state.lastAfterTokens)}`
		: "";
	return `Context ${usageText} | ${phase} | window ${policy.softArmPercent}-${policy.hardThresholdPercent}% | ${policy.methodOrder.join("->")}${last}`;
}
