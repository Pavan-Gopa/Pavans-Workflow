export type Tone = "normal" | "accent" | "muted" | "warning";

export type TextLine = {
	text: string;
	tone?: Tone;
};

export type ChecklistItem = {
	text: string;
	done: boolean;
	canonical: boolean;
};

export type StepCard = {
	id: string;
	title: string;
	goal: string;
	dependsOn: string;
	todos: ChecklistItem[];
	objectiveGates: ChecklistItem[];
	judgmentGates: ChecklistItem[];
};

export type WorkflowState = {
	currentStep: string;
	currentWorkItem: string;
	stepDescription: string;
	track: string;
	nextActor: string;
	completedSteps: string[];
	onboardingStatus: string;
	implementationStatus: string;
	implementationAttempts: number;
	reviewStatus: string;
	reviewVerdict: string;
	reviewEnabled: boolean;
	qaStatus: string;
	qaEnabled: boolean;
	securityNextRun: string;
	blocker: string;
	repeatedFailureCount: number;
	activeAgent: string;
	activeRole: string;
	interruptionStatus: string;
	modelFailureStatus: string;
	modelFailureRole: string;
	modelFailureInstruction: string;
};

export type MetricRatio = {
	count: number;
	total: number;
	rate_pct?: number | null;
};

export type RoleStats = {
	runs: number;
	verified_results: number;
	results: Record<string, number>;
	median_duration_ms?: number | null;
	first_review_approval?: MetricRatio;
	product_rejection?: MetricRatio;
	qa_escape?: MetricRatio;
	modes?: Record<string, number>;
};

export type StepModelStats = {
	role: string;
	provider: string;
	model: string;
	runs: number;
};

export type StepStats = {
	status: "completed" | "in_progress" | "observed";
	started_at?: string | null;
	completed_at?: string | null;
	duration_ms?: number | null;
	coder_attempts: number;
	product_reviews: { runs: number; approved: number; changes_requested: number };
	qa_runs: { runs: number; qa_green: number; bugs: number };
	architect_modes: Record<string, number>;
	failure_count: number;
	runtime_interruptions: number;
	gate_skips: Record<string, number>;
	human_rating?: string | null;
	models: StepModelStats[];
};

export type ModelSample = {
	role: string;
	provider: string;
	model: string;
	runs: number;
	median_duration_ms?: number | null;
	first_review_approval?: MetricRatio;
	sample_warning?: string | null;
};

export type MetricsReport = {
	available?: boolean;
	error?: string;
	storage?: {
		data_since?: string | null;
		valid_events?: number;
	};
	summary?: {
		completed_steps?: number;
		completed_product_steps?: number;
		first_pass_step_success?: MetricRatio;
		average_coder_attempts?: number | null;
		reviewer_rejection?: MetricRatio;
		qa_escape?: MetricRatio;
		architect_escalation?: MetricRatio;
		advisor_usage?: MetricRatio;
		repeated_failure_incidents?: number;
		runtime_interruption?: MetricRatio;
		model_failure?: MetricRatio;
		median_step_duration_ms?: number | null;
		median_worker_duration_ms?: number | null;
	};
	role_stats?: Record<string, RoleStats>;
	step_stats?: Record<string, StepStats>;
	failure_categories?: Record<string, number>;
	detected_by?: Record<string, number>;
	human_ratings?: Record<string, number>;
	model_samples?: ModelSample[];
};

export type SessionModelUsage = {
	model: string;
	totalTokens: number;
	requests: number;
	roles: Record<string, number>;
};

export type SessionUsage = {
	totalTokens: number;
	models: SessionModelUsage[];
};

export type WorkerSnapshot = {
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	startedAt: number;
	durationMs?: number;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
};

export type RuntimeSnapshot = {
	worker?: WorkerSnapshot;
	mainModel?: string;
	mainStatus: "idle" | "working";
	mainActivity: string;
};

export type DashboardData = {
	state: WorkflowState;
	steps: StepCard[];
	metrics?: MetricsReport;
	metricsError?: string;
	stateError?: string;
	stepsError?: string;
	sessionUsage: SessionUsage;
};

export type StepRelation = "current" | "completed" | "planned" | "missing";

export type DashboardViewModel = {
	data: DashboardData;
	runtime: RuntimeSnapshot;
	selectedStep?: StepCard;
	selectedStepId: string;
	selectedIndex: number;
	currentIndex: number;
	relation: StepRelation;
	completedInPlan: number;
	remainingInPlan: number;
	completedOutsidePlan: string[];
	currentRole?: string;
	status: string;
	nextAction: string;
	waitingForHuman: boolean;
};

export type RenderResult = {
	lines: TextLine[];
	layout: "wide" | "medium" | "narrow";
	maxDetailScroll: number;
};

export type StatsFooterInfo = {
	url?: string;
	status: string;
};

const SPECIALIZED_ROLES = new Set(["coder", "reviewer", "tester", "architect", "security"]);
const THINKING_SUFFIX = /:(?:none|minimal|low|medium|high|xhigh|max)$/i;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export type AssistantUsageMessage = {
	role?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
	responseId?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheWrite?: number;
		totalTokens?: number;
	};
};

export type WorkerUsageProgress = {
	id: string;
	agent: string;
	tokens?: number;
	requests?: number;
	resolvedModel?: string;
};

type MutableModelUsage = SessionModelUsage;
type WorkerUsageBaseline = {
	tokens: number;
	requests: number;
	model?: string;
	pendingTokens: number;
	pendingRequests: number;
};

function finiteUsageNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageTokens(usage: AssistantUsageMessage["usage"]): number {
	if (!usage) return 0;
	const computed =
		finiteUsageNumber(usage.input) +
		finiteUsageNumber(usage.output) +
		finiteUsageNumber(usage.cacheWrite);
	return computed > 0 ? computed : finiteUsageNumber(usage.totalTokens);
}

export class SessionUsageTracker {
	private readonly models = new Map<string, MutableModelUsage>();
	private readonly workerBaselines = new Map<string, WorkerUsageBaseline>();
	private readonly messageKeys = new Set<string>();

	reset(): void {
		this.models.clear();
		this.workerBaselines.clear();
		this.messageKeys.clear();
	}

	recordAssistantMessage(message: AssistantUsageMessage, role = "orchestrator", key?: string): void {
		if (message.role !== "assistant" || !message.provider || !message.model) return;
		const identity =
			key ??
			`${message.timestamp ?? 0}:${message.responseId ?? ""}:${message.provider}/${message.model}`;
		if (this.messageKeys.has(identity)) return;
		this.messageKeys.add(identity);
		this.add(`${message.provider}/${message.model}`, role, usageTokens(message.usage), 1);
	}

