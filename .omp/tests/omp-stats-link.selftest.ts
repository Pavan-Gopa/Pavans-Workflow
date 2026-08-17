import assert from "node:assert/strict";
import {
	OmpStatsController,
	browserCommandCandidates,
	formatStatsPanelRow,
	formatStatsUrl,
	formatStatsWidgetLines,
	statsLaunchCommandCandidates,
	type OmpStatsContext,
	type OmpStatsProcess,
} from "../lib/omp-stats-link.ts";

assert.equal(formatStatsUrl("127.0.0.1", 3847), "http://127.0.0.1:3847");
assert.equal(formatStatsUrl("::1", 3847), "http://[::1]:3847");

const ready = { phase: "ready" as const, url: "http://127.0.0.1:3847" };
const widgetLines = formatStatsWidgetLines(ready);
assert.equal(widgetLines[1], ready.url, "the persistent widget must expose a raw clickable URL");
assert.match(widgetLines[2], /workflow-stats/);
const panelRow = formatStatsPanelRow(ready, 80);
assert.equal(panelRow.length, 80);
assert.equal(panelRow.startsWith("|"), true);
assert.equal(panelRow.endsWith("|"), true);
assert.match(panelRow, /OMP STATS/);
assert.match(panelRow, /press o/);
assert.match(panelRow, /http:\/\/127\.0\.0\.1:3847/);
assert.equal(formatStatsPanelRow(ready, 24).length, 24);

assert.deepEqual(browserCommandCandidates("darwin", ready.url), [{ command: "open", args: [ready.url] }]);
assert.equal(browserCommandCandidates("win32", ready.url)[0].command, "powershell.exe");
assert.equal(browserCommandCandidates("linux", ready.url, { WSL_DISTRO_NAME: "Ubuntu" })[0].command, "wslview");
assert.equal(browserCommandCandidates("linux", ready.url)[0].command, "xdg-open");
assert.deepEqual(statsLaunchCommandCandidates("127.0.0.1", 3847)[0], {
	command: "omp-stats",
	args: ["--port", "3847", "--host", "127.0.0.1"],
	label: "omp-stats",
});
assert.equal(statsLaunchCommandCandidates("127.0.0.1", 3847)[1].command, "omp");

const widgets: Array<string[] | undefined> = [];
const notifications: Array<{ message: string; type?: string }> = [];
const context: OmpStatsContext = {
	cwd: "/tmp/project",
	hasUI: true,
	ui: {
		notify(message, type) {
			notifications.push({ message, type });
		},
		setWidget(_key, content) {
			widgets.push(content);
		},
	},
	setTimeout(callback) {
		callback();
		return undefined;
	},
};

let dashboardReady = false;
let syncs = 0;
let stops = 0;
let changes = 0;
const launches: string[] = [];
const child: OmpStatsProcess = {
	exitCode: null,
	kill() {
		stops += 1;
		this.exitCode = 0;
	},
};
const controller = new OmpStatsController({
	platform: "linux",
	env: {},
	onChange: () => {
		changes += 1;
	},
	probeDashboard: async () => dashboardReady,
	spawnProcess(command) {
		launches.push(command);
		dashboardReady = true;
		return child;
	},
	syncDashboard: async url => {
		assert.equal(url, ready.url);
		syncs += 1;
	},
	delay: async () => {},
});

const url = await controller.start(context, true);
assert.equal(url, ready.url);
assert.deepEqual(launches, ["omp-stats"]);
assert.equal(controller.snapshot().phase, "ready");
assert.equal(widgets.at(-1)?.[1], ready.url);
assert.match(notifications.at(-1)?.message ?? "", /OMP Stats:/);
assert.ok(changes >= 2);

await controller.start(context, false);
assert.deepEqual(launches, ["omp-stats"], "ready controller must reuse its live dashboard");
await controller.sync();
assert.equal(syncs, 1);

const commands: string[] = [];
const opened = await controller.open(
	{
		async exec(command) {
			commands.push(command);
			return command === "gio"
				? { stdout: "", stderr: "", code: 0 }
				: { stdout: "", stderr: "missing opener", code: 1 };
		},
	},
	context,
);
assert.equal(opened, true);
assert.deepEqual(commands.slice(0, 2), ["xdg-open", "gio"]);
assert.match(notifications.at(-1)?.message ?? "", /Opened OMP Stats/);

await controller.shutdown(context);
assert.equal(stops, 1);
assert.equal(widgets.at(-1), undefined);
assert.equal(controller.snapshot().phase, "idle");

let fallbackReady = false;
const fallbackLaunches: string[] = [];
const fallback = new OmpStatsController({
	probeDashboard: async () => fallbackReady,
	spawnProcess(command) {
		fallbackLaunches.push(command);
		if (command === "omp-stats") return { exitCode: 1, kill() {} };
		fallbackReady = true;
		return { exitCode: null, kill() {} };
	},
	delay: async () => {},
});
assert.equal(await fallback.start(context, false), ready.url);
assert.deepEqual(fallbackLaunches, ["omp-stats", "omp"], "the OMP CLI must be the portable fallback");
await fallback.shutdown(context);

let reusedStops = 0;
const reused = new OmpStatsController({
	probeDashboard: async () => true,
	spawnProcess() {
		throw new Error("must not spawn when an OMP Stats dashboard is already live");
	},
	stopProcess() {
		reusedStops += 1;
	},
});
assert.equal(await reused.start(context, false), ready.url);
await reused.shutdown(context);
assert.equal(reusedStops, 0, "shutdown must not stop a dashboard owned by another process");

let failureLaunches = 0;
const failed = new OmpStatsController({
	probeDashboard: async () => false,
	spawnProcess() {
		failureLaunches += 1;
		throw new Error("launcher missing");
	},
	delay: async () => {},
});
assert.equal(await failed.start(context, false), undefined);
assert.equal(failed.snapshot().phase, "error");
assert.match(failed.panelRow(80), /press o to retry/);
assert.equal(await failed.start(context, false), undefined);
assert.equal(failureLaunches, 4, "a manual retry must retry both portable launchers");

console.log("OMP stats link selftest: OK");
