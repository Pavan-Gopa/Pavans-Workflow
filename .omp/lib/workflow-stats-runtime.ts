// Manual OMP Stats integration for Pavan's Workflow.
//
// Project extensions must not import @oh-my-pi/omp-stats directly: that package
// is an internal dependency of the OMP CLI and is not guaranteed to be exposed
// through the runtime extension resolver. The supported boundary for a project
// extension is therefore the native `omp stats` command itself.

import { spawn, type ChildProcess } from "node:child_process";
import { browserCommands } from "./workflow-stats.ts";

/** Legacy key retained for source compatibility; v3 never installs the widget. */
export const STATS_WIDGET_KEY = "workflow-stats";
export const STATS_DEFAULT_HOST = "127.0.0.1";
export const STATS_DEFAULT_PORT = 3847;
export const STATS_DEFAULT_URL = `http://${STATS_DEFAULT_HOST}:${STATS_DEFAULT_PORT}`;

export type NativeStatsStatus = "idle" | "starting" | "ready" | "unavailable";
export type NativeStatsState = {
	status: NativeStatsStatus;
	url: string;
	error?: string;
	lastSyncSummary?: string;
};

type StatsControllerCompat = {
	readonly url: string;
	readonly snapshot: NativeStatsState;
	shutdown(): NativeStatsState;
};

export type StatsRuntime = {
	controller: StatsControllerCompat;
	subscribe(listener: (state: NativeStatsState) => void): () => void;
	/** Explicit action: delegate sync/server/browser lifecycle to `omp stats`. */
	openInBrowser(url?: string): Promise<boolean>;
	/** Always empty: v3 has no persistent below-editor Stats widget. */
	widgetLines(): string[];
	/** Always available so Alt+W can show a copyable URL while Stats is idle. */
	footerInfo(): { url: string; status: string };
};

let runtime: StatsRuntime | undefined;
const BROWSER_OPEN_TIMEOUT_MS = 4_000;
const CLI_START_GRACE_MS = 750;

function childRunning(child: ChildProcess | undefined): child is ChildProcess {
	return !!child && child.exitCode === null && child.signalCode === null && !child.killed;
}

async function openUrlInBrowser(url: string): Promise<boolean> {
	const env = process.env as Record<string, string | undefined>;
	for (const candidate of browserCommands(process.platform, env, url)) {
		try {
			const child = spawn(candidate.command, candidate.args, {
				stdio: "ignore",
				detached: process.platform !== "win32",
			});
			child.unref();
			const exit = await new Promise<number | null | "timeout">(resolve => {
				const timer = setTimeout(() => resolve("timeout"), BROWSER_OPEN_TIMEOUT_MS);
				timer.unref?.();
				child.once("error", () => {
					clearTimeout(timer);
					resolve(null);
				});
				child.once("exit", code => {
					clearTimeout(timer);
					resolve(code);
				});
			});
			if (exit === "timeout" || exit === 0) return true;
		} catch {
			// Try the next platform opener.
		}
	}
	return false;
}

function waitForCliStart(child: ChildProcess): Promise<{ ok: true } | { ok: false; error: string }> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (result: { ok: true } | { ok: false; error: string }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => finish({ ok: true }), CLI_START_GRACE_MS);
		timer.unref?.();
		child.once("error", error => finish({ ok: false, error: error.message }));
		child.once("exit", (code, signal) => {
			finish({
				ok: false,
				error: signal ? `omp stats exited on ${signal}` : `omp stats exited with code ${code ?? "unknown"}`,
			});
		});
	});
}

export function getStatsRuntime(cwd = process.cwd()): StatsRuntime {
	if (runtime) return runtime;

	const listeners = new Set<(state: NativeStatsState) => void>();
	let state: NativeStatsState = { status: "idle", url: STATS_DEFAULT_URL };
	let child: ChildProcess | undefined;
	let opening: Promise<boolean> | undefined;
	let shuttingDown = false;

	const publish = (patch: Partial<NativeStatsState>): NativeStatsState => {
		state = { ...state, ...patch };
		for (const listener of [...listeners]) {
			try {
				listener({ ...state });
			} catch {
				// One dashboard listener must never break Stats.
			}
		}
		return { ...state };
	};

	const shutdown = (): NativeStatsState => {
		shuttingDown = true;
		if (childRunning(child)) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Best effort only.
			}
		}
		child = undefined;
		shuttingDown = false;
		return publish({ status: "idle", url: STATS_DEFAULT_URL, error: undefined });
	};

	const controller: StatsControllerCompat = {
		get url() {
			return state.url;
		},
		get snapshot() {
			return { ...state };
		},
		shutdown,
	};

	runtime = {
		controller,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async openInBrowser(requestedUrl = STATS_DEFAULT_URL) {
			if (opening) return opening;
			if (childRunning(child)) {
				publish({ status: "ready", url: requestedUrl, error: undefined });
				return openUrlInBrowser(requestedUrl);
			}

			opening = (async () => {
				publish({ status: "starting", url: requestedUrl, error: undefined });
				try {
					child = spawn(
						"omp",
						["stats", "--port", String(STATS_DEFAULT_PORT), "--host", STATS_DEFAULT_HOST],
						{
							cwd,
							stdio: "ignore",
							env: process.env,
						},
					);
					child.unref();
					const owned = child;
					owned.once("exit", (code, signal) => {
						if (shuttingDown || child !== owned) return;
						child = undefined;
						publish({
							status: "unavailable",
							error: signal ? `omp stats exited on ${signal}` : `omp stats exited with code ${code ?? "unknown"}`,
						});
					});
					const started = await waitForCliStart(owned);
					if (!started.ok) {
						if (child === owned) child = undefined;
						publish({ status: "unavailable", error: started.error });
						return false;
					}
					publish({
						status: "ready",
						url: requestedUrl,
						error: undefined,
						lastSyncSummary: "Native OMP CLI owns Stats sync, server security, and browser lifecycle",
					});
					// `omp stats` opens the browser itself after synchronizing sessions.
					return true;
				} catch (error) {
					publish({
						status: "unavailable",
						error: error instanceof Error ? error.message : String(error),
					});
					return false;
				} finally {
					opening = undefined;
				}
			})();
			return opening;
		},
		widgetLines: () => [],
		footerInfo: () => ({
			url: state.url,
			status: state.status === "idle" ? "manual" : state.status,
		}),
	};
	return runtime;
}

/** Test seam: inject a fake runtime so extension wiring is deterministic. */
export function setStatsRuntimeForTesting(fake: StatsRuntime | undefined): void {
	runtime = fake;
}