	recordWorkerProgress(progress: WorkerUsageProgress): void {
		const previous = this.workerBaselines.get(progress.id) ?? {
			tokens: 0,
			requests: 0,
			pendingTokens: 0,
			pendingRequests: 0,
		};
		const nextTokens = Math.max(0, finiteUsageNumber(progress.tokens));
		const nextRequests = Math.max(0, finiteUsageNumber(progress.requests));
		const tokenDelta = nextTokens >= previous.tokens ? nextTokens - previous.tokens : 0;
		const requestDelta = nextRequests >= previous.requests ? nextRequests - previous.requests : 0;
		const model = progress.resolvedModel ? stripThinkingSuffix(progress.resolvedModel) : previous.model;
		const role = normalizeRole(progress.agent) ?? progress.agent;
		if (model) {
			this.add(
				model,
				role,
				tokenDelta + previous.pendingTokens,
				requestDelta + previous.pendingRequests,
			);
			previous.pendingTokens = 0;
			previous.pendingRequests = 0;
		} else {
			previous.pendingTokens += tokenDelta;
			previous.pendingRequests += requestDelta;
		}
		previous.tokens = nextTokens;
		previous.requests = nextRequests;
		previous.model = model;
		this.workerBaselines.set(progress.id, previous);
	}

	snapshot(): SessionUsage {
		const models = [...this.models.values()].map(model => ({
			model: model.model,
			totalTokens: model.totalTokens,
			requests: model.requests,
			roles: { ...model.roles },
		}));
		return {
			totalTokens: models.reduce((total, model) => total + model.totalTokens, 0),
			models,
		};
	}

	private add(modelValue: string, role: string, tokens: number, requests: number): void {
		if (tokens <= 0 && requests <= 0) return;
		const model = stripThinkingSuffix(modelValue);
		const bucket = this.models.get(model) ?? {
			model,
			totalTokens: 0,
			requests: 0,
			roles: {},
		};
		bucket.totalTokens += Math.max(0, tokens);
		bucket.requests += Math.max(0, requests);
		bucket.roles[role] = (bucket.roles[role] ?? 0) + Math.max(0, tokens);
		this.models.set(model, bucket);
	}
}

function cleanScalar(value: string | undefined, fallback = "-"): string {
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "null" || trimmed === "~") return fallback;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function topValue(source: string, key: string): string {
	const match = source.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+)$`, "m"));
	return cleanScalar(match?.[1]);
}

function sectionBody(source: string, section: string): string {
	const match = source.match(
		new RegExp(`^${escapeRegExp(section)}:\\s*\\n([\\s\\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|(?![\\s\\S]))`, "m"),
	);
	return match?.[1] ?? "";
}

function sectionValue(source: string, section: string, key: string): string {
	const body = sectionBody(source, section);
	const match = body.match(new RegExp(`^\\s{2}${escapeRegExp(key)}:\\s*(.+)$`, "m"));
	return cleanScalar(match?.[1]);
}

function sectionNumber(source: string, section: string, key: string): number {
	const value = Number(sectionValue(source, section, key));
	return Number.isFinite(value) ? value : 0;
}

function sectionBoolean(source: string, section: string, key: string, fallback: boolean): boolean {
	const value = sectionValue(source, section, key).toLowerCase();
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function nestedSectionValue(source: string, parent: string, section: string, key: string): string {
	const parentBody = sectionBody(source, parent);
	const nested = parentBody.match(new RegExp(`^\\s{2}${escapeRegExp(section)}:\\s*\\n((?:\\s{4,}.*(?:\\n|$))*)`, "m"));
	if (!nested) return "-";
	const match = nested[1].match(new RegExp(`^\\s{4}${escapeRegExp(key)}:\\s*(.+)$`, "m"));
	return cleanScalar(match?.[1]);
}

function foldedValue(source: string, key: string): string {
	const match = source.match(new RegExp(`^${escapeRegExp(key)}:\\s*>-?\\s*\\n((?:\\s{2,}.*(?:\\n|$))+)`, "m"));
	if (!match) return topValue(source, key);
	return match[1]
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.join(" ");
}

function listValue(source: string, key: string): string[] {
	const inline = source.match(new RegExp(`^${escapeRegExp(key)}:\\s*\\[([^\\]]*)\\]`, "m"));
	if (inline) {
		return inline[1]
			.split(",")
			.map(value => cleanScalar(value, ""))
			.filter(Boolean);
	}
	const block = source.match(new RegExp(`^${escapeRegExp(key)}:\\s*\\n((?:\\s{2,}-\\s+.*(?:\\n|$))*)`, "m"));
	if (!block) return [];
	return block[1]
		.split("\n")
		.map(line => cleanScalar(line.replace(/^\s*-\s*/, ""), ""))
		.filter(Boolean);
}

export function parseWorkflowState(source: string): WorkflowState {
	return {
		currentStep: topValue(source, "current_step"),
		currentWorkItem: topValue(source, "current_work_item"),
		stepDescription: foldedValue(source, "step_description"),
		track: topValue(source, "track"),
		nextActor: topValue(source, "next_actor"),
		completedSteps: listValue(source, "completed_steps"),
		onboardingStatus: sectionValue(source, "onboarding", "status"),
		implementationStatus: sectionValue(source, "implementation", "status"),
		implementationAttempts: sectionNumber(source, "implementation", "attempts"),
		reviewStatus: sectionValue(source, "review", "status"),
		reviewVerdict: sectionValue(source, "review", "verdict"),
		reviewEnabled: sectionBoolean(source, "review", "enabled", true),
		qaStatus: sectionValue(source, "qa", "status"),
		qaEnabled: sectionBoolean(source, "qa", "enabled", true),
		securityNextRun: sectionValue(source, "security", "next_run"),
		blocker: sectionValue(source, "retry_guard", "blocker"),
		repeatedFailureCount: sectionNumber(source, "retry_guard", "repeated_failure_count"),
		activeAgent: sectionValue(source, "omp", "active_agent"),
		activeRole: sectionValue(source, "omp", "active_role"),
		interruptionStatus: nestedSectionValue(source, "omp", "interruption", "status"),
		modelFailureStatus: nestedSectionValue(source, "omp", "model_failure", "status"),
		modelFailureRole: nestedSectionValue(source, "omp", "model_failure", "role"),
		modelFailureInstruction: nestedSectionValue(source, "omp", "model_failure", "human_instruction"),
	};
}

function stripFencedBlocks(source: string): string {
	return source.replace(/```[\s\S]*?```/g, block => block.replace(/[^\n]/g, " "));
}

function fieldValue(body: string, name: string): string {
	const match = body.match(new RegExp(`\\*\\*${escapeRegExp(name)}:\\*\\*\\s*(.+)`, "i"));
	return cleanScalar(match?.[1]);
}

function sectionLines(body: string, heading: string): string[] {
	const marker = `(?:\\*\\*${escapeRegExp(heading)}:\\*\\*|#{3,}\\s+${escapeRegExp(heading)}\\s*)`;
	const nextMarker = `(?=\\n(?:\\*\\*[A-Za-z][^\\n]*:\\*\\*|#{2,}\\s+[^\\n]+)|$)`;
	const match = body.match(new RegExp(`${marker}[^\\n]*\\n([\\s\\S]*?)${nextMarker}`, "i"));
	return match ? match[1].split("\n") : [];
}

