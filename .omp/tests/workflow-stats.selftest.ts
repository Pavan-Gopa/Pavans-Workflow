import assert from "node:assert/strict";
import {
	browserCommands,
	defaultLaunchCandidates,
	formatStatsUrl,
	probeStatsServer,
	statsWidgetLines,
	StatsController,
	type ChildExit,
	type ChildLike,
	type FetchLike,
	type FetchResponseLike,
	type LaunchCommand,
	type StatsState,
} from "../lib/workflow-stats.ts";
import { displayWidth, parseSteps, parseWorkflowState, renderDashboard, deriveDashboardViewModel, type DashboardData, type RuntimeSnapshot } from "../lib/workflow-dashboard-core.ts";
import { setStatsRuntimeForTesting } from "../lib/workflow-stats-runtime.ts";
import workflowStats from "../extensions/workflow-stats.ts";

// ---------------------------------------------------------------------------
// URL formatting
// ---------------------------------------------------------------------------

assert.equal(formatStatsUrl("127.0.0.1", 3847), "http://127.0.0.1:3847");
assert.equal(formatStatsUrl("::1", 3847), "http://[::1]:3847");
assert.equal(formatStatsUrl("localhost", 8080), "http://localhost:8080");

// ---------------------------------------------------------------------------
// Widget lines: bare URL on its own line, all five states
// ---------------------------------------------------------------------------

const readyWidget = statsWidgetLines({ status: "ready", url: "http://127.0.0.1:3847" });
assert.deepEqual(readyWidget, ["OMP Stats · ready", "http://127.0.0.1:3847"]);
assert.deepEqual(statsWidgetLines({ status: "idle" }), []);
assert.deepEqual(statsWidgetLines({ status: "starting", url: "http://127.0.0.1:3847" }), [
	"OMP Stats · starting…",
	"http://127.0.0.1:3847",
]);
assert.deepEqual(statsWidgetLines({ status: "sync-warning", url: "http://127.0.0.1:3847", error: "sync failed: HTTP 500" }), [
	"OMP Stats · sync warning",
	"http://127.0.0.1:3847",
	"sync failed: HTTP 500",
]);
const unavailableWidget = statsWidgetLines({ status: "unavailable", error: "port busy" });
assert.deepEqual(unavailableWidget, ["OMP Stats · unavailable", "port busy"]);
assert.equal(unavailableWidget.some(line => line.includes("http")), false);

// ---------------------------------------------------------------------------
// Alt-W dashboard footer: present, width-exact, truncated on narrow terminals
// ---------------------------------------------------------------------------

const stateSource = `
current_step: WP-01
current_work_item: Wire stats panel
completed_steps: []
next_actor: coder
track: IMPLEMENTATION
onboarding:
  status: complete
`;
const stepsSource = `
## WP-01 — Wire stats panel

**Goal:** show OMP Stats in the workflow UI

**Do:**
- [ ] Ship it
`;
const statsData: DashboardData = {
	state: parseWorkflowState(stateSource),
	steps: parseSteps(stepsSource),
	sessionUsage: { totalTokens: 0, models: [] },
};
const statsRuntime: RuntimeSnapshot = { mainStatus: "idle", mainActivity: "Ready for instruction" };
const statsView = deriveDashboardViewModel(statsData, statsRuntime);
const statsFooter = { url: "http://127.0.0.1:3847", status: "ready" };

for (const width of [160, 120, 80, 46, 20]) {
	const result = renderDashboard(statsView, width, 24, 0, statsFooter);
	for (const line of result.lines) assert.equal(displayWidth(line.text), Math.max(20, width));
	const footer = result.lines[result.lines.length - 2];
	assert.match(footer.text, /OMP Stats/);
	const withoutFooter = renderDashboard(statsView, width, 24, 0);
	assert.equal(result.lines.length, withoutFooter.lines.length + 1);
}
const narrowFooter = renderDashboard(statsView, 46, 24, 0, statsFooter).lines.at(-2)?.text ?? "";
assert.match(narrowFooter, /OMP Stats/);
assert.equal(narrowFooter.startsWith("|"), true);
assert.equal(narrowFooter.endsWith("|"), true);
const wideFooter = renderDashboard(statsView, 160, 24, 0, statsFooter).lines.at(-2)?.text ?? "";
assert.match(wideFooter, /http:\/\/127\.0\.0\.1:3847/);
assert.match(wideFooter, /o open/);
assert.doesNotMatch(renderDashboard(statsView, 160, 24, 0).lines.join("\n").replace(/\n/g, " "), /OMP Stats/);

