// Runtime smoke test (CI only, Bun): run the workflow-guard extension inside a
// real OMP session with a scripted mock model. Main spawns `workflow-coder`,
// the worker tries an out-of-scope write, a git commit, an in-scope write, and
// a shell write; the guard must block the first two inside the worker session
// and report a clean verdict to Main.
//
//   bun ci/omp_runtime_guard.ts        (needs the pinned OMP in ./node_modules)
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "wf-omp-runtime-"));
const project = join(work, "project");
process.env.HOME = join(work, "home");
process.env.PYTHONDONTWRITEBYTECODE = "1";
delete process.env.WF_GUARD_MODE;

function fail(message: string): never {
	console.error(`FAIL omp runtime guard: ${message}`);
	process.exit(1);
}
function check(condition: unknown, message: string): void {
	if (!condition) fail(message);
}
function git(...args: string[]): string {
	return execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
}
function write(rel: string, text: string): void {
	mkdirSync(dirname(join(project, rel)), { recursive: true });
	writeFileSync(join(project, rel), text);
}
const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

mkdirSync(join(project, "AI_Workflow_Kit", "script"), { recursive: true });
mkdirSync(process.env.HOME, { recursive: true });
git("init", "-q");
git("config", "user.email", "ci@example.com");
git("config", "user.name", "ci");
copyFileSync(join(repo, "AI_Workflow_Kit/script/workflow_guard.py"), join(project, "AI_Workflow_Kit/script/workflow_guard.py"));
mkdirSync(join(project, ".omp", "extensions"), { recursive: true });
copyFileSync(join(repo, ".omp/extensions/workflow-guard.ts"), join(project, ".omp/extensions/workflow-guard.ts"));
cpSync(join(repo, ".omp/lib"), join(project, ".omp/lib"), { recursive: true });
write(".omp/config.yml", "modelRoles:\n  default: mockp/m\n  task: mockp/m\n");
write(".omp/agents/workflow-coder.md", '---\nname: workflow-coder\ndescription: runtime test coder\ntools: ["read", "bash", "edit", "write"]\n---\nWORKER-MARKER\n');
write("AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: S1\ntarget_files:\n  - src/feature/\n");
write("AI_Workflow_Kit/installed.manifest", "runtime test\n");
write("src/feature/a.ts", "export const a = 1\n");
write("src/other.ts", "export const other = 1\n");
git("add", "-A");
git("commit", "-qm", "base");
const baseHead = git("rev-parse", "HEAD").trim();

const workerResults: string[] = [];
registerMockApi();
const mock = createMockModel({
	handler: (context: any) => {
		const isWorker = text(context.systemPrompt).includes("WORKER-MARKER");
		const results = (context.messages ?? []).filter((message: any) => message.role === "toolResult");
		if (isWorker) {
			if (results.length) workerResults.push(text(results[results.length - 1].content));
			const steps = [
				{ name: "write", arguments: { path: "src/other.ts", content: "export const other = 'coder'\n" } },
				{ name: "bash", arguments: { command: "git add -A && git commit -qm worker-commit" } },
				{ name: "write", arguments: { path: "src/feature/a.ts", content: "export const a = 2\n" } },
				{ name: "bash", arguments: { command: "echo generated > src/feature/gen.txt" } },
				{ name: "yield", arguments: { data: "done" } },
			];
			const step = steps[Math.min(results.length, steps.length - 1)];
			return { content: [{ type: "toolCall", ...step }] };
		}
		if (results.length === 0) {
			return { content: [{ type: "toolCall", name: "task", arguments: { agent: "workflow-coder", task: "Edit files.", solutionSpace: "src/feature" } }] };
		}
		return { content: ["ok"] };
	},
});

const agentDir = join(process.env.HOME, ".omp", "agent");
const modelRegistry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"), {} as never);
modelRegistry.registerProvider("mockp", {
	api: "mockp-api",
	apiKey: "x",
	baseUrl: "mock://",
	streamSimple: (model: any, context: any, options: any) => mock.stream(model, context, options),
	models: [{ id: "m", name: "m", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }],
} as never);
const model = modelRegistry.find("mockp", "m");
check(model, "mock model not registered");

const { session } = await createAgentSession({ cwd: project, model: model as never, modelRegistry, hasUI: false, enableMCP: false, enableLsp: false, skipPythonPreflight: true } as never);
const errors: string[] = [];
await initializeExtensions(session as never, {
	reportSendError: (_action, error) => errors.push(String(error)),
	reportRuntimeError: error => errors.push(text(error)),
});

const guardDir = () => join(project, git("rev-parse", "--git-common-dir").trim(), "pavans-workflow", "guard");
const verdicts = () => {
	try {
		return readdirSync(guardDir()).filter(name => name.endsWith(".verdict.json"));
	} catch {
		return [];
	}
};

await session.prompt("start");
for (let attempt = 0; attempt < 200 && verdicts().length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
await new Promise(resolve => setTimeout(resolve, 500));
await session.prompt("continue");

try {
	check(errors.length === 0, `extension errors: ${errors.join("; ")}`);
	check(workerResults[0]?.includes("WORKFLOW GUARD blocked") && workerResults[0].includes("src/other.ts"), `out-of-scope write not blocked: ${workerResults[0]}`);
	check(workerResults[1]?.includes("WORKFLOW GUARD blocked") && workerResults[1].includes("git add -A"), `git state change not blocked: ${workerResults[1]}`);
	check(!workerResults[2]?.includes("WORKFLOW GUARD"), `in-scope write was blocked: ${workerResults[2]}`);
	check(git("rev-parse", "HEAD").trim() === baseHead, "the worker committed");
	check(readFileSync(join(project, "src/other.ts"), "utf8") === "export const other = 1\n", "blocked write changed src/other.ts");
	check(readFileSync(join(project, "src/feature/a.ts"), "utf8") === "export const a = 2\n", "in-scope write did not land");
	check(verdicts().length === 1, `expected one verdict, got ${verdicts().length}`);
	const verdict = JSON.parse(readFileSync(join(guardDir(), verdicts()[0]), "utf8"));
	check(verdict.verdict === "clean" && verdict.agent === "workflow-coder", `verdict: ${text(verdict)}`);
	check(text(verdict.changed) === text(["src/feature/a.ts"]), `changed: ${text(verdict.changed)}`);
	check(verdict.blocked?.length === 2, `blocked: ${text(verdict.blocked)}`);
	check(text(verdict.shell_suspects) === text(["src/feature/gen.txt"]), `shell_suspects: ${text(verdict.shell_suspects)}`);
	const note = (session.state.messages as any[]).find(message => message.customType === "workflow-guard");
	check(note && text(note.content).includes("Not a violation"), "Main did not receive the guard note");
	console.log("OK   omp runtime: guard blocks inside a real workflow-coder session and reports a clean verdict to Main");
} finally {
	rmSync(work, { recursive: true, force: true });
}
process.exit(0);