function parseChecklistSection(body: string, heading: string): ChecklistItem[] {
	const items: ChecklistItem[] = [];
	for (const rawLine of sectionLines(body, heading)) {
		if (!rawLine.trim()) continue;
		const item = rawLine.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*\S)\s*$/);
		if (item) {
			items.push({ done: item[1]?.toLowerCase() === "x", canonical: item[1] !== undefined, text: item[2].trim() });
			continue;
		}
		const checkbox = rawLine.match(/^\s*\[([ xX])\]\s*(.*\S)\s*$/);
		if (checkbox) {
			items.push({ done: checkbox[1].toLowerCase() === "x", canonical: true, text: checkbox[2].trim() });
			continue;
		}
		if (items.length > 0) items[items.length - 1].text += ` ${rawLine.trim()}`;
	}
	return items;
}

function normalizedTitle(title: string): string {
	return title.replace(/^_\((.*)\)_$/, "$1").replace(/^_+|_+$/g, "").trim();
}

function isTemplateCard(title: string, body: string): boolean {
	const normalized = normalizedTitle(title).toLowerCase().replace(/[()]/g, "").trim();
	if (["title", "short title", "step title", "placeholder"].includes(normalized)) return true;
	if (/\btemplate(?: card)?\b/.test(normalized)) return true;
	return /\{\{\s*(?:step|title|goal|item)/i.test(body);
}

export function parseSteps(source: string): StepCard[] {
	const visible = stripFencedBlocks(source);
	const matches = [...visible.matchAll(/^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)[ \t]+(?:—|-)[ \t]+(.+?)\s*$/gm)];
	const cards: StepCard[] = [];
	for (const [index, match] of matches.entries()) {
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? visible.length;
		const body = visible.slice(start, end);
		if (isTemplateCard(match[2], body)) continue;
		const objective = parseChecklistSection(body, "Objective gates");
		const legacyDone = parseChecklistSection(body, "Done when");
		cards.push({
			id: match[1],
			title: normalizedTitle(match[2]),
			goal: fieldValue(body, "Goal"),
			dependsOn: fieldValue(body, "Depends on"),
			todos: parseChecklistSection(body, "Do"),
			objectiveGates: objective.length > 0 ? objective : legacyDone,
			judgmentGates: parseChecklistSection(body, "Judgment gates"),
		});
	}
	return cards;
}

export function normalizeRole(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const role = value
		.trim()
		.toLowerCase()
		.replace(/^workflow[-_]/, "")
		.replace(/[-_]backup$/, "");
	if (role === "main" || role === "orchestrator") return "orchestrator";
	if (role === "code-reviewer") return "reviewer";
	return role || undefined;
}

export function roleLabel(value: string | undefined): string {
	const role = normalizeRole(value);
	return (
		{
			orchestrator: "Main",
			architect: "Architect",
			coder: "Coder",
			reviewer: "Reviewer",
			tester: "Tester",
			security: "Security",
			human: "Human",
		}[role ?? ""] ?? value ?? "Unknown"
	);
}

function isBackupAgent(value: string | undefined): boolean {
	return Boolean(value && /[-_]backup$/.test(value));
}

function currentStatus(state: WorkflowState, runtime: RuntimeSnapshot): { status: string; waitingForHuman: boolean } {
	if (state.blocker !== "-") return { status: "Blocked", waitingForHuman: state.nextActor === "human" };
	if (state.onboardingStatus !== "complete") return { status: "Onboarding", waitingForHuman: true };
	if (state.modelFailureStatus === "awaiting_human") return { status: "Waiting for Human", waitingForHuman: true };
	if (state.nextActor === "human") return { status: "Waiting for Human", waitingForHuman: true };
	if (runtime.worker && (runtime.worker.status === "running" || runtime.worker.status === "pending")) {
		return { status: `${roleLabel(runtime.worker.agent)} running`, waitingForHuman: false };
	}
	if (state.implementationStatus === "waiting_review") return { status: "Objective-ready", waitingForHuman: false };
	if (state.reviewVerdict === "changes_requested" || state.reviewStatus === "changes_requested") {
		return { status: "Changes requested", waitingForHuman: false };
	}
	if (state.qaStatus === "bugs") return { status: "QA found bugs", waitingForHuman: false };
	if (state.reviewVerdict === "approved" && (state.qaStatus === "qa_green" || !state.qaEnabled)) {
		return { status: "Stop-gate ready", waitingForHuman: false };
	}
	if (state.implementationStatus === "running") return { status: "Implementation running", waitingForHuman: false };
	return { status: "Main coordinating", waitingForHuman: false };
}

function deriveNextAction(state: WorkflowState, runtime: RuntimeSnapshot): string {
	if (state.blocker !== "-") {
		if (normalizeRole(state.nextActor) === "architect") return "Main requests Architect escalation";
		return state.nextActor === "human" ? "Human resolves the recorded blocker" : "Main verifies and resolves the blocker";
	}
	if (state.onboardingStatus !== "complete") return "Human completes onboarding and model selection";
	if (state.modelFailureStatus === "awaiting_human") {
		const role = roleLabel(state.modelFailureRole);
		return state.modelFailureInstruction !== "-"
			? state.modelFailureInstruction
			: `Human authorizes ${role} backup or changes the model`;
	}
	if (state.nextActor === "human") return "Human input required before routing continues";
	if (runtime.worker && (runtime.worker.status === "running" || runtime.worker.status === "pending")) {
		return `Wait for ${roleLabel(runtime.worker.agent)} result, then Main verifies it`;
	}
	if (state.reviewVerdict === "changes_requested" || state.reviewStatus === "changes_requested") {
		return "Main reopens affected TODO, then dispatches a fresh Coder";
	}
	if (state.qaStatus === "bugs") return "Main records the bug and dispatches a fresh Coder";
	if (state.implementationStatus === "waiting_review" && state.reviewEnabled) {
		return "Main verifies Coder evidence, then dispatches Reviewer";
	}
	if (state.reviewVerdict === "approved" && state.qaEnabled && state.qaStatus !== "qa_green") {
		return "Main verifies review, then dispatches Tester";
	}
	if (state.reviewVerdict === "approved" && (state.qaStatus === "qa_green" || !state.qaEnabled)) {
		return "Main closes the Stop-gate and opens the next step";
	}
	const role = normalizeRole(state.nextActor);
	if (role && SPECIALIZED_ROLES.has(role)) return `Main dispatches a fresh ${roleLabel(role)}`;
	return "Main verifies evidence and selects the next transition";
}

export function deriveDashboardViewModel(
	data: DashboardData,
	runtime: RuntimeSnapshot,
	selectedStepId?: string,
): DashboardViewModel {
	const state = data.state;
	const currentIndex = data.steps.findIndex(step => step.id === state.currentStep);
	const requestedIndex = selectedStepId ? data.steps.findIndex(step => step.id === selectedStepId) : -1;
	const selectedIndex = requestedIndex >= 0 ? requestedIndex : currentIndex >= 0 ? currentIndex : data.steps.length > 0 ? 0 : -1;
	const selectedStep = selectedIndex >= 0 ? data.steps[selectedIndex] : undefined;
	const selectedId = selectedStep?.id ?? (selectedStepId || state.currentStep);
	const completed = new Set(state.completedSteps);
	const planIds = new Set(data.steps.map(step => step.id));
	const completedInPlan = data.steps.filter(step => completed.has(step.id)).length;
	let relation: StepRelation = "missing";
	if (selectedStep) {
		relation = selectedStep.id === state.currentStep ? "current" : completed.has(selectedStep.id) ? "completed" : "planned";
	}
	const workerRole = normalizeRole(runtime.worker?.agent);
	const currentRole = workerRole && SPECIALIZED_ROLES.has(workerRole) ? workerRole : undefined;
	const status = currentStatus(state, runtime);
	return {
		data,
		runtime,
		selectedStep,
		selectedStepId: selectedId,
		selectedIndex,
		currentIndex,
		relation,
		completedInPlan,
		remainingInPlan: Math.max(0, data.steps.length - completedInPlan),
		completedOutsidePlan: state.completedSteps.filter(step => !planIds.has(step)),
		currentRole,
		status: status.status,
		nextAction: deriveNextAction(state, runtime),
		waitingForHuman: status.waitingForHuman,
	};
}

function isCombining(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		(codePoint >= 0xe0100 && codePoint <= 0xe01ef)
	);
}