// ---------------------------------------------------------------------------
// Browser commands per platform; URL always a separate argument
// ---------------------------------------------------------------------------

const url = "http://127.0.0.1:3847";
assert.deepEqual(browserCommands("darwin", {}, url), [{ command: "open", args: [url] }]);

const linux = browserCommands("linux", {}, url);
assert.deepEqual(linux.map(entry => entry.command), ["xdg-open", "gio", "sensible-browser"]);
assert.deepEqual(linux[1].args, ["open", url]);

const wsl = browserCommands("linux", { WSL_DISTRO_NAME: "Ubuntu" }, url);
assert.deepEqual(wsl.map(entry => entry.command), ["wslview", "xdg-open", "gio", "sensible-browser"]);
assert.deepEqual(wsl[0].args, [url]);

const windows = browserCommands("win32", { SystemRoot: "C:\\WIN" }, url);
assert.equal(windows.length, 2);
assert.equal(windows[0].command, "C:\\WIN\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
assert.deepEqual(windows[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
const decoded = Buffer.from(windows[0].args[3], "base64").toString("utf16le");
assert.match(decoded, /Start-Process/);
assert.match(decoded, /http:\/\/127\.0\.0\.1:3847/);
assert.deepEqual(windows[1], { command: "cmd", args: ["/c", "start", "", url] });
for (const entry of [...linux, ...wsl, ...windows]) {
	for (const arg of entry.args) assert.equal(arg.includes("&&"), false);
}
assert.deepEqual(browserCommands("darwin", {}, "javascript:alert(1)"), []);
assert.deepEqual(browserCommands("linux", {}, "http://x/$(rm -rf ~)".replace("$", " ")), []);
assert.deepEqual(browserCommands("darwin", {}, "http://has space"), []);

// ---------------------------------------------------------------------------
// Launcher candidate order: quiet standalone first, OMP CLI fallback
// ---------------------------------------------------------------------------

assert.deepEqual(defaultLaunchCandidates(3847), [
	{ command: "omp-stats", args: ["--port", "3847"], kind: "standalone" },
	{ command: "omp", args: ["stats", "--port", "3847"], kind: "omp-cli" },
]);
assert.deepEqual(
	defaultLaunchCandidates(9000, ["omp", "/opt/omp/bin/omp"]).map(entry => entry.command),
	["omp-stats", "omp", "/opt/omp/bin/omp"],
);

// ---------------------------------------------------------------------------
// Probe contract: trusted header, no CORS, status 200
// ---------------------------------------------------------------------------

function fakeResponse(status: number, headers: Record<string, string>, body = "[]"): FetchResponseLike {
	const lower: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
	return {
		status,
		headers: { get: name => lower[name.toLowerCase()] ?? null, has: name => name.toLowerCase() in lower },
		text: async () => body,
		body: { cancel: async () => {} },
	};
}

const trustedResponse = () => fakeResponse(200, { "x-omp-stats-dashboard": "2" });
assert.equal(await probeStatsServer(async () => trustedResponse()), "reusable");
assert.equal(await probeStatsServer(async () => fakeResponse(200, {})), "occupied");
assert.equal(
	await probeStatsServer(async () => fakeResponse(200, { "x-omp-stats-dashboard": "2", "access-control-allow-origin": "*" })),
	"occupied",
);
assert.equal(await probeStatsServer(async () => fakeResponse(200, { "x-omp-stats-dashboard": "1" })), "occupied");
assert.equal(await probeStatsServer(async () => fakeResponse(500, { "x-omp-stats-dashboard": "2" })), "occupied");
assert.equal(await probeStatsServer(async () => { throw new Error("ECONNREFUSED"); }), "unreachable");

{
	const seen: string[] = [];
	await probeStatsServer(async (target: string) => {
		seen.push(target);
		return trustedResponse();
	}, "::1", 3847);
	assert.deepEqual(seen, ["http://[::1]:3847/api/stats/models"]);
}

// ---------------------------------------------------------------------------
// Controller harness: fake clock, scripted fetch, scripted children
// ---------------------------------------------------------------------------

type FakeChild = ChildLike & {
	killed: string[];
	exitWith(result: ChildExit): void;
};

function makeChild(immediateExit?: ChildExit): FakeChild {
	const { promise: waitPromise, resolve: resolveWait } = Promise.withResolvers<ChildExit>();
	const child: FakeChild = {
		pid: 4242,
		killed: [],
		kill(signal?: string) {
			child.killed.push(signal ?? "SIGTERM");
		},
		wait: () => waitPromise,
		exitWith(result: ChildExit) {
			resolveWait(result);
		},
	};
	if (immediateExit) setImmediate(() => resolveWait(immediateExit));
	return child;
}

type ProbeOutcome = "reusable" | "occupied" | "unreachable";

type Harness = {
	controller: StatsController;
	spawns: { command: string; args: string[] }[];
	children: FakeChild[];
	spawnErrors: Record<string, string>;
	readonly syncCalls: number;
	setProbes(results: ProbeOutcome[], fallback?: ProbeOutcome): void;
	setSync(behavior: "ok" | "fail" | "hang"): void;
	advance(ms: number): void;
	flush(): Promise<void>;
	holdSleep(): void;
	releaseSleep(): void;
};

function makeHarness(options?: {
	candidates?: (port: number) => LaunchCommand[];
	spawnErrors?: Record<string, string>;
	syncGate?: Promise<void>;
	immediateExit?: Record<string, ChildExit>;
}): Harness {
	let time = 0;
	const spawns: { command: string; args: string[] }[] = [];
	const children: FakeChild[] = [];
	const spawnErrors: Record<string, string> = { ...options?.spawnErrors };
	let probeScript: ProbeOutcome[] = [];
	let probeFallback: ProbeOutcome = "unreachable";
	let syncBehavior: "ok" | "fail" | "hang" = "ok";
	let syncCalls = 0;
	let sleepGate: { promise: Promise<void>; resolve: () => void } | undefined;

	const fetchImpl: FetchLike = async target => {
		if (target.includes("/api/sync")) {
			syncCalls += 1;
			if (options?.syncGate) await options.syncGate;
			if (syncBehavior === "fail") return fakeResponse(500, {});
			if (syncBehavior === "hang") throw new Error("timeout");
			return fakeResponse(200, {}, JSON.stringify({ processed: 3, files: 2, totalMessages: 100 }));
		}
		const result = probeScript.shift() ?? probeFallback;
		if (result === "reusable") return trustedResponse();
		if (result === "occupied") return fakeResponse(200, { "some-other-server": "yes" });
		throw new Error("ECONNREFUSED");
	};

	const harness: Harness = {
		controller: new StatsController({
			fetch: fetchImpl,
			spawn(command, args) {
				const error = spawnErrors[command];
				if (error) throw new Error(error);
				spawns.push({ command, args });
				const child = makeChild(options?.immediateExit?.[command]);
				children.push(child);
				return child;
			},
			launchCandidates: options?.candidates ?? defaultLaunchCandidates,
			now: () => time,
			sleep: async ms => {
				time += ms;
				// Yield to the event loop so scripted child exits and other
				// pending work interleave deterministically with the poll loop.
				await new Promise(resolve => setImmediate(resolve));
				if (sleepGate) await sleepGate.promise;
			},
			launchTimeoutMs: 5_000,
			pollIntervalMs: 100,
			syncMinIntervalMs: 1_000,
		}),
		spawns,
		children,
		spawnErrors,
		get syncCalls() {
			return syncCalls;
		},
		setProbes(results, fallback) {
			probeScript = [...results];
			probeFallback = fallback ?? results[results.length - 1] ?? "unreachable";
		},
		setSync(behavior) {
			syncBehavior = behavior;
		},
		advance(ms) {
			time += ms;
		},
		flush: async () => {
			for (let round = 0; round < 20; round++) {
				await new Promise(resolve => setImmediate(resolve));
			}
		},
		holdSleep() {
			if (!sleepGate) sleepGate = Promise.withResolvers<void>();
		},
		releaseSleep() {
			sleepGate?.resolve();
			sleepGate = undefined;
		},
	};
	return harness;
}

// ---------------------------------------------------------------------------
// Reuse: an already-running trusted server is adopted, never spawned or killed
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["reusable"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "ready");
	assert.equal(state.external, true);
	assert.equal(state.url, "http://127.0.0.1:3847");
	assert.equal(harness.spawns.length, 0);
	const again = await harness.controller.ensureStarted();
	assert.equal(again.status, "ready");
	assert.equal(harness.spawns.length, 0);
	harness.controller.shutdown();
	assert.equal(harness.children.length, 0);
	assert.equal(harness.controller.snapshot.status, "idle");
}

// ---------------------------------------------------------------------------
// Standalone launch: omp-stats becomes ready after two polls
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["unreachable", "unreachable", "reusable"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "ready");
	assert.equal(state.external, false);
	assert.deepEqual(harness.spawns, [{ command: "omp-stats", args: ["--port", "3847"] }]);
	assert.equal(harness.children.length, 1);
	// A second ensureStarted must not spawn a duplicate server.
	await harness.controller.ensureStarted();
	assert.equal(harness.spawns.length, 1);
	// Shutdown stops only the owned child.
	harness.controller.shutdown();
	assert.deepEqual(harness.children[0].killed, ["SIGTERM"]);
	assert.equal(harness.controller.snapshot.status, "idle");
	assert.equal(harness.controller.snapshot.url, undefined);
}

// ---------------------------------------------------------------------------
// Fallback: standalone missing, OMP CLI takes over
// ---------------------------------------------------------------------------

{
	const harness = makeHarness({ spawnErrors: { "omp-stats": "spawn omp-stats ENOENT" } });
	harness.setProbes(["unreachable", "unreachable", "reusable"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "ready");
	assert.deepEqual(harness.spawns, [{ command: "omp", args: ["stats", "--port", "3847"] }]);
	harness.controller.shutdown();
	assert.deepEqual(harness.children[0].killed, ["SIGTERM"]);
}

// ---------------------------------------------------------------------------
// Launch failure: every launcher fails -> unavailable with the last error
// ---------------------------------------------------------------------------

{
	const harness = makeHarness({ spawnErrors: { "omp-stats": "ENOENT", omp: "ENOENT" } });
	harness.setProbes(["unreachable"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "unavailable");
	assert.match(state.error ?? "", /omp/);
	assert.equal(harness.spawns.length, 0);
	// The target URL stays in state for retry messaging; the widget hides it.
	assert.equal(harness.controller.snapshot.url, "http://127.0.0.1:3847");
	assert.equal(statsWidgetLines(harness.controller.snapshot).some(line => line.includes("http")), false);
}

// ---------------------------------------------------------------------------
// Launch failure: child exits before the dashboard comes up -> next candidate
// ---------------------------------------------------------------------------

{
	const harness = makeHarness({ immediateExit: { "omp-stats": { ok: false, error: "exit code 1" } } });
	harness.setProbes(["unreachable", "unreachable", "unreachable", "reusable"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "ready");
	assert.deepEqual(harness.spawns.map(entry => entry.command), ["omp-stats", "omp"]);
	harness.controller.shutdown();
}

// ---------------------------------------------------------------------------
// Foreign process on the port before launch: refuse, do not spawn
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["occupied"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "unavailable");
	assert.match(state.error ?? "", /untrusted/);
	assert.equal(harness.spawns.length, 0);
}

// ---------------------------------------------------------------------------
// Unsafe CORS responder appearing mid-launch: kill own child, refuse reuse
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["unreachable", "occupied"]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "unavailable");
	assert.match(state.error ?? "", /trusted OMP Stats headers/);
	assert.equal(harness.spawns.length, 1);
	assert.deepEqual(harness.children[0].killed, ["SIGTERM"]);
}

// ---------------------------------------------------------------------------
// Launch timeout: never becomes reachable -> unavailable, child killed
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes([]);
	const state = await harness.controller.ensureStarted();
	assert.equal(state.status, "unavailable");
	assert.match(state.error ?? "", /timed out/);
	assert.deepEqual(harness.children.map(child => child.killed), [["SIGTERM"], ["SIGTERM"]]);
}

