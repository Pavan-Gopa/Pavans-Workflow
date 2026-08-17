// Real-environment wiring for the StatsController: global fetch, detached
// child_process spawns, and platform browser openers. A process-wide singleton
// so the stats extension, the dashboard extension, and the /workflow-stats
// command all drive one controller and one owned server process.

import { spawn } from "node:child_process";
import {
	browserCommands,
	defaultLaunchCandidates,
	statsStatusLabel,
	statsWidgetLines,
	StatsController,
	type ChildExit,
	type ChildLike,
	type StatsState,
} from "./workflow-stats.ts";

export const STATS_WIDGET_KEY = "workflow-stats";
export const STATS_DEFAULT_URL = "http://127.0.0.1:3847";

export type StatsRuntime = {
	controller: StatsController;
	subscribe(listener: (state: StatsState) => void): () => void;
	openInBrowser(url: string): Promise<boolean>;
	widgetLines(): string[];
	footerInfo(): { url?: string; status: string } | undefined;
};

let runtime: StatsRuntime | undefined;

function spawnDetached(command: string, args: string[], options: { cwd?: string }): ChildLike {
	const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: "ignore" });
	child.unref();
	const { promise, resolve } = Promise.withResolvers<ChildExit>();
	let settled = false;
	const settle = (result: ChildExit): void => {
		if (settled) return;
		settled = true;
		resolve(result);
	};
	child.once("error", error => settle({ ok: false, error: error.message }));
	child.once("exit", (code, signal) =>
		settle(code === 0 || signal !== null ? { ok: true } : { ok: false, error: `exit code ${code}` }),
	);
	return {
		pid: child.pid,
		kill: signal => {
			if (child.pid === undefined) return;
			try {
				child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
			} catch {
				// Process already gone.
			}
		},
		wait: () => promise,
	};
}

const BROWSER_OPEN_TIMEOUT_MS = 4_000;

async function openInBrowser(url: string): Promise<boolean> {
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
			// A still-running opener counts as success; it may just be slow.
			if (exit === "timeout" || exit === 0) return true;
		} catch {
			// Try the next opener.
		}
	}
	return false;
}

/**
 * Lazily create the shared StatsController. The quiet standalone `omp-stats`
 * CLI is tried first; the main `omp stats` CLI is the portable fallback.
 */
export function getStatsRuntime(cwd?: string): StatsRuntime {
	if (runtime) return runtime;
	const listeners = new Set<(state: StatsState) => void>();
	const controller = new StatsController({
		fetch: (url, init) => fetch(url, init as RequestInit),
		spawn: spawnDetached,
		launchCandidates: defaultLaunchCandidates,
		cwd,
	});
	controller.onChange = state => {
		for (const listener of [...listeners]) {
			try {
				listener(state);
			} catch {
				// One broken listener must not blind the others.
			}
		}
	};
	runtime = {
		controller,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		openInBrowser,
		widgetLines: () => statsWidgetLines(controller.snapshot),
		footerInfo: () => {
			const snapshot = controller.snapshot;
			if (snapshot.status === "idle") return undefined;
			return {
				url: snapshot.status === "unavailable" ? undefined : snapshot.url,
				status: statsStatusLabel(snapshot.status),
			};
		},
	};
	return runtime;
}

/** Test seam: inject a fake runtime so extension wiring is deterministic. */
export function setStatsRuntimeForTesting(fake: StatsRuntime | undefined): void {
	runtime = fake;
}
