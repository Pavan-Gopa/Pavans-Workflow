export const DEFAULT_OMP_STATS_HOST = "127.0.0.1";
export const DEFAULT_OMP_STATS_PORT = 3847;
export const OMP_STATS_WIDGET_KEY = "pavans-workflow.omp-stats";

const OMP_STATS_DASHBOARD_HEADER = "x-omp-stats-dashboard";
const OMP_STATS_HOSTNAME_HEADER = "x-omp-stats-hostname";
const OMP_STATS_MIN_SECURITY_VERSION = 3;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_SYNC_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export type OmpStatsPhase = "idle" | "starting" | "ready" | "error";

export type OmpStatsSnapshot = {
	phase: OmpStatsPhase;
	url: string;
	error?: string;
	syncError?: string;
};

export type BrowserCommand = {
	command: string;
	args: string[];
};

export type StatsLaunchCommand = BrowserCommand & {
	label: string;
};

export type OmpStatsProcess = {
	exitCode: number | null;
	killed?: boolean;
	kill: (signal?: string | number) => void;
	unref?: () => void;
};

type OmpStatsUi = {
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	setWidget: (
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => void;
};

export type OmpStatsContext = {
	cwd: string;
	hasUI: boolean;
	ui: OmpStatsUi;
	setTimeout?: (callback: () => void, milliseconds: number) => unknown;
};

export type OmpStatsCommandRunner = {
	exec: (
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
};

type ProbeDashboard = (url: string, host: string) => Promise<boolean>;
type SpawnProcess = (command: string, args: string[], cwd: string) => OmpStatsProcess;
type StopProcess = (process: OmpStatsProcess) => void;
type SyncDashboard = (url: string) => Promise<void>;
type Delay = (milliseconds: number, context?: OmpStatsContext) => Promise<void>;

export type OmpStatsControllerOptions = {
	host?: string;
	port?: number;
	platform?: string;
	env?: Record<string, string | undefined>;
	onChange?: () => void;
	probeDashboard?: ProbeDashboard;
	spawnProcess?: SpawnProcess;
	stopProcess?: StopProcess;
	syncDashboard?: SyncDashboard;
	delay?: Delay;
	startTimeoutMs?: number;
	pollIntervalMs?: number;
};

function messageFrom(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function compact(value: string, maxLength = 120): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatStatsUrl(hostname: string, port: number): string {
	const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	return `http://${urlHostname}:${port}`;
}

export function formatStatsWidgetLine(snapshot: OmpStatsSnapshot): string {
	if (snapshot.phase === "ready") {
		return `OMP Stats · ready${snapshot.syncError ? " · sync warning" : ""}`;
	}
	if (snapshot.phase === "starting") return "OMP Stats · starting local dashboard in background…";
	if (snapshot.phase === "error") {
		return `OMP Stats unavailable · /workflow-stats retries · ${compact(snapshot.error ?? "unknown error", 80)}`;
	}
	return "OMP Stats · starts automatically with the workflow";
}

export function formatStatsWidgetLines(snapshot: OmpStatsSnapshot): string[] {
	return [
		formatStatsWidgetLine(snapshot),
		snapshot.url,
		"Open: /workflow-stats · Alt+W, then o",
	];
}

export function formatStatsPanelLine(snapshot: OmpStatsSnapshot): string {
	if (snapshot.phase === "ready") {
		return `${snapshot.url} · OMP STATS · click URL or press o${snapshot.syncError ? " · sync warning" : ""}`;
	}
	if (snapshot.phase === "starting") return `${snapshot.url} · OMP STATS · starting`;
	if (snapshot.phase === "error") {
		return `${snapshot.url} · OMP STATS unavailable · press o to retry`;
	}
	return `${snapshot.url} · OMP STATS · press o to start`;
}

export function statsPanelTone(snapshot: OmpStatsSnapshot): "accent" | "muted" | "warning" {
	if (snapshot.phase === "error" || snapshot.syncError) return "warning";
	return snapshot.phase === "ready" ? "accent" : "muted";
}

export function formatStatsPanelRow(snapshot: OmpStatsSnapshot, width: number): string {
	const panelWidth = Math.max(2, width);
	const innerWidth = Math.max(0, panelWidth - 2);
	const line = formatStatsPanelLine(snapshot);
	const clipped = line.length <= innerWidth
		? line
		: innerWidth <= 1
			? "…".slice(0, innerWidth)
			: `${line.slice(0, innerWidth - 1)}…`;
	return `|${clipped.padEnd(innerWidth)}|`;
}

export function browserCommandCandidates(
	platform: string,
	url: string,
	env: Record<string, string | undefined> = {},
): BrowserCommand[] {
	if (platform === "darwin") return [{ command: "open", args: [url] }];
	if (platform === "win32") {
		return [
			{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url] },
			{ command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] },
		];
	}
	const commands: BrowserCommand[] = [];
	if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) commands.push({ command: "wslview", args: [url] });
	commands.push(
		{ command: "xdg-open", args: [url] },
		{ command: "gio", args: ["open", url] },
		{ command: "sensible-browser", args: [url] },
	);
	return commands;
}

