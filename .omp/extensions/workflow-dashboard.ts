import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";

const STATE_PATH = "AI_Workflow_Kit/docs/AI/STATE.yaml";
const STEPS_PATH = "AI_Workflow_Kit/docs/STEPS.md";
const CONFIG_PATH = ".omp/config.yml";
const QUOTA_REFRESH_MS = 60_000;
const METRICS_REFRESH_MS = 15_000;
const METRICS_HELPER_PATH = "AI_Workflow_Kit/script/workflow_metrics.sh";

type Tone = "normal" | "accent" | "muted";
type ThemeLike = { fg: (tone: "accent" | "muted", text: string) => string };
type KeybindingsLike = { matches: (data: string, action: string) => boolean };

type Line = { text: string; tone?: Tone };

type WorkflowState = {
	currentStep: string;
	stepDescription: string;
	track: string;
	nextActor: string;
	completedSteps: string[];
	onboardingStatus: string;
	implementationStatus: string;
	reviewStatus: string;
	reviewVerdict: string;
	qaStatus: string;
	securityNextRun: string;
	blocker: string;
	activeAgent: string;
	activeRole: string;
	interruptionStatus: string;
};

type GateItem = { text: string; done: boolean };

type StepCard = {
	id: string;
	title: string;
	goal: string;
	doItems: string[];
	objectiveGates: GateItem[];
	judgmentGates: GateItem[];
};

type RolePair = { role: string; primary: string; backup: string };

type WorkerProgress = {
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task?: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	toolCount?: number;
	requests?: number;
	tokens?: number;
	durationMs?: number;
	startedAt: number;
	resolvedModel?: string;
	resolvedModelIsFallback?: boolean;
	updatedAt: number;
};

type QuotaLimit = {
	label?: string;
	window?: { label?: string; resetsAt?: number };
	amount?: { remainingFraction?: number; usedFraction?: number; remaining?: number; unit?: string };
};

type QuotaReport = {
	provider?: string;
	fetchedAt?: number;
	limits?: QuotaLimit[];
	metadata?: { email?: string; accountId?: string; projectId?: string; planType?: string };
};

type QuotaSnapshot = {
	generatedAt?: number;
	reports?: QuotaReport[];
	accountsWithoutUsage?: Array<{ provider?: string; email?: string; accountId?: string }>;
	disabledCredentials?: Array<{ provider?: string }>;
};

type MetricRatio = {
	count: number;
	total: number;
	rate_pct?: number | null;
};

type MetricsReport = {
	available?: boolean;
	error?: string;
	storage?: { data_since?: string | null };
	summary?: {
		completed_steps?: number;
		first_pass_step_success?: MetricRatio;
		average_coder_attempts?: number | null;
		reviewer_rejection?: MetricRatio;
		qa_escape?: MetricRatio;
		architect_escalation?: MetricRatio;
		advisor_usage?: MetricRatio;
		repeated_failure_incidents?: number;
		runtime_interruption?: MetricRatio;
		model_failure?: MetricRatio;
	};
};

type DashboardData = {
	state: WorkflowState;
	steps: StepCard[];
	rolePairs: RolePair[];
	metrics?: MetricsReport;
	metricsError?: string;
	quota?: QuotaSnapshot;
	quotaError?: string;
	quotaFetchedAt?: number;
};

const liveWorkers = new Map<string, WorkerProgress>();
let lastWorker: WorkerProgress | undefined;
let mainContext: ExtensionContext | undefined;
let mainActivity = "Ready";
let listenersInstalled = false;
let activePanel: WorkflowDashboard | undefined;
let quotaCache: { data?: QuotaSnapshot; error?: string; fetchedAt: number } = { fetchedAt: 0 };
let metricsCache: { data?: MetricsReport; error?: string; fetchedAt: number } = { fetchedAt: 0 };

