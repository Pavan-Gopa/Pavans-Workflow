import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import workflowMainAttribution, {
	MainAttributionTracker,
	currentStepId,
	isHumanInstruction,
	mainModelKey,
	recordAttribution,
	recorderArgs,
	type AttributionDeps,
} from "../lib/workflow-main-attribution.ts";

// Model identity: provider/id, effort suffix stripped, unrecordable values rejected.
assert.equal(mainModelKey({ provider: "anthropic", id: "claude-opus-5" }), "anthropic/claude-opus-5");
assert.equal(mainModelKey({ provider: "openai", id: "gpt-5:high" }), "openai/gpt-5");
assert.equal(mainModelKey({ provider: "vertex", id: "claude-sonnet-4@20250514" }), "vertex/claude-sonnet-4@20250514");
assert.equal(mainModelKey({ id: "local-model" }), "local-model");
assert.equal(mainModelKey({ provider: "x", id: "has space" }), undefined);
assert.equal(mainModelKey({ provider: "x" }), undefined);
assert.equal(mainModelKey(undefined), undefined);

// Current step: only a real STATE.yaml step is recordable.
assert.equal(currentStepId("current_step: S30\n"), "S30");
assert.equal(currentStepId('current_step: "S3.1"\n'), "S3.1");
assert.equal(currentStepId("current_step: null\n"), undefined);
assert.equal(currentStepId("current_step: -\n"), undefined);
assert.equal(currentStepId("schema_version: 1\n"), undefined);
assert.equal(currentStepId("current_step: has space\n"), undefined);

// Human instructions to Main versus OMP UI commands.
assert.equal(isHumanInstruction("please also handle empty input"), true);
assert.equal(isHumanInstruction("/workflow next"), true);
assert.equal(isHumanInstruction("/workflow"), true);
assert.equal(isHumanInstruction("/model"), false);
assert.equal(isHumanInstruction("/workflow-stats"), false);
assert.equal(isHumanInstruction("!ls"), false);
assert.equal(isHumanInstruction("   "), false);

// Tracker: first sight and changes only; deterministic keys; failed records are retried.
const tracker = new MainAttributionTracker();
const first = tracker.planModel("S1", "anthropic/claude-opus-5");
assert.deepEqual(first, {
	event: "orchestrator_model",
	eventKey: "orchestrator_model:S1:anthropic/claude-opus-5",
	step: "S1",
	model: "anthropic/claude-opus-5",
});
assert.equal(tracker.planModel("S1", "anthropic/claude-opus-5"), undefined, "same model on the same step is not re-recorded");
assert.equal(tracker.planModel("S2", "anthropic/claude-opus-5")?.step, "S2", "first sight of another step records");
assert.equal(tracker.planModel("S1", "openai/gpt-5")?.model, "openai/gpt-5", "model change on a step records");
assert.equal(
	tracker.planModel("S3", "vertex/claude@2025")?.eventKey,
	"orchestrator_model:S3:vertex/claude_2025",
	"event keys only use recorder-legal characters",
);
tracker.rollback(first!);
assert.equal(tracker.planModel("S1", "anthropic/claude-opus-5")?.model, "anthropic/claude-opus-5");
assert.notEqual(tracker.planHumanTurn("S1", "m/x", 1).eventKey, tracker.planHumanTurn("S1", "m/x", 1).eventKey);
tracker.reset();
assert.ok(tracker.planModel("S1", "openai/gpt-5"), "reset forgets recorded models");

// recordAttribution: argument contract, no-step skip, recorder failure.
type Call = string[];
function makeDeps(stateText: string | Error, outcome: { code: number } | Error = { code: 0 }): AttributionDeps & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		tracker: new MainAttributionTracker(),
		readState: async () => {
			if (stateText instanceof Error) throw stateText;
			return stateText;
		},
		exec: async args => {
			calls.push(args);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
		now: () => 1_700_000_000_000,
	};
}

const deps = makeDeps("current_step: S7\n");
assert.equal(await recordAttribution(deps, "human_turn", "anthropic/claude-opus-5"), "recorded");
assert.deepEqual(deps.calls[0], [
	"AI_Workflow_Kit/script/workflow_metrics.sh", "record", "human_turn",
	"--event-key", "human_turn:S7:1700000000000:1", "--step", "S7", "--model", "anthropic/claude-opus-5",
]);
assert.equal(await recordAttribution(deps, "orchestrator_model", "anthropic/claude-opus-5"), "recorded");
assert.equal(await recordAttribution(deps, "orchestrator_model", "anthropic/claude-opus-5"), "skipped");
assert.equal(await recordAttribution(deps, "orchestrator_model", "openai/gpt-5"), "recorded");
assert.equal(deps.calls.length, 3);

const noStep = makeDeps("current_step: null\n");
assert.equal(await recordAttribution(noStep, "human_turn", "openai/gpt-5"), "skipped");
assert.equal(await recordAttribution(noStep, "orchestrator_model", "openai/gpt-5"), "skipped");
assert.equal(noStep.calls.length, 0, "no current step: the recorder is never started");
assert.equal(await recordAttribution(makeDeps(new Error("ENOENT")), "human_turn", "openai/gpt-5"), "skipped");
assert.equal(await recordAttribution(makeDeps("current_step: S1\n"), "human_turn", undefined), "skipped");