// ---------------------------------------------------------------------------
// Manual retry after failure succeeds once the launcher works
// ---------------------------------------------------------------------------

{
	const harness = makeHarness({ spawnErrors: { "omp-stats": "ENOENT", omp: "ENOENT" } });
	harness.setProbes(["unreachable"]);
	assert.equal((await harness.controller.ensureStarted()).status, "unavailable");
	// Repair the environment, then retry manually: the launcher works now.
	delete harness.spawnErrors["omp-stats"];
	delete harness.spawnErrors.omp;
	harness.setProbes(["unreachable", "reusable"]);
	const state = await harness.controller.ensureStarted(true);
	assert.equal(state.status, "ready");
	assert.equal(harness.spawns.length, 1);
	harness.controller.shutdown();
}

// ---------------------------------------------------------------------------
// Owned child dying after ready flips state to unavailable
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["unreachable", "reusable"]);
	await harness.controller.ensureStarted();
	harness.children[0].exitWith({ ok: false, error: "crashed" });
	await harness.flush();
	const snapshot = harness.controller.snapshot;
	assert.equal(snapshot.status, "unavailable");
	assert.match(snapshot.error ?? "", /crashed/);
	// Restart spawns a fresh server.
	harness.setProbes(["unreachable", "reusable"]);
	const restarted = await harness.controller.ensureStarted(true);
	assert.equal(restarted.status, "ready");
	assert.equal(harness.spawns.length, 2);
	harness.controller.shutdown();
}