function cleanScalar(value: string | undefined, fallback = "-"): string {
	if (!value) return fallback;
	const trimmed = value.trim();
	if (!trimmed || trimmed === "null") return fallback;
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function topValue(source: string, key: string): string {
	const match = source.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return cleanScalar(match?.[1]);
}

function sectionValue(source: string, section: string, key: string): string {
	const sectionMatch = source.match(
		new RegExp(`^${section}:\\s*\\n([\\s\\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|(?![\\s\\S]))`, "m"),
	);
	if (!sectionMatch) return "-";
	const valueMatch = sectionMatch[1].match(new RegExp(`^\\s{2}${key}:\\s*(.+)$`, "m"));
	return cleanScalar(valueMatch?.[1]);
}

function nestedSectionValue(source: string, parent: string, section: string, key: string): string {
	const parentMatch = source.match(
		new RegExp(`^${parent}:\\s*\\n([\\s\\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|(?![\\s\\S]))`, "m"),
	);
	if (!parentMatch) return "-";
	const nestedMatch = parentMatch[1].match(
		new RegExp(`^\\s{2}${section}:\\s*\\n((?:\\s{4,}.*(?:\\n|$))*)`, "m"),
	);
	if (!nestedMatch) return "-";
	const valueMatch = nestedMatch[1].match(new RegExp(`^\\s{4}${key}:\\s*(.+)$`, "m"));
	return cleanScalar(valueMatch?.[1]);
}

function foldedValue(source: string, key: string): string {
	const folded = source.match(new RegExp(`^${key}:\\s*>-?\\s*\\n((?:\\s{2,}.*(?:\\n|$))+)`, "m"));
	if (folded) return folded[1].split("\n").map(line => line.trim()).filter(Boolean).join(" ");
	return topValue(source, key);
}

function listValue(source: string, key: string): string[] {
	const inline = source.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
	if (inline) {
		return inline[1].split(",").map(value => cleanScalar(value, "")).filter(Boolean);
	}
	const block = source.match(new RegExp(`^${key}:\\s*\\n((?:\\s{2,}-\\s+.*(?:\\n|$))*)`, "m"));
	if (!block) return [];
	return block[1].split("\n").map(line => cleanScalar(line.replace(/^\s*-\s*/, ""), "")).filter(Boolean);
}

function parseWorkflowState(source: string): WorkflowState {
	return {
		currentStep: topValue(source, "current_step"),
		stepDescription: foldedValue(source, "step_description"),
		track: topValue(source, "track"),
		nextActor: topValue(source, "next_actor"),
		completedSteps: listValue(source, "completed_steps"),
		onboardingStatus: sectionValue(source, "onboarding", "status"),
		implementationStatus: sectionValue(source, "implementation", "status"),
		reviewStatus: sectionValue(source, "review", "status"),
		reviewVerdict: sectionValue(source, "review", "verdict"),
		qaStatus: sectionValue(source, "qa", "status"),
		securityNextRun: sectionValue(source, "security", "next_run"),
		blocker: sectionValue(source, "retry_guard", "blocker"),
		activeAgent: sectionValue(source, "omp", "active_agent"),
		activeRole: sectionValue(source, "omp", "active_role"),
		interruptionStatus: nestedSectionValue(source, "omp", "interruption", "status"),
	};
}

function parseBulletSection(body: string, heading: string): string[] {
	const marker = `(?:\\*\\*${heading}:\\*\\*|#{3,}\\s+${heading})`;
	const nextMarker = `(?=\\n(?:\\*\\*[A-Za-z][^\\n]*:\\*\\*|#{2,}\\s+[^\\n]+)|$)`;
	const match = body.match(new RegExp(`${marker}\\s*\\n([\\s\\S]*?)${nextMarker}`, "i"));
	if (!match) return [];
	return match[1]
		.split("\n")
		.map(line => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, "").trim())
		.filter(Boolean);
}

function parseGateItems(body: string, heading: string): GateItem[] {
	return parseBulletSection(body, heading).map(item => {
		const box = item.match(/^\[([ xX])\]\s*(.*)$/);
		return box ? { done: box[1].toLowerCase() === "x", text: box[2] } : { done: false, text: item };
	});
}