export function statsLaunchCommandCandidates(host: string, port: number): StatsLaunchCommand[] {
	return [
		{
			command: "omp-stats",
			args: ["--port", String(port), "--host", host],
			label: "omp-stats",
		},
		{
			command: "omp",
			args: ["stats", "--port", String(port), "--host", host],
			label: "omp stats",
		},
	];
}

export function isReusableStatsDashboardResponse(
	response: Pick<Response, "status" | "headers">,
	host: string,
): boolean {
	const versionHeader = response.headers.get(OMP_STATS_DASHBOARD_HEADER);
	const securityVersion = versionHeader === null ? Number.NaN : Number(versionHeader);
	return (
		response.status === 200 &&
		Number.isInteger(securityVersion) &&
		securityVersion >= OMP_STATS_MIN_SECURITY_VERSION &&
		response.headers.get(OMP_STATS_HOSTNAME_HEADER) === host &&
		!response.headers.has("Access-Control-Allow-Origin")
	);
}

async function defaultProbeDashboard(url: string, host: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/stats/models`, {
			signal: AbortSignal.timeout(750),
		});
		const isStatsDashboard = isReusableStatsDashboardResponse(response, host);
		await response.body?.cancel();
		return isStatsDashboard;
	} catch {
		return false;
	}
}

function defaultSpawnProcess(command: string, args: string[], cwd: string): OmpStatsProcess {
	const child = Bun.spawn([command, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	}) as unknown as OmpStatsProcess;
	child.unref?.();
	return child;
}

function defaultStopProcess(child: OmpStatsProcess): void {
	if (child.exitCode !== null || child.killed) return;
	try {
		child.kill(process.platform === "win32" ? undefined : "SIGINT");
	} catch {
		try {
			child.kill();
		} catch {}
	}
}

async function defaultSyncDashboard(url: string): Promise<void> {
	const response = await fetch(`${url}/api/sync`, {
		method: "POST",
		signal: AbortSignal.timeout(DEFAULT_SYNC_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	await response.json();
}

function defaultDelay(milliseconds: number, context?: OmpStatsContext): Promise<void> {
	return new Promise(resolve => {
		if (context?.setTimeout) context.setTimeout(resolve, milliseconds);
		else setTimeout(resolve, milliseconds);
	});
}

export class OmpStatsController {
	private readonly host: string;
	private readonly port: number;
	private readonly platform: string;
	private readonly env: Record<string, string | undefined>;
	private readonly onChange?: () => void;
	private readonly probeDashboard: ProbeDashboard;
	private readonly spawnProcess: SpawnProcess;
	private readonly stopProcess: StopProcess;
	private readonly syncDashboard: SyncDashboard;
	private readonly delay: Delay;
	private readonly startTimeoutMs: number;
	private readonly pollIntervalMs: number;
	private context?: OmpStatsContext;
	private child?: OmpStatsProcess;
	private startPromise?: Promise<string | undefined>;
	private syncPromise?: Promise<void>;
	private syncQueued = false;
	private epoch = 0;
	private state: OmpStatsSnapshot;

	constructor(options: OmpStatsControllerOptions = {}) {
		this.host = options.host ?? DEFAULT_OMP_STATS_HOST;
		this.port = options.port ?? DEFAULT_OMP_STATS_PORT;
		this.platform = options.platform ?? process.platform;
		this.env = options.env ?? process.env;
		this.onChange = options.onChange;
		this.probeDashboard = options.probeDashboard ?? defaultProbeDashboard;
		this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
		this.stopProcess = options.stopProcess ?? defaultStopProcess;
		this.syncDashboard = options.syncDashboard ?? defaultSyncDashboard;
		this.delay = options.delay ?? defaultDelay;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.state = { phase: "idle", url: formatStatsUrl(this.host, this.port) };
	}

	snapshot(): OmpStatsSnapshot {
		return { ...this.state };
	}

	panelRow(width: number): string {
		return formatStatsPanelRow(this.state, width);
	}

	panelTone(): "accent" | "muted" | "warning" {
		return statsPanelTone(this.state);
	}

	attach(context: OmpStatsContext): void {
		if (!context.hasUI) return;
		this.context = context;
		this.publish();
	}

	private publish(): void {
		if (this.context?.hasUI) {
			this.context.ui.setWidget(
				OMP_STATS_WIDGET_KEY,
				formatStatsWidgetLines(this.state),
				{ placement: "belowEditor" },
			);
		}
		this.onChange?.();
	}

	private update(next: OmpStatsSnapshot, epoch = this.epoch): void {
		if (epoch !== this.epoch) return;
		this.state = next;
		this.publish();
	}

	private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
		if (this.context?.hasUI) this.context.ui.notify(message, type);
	}

	private stopOwnedChild(): void {
		if (!this.child) return;
		this.stopProcess(this.child);
		this.child = undefined;
	}

	private async waitUntilReady(child: OmpStatsProcess, epoch: number): Promise<boolean> {
		const deadline = Date.now() + this.startTimeoutMs;
		while (Date.now() < deadline && epoch === this.epoch) {
			if (await this.probeDashboard(this.state.url, this.host)) return true;
			if (child.exitCode !== null || child.killed) return false;
			await this.delay(this.pollIntervalMs, this.context);
		}
		return epoch === this.epoch && this.probeDashboard(this.state.url, this.host);
	}

	async start(context?: OmpStatsContext, notifyReady = false): Promise<string | undefined> {
		if (context) this.attach(context);

		if (this.state.phase === "ready") {
			if (await this.probeDashboard(this.state.url, this.host)) {
				if (notifyReady) this.notify(`OMP Stats: ${this.state.url}`, "info");
				return this.state.url;
			}
			this.stopOwnedChild();
			this.update({ phase: "idle", url: formatStatsUrl(this.host, this.port) });
		}
		if (this.startPromise) return this.startPromise;

		const epoch = this.epoch;
		this.update({ phase: "starting", url: formatStatsUrl(this.host, this.port) }, epoch);
		const currentStart = (async () => {
			if (await this.probeDashboard(this.state.url, this.host)) {
				this.update({ phase: "ready", url: this.state.url }, epoch);
				return this.state.url;
			}

			const failures: string[] = [];
			for (const candidate of statsLaunchCommandCandidates(this.host, this.port)) {
				if (epoch !== this.epoch) return undefined;
				let child: OmpStatsProcess;
				try {
					child = this.spawnProcess(candidate.command, candidate.args, this.context?.cwd ?? process.cwd());
				} catch (error) {
					failures.push(`${candidate.label}: ${compact(messageFrom(error), 80)}`);
					continue;
				}

				this.child = child;
				if (await this.waitUntilReady(child, epoch)) {
					this.update({ phase: "ready", url: this.state.url }, epoch);
					return this.state.url;
				}

				failures.push(
					`${candidate.label}: ${child.exitCode === null ? "dashboard start timed out" : `exited ${child.exitCode}`}`,
				);
				this.stopOwnedChild();
			}

			const error = compact(failures.join("; ") || "no OMP Stats launcher was available");
			this.update({ phase: "error", url: formatStatsUrl(this.host, this.port), error }, epoch);
			return undefined;
		})();
		this.startPromise = currentStart;

		try {
			const url = await currentStart;
			if (url && notifyReady) this.notify(`OMP Stats: ${url}`, "info");
			else if (!url && notifyReady) this.notify(`OMP Stats unavailable: ${this.state.error ?? "unknown error"}`, "warning");
			return url;
		} finally {
			if (this.startPromise === currentStart) this.startPromise = undefined;
		}
	}

	async sync(notifyOnError = false): Promise<void> {
		if (this.state.phase !== "ready") return;
		if (this.syncPromise) {
			this.syncQueued = true;
			return this.syncPromise;
		}
		const epoch = this.epoch;
		const currentSync = (async () => {
			try {
				do {
					this.syncQueued = false;
					await this.syncDashboard(this.state.url);
				} while (this.syncQueued && epoch === this.epoch);
				if (this.state.syncError) this.update({ ...this.state, syncError: undefined }, epoch);
			} catch (error) {
				const syncError = compact(messageFrom(error));
				this.update({ ...this.state, syncError }, epoch);
				if (notifyOnError) this.notify(`OMP Stats sync failed: ${syncError}`, "warning");
			}
		})();
		this.syncPromise = currentSync;
		try {
			await currentSync;
		} finally {
			if (this.syncPromise === currentSync) this.syncPromise = undefined;
		}
	}

	async open(runner: OmpStatsCommandRunner, context: OmpStatsContext): Promise<boolean> {
		const url = await this.start(context, false);
		if (!url) {
			this.notify(`OMP Stats unavailable: ${this.state.error ?? "unknown error"}`, "warning");
			return false;
		}
		void this.sync(false);
		const failures: string[] = [];
		for (const candidate of browserCommandCandidates(this.platform, url, this.env)) {
			try {
				const result = await runner.exec(candidate.command, candidate.args, { cwd: context.cwd, timeout: 10_000 });
				if (result.code === 0) {
					this.notify(`Opened OMP Stats: ${url}`, "info");
					return true;
				}
				failures.push(`${candidate.command}: ${compact(result.stderr || result.stdout || `exit ${result.code}`, 72)}`);
			} catch (error) {
				failures.push(`${candidate.command}: ${compact(messageFrom(error), 72)}`);
			}
		}
		this.notify(
			`Could not open the browser automatically. Click ${url}. ${compact(failures.join("; "), 120)}`,
			"warning",
		);
		return false;
	}

	async shutdown(context?: OmpStatsContext): Promise<void> {
		const attachedContext = context?.hasUI ? context : this.context;
		this.epoch += 1;
		this.context = undefined;
		this.stopOwnedChild();
		if (attachedContext?.hasUI) {
			attachedContext.ui.setWidget(OMP_STATS_WIDGET_KEY, undefined, { placement: "belowEditor" });
		}
		this.startPromise = undefined;
		this.syncPromise = undefined;
		this.syncQueued = false;
		this.state = { phase: "idle", url: formatStatsUrl(this.host, this.port) };
		this.onChange?.();
	}
}