// ---------------------------------------------------------------------------
// Sync: success records summary; failure downgrades to sync-warning
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["reusable"]);
	await harness.controller.ensureStarted();
	const synced = await harness.controller.requestSync(true);
	assert.equal(synced.status, "ready");
	assert.equal(synced.lastSyncSummary, "Synced 3 new entries from 2 files (100 total)");
	assert.equal(harness.syncCalls, 1);
	assert.notEqual(synced.lastSyncAt, undefined);

	harness.setSync("fail");
	harness.advance(5_000);
	const warned = await harness.controller.requestSync(true);
	assert.equal(warned.status, "sync-warning");
	assert.match(warned.error ?? "", /sync failed/);

	harness.setSync("ok");
	const healed = await harness.controller.requestSync(true);
	assert.equal(healed.status, "ready");
	assert.equal(healed.error, undefined);
}

// ---------------------------------------------------------------------------
// Sync coalescing: concurrent requests collapse to one extra run
// ---------------------------------------------------------------------------

{
	let releaseSync!: () => void;
	const gate = new Promise<void>(resolve => {
		releaseSync = resolve;
	});
	const harness = makeHarness({ syncGate: gate });
	harness.setProbes(["reusable"]);
	await harness.controller.ensureStarted();
	const first = harness.controller.requestSync(true);
	await harness.flush();
	const second = harness.controller.requestSync(true);
	const third = harness.controller.requestSync(true);
	assert.equal(harness.syncCalls, 1);
	releaseSync();
	await Promise.all([first, second, third]);
	// One in-flight run plus at most one queued re-run — never three.
	assert.ok(harness.syncCalls <= 2, `expected at most 2 sync calls, saw ${harness.syncCalls}`);
}

