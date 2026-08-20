// Native OMP Stats integration for Pavan's Workflow.
//
// Construction is deliberately side-effect free. The official
// @oh-my-pi/omp-stats package is touched only after an explicit Human action
// (`o` in Alt+W or `/workflow-stats`). This keeps startup quiet while avoiding
// any duplicated knowledge of OMP's dashboard security/probe protocol.

import { spawn } from "node:child_process";
import {
	closeDb,
	formatStatsDashboardUrl,
	startServer,
	syncAllSessions,
} from "@oh-my-pi/omp-stats";
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

type NativeServer = {
	hostname: string;
	port: number;
	stop(): void;
};

type StatsControllerCompat = {
	readonly url: string;
	readonly snapshot: NativeStatsState;
	shutdown(): NativeStatsState;
};

export type StatsRuntime = {
	controller: StatsControllerCompat;
	subscribe(listener: (state: NativeStatsState) => void): () => void;
	/** Explicit action: native sync + native server start/reuse + browser open. */
	openInBrowser(url?: string): Promise<boolean>;
	/** Always empty: v3 has no persistent below-editor Stats widget. */
	widgetLines(): string[];
	/** Always available so Alt+W can show a copyable URL while Stats is idle. */
	footerInfo(): { url: string; status: string };
};

let runtime: StatsRuntime | undefined;
const BROWSER_OPEN_TIMEOUT_MS = 4_000;

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

export function getStatsRuntime(_cwd?: string): StatsRuntime {
	if (runtime) return runtime;

	const listeners = new Set<(state: NativeStatsState) => void>();
	let state: NativeStatsState = { status: "idle", url: STATS_DEFAULT_URL };
	let server: NativeServer | undefined;
	let opening: Promise<boolean> | undefined;

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
		try {
			server?.stop();
		} catch {
			// Server may already be gone or may be a reused external no-op handle.
		}
		server = undefined;
		try {
			closeDb();
		} catch {
			// Shutdown is best-effort and never affects workflow state.
		}
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
			opening = (async () => {
				publish({ status: "starting", error: undefined });
				try {
					const sync = await syncAllSessions();
					if (!server) server = await startServer(STATS_DEFAULT_PORT, STATS_DEFAULT_HOST);
					const url = formatStatsDashboardUrl(server.hostname, server.port);
					publish({
						status: "ready",
						url,
						error: undefined,
						lastSyncSummary: `Synced ${sync.processed} new entries from ${sync.files} files`,
					});
					return openUrlInBrowser(url || requestedUrl);
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