function isWide(codePoint: number): boolean {
	return (
		codePoint >= 0x1100 &&
		(codePoint <= 0x115f ||
			codePoint === 0x2329 ||
			codePoint === 0x232a ||
			(codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
			(codePoint >= 0x20000 && codePoint <= 0x3fffd))
	);
}

export function displayWidth(value: string): number {
	let width = 0;
	for (const character of value.replace(ANSI_PATTERN, "")) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) || isCombining(codePoint)) continue;
		width += isWide(codePoint) ? 2 : 1;
	}
	return width;
}

export function truncateDisplay(value: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(value) <= width) return value;
	if (width === 1) return "…";
	let output = "";
	let used = 0;
	for (const character of value.replace(ANSI_PATTERN, "")) {
		const characterWidth = displayWidth(character);
		if (used + characterWidth > width - 1) break;
		output += character;
		used += characterWidth;
	}
	return `${output}…`;
}

function fit(value: string, width: number): string {
	const truncated = truncateDisplay(value, width);
	return truncated + " ".repeat(Math.max(0, width - displayWidth(truncated)));
}

export function wrapDisplay(value: string, width: number, prefix = ""): string[] {
	const normalized = value.replace(/\s+/g, " ").trim();
	const prefixWidth = displayWidth(prefix);
	const available = Math.max(1, width - prefixWidth);
	if (!normalized) return [prefix.trimEnd()];
	const lines: string[] = [];
	let current = "";
	for (const word of normalized.split(" ")) {
		const candidate = current ? `${current} ${word}` : word;
		if (displayWidth(candidate) <= available) {
			current = candidate;
			continue;
		}
		if (current) lines.push(prefix + current);
		current = displayWidth(word) <= available ? word : truncateDisplay(word, available);
	}
	if (current) lines.push(prefix + current);
	return lines;
}

function addWrapped(lines: TextLine[], value: string, width: number, prefix = "", tone?: Tone): void {
	for (const text of wrapDisplay(value, width, prefix)) lines.push({ text, tone });
}