function parseSteps(source: string): StepCard[] {
	const visible = source.replace(/```[\s\S]*?```/g, "");
	const matches = [...visible.matchAll(/^##\s+(S\d+)\s+[—-]\s+(.+)$/gm)];
	return matches.map((match, index) => {
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? visible.length;
		const body = visible.slice(start, end);
		const legacyDone = parseGateItems(body, "Done when");
		const objectiveGates = parseGateItems(body, "Objective gates");
		const judgmentGates = parseGateItems(body, "Judgment gates");
		return {
			id: match[1],
			title: match[2].replace(/^_\((.*)\)_$/, "$1"),
			goal: cleanScalar(body.match(/\*\*Goal:\*\*\s*(.+)/)?.[1]),
			doItems: parseBulletSection(body, "Do"),
			objectiveGates: objectiveGates.length ? objectiveGates : legacyDone,
			judgmentGates,
		};
	});
}

function parseRolePairs(source: string): RolePair[] {
	const entries = new Map<string, string>();
	const block =
		source.match(/^modelRoles:\s*\n([\s\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|(?![\s\S]))/m)?.[1] ?? "";
	for (const line of block.split("\n")) {
		const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.+)$/);
		if (match) entries.set(match[1], cleanScalar(match[2]));
	}
	const roles = ["orchestrator", "architect", "coder", "reviewer", "tester", "security"];
	return roles.map(role => ({
		role,
		primary: entries.get(`workflow_${role}`) ?? "not configured",
		backup: entries.get(`workflow_${role}_backup`) ?? "not configured",
	}));
}

function isBackupAgent(agent: string): boolean {
	return /-backup$/.test(agent);
}

function roleLabel(agent: string): string {
	const normalized = agent.replace(/^workflow-/, "").replace(/^workflow_/, "").replace(/-backup$/, "");
	const label = ({
		orchestrator: "Main Orchestrator",
		architect: "Architect",
		coder: "Coder",
		reviewer: "Code Reviewer",
		tester: "Tester / QA",
		security: "Security Reviewer",
	} as Record<string, string>)[normalized] ?? agent;
	return isBackupAgent(agent) ? `${label} (Human-authorized backup)` : label;
}

function workflowPhase(state: WorkflowState, worker?: WorkerProgress): string {
	if (state.blocker !== "-") return `Blocked: ${state.blocker}`;
	if (state.onboardingStatus !== "complete") return "Onboarding";
	if (worker?.status === "running") return roleLabel(worker.agent);
	if (state.nextActor !== "-") return `Main verification -> ${roleLabel(state.nextActor)}`;
	return "Main verification";
}

function duration(value?: number): string {
	if (!value || value < 1_000) return "<1s";
	const seconds = Math.floor(value / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function metricRatio(value?: MetricRatio): string {
	if (!value || value.rate_pct === null || value.rate_pct === undefined) return "n/a";
	return `${value.rate_pct.toFixed(1)}%`;
}

function resetIn(resetsAt?: number): string {
	if (!resetsAt) return "";
	const delta = resetsAt - Date.now();
	if (delta <= 0) return "reset due";
	const minutes = Math.ceil(delta / 60_000);
	if (minutes < 60) return `resets in ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `resets in ${hours}h ${minutes % 60}m`;
	return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function remainingPercent(limit: QuotaLimit): number | undefined {
	if (typeof limit.amount?.remainingFraction === "number") return limit.amount.remainingFraction * 100;
	if (typeof limit.amount?.usedFraction === "number") return Math.max(0, 100 - limit.amount.usedFraction * 100);
	if (limit.amount?.unit === "percent" && typeof limit.amount.remaining === "number") return limit.amount.remaining;
	return undefined;
}

function accountLabel(report: QuotaReport): string {
	return report.metadata?.email ?? report.metadata?.accountId ?? report.metadata?.projectId ?? "account";
}

function modelText(ctx: ExtensionContext | undefined): string {
	const model = ctx?.model;
	return model ? `${model.provider}/${model.id}` : "not resolved";
}

function wrap(text: string, width: number, prefix = ""): string[] {
	const available = Math.max(12, width - prefix.length);
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [prefix.trimEnd()];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= available) {
			current += ` ${word}`;
		} else {
			lines.push(prefix + current);
			current = word;
		}
	}
	if (current) lines.push(prefix + current);
	return lines;
}

async function readDashboardFiles(cwd: string): Promise<Omit<DashboardData, "quota" | "quotaError" | "quotaFetchedAt">> {
	const [stateSource, stepsSource, configSource] = await Promise.all([
		readFile(`${cwd}/${STATE_PATH}`, "utf8"),
		readFile(`${cwd}/${STEPS_PATH}`, "utf8"),
		readFile(`${cwd}/${CONFIG_PATH}`, "utf8"),
	]);
	return {
		state: parseWorkflowState(stateSource),
		steps: parseSteps(stepsSource),
		rolePairs: parseRolePairs(configSource),
	};
}

async function refreshQuota(pi: ExtensionAPI, cwd: string, force = false): Promise<void> {
	if (!force && Date.now() - quotaCache.fetchedAt < QUOTA_REFRESH_MS) return;
	quotaCache = { ...quotaCache, fetchedAt: Date.now() };
	try {
		const result = await pi.exec("omp", ["usage", "--json", "--redact"], { cwd, timeout: 30_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `omp usage exited ${result.code}`);
		quotaCache = { data: JSON.parse(result.stdout) as QuotaSnapshot, fetchedAt: Date.now() };
	} catch (error) {
		quotaCache = { error: error instanceof Error ? error.message : String(error), fetchedAt: Date.now() };
	}
}

async function refreshMetrics(pi: ExtensionAPI, cwd: string, force = false): Promise<void> {
	if (!force && Date.now() - metricsCache.fetchedAt < METRICS_REFRESH_MS) return;
	metricsCache = { ...metricsCache, fetchedAt: Date.now() };
	try {
		const result = await pi.exec("bash", [METRICS_HELPER_PATH, "report", "--json"], { cwd, timeout: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr.trim() || `metrics helper exited ${result.code}`);
		const data = JSON.parse(result.stdout) as MetricsReport;
		if (data.available === false) throw new Error(data.error ?? "metrics unavailable");
		metricsCache = { data, fetchedAt: Date.now() };
	} catch (error) {
		metricsCache = { error: error instanceof Error ? error.message : String(error), fetchedAt: Date.now() };
	}
}

function currentWorker(): WorkerProgress | undefined {
	return [...liveWorkers.values()]
		.filter(worker => worker.status === "running" || worker.status === "pending")
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function buildBody(data: DashboardData, width: number): Line[] {
	const lines: Line[] = [];
	const state = data.state;
	const worker = currentWorker();
	const currentCard = data.steps.find(step => step.id === state.currentStep);
	const completed = new Set(state.completedSteps);
	const doneCount = data.steps.filter(step => completed.has(step.id)).length;
	const remaining = Math.max(0, data.steps.length - doneCount);

	lines.push({ text: "WORKFLOW", tone: "accent" });
	lines.push({ text: `Track: ${state.track}    Step: ${state.currentStep}    Progress: ${doneCount}/${data.steps.length} done, ${remaining} remaining` });
	lines.push({ text: `Stage: ${workflowPhase(state, worker)}` });
	lines.push({ text: `Gates: implementation=${state.implementationStatus}  review=${state.reviewVerdict !== "-" ? state.reviewVerdict : state.reviewStatus}  qa=${state.qaStatus}  security=${state.securityNextRun}` });
	for (const line of wrap(state.stepDescription, width, "  ")) lines.push({ text: line, tone: "muted" });
	if (state.interruptionStatus !== "-" && state.interruptionStatus !== "none") {
		lines.push({ text: `Recovery: ${state.interruptionStatus}`, tone: "muted" });
	}
	lines.push({ text: "" });

	lines.push({ text: "LOCAL WORKFLOW METRICS", tone: "accent" });
	if (data.metricsError || !data.metrics?.summary) {
		lines.push({ text: `Unavailable: ${data.metricsError ?? "no valid metrics report"}`, tone: "muted" });
		lines.push({ text: "Metrics never block workflow execution.", tone: "muted" });
	} else {
		const metrics = data.metrics.summary;
		lines.push({
			text: `Completed=${metrics.completed_steps ?? 0}  First-pass=${metricRatio(metrics.first_pass_step_success)}  Avg Coder=${metrics.average_coder_attempts ?? "n/a"}`,
		});
		lines.push({
			text: `Review reject=${metricRatio(metrics.reviewer_rejection)}  QA escape=${metricRatio(metrics.qa_escape)}`,
		});
		lines.push({
			text: `Interruptions=${metricRatio(metrics.runtime_interruption)}  Model fail=${metricRatio(metrics.model_failure)}  Repeats=${metrics.repeated_failure_incidents ?? 0}`,
		});
		lines.push({
			text: `Architect=${metricRatio(metrics.architect_escalation)}  Advisor=${metricRatio(metrics.advisor_usage)}  Since=${data.metrics.storage?.data_since ?? "no events"}`,
			tone: "muted",
		});
	}
	lines.push({ text: "" });

	lines.push({ text: "ACTIVE MODEL", tone: "accent" });
	if (worker) {
		lines.push({ text: `${roleLabel(worker.agent)}  [${worker.status}]  agent=${worker.id}` });
		lines.push({ text: `Model: ${worker.resolvedModel ?? "resolving"}${worker.resolvedModelIsFallback || isBackupAgent(worker.agent) ? "  [BACKUP ACTIVE]" : ""}` });
		const elapsed = Math.max(worker.durationMs ?? 0, Date.now() - worker.startedAt);
		lines.push({ text: `Run: ${duration(elapsed)}  tools=${worker.toolCount ?? 0}  requests=${worker.requests ?? 0}  tokens=${worker.tokens ?? 0}` });
		if (worker.lastIntent) for (const line of wrap(worker.lastIntent, width, "Intent: ")) lines.push({ text: line });
		if (worker.currentTool) lines.push({ text: `Now: ${worker.currentTool}` });
		const assignment = worker.assignment ?? worker.task;
		if (assignment) for (const line of wrap(assignment, width, "Task: ")) lines.push({ text: line, tone: "muted" });
	} else {
		lines.push({ text: `Main Orchestrator  [${mainContext?.isIdle() ? "idle" : "working"}]` });
		lines.push({ text: `Model: ${modelText(mainContext)}` });
		lines.push({ text: `Now: ${mainActivity}` });
		if (state.activeAgent !== "-") lines.push({ text: `File state: ${roleLabel(state.activeRole)} / ${state.activeAgent}`, tone: "muted" });
		if (lastWorker) lines.push({ text: `Last worker: ${roleLabel(lastWorker.agent)} [${lastWorker.status}] ${lastWorker.resolvedModel ?? ""}`, tone: "muted" });
	}
	lines.push({ text: "" });

	lines.push({ text: `CURRENT STEP TODO — ${currentCard?.id ?? state.currentStep} ${currentCard?.title ?? ""}`, tone: "accent" });
	if (currentCard?.goal && currentCard.goal !== "-") {
		for (const line of wrap(currentCard.goal, width, "Goal: ")) lines.push({ text: line, tone: "muted" });
	}
	if (currentCard?.doItems.length) {
		for (const [index, item] of currentCard.doItems.entries()) {
			for (const line of wrap(item, width, `${index + 1}. `)) lines.push({ text: line });
		}
	} else {
		lines.push({ text: "No Do items recorded for this step.", tone: "muted" });
	}
	if (currentCard?.objectiveGates.length) {
		lines.push({ text: "Objective gates:" });
		for (const item of currentCard.objectiveGates) {
			for (const line of wrap(item.text, width, `  [${item.done ? "x" : " "}] `)) lines.push({ text: line });
		}
	}
	if (currentCard?.judgmentGates.length) {
		lines.push({ text: "Judgment gates:" });
		for (const item of currentCard.judgmentGates) {
			for (const line of wrap(item.text, width, `  [${item.done ? "x" : " "}] `)) lines.push({ text: line });
		}
	}
	lines.push({ text: "" });

	lines.push({ text: "STEP TRAIN", tone: "accent" });
	for (const step of data.steps) {
		const marker = completed.has(step.id) ? "x" : step.id === state.currentStep ? ">" : " ";
		lines.push({ text: `[${marker}] ${step.id} — ${step.title}`, tone: step.id === state.currentStep ? "accent" : "normal" });
	}
	lines.push({ text: "" });

	lines.push({ text: "MODEL PAIRS", tone: "accent" });
	for (const pair of data.rolePairs) {
		lines.push({ text: `${roleLabel(pair.role)}: ${pair.primary}` });
		lines.push({ text: `  backup: ${pair.backup}`, tone: "muted" });
	}
	lines.push({ text: "" });

	lines.push({ text: "PROVIDER QUOTA", tone: "accent" });
	if (data.quotaError) {
		for (const line of wrap(data.quotaError, width, "Unavailable: ")) lines.push({ text: line, tone: "muted" });
		lines.push({ text: "Quota display is advisory; workflow execution continues.", tone: "muted" });
	} else if (!data.quota?.reports?.length) {
		lines.push({ text: "Loading provider usage...", tone: "muted" });
	} else {
		const age = data.quotaFetchedAt ? duration(Date.now() - data.quotaFetchedAt) : "unknown";
		lines.push({ text: `Redacted live usage; refreshed ${age} ago.`, tone: "muted" });
		for (const report of data.quota.reports) {
			const identity = accountLabel(report);
			const plan = report.metadata?.planType ? ` (${report.metadata.planType})` : "";
			lines.push({ text: `${report.provider ?? "provider"} / ${identity}${plan}` });
			for (const limit of report.limits ?? []) {
				const remainingValue = remainingPercent(limit);
				const left = remainingValue === undefined ? "remaining unknown" : `${remainingValue.toFixed(1)}% left`;
				const reset = resetIn(limit.window?.resetsAt);
				lines.push({ text: `  ${limit.label ?? "quota"}: ${left}${reset ? `, ${reset}` : ""}`, tone: "muted" });
			}
		}
		for (const account of data.quota.accountsWithoutUsage ?? []) {
			lines.push({ text: `${account.provider ?? "provider"} / ${account.email ?? account.accountId ?? "account"}: no usage endpoint`, tone: "muted" });
		}
		for (const credential of data.quota.disabledCredentials ?? []) {
			lines.push({ text: `${credential.provider ?? "provider"}: credential disabled`, tone: "muted" });
		}
	}

	return lines;
}

class WorkflowDashboard implements Component {
	private data?: DashboardData;
	private error?: string;
	private scroll = 0;
	private timer?: Timer;
	private refreshing = false;
	private closed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly done: (value: undefined) => void,
	) {
		this.timer = ctx.setInterval(() => void this.refresh(false), 1_000);
		void this.refresh(true);
	}

	private async refresh(forceQuota: boolean): Promise<void> {
		if (this.refreshing || this.closed) return;
		this.refreshing = true;
		try {
			const files = await readDashboardFiles(this.ctx.cwd);
			await Promise.all([
				refreshQuota(this.pi, this.ctx.cwd, forceQuota),
				refreshMetrics(this.pi, this.ctx.cwd, forceQuota),
			]);
			this.data = {
				...files,
				metrics: metricsCache.data,
				metricsError: metricsCache.error,
				quota: quotaCache.data,
				quotaError: quotaCache.error,
				quotaFetchedAt: quotaCache.fetchedAt,
			};
			this.error = undefined;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) this.ctx.clearTimer(this.timer);
		if (activePanel === this) activePanel = undefined;
		this.done(undefined);
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "app.interrupt") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.alt("w")) ||
			matchesKey(data, "q")
		) {
			this.close();
			return;
		}
		if (matchesKey(data, "r")) {
			void this.refresh(true);
			return;
		}
		const page = Math.max(4, this.tui.terminal.rows - 8);
		if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
		else if (matchesKey(data, Key.pageDown)) this.scroll += page;
		else if (matchesKey(data, Key.home)) this.scroll = 0;
		else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
		else return;
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): readonly string[] {
		const panelWidth = width;
		const innerWidth = Math.max(1, panelWidth - 4);
		const viewport = Math.max(8, this.tui.terminal.rows - 7);
		let body: Line[];
		if (this.error) body = wrap(this.error, innerWidth, "Dashboard error: ").map(text => ({ text }));
		else if (!this.data) body = [{ text: "Loading workflow state and provider usage...", tone: "muted" }];
		else body = buildBody(this.data, innerWidth);

		const maxScroll = Math.max(0, body.length - viewport);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = body.slice(this.scroll, this.scroll + viewport);
		const border = `+${"-".repeat(panelWidth - 2)}+`;
		const title = `Pavan's Workflow Dashboard  ${this.scroll + 1}-${Math.min(body.length, this.scroll + viewport)}/${body.length}`;
		const renderLine = (line: Line): string => {
			const plain = truncateToWidth(line.text, innerWidth);
			const padded = plain + " ".repeat(Math.max(0, innerWidth - plain.length));
			const styled = line.tone === "accent" ? this.theme.fg("accent", padded) : line.tone === "muted" ? this.theme.fg("muted", padded) : padded;
			return `| ${styled} |`;
		};
		const rows = [
			border,
			renderLine({ text: title, tone: "accent" }),
			renderLine({ text: "Alt+W/Esc/q close  Up/Down/PgUp/PgDn scroll  r refresh metrics + quota", tone: "muted" }),
			border,
			...visible.map(renderLine),
		];
		while (rows.length < viewport + 4) rows.push(renderLine({ text: "" }));
		rows.push(border);
		return rows;
	}

	invalidate(): void {}

	requestRender(): void {
		this.invalidate();
		this.tui.requestRender();
	}
}

function installLiveListeners(pi: ExtensionAPI): void {
	if (listenersInstalled) return;
	listenersInstalled = true;
	pi.events.on("task:subagent:progress", data => {
		const payload = data as { progress?: Partial<WorkerProgress> & { id?: string; agent?: string; status?: WorkerProgress["status"] } };
		const progress = payload.progress;
		if (!progress?.id || !progress.agent || !progress.status) return;
		const previous = liveWorkers.get(progress.id);
		const worker: WorkerProgress = {
			...previous,
			id: progress.id,
			agent: progress.agent,
			status: progress.status,
			task: progress.task,
			assignment: progress.assignment,
			lastIntent: progress.lastIntent,
			currentTool: progress.currentTool,
			toolCount: progress.toolCount,
			requests: progress.requests,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
			startedAt: previous?.startedAt ?? Date.now(),
			resolvedModel: progress.resolvedModel,
			resolvedModelIsFallback: progress.resolvedModelIsFallback,
			updatedAt: Date.now(),
		};
		liveWorkers.set(worker.id, worker);
		lastWorker = worker;
		activePanel?.requestRender();
	});
	pi.events.on("task:subagent:lifecycle", data => {
		const payload = data as {
			id?: string;
			agent?: string;
			status?: "started" | WorkerProgress["status"];
		};
		if (!payload.id || !payload.agent || !payload.status) return;
		const previous = liveWorkers.get(payload.id);
		const worker: WorkerProgress = {
			...(previous ?? { id: payload.id, agent: payload.agent }),
			status: payload.status === "started" ? "running" : payload.status,
			startedAt: previous?.startedAt ?? Date.now(),
			updatedAt: Date.now(),
		};
		liveWorkers.set(worker.id, worker);
		lastWorker = worker;
		activePanel?.requestRender();
	});
}

async function showDashboard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	mainContext = ctx;
	installLiveListeners(pi);
	await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
		const panel = new WorkflowDashboard(pi, ctx, tui, theme, keybindings, done);
		activePanel = panel;
		return panel;
	});
}

export default function workflowDashboard(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainContext = ctx;
		installLiveListeners(pi);
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainContext = ctx;
		mainActivity = "Reasoning and routing";
		activePanel?.requestRender();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainActivity = "Ready for instruction / next transition";
		activePanel?.requestRender();
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		mainContext = ctx;
		const detail = event.intent ? ` — ${event.intent}` : "";
		mainActivity = `${event.toolName}${detail}`;
		activePanel?.requestRender();
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		mainContext = ctx;
		mainActivity = currentWorker() ? "Supervising active worker" : "Verifying result / selecting next transition";
		activePanel?.requestRender();
	});

	pi.registerCommand("workflow-dashboard", {
		description: "Open the live workflow, agent, model, and provider quota dashboard",
		handler: async (_args, ctx) => showDashboard(pi, ctx),
	});
	pi.registerShortcut(Key.alt("w"), {
		description: "Open Pavan's Workflow dashboard",
		handler: async ctx => showDashboard(pi, ctx),
	});
}