// ---------------------------------------------------------------------------
// Sync throttle: lifecycle requests are rate-limited; force bypasses
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["reusable"]);
	await harness.controller.ensureStarted();
	await harness.controller.requestSync(true);
	assert.equal(harness.syncCalls, 1);
	await harness.controller.requestSync();
	assert.equal(harness.syncCalls, 1, "throttled request must not refetch");
	await harness.controller.requestSync(true);
	assert.equal(harness.syncCalls, 2, "forced request bypasses the throttle");
	harness.advance(5_000);
	await harness.controller.requestSync();
	assert.equal(harness.syncCalls, 3, "throttle expires over time");
	// Sync is skipped entirely when the server is not ready.
	const down = makeHarness();
	await down.controller.requestSync(true);
	assert.equal(down.syncCalls, 0);
}

// ---------------------------------------------------------------------------
// Shutdown preserves external servers and blocks stale startup work
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["reusable"]);
	await harness.controller.ensureStarted();
	assert.equal(harness.controller.snapshot.external, true);
	harness.controller.shutdown();
	assert.equal(harness.children.length, 0, "external server must not be killed");
	assert.equal(harness.controller.snapshot.status, "idle");
}

{
	const harness = makeHarness();
	harness.setProbes([], "unreachable");
	harness.holdSleep();
	const starting = harness.controller.ensureStarted();
	await harness.flush();
	assert.equal(harness.children.length, 1, "launch must be in flight before shutdown");
	harness.controller.shutdown();
	harness.releaseSleep();
	await starting;
	assert.equal(harness.controller.snapshot.status, "idle");
	assert.deepEqual(harness.children[0].killed, ["SIGTERM"], "in-flight launch must be killed on shutdown");
}