function formatDuration(value?: number | null): string {
	if (value === undefined || value === null || value < 0) return "n/a";
	const seconds = Math.round(value / 100) / 10;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const wholeSeconds = Math.round(seconds);
	const minutes = Math.floor(wholeSeconds / 60);
	if (minutes < 60) return `${minutes}m ${wholeSeconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function formatRatio(value?: MetricRatio): string {
	if (!value) return "n/a";
	const denominator = `${value.count}/${value.total}`;
	return value.rate_pct === null || value.rate_pct === undefined ? denominator : `${value.rate_pct.toFixed(1)}% (${denominator})`;
}

function formatTokens(value: number): string {
	return `${Math.max(0, Math.round(value)).toLocaleString("en-US")} tok`;
}


function stripThinkingSuffix(value: string): string {
	return value.trim().replace(THINKING_SUFFIX, "");
}

export function friendlyModelName(value: string): string {
	const exact = stripThinkingSuffix(value);
	const id = exact.includes("/") ? exact.slice(exact.lastIndexOf("/") + 1) : exact;
	return id
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(token => {
			const lower = token.toLowerCase();
			if (["gpt", "glm", "llm", "ai"].includes(lower)) return lower.toUpperCase();
			if (/^\d+(?:\.\d+)*$/.test(token)) return token;
			return token.charAt(0).toUpperCase() + token.slice(1);
		})
		.join(" ") || value;
}

function findExactModelSample(report: MetricsReport | undefined, role: string, resolvedModel: string): ModelSample | undefined {
	const exact = stripThinkingSuffix(resolvedModel);
	const samples = (report?.model_samples ?? []).filter(sample => sample.role === role);
	const full = samples.find(sample => `${sample.provider}/${sample.model}` === exact);
	if (full) return full;
	if (exact.includes("/")) return undefined;
	const bare = samples.filter(sample => sample.model === exact);
	return bare.length === 1 ? bare[0] : undefined;
}

function planStatusMarker(view: DashboardViewModel, step: StepCard): string {
	const selected = step.id === view.selectedStepId ? "*" : " ";
	const isCurrent = step.id === view.data.state.currentStep;
	const current = isCurrent ? ">" : " ";
	const completed = view.data.state.completedSteps.includes(step.id);
	const state = completed ? "✓" : isCurrent ? "●" : "○";
	return `${selected}${current} ${state}`;
}

function buildPlanLines(view: DashboardViewModel, height: number): TextLine[] {
	const lines: TextLine[] = [
		{ text: "PLAN", tone: "accent" },
		{ text: `Current ${view.currentIndex >= 0 ? view.currentIndex + 1 : "-"} / ${view.data.steps.length}` },
		{ text: `${view.completedInPlan} complete · ${view.remainingInPlan} remaining`, tone: "muted" },
	];
	if (view.completedOutsidePlan.length > 0) {
		lines.push({ text: `[WARN] ${view.completedOutsidePlan.length} completed outside current plan`, tone: "warning" });
	}
	if (view.data.stepsError) lines.push({ text: `[WARN] STEPS.md: ${view.data.stepsError}`, tone: "warning" });
	if (view.data.steps.length === 0) {
		lines.push({ text: "No executable step cards parsed.", tone: "warning" });
		return lines;
	}
	lines.push({ text: "" });
	const slots = Math.max(1, height - lines.length);
	const selectedIndex = Math.max(0, view.selectedIndex);
	let start = Math.max(0, selectedIndex - Math.floor(slots / 2));
	start = Math.min(start, Math.max(0, view.data.steps.length - slots));
	const window = view.data.steps.slice(start, start + slots).map(step => ({
		text: `${planStatusMarker(view, step)} ${step.id} ${step.title}`,
		tone: step.id === view.selectedStepId || step.id === view.data.state.currentStep ? "accent" as Tone : "normal" as Tone,
	}));
	if (start > 0 && window.length > 0) window[0] = { text: `↑ ${start} earlier`, tone: "muted" };
	const hiddenAfter = view.data.steps.length - (start + slots);
	if (hiddenAfter > 0 && window.length > 1) window[window.length - 1] = { text: `↓ ${hiddenAfter} later`, tone: "muted" };
	lines.push(...window);
	return lines;
}

function todoLines(step: StepCard, currentWorkItem: string, width: number, warnWhenEmpty: boolean): TextLine[] {
	const lines: TextLine[] = [];
	const done = step.todos.filter(item => item.done).length;
	lines.push({ text: `TODO · ${done} / ${step.todos.length} verified`, tone: "accent" });
	if (step.todos.some(item => !item.canonical)) {
		lines.push({ text: "[WARN] Legacy Do list · convert to checkboxes", tone: "warning" });
	}
	if (step.todos.length === 0) {
		if (warnWhenEmpty) lines.push({ text: "[WARN] No TODO checklist parsed from STEPS.md", tone: "warning" });
		return lines;
	}
	for (const item of step.todos) {
		const active = currentWorkItem !== "-" && item.text.trim() === currentWorkItem.trim();
		const marker = item.done ? "✓" : active ? "●" : "○";
		const tone: Tone = active ? "accent" : item.done ? "muted" : "normal";
		addWrapped(lines, item.text, width, `${marker} `, tone);
	}
	return lines;
}

function gateMarker(status: "pass" | "pending" | "fail" | "skip"): string {
	return status === "pass" ? "✓" : status === "fail" ? "[WARN]" : status === "skip" ? "-" : "○";
}

function currentGateLines(state: WorkflowState): TextLine[] {
	const lines: TextLine[] = [{ text: "GATES", tone: "accent" }];
	const implementation = state.implementationStatus === "waiting_review" || state.implementationStatus === "complete"
		? "pass"
		: state.implementationStatus === "blocked" || state.implementationStatus === "changes_requested"
			? "fail"
			: "pending";
	const review = !state.reviewEnabled || state.reviewStatus === "skipped"
		? "skip"
		: state.reviewVerdict === "approved"
			? "pass"
			: state.reviewVerdict === "changes_requested" || state.reviewStatus === "blocked"
				? "fail"
				: "pending";
	const qa = !state.qaEnabled || state.qaStatus === "skipped"
		? "skip"
		: state.qaStatus === "qa_green"
			? "pass"
			: state.qaStatus === "bugs" || state.qaStatus === "blocked"
				? "fail"
				: "pending";
	const security = state.securityNextRun === "none" || state.securityNextRun === "not_requested"
		? "skip"
		: state.securityNextRun === "security_clean"
			? "pass"
			: state.securityNextRun === "findings_open"
				? "fail"
				: "pending";
	const rows: Array<[string, "pass" | "pending" | "fail" | "skip", string]> = [
		["Implementation", implementation, state.implementationStatus],
		["Review", review, !state.reviewEnabled ? "skipped" : state.reviewVerdict !== "-" ? state.reviewVerdict : state.reviewStatus],
		["QA", qa, !state.qaEnabled ? "skipped" : state.qaStatus],
		["Security", security, security === "skip" ? "not requested" : state.securityNextRun],
	];
	for (const [label, status, detail] of rows) {
		lines.push({ text: `${gateMarker(status)} ${label} · ${detail}`, tone: status === "fail" ? "warning" : status === "skip" ? "muted" : "normal" });
	}
	return lines;
}

function checklistGateLines(step: StepCard): TextLine[] {
	const lines: TextLine[] = [];
	if (step.objectiveGates.length > 0) {
		const done = step.objectiveGates.filter(item => item.done).length;
		lines.push({ text: `Objective gates · ${done}/${step.objectiveGates.length}` });
	}
	if (step.judgmentGates.length > 0) {
		const done = step.judgmentGates.filter(item => item.done).length;
		lines.push({ text: `Judgment gates · ${done}/${step.judgmentGates.length}` });
	}
	return lines;
}

function buildCenterContent(view: DashboardViewModel, width: number): { pinned: TextLine[]; scrollable: TextLine[] } {
	const pinned: TextLine[] = [];
	const scrollable: TextLine[] = [];
	const state = view.data.state;
	const step = view.selectedStep;
	const heading = view.relation === "current" ? "CURRENT STEP" : "SELECTED STEP";
	pinned.push({ text: heading, tone: "accent" });
	if (!step) {
		pinned.push({ text: `${view.selectedStepId} · not found in STEPS.md`, tone: "warning" });
		if (view.data.stateError) pinned.push({ text: `[WARN] STATE.yaml: ${view.data.stateError}`, tone: "warning" });
		if (view.data.stepsError) pinned.push({ text: `[WARN] STEPS.md: ${view.data.stepsError}`, tone: "warning" });
		else if (view.data.steps.length === 0) pinned.push({ text: "[WARN] No executable step cards parsed", tone: "warning" });
		return { pinned, scrollable };
	}
	pinned.push({ text: `${step.id} — ${step.title}`, tone: "accent" });
	if (view.relation === "completed") {
		pinned.push({ text: "STATUS · Completed", tone: "muted" });
	} else if (view.relation === "planned") {
		pinned.push({ text: "STATUS · Planned · no execution data yet", tone: "muted" });
	} else {
		if (state.blocker !== "-") addWrapped(pinned, state.blocker, width, "[WARN] BLOCKED · ", "warning");
		pinned.push({ text: `STATUS · ${view.status}`, tone: view.waitingForHuman ? "warning" : "normal" });
		if (view.waitingForHuman) addWrapped(pinned, view.nextAction, width, "NEXT ACTION · ", "warning");
		const worker = view.runtime.worker;
		if (worker && (worker.status === "running" || worker.status === "pending")) {
			const elapsed = Math.max(worker.durationMs ?? 0, Date.now() - worker.startedAt);
			const model = worker.resolvedModel ? friendlyModelName(worker.resolvedModel) : "resolving model";
			const backup = worker.resolvedModelIsFallback || isBackupAgent(worker.agent) ? " · BACKUP" : "";
			pinned.push({ text: `ACTIVE · ${roleLabel(worker.agent)} · ${model} · ${formatDuration(elapsed)}${backup}`, tone: "accent" });
			if (state.currentWorkItem !== "-") addWrapped(pinned, state.currentWorkItem, width, "Working on: ");
		} else {
			const model = view.runtime.mainModel ? friendlyModelName(view.runtime.mainModel) : "model unresolved";
			pinned.push({ text: `MAIN · ${model} · ${view.runtime.mainStatus}` });
			addWrapped(pinned, view.runtime.mainActivity, width, "Now: ", "muted");
		}
	}
	if (step.goal !== "-") addWrapped(scrollable, step.goal, width, "Goal: ", "muted");
	if (step.dependsOn !== "-" && view.relation === "planned") addWrapped(scrollable, step.dependsOn, width, "Depends on: ", "muted");
	if (scrollable.length > 0) scrollable.push({ text: "" });
	scrollable.push(...todoLines(step, view.relation === "current" ? state.currentWorkItem : "-", width, view.relation === "current"));
	if (view.relation === "current") {
		scrollable.push({ text: "" }, ...currentGateLines(state));
		if (!view.waitingForHuman) {
			scrollable.push({ text: "" });
			addWrapped(scrollable, view.nextAction, width, "NEXT · ", "accent");
		}
	} else {
		const gateLines = checklistGateLines(step);
		if (gateLines.length > 0) scrollable.push({ text: "" }, ...gateLines);
		if (view.relation === "completed") scrollable.push({ text: "" }, { text: "RESULT · Completed Stop-gate", tone: "muted" });
	}
	return { pinned, scrollable };
}

function sessionUsageLines(usage: SessionUsage): TextLine[] {
	const lines: TextLine[] = [{ text: "THIS OMP SESSION · MAIN + WORKERS", tone: "accent" }];
	if (usage.models.length === 0) {
		lines.push({ text: "Token usage appears after the first model response.", tone: "muted" });
		return lines;
	}
	lines.push({ text: `All models · ${formatTokens(usage.totalTokens)}` });
	for (const model of usage.models) {
		lines.push({ text: `${friendlyModelName(model.model)} · ${formatTokens(model.totalTokens)} · ${model.requests} req` });
	}
	return lines;
}

function stepStatsLines(view: DashboardViewModel, stats: StepStats | undefined, width: number, compact: boolean): TextLine[] {
	const lines: TextLine[] = [{ text: "STEP STATISTICS", tone: "accent" }];
	if (!stats) {
		lines.push({ text: view.relation === "planned" ? "Planned · no execution data yet" : "No telemetry for this step yet", tone: "muted" });
		return lines;
	}
	lines.push({ text: `${stats.status.replace("_", " ")} · duration ${formatDuration(stats.duration_ms)}` });
	lines.push({ text: `Coder attempts ${stats.coder_attempts} · Reviews ${stats.product_reviews.runs} · QA ${stats.qa_runs.runs}` });
	if (compact) {
		if (stats.product_reviews.changes_requested > 0 || stats.qa_runs.bugs > 0 || stats.failure_count > 0) {
			lines.push({
				text: `Changes ${stats.product_reviews.changes_requested} · QA bugs ${stats.qa_runs.bugs} · Failures ${stats.failure_count}`,
				tone: "warning",
			});
		}
		return lines;
	}
	if (stats.product_reviews.changes_requested > 0 || stats.qa_runs.bugs > 0) {
		lines.push({ text: `Changes ${stats.product_reviews.changes_requested} · QA bugs ${stats.qa_runs.bugs}`, tone: "warning" });
	}
	if (stats.failure_count > 0 || stats.runtime_interruptions > 0) {
		lines.push({ text: `Failures ${stats.failure_count} · Interruptions ${stats.runtime_interruptions}`, tone: stats.failure_count > 0 ? "warning" : "normal" });
	}
	if (stats.human_rating) lines.push({ text: `Human rating · ${stats.human_rating}`, tone: "muted" });
	if (stats.models.length > 0) {
		lines.push({ text: "AGENTS USED", tone: "accent" });
		for (const model of stats.models) {
			addWrapped(lines, `${roleLabel(model.role)} · ${model.provider}/${model.model} · ${model.runs} run${model.runs === 1 ? "" : "s"}`, width, "", "muted");
		}
	}
	return lines;
}

function teamHealthLines(report: MetricsReport): TextLine[] {
	const summary = report.summary;
	if (!summary) return [];
	const lines: TextLine[] = [{ text: "TEAM HEALTH", tone: "accent" }];
	const completed = summary.completed_product_steps ?? 0;
	if (!report.storage?.data_since || (report.storage.valid_events ?? 0) === 0) {
		lines.push({ text: "Collecting data · 0 completed steps", tone: "muted" });
		return lines;
	}
	lines.push({ text: `Completed product steps · ${completed}` });
	if ((summary.first_pass_step_success?.total ?? 0) > 0) {
		lines.push({ text: `First-pass · ${formatRatio(summary.first_pass_step_success)}` });
	}
	if (summary.average_coder_attempts !== null && summary.average_coder_attempts !== undefined) {
		lines.push({ text: `Average Coder attempts · ${summary.average_coder_attempts}` });
	}
	if ((summary.reviewer_rejection?.total ?? 0) > 0) lines.push({ text: `Review rejection · ${formatRatio(summary.reviewer_rejection)}` });
	if ((summary.qa_escape?.total ?? 0) > 0) lines.push({ text: `QA escape · ${formatRatio(summary.qa_escape)}` });
	if ((summary.runtime_interruption?.count ?? 0) > 0 || (summary.model_failure?.count ?? 0) > 0) {
		lines.push({ text: `Interruptions ${summary.runtime_interruption?.count ?? 0} · Model failures ${summary.model_failure?.count ?? 0}`, tone: "warning" });
	}
	if ((summary.repeated_failure_incidents ?? 0) > 0) {
		lines.push({ text: `Repeated-failure incidents · ${summary.repeated_failure_incidents}`, tone: "warning" });
	}
	return lines;
}

function roleStatsLines(view: DashboardViewModel, report: MetricsReport): TextLine[] {
	if (view.relation !== "current" || !view.currentRole) return [];
	const stats = report.role_stats?.[view.currentRole];
	if (!stats) return [];
	const lines: TextLine[] = [{ text: `CURRENT ROLE · ${roleLabel(view.currentRole).toUpperCase()}`, tone: "accent" }];
	lines.push({ text: `Runs ${stats.runs} · Verified ${stats.verified_results} · Median ${formatDuration(stats.median_duration_ms)}` });
	if (view.currentRole === "coder" && stats.first_review_approval && stats.first_review_approval.total > 0) {
		lines.push({ text: `First-review approval · ${formatRatio(stats.first_review_approval)}` });
	} else if (view.currentRole === "reviewer" && stats.product_rejection && stats.product_rejection.total > 0) {
		lines.push({ text: `Product rejection · ${formatRatio(stats.product_rejection)}` });
	} else if (view.currentRole === "tester") {
		lines.push({ text: `Green ${stats.results.qa_green ?? 0} · Bugs ${stats.results.bugs ?? 0} · Blocked ${stats.results.blocked ?? 0}` });
	} else if (view.currentRole === "architect" && stats.modes) {
		lines.push({ text: `Advisory ${stats.modes.advisory ?? 0} · Design ${stats.modes.design ?? 0} · Grilling ${stats.modes.grilling ?? 0}` });
	} else if (view.currentRole === "security") {
		lines.push({ text: `Clean ${stats.results.security_clean ?? 0} · Findings ${stats.results.findings_open ?? 0}` });
	}
	return lines;
}

function currentModelLines(view: DashboardViewModel, report: MetricsReport): TextLine[] {
	if (view.relation !== "current" || !view.runtime.worker || !view.currentRole || !view.runtime.worker.resolvedModel) return [];
	const sample = findExactModelSample(report, view.currentRole, view.runtime.worker.resolvedModel);
	if (!sample) return [];
	const lines: TextLine[] = [{ text: `CURRENT MODEL · ${friendlyModelName(view.runtime.worker.resolvedModel)}`, tone: "accent" }];
	lines.push({ text: `Runs ${sample.runs}${sample.sample_warning ? ` · ${sample.sample_warning}` : ""} · Median ${formatDuration(sample.median_duration_ms)}` });
	if (view.currentRole === "coder" && sample.first_review_approval && sample.first_review_approval.total > 0) {
		lines.push({ text: `First-review approval · ${formatRatio(sample.first_review_approval)}` });
	}
	return lines;
}

function failureLines(report: MetricsReport): TextLine[] {
	const categories = Object.entries(report.failure_categories ?? {})
		.filter(([, count]) => count > 0)
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 3);
	const detected = Object.entries(report.detected_by ?? {}).filter(([, count]) => count > 0);
	if (categories.length === 0 && detected.length === 0) return [];
	const lines: TextLine[] = [{ text: "FAILURES", tone: "accent" }];
	for (const [category, count] of categories) lines.push({ text: `${category.replaceAll("_", " ")} · ${count}`, tone: "warning" });
	if (detected.length > 0) lines.push({ text: `Detected by · ${detected.map(([actor, count]) => `${roleLabel(actor)} ${count}`).join(" · ")}`, tone: "muted" });
	return lines;
}

function buildStatisticsLines(view: DashboardViewModel, width: number, compact = false): TextLine[] {
	const lines: TextLine[] = [{ text: "STATISTICS", tone: "accent" }];
	const report = view.data.metrics;
	const selectedStats = report?.step_stats?.[view.selectedStepId];
	if (view.data.metricsError || !report?.summary) {
		if (view.relation === "planned") lines.push(...stepStatsLines(view, undefined, width, compact), { text: "" });
		lines.push(
			{ text: `[WARN] Canonical metrics unavailable`, tone: "warning" },
			{ text: "Workflow execution is unaffected.", tone: "muted" },
			{ text: "" },
			...sessionUsageLines(view.data.sessionUsage),
		);
		return lines;
	}
	lines.push(...teamHealthLines(report));
	const roleLines = roleStatsLines(view, report);
	if (roleLines.length > 0) lines.push({ text: "" }, ...roleLines);
	const modelLines = currentModelLines(view, report);
	if (modelLines.length > 0) lines.push({ text: "" }, ...modelLines);
	lines.push({ text: "" }, ...stepStatsLines(view, selectedStats, width, compact));
	const failures = failureLines(report);
	if (failures.length > 0) lines.push({ text: "" }, ...failures);
	lines.push({ text: "" }, ...sessionUsageLines(view.data.sessionUsage));
	return lines;
}

function mergeTone(values: Array<Tone | undefined>): Tone | undefined {
	if (values.includes("warning")) return "warning";
	if (values.includes("accent")) return "accent";
	if (values.every(value => value === "muted" || value === undefined) && values.some(value => value === "muted")) return "muted";
	return undefined;
}

function border(widths: number[]): string {
	return `+${widths.map(width => "-".repeat(Math.max(0, width))).join("+")}+`;
}

function fullRow(line: TextLine, width: number): TextLine {
	return { text: `|${fit(line.text, Math.max(1, width - 2))}|`, tone: line.tone };
}

function columnRow(lines: Array<TextLine | undefined>, widths: number[]): TextLine {
	return {
		text: `|${widths.map((width, index) => fit(lines[index]?.text ?? "", width)).join("|")}|`,
		tone: mergeTone(lines.map(line => line?.tone)),
	};
}

function clip(lines: TextLine[], height: number): TextLine[] {
	const output = lines.slice(0, Math.max(0, height));
	while (output.length < height) output.push({ text: "" });
	return output;
}

function windowCenter(
	content: { pinned: TextLine[]; scrollable: TextLine[] },
	height: number,
	detailScroll: number,
): { lines: TextLine[]; maxScroll: number } {
	if (height <= 0) return { lines: [], maxScroll: 0 };
	const pinned = content.pinned.slice(0, height);
	const room = Math.max(0, height - pinned.length);
	if (room === 0) return { lines: pinned, maxScroll: Math.max(0, content.scrollable.length) };
	const maxScroll = Math.max(0, content.scrollable.length - room);
	const scroll = Math.min(Math.max(0, detailScroll), maxScroll);
	const visible = content.scrollable.slice(scroll, scroll + room);
	if (maxScroll > 0 && visible.length > 0) {
		if (scroll > 0) visible[0] = { text: `↑ ${scroll} detail line${scroll === 1 ? "" : "s"}`, tone: "muted" };
		const below = content.scrollable.length - (scroll + room);
		if (below > 0 && visible.length > 1) visible[visible.length - 1] = { text: `↓ ${below} more detail line${below === 1 ? "" : "s"}`, tone: "muted" };
	}
	return { lines: clip([...pinned, ...visible], height), maxScroll };
}

function wideBody(view: DashboardViewModel, width: number, height: number, detailScroll: number): { lines: TextLine[]; maxScroll: number } {
	const available = width - 4;
	const planWidth = Math.max(24, Math.floor(available * 0.26));
	const centerWidth = Math.max(42, Math.floor(available * 0.44));
	const statsWidth = available - planWidth - centerWidth;
	const widths = [planWidth, centerWidth, statsWidth];
	const plan = clip(buildPlanLines(view, height), height);
	const center = windowCenter(buildCenterContent(view, centerWidth), height, detailScroll);
	const stats = clip(buildStatisticsLines(view, statsWidth), height);
	const lines = Array.from({ length: height }, (_, index) => columnRow([plan[index], center.lines[index], stats[index]], widths));
	return { lines, maxScroll: center.maxScroll };
}

function mediumBody(view: DashboardViewModel, width: number, height: number, detailScroll: number): { lines: TextLine[]; maxScroll: number } {
	const topHeight = Math.max(6, Math.floor((height - 1) * 0.64));
	const statsHeight = Math.max(0, height - topHeight - 1);
	const available = width - 3;
	const planWidth = Math.max(28, Math.floor(available * 0.32));
	const centerWidth = available - planWidth;
	const widths = [planWidth, centerWidth];
	const plan = clip(buildPlanLines(view, topHeight), topHeight);
	const center = windowCenter(buildCenterContent(view, centerWidth), topHeight, detailScroll);
	const lines = Array.from({ length: topHeight }, (_, index) => columnRow([plan[index], center.lines[index]], widths));
	lines.push({ text: border([width - 2]), tone: "muted" });
	for (const line of clip(buildStatisticsLines(view, width - 2, true), statsHeight)) lines.push(fullRow(line, width));
	return { lines, maxScroll: center.maxScroll };
}

function narrowBody(view: DashboardViewModel, width: number, height: number, detailScroll: number): { lines: TextLine[]; maxScroll: number } {
	const available = Math.max(6, height - 2);
	let currentHeight = Math.max(4, Math.floor(available * 0.42));
	let planHeight = Math.max(2, Math.floor(available * 0.18));
	let statsHeight = available - currentHeight - planHeight;
	if (statsHeight < 2) {
		const needed = 2 - statsHeight;
		currentHeight = Math.max(4, currentHeight - needed);
		statsHeight = available - currentHeight - planHeight;
	}
	const center = windowCenter(buildCenterContent(view, width - 2), currentHeight, detailScroll);
	const lines = center.lines.map(line => fullRow(line, width));
	lines.push({ text: border([width - 2]), tone: "muted" });
	for (const line of clip(buildPlanLines(view, planHeight), planHeight)) lines.push(fullRow(line, width));
	lines.push({ text: border([width - 2]), tone: "muted" });
	for (const line of clip(buildStatisticsLines(view, width - 2, true), statsHeight)) lines.push(fullRow(line, width));
	return { lines, maxScroll: center.maxScroll };
}

export function renderDashboard(
	view: DashboardViewModel,
	width: number,
	bodyHeight: number,
	detailScroll = 0,
	statsFooter?: StatsFooterInfo,
): RenderResult {
	const panelWidth = Math.max(20, width);
	const height = Math.max(8, bodyHeight);
	const layout: RenderResult["layout"] = panelWidth >= 140 ? "wide" : panelWidth >= 100 ? "medium" : "narrow";
	const body = layout === "wide"
		? wideBody(view, panelWidth, height, detailScroll)
		: layout === "medium"
			? mediumBody(view, panelWidth, height, detailScroll)
			: narrowBody(view, panelWidth, height, detailScroll);
	const title = `PAVAN'S WORKFLOW · LIVE · ${view.data.state.track !== "-" ? view.data.state.track : "file-backed"}`;
	const footer = `↑/↓ step · c current · PgUp/PgDn details · r refresh · Alt+A agents · Alt+W/Esc close${body.maxScroll > 0 ? ` · detail ${Math.min(detailScroll, body.maxScroll) + 1}/${body.maxScroll + 1}` : ""}`;
	return {
		layout,
		maxDetailScroll: body.maxScroll,
		lines: [
			{ text: border([panelWidth - 2]), tone: "accent" },
			fullRow({ text: title, tone: "accent" }, panelWidth),
			{ text: border([panelWidth - 2]), tone: "muted" },
			...body.lines,
			{ text: border([panelWidth - 2]), tone: "muted" },
			fullRow({ text: footer, tone: "muted" }, panelWidth),
			...(statsFooter
				? [fullRow({ text: `OMP Stats · ${statsFooter.status}${statsFooter.url ? ` · ${statsFooter.url}` : ""} · o open in browser`, tone: "muted" }, panelWidth)]
				: []),
			{ text: border([panelWidth - 2]), tone: "accent" },
		],
	};
}
