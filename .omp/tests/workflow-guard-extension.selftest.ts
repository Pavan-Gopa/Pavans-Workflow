// Wiring test: drives the real workflow-guard extension through a fake OMP API
// against a temporary git repository and the real workflow_guard.py.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import workflowGuard from "../extensions/workflow-guard.ts";

type Handler = (event: any, ctx: any) => Promise<any> | any;

const here = dirname(fileURLToPath(import.meta.url));
const guardScript = join(here, "..", "..", "AI_Workflow_Kit", "script", "workflow_guard.py");
const project = mkdtempSync(join(tmpdir(), "wf-guard-ext-"));
const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
delete env.WF_GUARD_MODE;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", env });
}

function write(rel: string, text: string): void {
	mkdirSync(dirname(join(project, rel)), { recursive: true });
	writeFileSync(join(project, rel), text);
}

try {
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	mkdirSync(join(project, "AI_Workflow_Kit", "script"), { recursive: true });
	copyFileSync(guardScript, join(project, "AI_Workflow_Kit", "script", "workflow_guard.py"));
	write("AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S1\ntarget_files:\n  - src/feature/\n");
	write("AI_Workflow_Kit/installed.manifest", "x\n");
	write("src/feature/a.ts", "export const a = 1\n");
	write("src/other.ts", "export const other = 1\n");
	git("add", "-A");
	git("commit", "-qm", "base");

	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Array<(data: unknown) => void>>();
	const messages: Array<{ content: string; details: any }> = [];
	const notices: string[] = [];
	const warnings: string[] = [];
	let execCalls = 0;
	let pythonMissing = false;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			on(channel: string, callback: (data: unknown) => void) {
				channels.set(channel, [...(channels.get(channel) ?? []), callback]);
			},
		},
		async exec(command: string, args: string[], options: { cwd: string }) {
			execCalls++;
			if (pythonMissing && command === "python3") throw new Error('Executable not found in $PATH: "python3"');
			const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env });
			return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
		sendMessage(message: { content: string; details: any }) {
			messages.push(message);
		},
		logger: { warn: (text: string) => warnings.push(text) },
	};
	workflowGuard(pi as never);

	const emit = async (event: string, payload: unknown, ctx: unknown) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result as { block?: boolean; reason?: string } | undefined;
	};
	const lifecycle = (payload: unknown) => {
		for (const callback of channels.get("task:subagent:lifecycle") ?? []) callback(payload);
	};
	const until = async (check: () => boolean, label: string) => {
		for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
		assert.ok(check(), `timed out waiting for ${label}`);
	};
	const guardFiles = (suffix: string) => {
		const common = git("rev-parse", "--git-common-dir").trim();
		const directory = join(project, common, "pavans-workflow", "guard");
		return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(suffix)) : [];
	};

	const ui = { notify: (text: string) => notices.push(text) };
	const main = { agent: { kind: "main", id: "Main", name: "main", depth: 0 }, hasUI: true, cwd: project, ui };
	const coder = { agent: { kind: "sub", id: "0-WorkflowCoder", name: "workflow-coder", depth: 1 }, hasUI: false, cwd: project, ui };
	const scout = { agent: { kind: "sub", id: "1-Scout", name: "scout", depth: 1 }, hasUI: false, cwd: project, ui };

	await emit("session_start", {}, main);

	// OMP's own helpers are not snapshotted and never judged.
	assert.equal(await emit("before_subagent_spawn", { agent: "scout", spawnKey: "job-0" }, main), undefined);
	assert.equal(guardFiles(".snapshot.json").length, 0, "no snapshot for scout");
	const before = execCalls;
	assert.equal(await emit("tool_call", { toolName: "edit", toolCallId: "s1", input: { path: "src/other.ts" } }, scout), undefined);
	assert.equal(execCalls, before, "scout tool calls are not even checked");

	// A backup worker without recorded failure authorization is refused at spawn.
	const refused = await emit("before_subagent_spawn", { agent: "workflow-coder-backup" }, main);
	assert.equal(refused?.block, true);

	// Coder run.
	assert.equal(await emit("before_subagent_spawn", { agent: "workflow-coder", spawnKey: "job-1" }, main), undefined);
	assert.equal(guardFiles(".snapshot.json").length, 1);
	lifecycle({ id: "0-WorkflowCoder", agent: "workflow-coder", status: "started" });

	assert.equal(await emit("tool_call", { toolName: "edit", toolCallId: "c1", input: { path: "src/feature/a.ts" } }, coder), undefined);
	write("src/feature/a.ts", "export const a = 2\n");
	const outOfScope = await emit("tool_call", { toolName: "write", toolCallId: "c2", input: { path: "src/other.ts", content: "x" } }, coder);
	assert.equal(outOfScope?.block, true);
	assert.match(outOfScope?.reason ?? "", /src\/other\.ts — outside target_files for coder/);
	const workflowFile = await emit("tool_call", { toolName: "edit", toolCallId: "c3", input: { input: "[AI_Workflow_Kit/docs/AI/STATE.yaml#abcd]\n" } }, coder);
	assert.equal(workflowFile?.block, true, "hashline edits of workflow files are blocked");
	const commit = await emit("tool_call", { toolName: "bash", toolCallId: "c4", input: { command: "npm test && git commit -am wip" } }, coder);
	assert.equal(commit?.block, true);
	assert.match(commit?.reason ?? "", /git commit -am wip/);
	const callsBefore = execCalls;
	assert.equal(await emit("tool_call", { toolName: "bash", toolCallId: "c5", input: { command: "npm test" } }, coder), undefined);
	assert.equal(execCalls, callsBefore, "ordinary shell commands cost nothing");

	// Where a git command runs decides: the project's repository is blocked, fixtures are not.
	const subdir = await emit("tool_call", { toolName: "bash", toolCallId: "c6", input: { command: "cd src/feature && git add a.ts" } }, coder);
	assert.equal(subdir?.block, true, "a subfolder is still the project's repository");
	const fixtureCwd = await emit(
		"tool_call",
		{ toolName: "bash", toolCallId: "c7", input: { command: "git init -q . && git commit -q --allow-empty -m base", cwd: join(project, "..", "wf-fixture-elsewhere") } },
		coder,
	);
	assert.equal(fixtureCwd, undefined, "the bash tool's cwd argument points at another repository");
	mkdirSync(join(project, "tests", "fixtures", "repo"), { recursive: true });
	execFileSync("git", ["init", "-q", join(project, "tests", "fixtures", "repo")], { env });
	const nested = await emit("tool_call", { toolName: "bash", toolCallId: "c8", input: { command: "git -C tests/fixtures/repo commit -q --allow-empty -m x" } }, coder);
	assert.equal(nested, undefined, "a nested fixture repository is not the project");
	rmSync(join(project, "tests"), { recursive: true, force: true });

	await emit("tool_execution_start", { toolName: "bash", toolCallId: "c5" }, coder);
	write("src/feature/generated.ts", "export {}\n"); // written while the worker's shell ran
	await emit("tool_execution_end", { toolName: "bash", toolCallId: "c5" }, coder);

	// Meanwhile: Main edits and commits its state, a parallel session edits product code.
	await new Promise(resolve => setTimeout(resolve, 1_700));
	assert.equal(await emit("tool_call", { toolName: "edit", toolCallId: "m1", input: { path: "AI_Workflow_Kit/docs/AI/STATE.yaml" } }, main), undefined);
	write("AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S1\ntarget_files:\n  - src/feature/\nnote: main\n");
	git("commit", "-qm", "Main checkpoint", "--", "AI_Workflow_Kit/docs/AI/STATE.yaml");
	write("src/other.ts", "export const other = 'parallel session'\n");

	lifecycle({ id: "0-WorkflowCoder", agent: "workflow-coder", status: "completed" });
	await until(() => messages.length > 0, "guard message");
	const [message] = messages;
	assert.equal(message.details.verdict, "clean", JSON.stringify(message.details));
	assert.deepEqual(message.details.changed, ["src/feature/a.ts"]);
	assert.deepEqual(message.details.shell_suspects, ["src/feature/generated.ts"]);
	assert.ok(message.details.unattributed.includes("src/other.ts"), "the parallel session's edit is not the worker's");
	assert.equal(message.details.blocked.length, 4);
	assert.match(message.content, /Not a violation/);
	assert.doesNotMatch(message.content, /Do not accept/);
	assert.equal(warnings.length, 0, "guard ran without degradation");
	assert.ok(!notices.some(text => /unavailable/.test(text)));

	// lsp edits by a read-only role are blocked like edit/write.
	const reviewerCtx = { agent: { kind: "sub", id: "3-WorkflowReviewer", name: "workflow-reviewer", depth: 1 }, hasUI: false, cwd: project, ui };
	const lspRename = await emit("tool_call", { toolName: "lsp", toolCallId: "l1", input: { action: "rename", file: "src/other.ts", symbol: "other", new_name: "x" } }, reviewerCtx);
	assert.equal(lspRename?.block, true);
	assert.equal(await emit("tool_call", { toolName: "lsp", toolCallId: "l2", input: { action: "references", file: "src/other.ts" } }, reviewerCtx), undefined);

	// A broken guard (python3 missing) fails open with one warning; it never blocks work.
	pythonMissing = true;
	assert.equal(await emit("tool_call", { toolName: "write", toolCallId: "p1", input: { path: "src/other.ts", content: "x" } }, coder), undefined);
	assert.equal(await emit("before_subagent_spawn", { agent: "workflow-tester", spawnKey: "job-p" }, main), undefined);
	assert.ok(warnings.some(text => text.includes("python3")), "degradation is logged");
	assert.ok(notices.some(text => /Workflow guard unavailable/.test(text)), "and shown once");
	pythonMissing = false;
	warnings.length = 0;

	// Mode off: no snapshot, nothing blocked.
	execFileSync("python3", [join(project, "AI_Workflow_Kit", "script", "workflow_guard.py"), "mode", "off"], { cwd: project, env });
	const snapshots = guardFiles(".snapshot.json").length;
	await emit("before_subagent_spawn", { agent: "workflow-reviewer", spawnKey: "job-2" }, main);
	assert.equal(guardFiles(".snapshot.json").length, snapshots);
	const reviewer = { agent: { kind: "sub", id: "2-WorkflowReviewer", name: "workflow-reviewer", depth: 1 }, hasUI: false, cwd: project, ui };
	assert.equal(await emit("tool_call", { toolName: "edit", toolCallId: "r1", input: { path: "src/other.ts" } }, reviewer), undefined);
	assert.equal(warnings.length, 0, "mode off is not a degradation");

	console.log("OK workflow guard extension wiring selftest");
} finally {
	rmSync(project, { recursive: true, force: true });
}