const flaky = makeDeps("current_step: S1\n", new Error("spawn bash ENOENT"));
assert.equal(await recordAttribution(flaky, "orchestrator_model", "openai/gpt-5"), "failed");
flaky.exec = async args => {
	flaky.calls.push(args);
	return { code: 0 };
};
assert.equal(await recordAttribution(flaky, "orchestrator_model", "openai/gpt-5"), "recorded", "a failed record is retried by the next event");
assert.equal(await recordAttribution(makeDeps("current_step: S1\n", { code: 3 }), "human_turn", "openai/gpt-5"), "failed");

// Extension wiring: Main + interactive only, detached from the event.
type Handler = (event: unknown, ctx: unknown) => unknown;
const workspace = mkdtempSync(join(tmpdir(), "wf-attribution-"));
mkdirSync(join(workspace, "AI_Workflow_Kit/docs/AI"), { recursive: true });
writeFileSync(join(workspace, "AI_Workflow_Kit/docs/AI/STATE.yaml"), "current_step: S9\n");
const handlers = new Map<string, Handler>();
const execCalls: string[][] = [];
let releaseExec: (() => void) | undefined;
const fakePi = {
	on: (name: string, handler: Handler) => void handlers.set(name, handler),
	exec: (_command: string, args: string[]) => {
		execCalls.push(args);
		return new Promise<{ code: number }>(resolve => {
			releaseExec = () => resolve({ code: 0 });
		});
	},
};
workflowMainAttribution(fakePi as never);
assert.deepEqual([...handlers.keys()].sort(), ["agent_start", "input", "session_start", "session_switch"]);
const mainCtx = {
	cwd: workspace,
	hasUI: true,
	agent: { kind: "main", id: "Main", name: "main", depth: 0 },
	models: { current: () => ({ provider: "anthropic", id: "claude-opus-5:high" }) },
	model: undefined,
};
const workerCtx = { ...mainCtx, agent: { kind: "sub", id: "0-Coder", name: "workflow-coder", depth: 1 } };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const input = handlers.get("input")!;
const agentStart = handlers.get("agent_start")!;

assert.equal(await input({ type: "input", text: "do it", source: "interactive" }, mainCtx), undefined, "input is never modified or blocked");
await settle();
assert.equal(execCalls.length, 1, "the recorder is still pending while input already returned (non-blocking)");
assert.deepEqual(execCalls[0].slice(1, 3), ["record", "human_turn"]);
assert.equal(execCalls[0][execCalls[0].indexOf("--model") + 1], "anthropic/claude-opus-5");
assert.equal(execCalls[0][execCalls[0].indexOf("--step") + 1], "S9");
releaseExec?.();

await input({ type: "input", text: "do it", source: "rpc" }, mainCtx);
await input({ type: "input", text: "do it", source: "interactive" }, workerCtx);
await input({ type: "input", text: "/model", source: "interactive" }, mainCtx);
await settle();
assert.equal(execCalls.length, 1, "rpc input, worker sessions and UI commands record nothing");

await agentStart({ type: "agent_start" }, workerCtx);
await settle();
assert.equal(execCalls.length, 1, "subagents never record Main attribution");
await agentStart({ type: "agent_start" }, mainCtx);
await settle();
assert.equal(execCalls.length, 2);
assert.deepEqual(execCalls[1].slice(1, 3), ["record", "orchestrator_model"]);
releaseExec?.();
await agentStart({ type: "agent_start" }, mainCtx);
await settle();
assert.equal(execCalls.length, 2, "an unchanged model on the same step is recorded once");
rmSync(workspace, { recursive: true, force: true });

// The arguments are accepted by the real recorder: events land in a temp project store, registry under a temp state dir.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "wf-attribution-e2e-"));
try {
	const project = join(sandbox, "demo");
	mkdirSync(project);
	execFileSync("git", ["init", "-q", project]);
	const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: join(sandbox, "state") };
	delete env.PAVAN_WORKFLOW_METRICS_PATH;
	const helper = join(repoRoot, "AI_Workflow_Kit/script/workflow_metrics.sh");
	const livePlan = new MainAttributionTracker();
	for (const plan of [
		livePlan.planHumanTurn("S9", "anthropic/claude-opus-5", 1_700_000_000_000),
		livePlan.planModel("S9", "vertex/claude-sonnet-4@20250514")!,
	]) {
		const args = recorderArgs(plan);
		execFileSync("bash", [helper, ...args.slice(1)], { cwd: project, env, stdio: "pipe" });
	}
	const store = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: project }).toString().trim();
	const lines = readFileSync(join(project, store, "pavans-workflow/metrics/events.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as { event: string; step: string; model: string });
	assert.deepEqual(lines.map(line => [line.event, line.step, line.model]), [
		["human_turn", "S9", "anthropic/claude-opus-5"],
		["orchestrator_model", "S9", "vertex/claude-sonnet-4@20250514"],
	]);
	const registry = JSON.parse(readFileSync(join(sandbox, "state/pavans-workflow/projects.json"), "utf8")) as Array<{ name: string }>;
	assert.deepEqual(registry.map(entry => entry.name), ["demo"]);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log("OK workflow-main-attribution selftest");
