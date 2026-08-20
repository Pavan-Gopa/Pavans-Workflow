import assert from "node:assert/strict";
import workflowStats from "../extensions/workflow-stats.ts";
import { STATS_DEFAULT_URL, setStatsRuntimeForTesting } from "../lib/workflow-stats-runtime.ts";

let status: "idle" | "starting" | "ready" | "unavailable" = "idle";
let openCalls = 0;
let shutdownCalls = 0;
const opened: string[] = [];

const fakeController = {
	get url() {
		return STATS_DEFAULT_URL;
	},
	get snapshot() {
		return { status, url: STATS_DEFAULT_URL };
	},
	shutdown() {
		shutdownCalls += 1;
		status = "idle";
		return { status: "idle", url: STATS_DEFAULT_URL };
	},
};

setStatsRuntimeForTesting({
	controller: fakeController,
	subscribe: () => () => {},
	openInBrowser: async url => {
		openCalls += 1;
		status = "starting";
		status = "ready";
		opened.push(url ?? STATS_DEFAULT_URL);
		return true;
	},
	widgetLines: () => [],
	footerInfo: () => ({
		url: STATS_DEFAULT_URL,
		status: status === "idle" ? "manual" : status,
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
assert.match(commands["workflow-stats"].description, /native OMP Stats/i);

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

assert.equal(openCalls, 0, "loading the extension must not start or sync Stats");
await commands["workflow-stats"].handler("", ctx);
assert.equal(openCalls, 1);
assert.deepEqual(opened, [STATS_DEFAULT_URL]);
assert.ok(notifications.some(note => note.text.includes("Starting OMP Stats")));
assert.ok(notifications.some(note => note.text.includes("OMP Stats opened")));

await handlers.session_shutdown(undefined, ctx);
assert.equal(shutdownCalls, 1);
assert.equal(status, "idle");

setStatsRuntimeForTesting(undefined);
console.log("workflow stats selftest: PASS");
console.log("  startup: no probe, server, sync, notification, or below-editor widget");
console.log("  dashboard: fixed copyable URL remains available in manual state");
console.log("  command: one explicit native OMP Stats action and shutdown");
