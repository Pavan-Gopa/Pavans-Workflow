// Portable OMP Stats launcher, probe, sync, and lifecycle logic for the
// workflow UI. Dependency-free and deterministic: every side effect flows
// through injected implementations, so the selftest exercises the full state
// machine without touching the network or spawning processes.
//
// Trusted-server contract (verified against the OMP 17.x stats dashboard):
// - the server binds 127.0.0.1 only (loopback, never 0.0.0.0);
// - every response carries the `x-omp-stats-dashboard: 2` header;
// - responses carry no `Access-Control-Allow-Origin` header;
// - `GET /api/stats/models` is the official lightweight probe endpoint;
// - `GET /api/sync` is the official session-file sync endpoint.

export const DEFAULT_STATS_HOST = "127.0.0.1";
export const DEFAULT_STATS_PORT = 3847;
export const STATS_HEADER = "x-omp-stats-dashboard";
export const STATS_HEADER_VALUE = "2";
export const STATS_PROBE_PATH = "/api/stats/models";
export const STATS_SYNC_PATH = "/api/sync";
export const STATS_PROBE_TIMEOUT_MS = 500;
export const STATS_SYNC_TIMEOUT_MS = 30_000;
export const STATS_LAUNCH_TIMEOUT_MS = 45_000;
export const STATS_LAUNCH_POLL_MS = 250;
export const STATS_SYNC_MIN_INTERVAL_MS = 10_000;

export type StatsStatus = "idle" | "starting" | "ready" | "sync-warning" | "unavailable";

export type StatsState = {
	status: StatsStatus;
	url?: string;
	/** True when the reachable server was NOT spawned by this controller. */
	external?: boolean;
	error?: string;
	lastSyncAt?: number;
	lastSyncSummary?: string;
};

export type ProbeResult = "reusable" | "occupied" | "unreachable";

export type FetchResponseLike = {
	status: number;
	headers: { get(name: string): string | null; has(name: string): boolean };
	text(): Promise<string>;
	body?: { cancel(): Promise<void> } | null;
};

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>;

export type ChildExit = { ok: boolean; error?: string };

export type ChildLike = {
	pid?: number;
	kill(signal?: string): void;
	/** Resolves exactly once when the process exits or fails to spawn. */
	wait(): Promise<ChildExit>;
};

export type SpawnLike = (command: string, args: string[], options: { cwd?: string }) => ChildLike;

export type LaunchKind = "standalone" | "omp-cli";

export type LaunchCommand = {
	command: string;
	args: string[];
	kind: LaunchKind;
};

export type BrowserCommand = { command: string; args: string[] };

