import assert from "node:assert/strict";
import workflowStats from "../extensions/workflow-stats.ts";
import { STATS_DEFAULT_URL, setStatsRuntimeForTesting } from "../lib/workflow-stats-runtime.ts";
import { formatStatsUrl } from "../lib/workflow-stats.ts";

assert.equal(formatStatsUrl("127.0.0.1", 3847), STATS_DEFAULT_URL);
assert.equal(formatStatsUrl("::1", 3847), "http://[::1]:3847");

let status: "idle" | "ready" = "idle";
let startCalls = 0;
let syncCalls = 0;
let shutdownCalls = 0;
const opened: string[] = [];

const fakeController = {
	url: STATS_DEFAULT_URL,
	get snapshot() {
		return { status, ...(status === "ready" ? { url: STATS_DEFAULT_URL } : {}) };
	},
	async ensureStarted() {
		startCalls += 1;
		status = "ready";
		return { status: "ready", url: STATS_DEFAULT_URL };
	},
	async requestSync() {
		syncCalls += 1;
		return { status: "ready", url: STATS_DEFAULT_URL };
	},
	shutdown() {
		shutdownCalls += 1;
		status = "idle";
		return { status: "idle" };
	},
};

setStatsRuntimeForTesting({
	controller: fakeController as never,
	subscribe: () => () => {},
	openInBrowser: async url => {
		opened.push(url);
		return true;
	},
	widgetLines: () => [],
	footerInfo: () => ({
		url: STATS_DEFAULT_URL,
		status: status === "idle" ? "manual" : "ready",
	}),
});

const handlers: Record<string, (event: unknown, ctx: any) => Promise<void>> = {};
const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void>; description: string }> = {};
let lifecycleListenerCount = 0;
const fakePi = {
	on(event: string, handler: (event: unknown, ctx: any) => Promise<void>) {
		handlers[event] = handler;
	},
	events: {
		on() {
			lifecycleListenerCount += 1;
		},
	},
	registerCommand(name: string, definition: { handler: (args: string, ctx: any) => Promise<void>; description: string }) {
		commands[name] = definition;
	},
};

workflowStats(fakePi as never);

// Manual means no startup/switch/turn/subagent hooks and no widget lifecycle.
assert.equal(handlers.session_start, undefined);
assert.equal(handlers.session_switch, undefined);
assert.equal(handlers.turn_end, undefined);
assert.equal(lifecycleListenerCount, 0);
assert.ok(handlers.session_shutdown);
assert.ok(commands["workflow-stats"]);
assert.match(commands["workflow-stats"].description, /Explicitly start/);

const notifications: Array<{ text: string; level?: string }> = [];
const ctx = {
	hasUI: true,
	cwd: "/tmp/fake-project",
	ui: {
		notify(text: string, level?: string) {
			notifications.push({ text, level });
		},
		setWidget() {
			throw new Error("v3 must never install a Stats widget");
		},
	},
};

assert.equal(startCalls, 0, "loading the extension must not start Stats");
assert.equal(syncCalls, 0, "loading the extension must not sync Stats");

await commands["workflow-stats"].handler("", ctx);
assert.equal(startCalls, 1);
assert.equal(syncCalls, 1);
assert.deepEqual(opened, [STATS_DEFAULT_URL]);
assert.ok(notifications.some(note => note.text.includes("Starting OMP Stats")));
assert.ok(notifications.some(note => note.text.includes("OMP Stats opened")));

await handlers.session_shutdown(undefined, ctx);
assert.equal(shutdownCalls, 1);
assert.equal(status, "idle");

setStatsRuntimeForTesting(undefined);
console.log("workflow stats selftest: PASS");
console.log("  startup: no probe, spawn, sync, notification, or below-editor widget");
console.log("  dashboard: fixed copyable URL remains available in manual state");
console.log("  command: explicit start, sync, browser open, and owned shutdown");