// ---------------------------------------------------------------------------
// onChange observer sees every transition (widget/dashboard redraw hook)
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	const transitions: string[] = [];
	harness.controller.onChange = state => transitions.push(state.status);
	harness.setProbes(["unreachable", "reusable"]);
	await harness.controller.ensureStarted();
	await harness.controller.requestSync(true);
	harness.controller.shutdown();
	assert.deepEqual(transitions, ["starting", "ready", "ready", "idle"]);
}

// ---------------------------------------------------------------------------
// Extension wiring: registration, widget lifecycle, command flow (headless)
// ---------------------------------------------------------------------------

{
	const harness = makeHarness();
	harness.setProbes(["unreachable", "reusable"]);
	const listeners = new Set<(state: StatsState) => void>();
	const openedUrls: string[] = [];
	harness.controller.onChange = state => {
		for (const listener of [...listeners]) listener(state);
	};
	setStatsRuntimeForTesting({
		controller: harness.controller,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		openInBrowser: async url => {
			openedUrls.push(url);
			return true;
		},
		widgetLines: () => statsWidgetLines(harness.controller.snapshot),
		footerInfo: () => {
			const snapshot = harness.controller.snapshot;
			if (snapshot.status === "idle") return undefined;
			return { url: snapshot.status === "unavailable" ? undefined : snapshot.url, status: snapshot.status };
		},
	});

	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
	const eventHandlers: Record<string, (data: unknown) => void> = {};
	const commands: Record<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const fakePi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
			handlers[event] = handler;
		},
		events: {
			on: (event: string, handler: (data: unknown) => void) => {
				eventHandlers[event] = handler;
			},
		},
		registerCommand: (name: string, definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = definition;
		},
	};
	workflowStats(fakePi as never);
	assert.ok(handlers["session_start"], "session_start handler registered");
	assert.ok(handlers["session_switch"], "session_switch handler registered");
	assert.ok(handlers["turn_end"], "turn_end handler registered");
	assert.ok(handlers["session_shutdown"], "session_shutdown handler registered");
	assert.ok(commands["workflow-stats"], "/workflow-stats command registered");

	const widgets: Record<string, string[] | undefined> = {};
	const notifications: { text: string; level?: string }[] = [];
	const fakeCtx = {
		hasUI: true,
		cwd: "/tmp/fake-project",
		ui: {
			setWidget: (key: string, content?: string[]) => {
				widgets[key] = content;
			},
			notify: (text: string, level?: string) => {
				notifications.push({ text, level });
			},
		},
	};

	await handlers["session_start"](undefined, fakeCtx);
	assert.ok(eventHandlers["task:subagent:lifecycle"], "subagent lifecycle listener installed on session_start");
	await harness.controller.ensureStarted();
	await harness.flush();
	assert.deepEqual(widgets["workflow-stats"], ["OMP Stats · ready", "http://127.0.0.1:3847"]);
	assert.ok(notifications.some(note => note.text.includes("http://127.0.0.1:3847")), "startup notification carries the URL");

	await handlers["turn_end"](undefined, fakeCtx);
	assert.ok(harness.syncCalls >= 1, "turn end requests a sync");
	eventHandlers["task:subagent:lifecycle"]({ status: "completed" });
	await harness.flush();

	await commands["workflow-stats"].handler("", fakeCtx);
	assert.deepEqual(openedUrls, ["http://127.0.0.1:3847"], "command opens the stats URL in the browser");
	assert.ok(notifications.some(note => note.text.includes("opened in your browser")), "command reports success");

	await handlers["session_shutdown"](undefined, fakeCtx);
	assert.equal(widgets["workflow-stats"], undefined, "widget cleared on shutdown");
	assert.equal(harness.controller.snapshot.status, "idle");
	assert.deepEqual(harness.children[0].killed, ["SIGTERM"], "owned server stopped on shutdown");
	setStatsRuntimeForTesting(undefined);
}

console.log("workflow stats selftest: PASS");
console.log("  url: IPv4/IPv6 formatting and probe targeting");
console.log("  widget: bare URL line across all five states");
console.log("  dashboard footer: width-exact at 160/120/80/46/20 columns");
console.log("  browser: macOS/Linux/Windows/WSL commands, no shell interpolation");
console.log("  launch: standalone, OMP CLI fallback, reuse, timeout, crash restart");
console.log("  safety: foreign port holder and unsafe CORS responder refused");
console.log("  sync: summary, warning, heal, coalescing, throttle");
console.log("  lifecycle: owned shutdown, external preserved, stale startup killed");
console.log("  extension: registration, widget lifecycle, /workflow-stats command flow");