export type StatsDeps = {
	fetch: FetchLike;
	spawn: SpawnLike;
	launchCandidates: (port: number) => LaunchCommand[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	host?: string;
	port?: number;
	launchTimeoutMs?: number;
	pollIntervalMs?: number;
	syncTimeoutMs?: number;
	cwd?: string;
	syncMinIntervalMs?: number;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Format a loopback URL; brackets IPv6 hosts (`::1` -> `http://[::1]:3847`). */
export function formatStatsUrl(host: string, port: number): string {
	const normalized = host.includes(":") ? `[${host}]` : host;
	return `http://${normalized}:${port}`;
}

/**
 * Probe a port for a trusted OMP Stats server. Mirrors the official OMP
 * port-conflict check: status 200 + `x-omp-stats-dashboard: 2` + no
 * `Access-Control-Allow-Origin`. Anything else on the port is untrusted.
 */
export async function probeStatsServer(
	fetchImpl: FetchLike,
	host: string = DEFAULT_STATS_HOST,
	port: number = DEFAULT_STATS_PORT,
	timeoutMs: number = STATS_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	try {
		const response = await fetchImpl(`${formatStatsUrl(host, port)}${STATS_PROBE_PATH}`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		const trusted =
			response.status === 200 &&
			response.headers.get(STATS_HEADER) === STATS_HEADER_VALUE &&
			!response.headers.has("access-control-allow-origin");
		await response.body?.cancel();
		return trusted ? "reusable" : "occupied";
	} catch {
		return "unreachable";
	}
}

/**
 * Ordered launcher candidates. The quiet standalone `omp-stats` CLI comes
 * first; the main `omp stats` CLI is the portable fallback (it prints
 * "Dashboard available at:" once ready and may open the browser itself).
 */
export function defaultLaunchCandidates(port: number, ompBinaries: string[] = ["omp"]): LaunchCommand[] {
	const candidates: LaunchCommand[] = [{ command: "omp-stats", args: ["--port", String(port)], kind: "standalone" }];
	for (const binary of new Set(ompBinaries)) {
		candidates.push({ command: binary, args: ["stats", "--port", String(port)], kind: "omp-cli" });
	}
	return candidates;
}

export function isWslEnvironment(env: Record<string, string | undefined>): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || env.WSLENV);
}

const SAFE_BROWSER_URL = /^https?:\/\/[^\s"'`<>\\]+$/i;

/**
 * Portable browser-open commands. The URL is always passed as a separate
 * argument, never interpolated into a shell string. Windows uses PowerShell
 * Start-Process with an encoded command, then `cmd /c start` as fallback;
 * WSL tries `wslview` before the Linux openers.
 */
export function browserCommands(
	platform: string,
	env: Record<string, string | undefined>,
	url: string,
): BrowserCommand[] {
	if (!SAFE_BROWSER_URL.test(url)) return [];
	if (platform === "darwin") return [{ command: "open", args: [url] }];
	if (platform === "win32") {
		const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || "C:\\Windows";
		const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
		const script = `$ErrorActionPreference='Stop';Start-Process '${url.replaceAll("'", "''")}'`;
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		return [
			{ command: powershell, args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] },
			{ command: "cmd", args: ["/c", "start", "", url] },
		];
	}
	const commands: BrowserCommand[] = [];
	if (isWslEnvironment(env)) commands.push({ command: "wslview", args: [url] });
	commands.push(
		{ command: "xdg-open", args: [url] },
		{ command: "gio", args: ["open", url] },
		{ command: "sensible-browser", args: [url] },
	);
	return commands;
}

export function statsStatusLabel(status: StatsStatus): string {
	switch (status) {
		case "idle":
			return "idle";
		case "starting":
			return "starting…";
		case "ready":
			return "ready";
		case "sync-warning":
			return "sync warning";
		case "unavailable":
			return "unavailable";
	}
}

/**
 * Widget lines for the area below the editor. The URL is emitted on its own
 * bare line so terminals can turn it into an OSC 8 / click-to-open link.
 */
export function statsWidgetLines(state: StatsState): string[] {
	if (state.status === "idle") return [];
	const lines = [`OMP Stats · ${statsStatusLabel(state.status)}`];
	if (state.url && state.status !== "unavailable") lines.push(state.url);
	if (state.error) lines.push(state.error);
	return lines;
}

type LaunchAttempt =
	| { outcome: "ready" }
	| { outcome: "fatal"; message: string }
	| { outcome: "failed"; message: string };

/**
 * Owns the Stats server lifecycle for one OMP process:
 * - reuses an already-running trusted server (never stops it);
 * - spawns at most one server of its own and stops only that one on shutdown;
 * - refuses ports held by untrusted processes (bad headers or unsafe CORS);
 * - coalesces sync requests into one in-flight + at most one queued sync.
 * Methods never reject; failures land in `state.error`.
 */
export class StatsController {
	readonly host: string;
	readonly port: number;
	onChange?: (state: StatsState) => void;

	private readonly deps: StatsDeps;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly launchTimeoutMs: number;
	private readonly syncTimeoutMs: number;
	private readonly syncMinIntervalMs: number;

	private state: StatsState = { status: "idle" };
	private child?: ChildLike;
	private childGone = false;
	private childExit?: ChildExit;
	private owned = false;
	private generation = 0;
	private startPromise?: Promise<StatsState>;
	private syncActive?: Promise<void>;
	private syncAgain = false;

	constructor(deps: StatsDeps) {
		this.sleep = deps.sleep ?? ((ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		});
		this.deps = deps;
		this.host = deps.host ?? DEFAULT_STATS_HOST;
		this.port = deps.port ?? DEFAULT_STATS_PORT;
		this.now = deps.now ?? Date.now;
		this.launchTimeoutMs = deps.launchTimeoutMs ?? STATS_LAUNCH_TIMEOUT_MS;
		this.pollIntervalMs = deps.pollIntervalMs ?? STATS_LAUNCH_POLL_MS;
		this.syncTimeoutMs = deps.syncTimeoutMs ?? STATS_SYNC_TIMEOUT_MS;
		this.syncMinIntervalMs = deps.syncMinIntervalMs ?? STATS_SYNC_MIN_INTERVAL_MS;
	}

	get url(): string {
		return formatStatsUrl(this.host, this.port);
	}

	get snapshot(): StatsState {
		return { ...this.state };
	}

	private setState(patch: Partial<StatsState>): void {
		this.state = { ...this.state, ...patch };
		try {
			this.onChange?.(this.state);
		} catch {
			// UI callbacks must never break the controller.
		}
	}

	private childAlive(): boolean {
		return this.child !== undefined && !this.childGone;
	}

	private trackChild(child: ChildLike): void {
		this.child = child;
		this.childGone = false;
		this.childExit = undefined;
		void child.wait().then(
			result => {
				if (this.child !== child) return;
				this.childGone = true;
				this.childExit = result;
				if (!result.ok && (this.state.status === "ready" || this.state.status === "sync-warning")) {
					this.setState({ status: "unavailable", error: `stats server exited: ${result.error ?? "unknown"}` });
				}
			},
			() => {
				if (this.child !== child) return;
				this.childGone = true;
				this.childExit = { ok: false, error: "wait rejected" };
			},
		);
	}

	private killOwned(): void {
		const child = this.child;
		this.child = undefined;
		this.owned = false;
		this.childGone = true;
		if (child) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Process already gone.
			}
		}
	}

	/**
	 * Ensure a trusted Stats server is running. Reuses a healthy instance,
	 * restarts when the owned child died, and otherwise spawns launchers in
	 * order. `recheck: true` re-probes even when the state looks healthy
	 * (manual retry). Never rejects.
	 */
	ensureStarted(recheck = false): Promise<StatsState> {
		if (this.startPromise) return this.startPromise;
		const healthy = this.state.status === "ready" || this.state.status === "sync-warning";
		if (healthy && !recheck && (this.state.external || this.childAlive())) {
			return Promise.resolve(this.state);
		}
		this.setState({ status: "starting", url: this.url, error: undefined });
		this.startPromise = this.runStart().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async runStart(): Promise<StatsState> {
		const generation = this.generation;
		try {
			const probe = await probeStatsServer(this.deps.fetch, this.host, this.port);
			if (generation !== this.generation) return this.state;
			if (probe === "reusable") {
				const keepOwned = this.owned && this.childAlive();
				if (!keepOwned) {
					this.child = undefined;
					this.owned = false;
				}
				this.setState({ status: "ready", url: this.url, external: !keepOwned, error: undefined });
				return this.state;
			}
			if (probe === "occupied") {
				this.setState({
					status: "unavailable",
					error: `port ${this.port} is held by an untrusted process (missing OMP Stats headers or unsafe CORS); not reusing it`,
				});
				return this.state;
			}
			if (this.owned && this.childAlive()) this.killOwned();
			let lastError = "no Stats launcher available";
			for (const candidate of this.deps.launchCandidates(this.port)) {
				if (generation !== this.generation) return this.state;
				const attempt = await this.tryLaunch(candidate, generation);
				if (generation !== this.generation) return this.state;
				if (attempt.outcome === "ready") return this.state;
				if (attempt.outcome === "fatal") {
					this.setState({ status: "unavailable", error: attempt.message });
					return this.state;
				}
				lastError = attempt.message;
			}
			if (generation !== this.generation) return this.state;
			this.setState({ status: "unavailable", error: lastError });
			return this.state;
		} catch (error) {
			if (generation === this.generation) this.setState({ status: "unavailable", error: errorMessage(error) });
			return this.state;
		}
	}

	private async tryLaunch(candidate: LaunchCommand, generation: number): Promise<LaunchAttempt> {
		let child: ChildLike;
		try {
			child = this.deps.spawn(candidate.command, candidate.args, { cwd: this.deps.cwd });
		} catch (error) {
			return { outcome: "failed", message: `${candidate.command}: ${errorMessage(error)}` };
		}
		this.owned = true;
		this.trackChild(child);
		const deadline = this.now() + this.launchTimeoutMs;
		while (this.now() < deadline) {
			if (generation !== this.generation) {
				this.killOwned();
				return { outcome: "fatal", message: "shutdown during startup" };
			}
			await this.sleep(this.pollIntervalMs);
			const probe = await probeStatsServer(this.deps.fetch, this.host, this.port);
			if (probe === "reusable") {
				this.setState({ status: "ready", url: this.url, external: false, error: undefined });
				return { outcome: "ready" };
			}
			if (probe === "occupied") {
				this.killOwned();
				return {
					outcome: "fatal",
					message: `port ${this.port} answered without trusted OMP Stats headers (version mismatch or foreign server)`,
				};
			}
			if (this.childGone) {
				const exit = this.childExit;
				this.child = undefined;
				this.owned = false;
				return {
					outcome: "failed",
					message: `${candidate.command}: ${exit?.ok ? "exited before the dashboard came up" : exit?.error ?? "failed to start"}`,
				};
			}
		}
		this.killOwned();
		return { outcome: "failed", message: `${candidate.command}: timed out after ${this.launchTimeoutMs} ms waiting for the dashboard` };
	}

	/**
	 * Request an official `/api/sync`. Single-flight: while one sync runs,
	 * additional requests set one queued flag instead of stacking up.
	 * Non-forced requests are additionally throttled to one per
	 * `syncMinIntervalMs` so lifecycle bursts cannot hammer the endpoint;
	 * `force: true` (manual refresh, slash command) bypasses the throttle.
	 * Never rejects.
	 */
	requestSync(force = false): Promise<StatsState> {
		const url = this.state.url;
		const syncable = this.state.status === "ready" || this.state.status === "sync-warning";
		if (!url || !syncable) return Promise.resolve(this.state);
		if (!force && this.state.lastSyncAt !== undefined && this.now() - this.state.lastSyncAt < this.syncMinIntervalMs) {
			return Promise.resolve(this.state);
		}
		if (this.syncActive) {
			this.syncAgain = true;
			return this.syncActive.then(() => this.state);
		}
		const run = async (): Promise<void> => {
			do {
				this.syncAgain = false;
				await this.performSync(url);
			} while (this.syncAgain && (this.state.status === "ready" || this.state.status === "sync-warning"));
		};
		this.syncActive = run().finally(() => {
			this.syncActive = undefined;
		});
		return this.syncActive.then(() => this.state);
	}

	private async performSync(url: string): Promise<void> {
		try {
			const response = await this.deps.fetch(`${url}${STATS_SYNC_PATH}`, {
				signal: AbortSignal.timeout(this.syncTimeoutMs),
			});
			if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
			let summary: string | undefined;
			try {
				const data = JSON.parse(await response.text()) as {
					processed?: number;
					files?: number;
					totalMessages?: number;
				};
				if (data && typeof data === "object") {
					summary = `Synced ${data.processed ?? 0} new entries from ${data.files ?? 0} files (${data.totalMessages ?? 0} total)`;
				}
			} catch {
				// Non-JSON sync payloads are not an error.
			}
			this.setState({ status: "ready", error: undefined, lastSyncAt: this.now(), lastSyncSummary: summary });
		} catch (error) {
			if (this.state.status === "ready" || this.state.status === "sync-warning") {
				this.setState({ status: "sync-warning", error: `sync failed: ${errorMessage(error)}` });
			}
		}
	}

	/**
	 * Stop only the server this controller spawned. External servers that
	 * were running before the workflow started are left untouched.
	 */
	shutdown(): StatsState {
		this.generation += 1;
		this.syncAgain = false;
		if (this.owned) this.killOwned();
		else this.child = undefined;
		this.setState({
			status: "idle",
			url: undefined,
			external: false,
			error: undefined,
			lastSyncAt: undefined,
			lastSyncSummary: undefined,
		});
		return this.state;
	}
}
