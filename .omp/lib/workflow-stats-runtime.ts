// Real-environment wiring for the StatsController.
//
// v3 keeps the runtime lazy: constructing it performs no probe, spawn, sync, UI
// update, or browser action. The dashboard may always display the known local
// URL, while an explicit Human action starts the service.

import { spawn } from "node:child_process";
import {
	browserCommands,
	defaultLaunchCandidates,
	statsStatusLabel,
	StatsController,
	type ChildExit,
	type ChildLike,
	type StatsState,
} from "./workflow-stats.ts";

/** Legacy key retained for source compatibility; v3 never installs the widget. */
export const STATS_WIDGET_KEY = "workflow-stats";
export const STATS_DEFAULT_URL = "http://127.0.0.1:3847";

export type StatsRuntime = {
	controller: StatsController;
	subscribe(listener: (state: StatsState) => void): () => void;
	/** Explicit action: ensure Stats is running, sync once, then open the URL. */
	openInBrowser(url: string): Promise<boolean>;
	/** Always empty: v3 has no persistent below-editor Stats widget. */
	widgetLines(): string[];
	/** Always available so Alt+W can show a copyable URL while Stats is idle. */
	footerInfo(): { url: string; status: string };
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
				// One broken dashboard listener must not blind the others.
			}
		}
	};
	runtime = {
		controller,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async openInBrowser(url) {
			let state = controller.snapshot;
			if (state.status !== "ready" && state.status !== "sync-warning") {
				state = await controller.ensureStarted(true);
			}
			if (state.status !== "ready" && state.status !== "sync-warning") return false;
			await controller.requestSync(true);
			return openUrlInBrowser(url);
		},
		widgetLines: () => [],
		footerInfo: () => {
			const snapshot = controller.snapshot;
			return {
				url: controller.url,
				status: snapshot.status === "idle" ? "manual" : statsStatusLabel(snapshot.status),
			};
		},
	};
	return runtime;
}

/** Test seam: inject a fake runtime so extension wiring is deterministic. */
export function setStatsRuntimeForTesting(fake: StatsRuntime | undefined): void {
	runtime = fake;
}
