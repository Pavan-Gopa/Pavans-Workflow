// Pure decision logic for the workflow-guard extension. Dependency-free so the
// selftest runs without OMP. The extension wires these into OMP hooks:
//   before_subagent_spawn   -> backup authorization + guard snapshot for workflow workers
//   task:subagent:lifecycle -> bind on `started` (snapshot follow-up turns), verify on finish
//   tool_call (worker)      -> `allow` before every edit/write and git state change: out-of-scope
//                              actions are blocked before they run, allowed edits are recorded
//   tool_execution_* (worker bash) -> time windows used to flag files the worker's shell changed
//   tool_call (Main)        -> remember Main's own edits so they are not listed against the worker

import { normalizeRole, parseWorkflowState } from "./workflow-dashboard-core.ts";

export const GUARD_SCRIPT = "AI_Workflow_Kit/script/workflow_guard.py";
export const GUARD_MESSAGE_TYPE = "workflow-guard";
export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "cancelled", "canceled", "error"]);

export function isWorkflowAgent(agent: string | undefined): boolean {
	return Boolean(agent && /^workflow[-_]/i.test(agent));
}

export function isBackupAgent(agent: string | undefined): boolean {
	return Boolean(agent && /[-_]backup$/i.test(agent));
}

type AgentIdentity = { kind: string; id?: string; name?: string };

/**
 * The guard extension also runs inside every worker session. Main is the
 * top-level session in every mode (TUI, RPC, print); `hasUI` only says whether
 * a UI is attached, so it decides only on hosts without agent identity.
 */
export function isMainSession(agent: AgentIdentity | undefined, hasUI: boolean): boolean {
	return agent ? agent.kind === "main" : hasUI;
}

/** A session running one of the workflow's own worker roles (not OMP's scout/explore/task). */
export function isWorkerSession(agent: AgentIdentity | undefined): agent is AgentIdentity & { name: string; id: string } {
	return Boolean(agent && agent.kind === "sub" && typeof agent.id === "string" && isWorkflowAgent(agent.name));
}

/** Guard role for a workflow agent name; anything else is "unknown" (and not guarded). */
export function guardRole(agent: string): string {
	if (!isWorkflowAgent(agent)) return "unknown";
	const role = normalizeRole(agent)?.replace(/-/g, "_");
	return role ?? "unknown";
}

export type BackupDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * A `-backup` worker may start only after the Human authorized it and Main
 * recorded that in STATE.yaml (TEAM_CONTRACT: automatic backup selection is
 * forbidden). Enforced in code at spawn time, not by prompt.
 */
export function backupAuthorization(stateText: string, agent: string): BackupDecision {
	if (!isBackupAgent(agent)) return { allowed: true };
	const state = parseWorkflowState(stateText);
	const recordedAgent = state.modelFailureBackupAgent === "-" ? "" : state.modelFailureBackupAgent;
	const canonical = (value: string | undefined) => value?.replace(/_/g, "-");
	const recordedRole = canonical(normalizeRole(state.modelFailureRole === "-" ? undefined : state.modelFailureRole));
	const role = canonical(normalizeRole(agent));
	const matches = recordedAgent ? recordedAgent === agent : Boolean(recordedRole && recordedRole === role);
	if (state.modelFailureStatus === "backup_authorized" && matches) return { allowed: true };
	return {
		allowed: false,
		reason:
			`${agent} needs explicit Human authorization. Record the primary failure and the Human's words in STATE.yaml ` +
			`(omp.model_failure.status: backup_authorized, backup_agent: ${agent}, human_instruction: "...") before dispatch.`,
	};
}

type OpenSnapshot = { snapshotId: string; agent: string; spawnKey?: string; runId?: string; openedAt: number };

/**
 * Open guard snapshots. A snapshot is taken at spawn time (keyed by OMP's
 * spawnKey, which equals the async job id), bound to the worker's lifecycle id
 * on `started`, and verified on the terminal lifecycle event. Workers woken
 * again with `agent://<id>` (no spawn hook) get a snapshot on `started`.
 */
export class GuardTracker {
	#open: OpenSnapshot[] = [];
	#mainTouched = new Set<string>();

	open(agent: string, snapshotId: string, spawnKey?: string, now = Date.now()): void {
		this.#open.push({ snapshotId, agent, spawnKey, openedAt: now });
	}

	/**
	 * Bind a started worker to its snapshot. Returns true when a snapshot is
	 * bound, false when the caller must take one (follow-up turn). Older unbound
	 * snapshots of the same agent belong to spawns that never started (aborted
	 * or blocked before running) and are dropped.
	 */
	bind(runId: string, agent: string): boolean {
		if (this.#open.some(entry => entry.runId === runId)) return true;
		const byKey = this.#open.find(entry => !entry.runId && entry.spawnKey === runId);
		const candidates = this.#open.filter(entry => !entry.runId && entry.agent === agent);
		const chosen = byKey ?? candidates[candidates.length - 1];
		if (!chosen) return false;
		chosen.runId = runId;
		this.#open = this.#open.filter(entry => entry === chosen || entry.runId || entry.agent !== agent || entry.openedAt > chosen.openedAt);
		return true;
	}

	/** Snapshot of a running worker (its lifecycle id equals the worker session's agent id). */
	snapshotFor(runId: string | undefined): string | undefined {
		return runId === undefined ? undefined : this.#open.find(entry => entry.runId === runId || entry.spawnKey === runId)?.snapshotId;
	}

	/** Snapshot to verify for a finished run (bound id, then spawn key, then oldest of the agent). */
	close(runId: string | undefined, agent: string): string | undefined {
		const index = [
			this.#open.findIndex(entry => runId !== undefined && entry.runId === runId),
			this.#open.findIndex(entry => runId !== undefined && !entry.runId && entry.spawnKey === runId),
			this.#open.findIndex(entry => !entry.runId && entry.agent === agent),
		].find(value => value >= 0);
		if (index === undefined) return undefined;
		const [entry] = this.#open.splice(index, 1);
		return entry.snapshotId;
	}

	active(): boolean {
		return this.#open.length > 0;
	}

	recordMainEdit(path: string | undefined): void {
		if (path && this.active()) this.#mainTouched.add(path);
	}

	/** Paths Main edited while workers ran; cleared once no worker remains open. */
	takeMainEdits(): string[] {
		const paths = [...this.#mainTouched];
		if (!this.active()) this.#mainTouched.clear();
		return paths;
	}
}

/**
 * When each worker's shell commands ran. A file whose mtime falls inside one
 * of these windows was probably written by that shell command; the guard lists
 * it for Main (`shell_suspects`) without calling it a violation, because a
 * parallel session may have written it at the same moment.
 */
export class ShellWindows {
	#running = new Map<string, { runId: string; start: number }>();
	#done = new Map<string, Array<[number, number]>>();

	start(runId: string, callId: string, now = Date.now()): void {
		this.#running.set(callId, { runId, start: now });
	}

	end(callId: string, now = Date.now()): void {
		const entry = this.#running.get(callId);
		if (!entry) return;
		this.#running.delete(callId);
		const list = this.#done.get(entry.runId) ?? [];
		list.push([entry.start, now]);
		this.#done.set(entry.runId, list);
	}

	/** Merged windows of a finished run (commands still running end now), then forgotten. */
	take(runId: string | undefined, now = Date.now()): Array<[number, number]> {
		if (runId === undefined) return [];
		const windows = [...(this.#done.get(runId) ?? [])];
		for (const [callId, entry] of this.#running) {
			if (entry.runId !== runId) continue;
			windows.push([entry.start, now]);
			this.#running.delete(callId);
		}
		this.#done.delete(runId);
		windows.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const window of windows) {
			const last = merged[merged.length - 1];
			if (last && window[0] <= last[1] + 2_000) last[1] = Math.max(last[1], window[1]);
			else merged.push([window[0], window[1]]);
		}
		return merged;
	}
}

const HASHLINE_HEADER = /^\[(.+?)(?:#[0-9A-Fa-f]{4})?\]\s*$/;
const HASHLINE_MOVE = /^MV\s+(.+?)\s*$/;
const APPLY_PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/;
const APPLY_PATCH_MOVE = /^\*\*\* Move to:\s*(.+?)\s*$/;

function unquote(value: string): string {
	const text = value.trim();
	return text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[0] === text[text.length - 1] ? text.slice(1, -1) : text;
}

/**
 * Paths an edit/write call touches, for every OMP edit mode: replace/patch
 * (`path`, `edits[].path|rename`), OMP's derived `paths`, and the `input` text
 * modes (hashline `[path#TAG]` / `MV dest`, apply_patch `*** Update File: path`).
 */
export function editedPaths(toolName: string, input: unknown): string[] {
	if (toolName !== "edit" && toolName !== "write") return [];
	const record = (input ?? {}) as {
		path?: unknown;
		paths?: unknown;
		edits?: Array<{ path?: unknown; rename?: unknown }>;
		input?: unknown;
	};
	const paths = new Set<string>();
	if (typeof record.path === "string") paths.add(record.path);
	for (const path of Array.isArray(record.paths) ? record.paths : []) {
		if (typeof path === "string") paths.add(path);
	}
	for (const edit of Array.isArray(record.edits) ? record.edits : []) {
		if (typeof edit?.path === "string") paths.add(edit.path);
		if (typeof edit?.rename === "string") paths.add(edit.rename);
	}
	if (typeof record.input === "string") {
		const lines = record.input.replace(/^﻿/, "").split("\n").map(line => line.replace(/\r$/, ""));
		// apply_patch bodies carry context lines verbatim (a TOML "[dependencies]"),
		// so there only its own file headers name paths.
		const applyPatch = lines.some(line => APPLY_PATCH_FILE.test(line));
		for (const line of lines) {
			const match = applyPatch
				? (APPLY_PATCH_FILE.exec(line) ?? APPLY_PATCH_MOVE.exec(line))
				: (HASHLINE_HEADER.exec(line) ?? HASHLINE_MOVE.exec(line));
			if (match) paths.add(unquote(match[1]));
		}
	}
	return [...paths];
}

export type LspWrite = { action: string; paths: string[] };

/** An `lsp` call that edits files (rename, rename_file, an applied code action), or undefined. */
export function lspWrite(toolName: string, input: unknown): LspWrite | undefined {
	if (toolName !== "lsp") return undefined;
	const record = (input ?? {}) as { action?: unknown; file?: unknown; new_name?: unknown; apply?: unknown };
	const file = typeof record.file === "string" ? [record.file] : [];
	if (record.action === "rename" && record.apply !== false) return { action: "lsp rename", paths: file };
	if (record.action === "rename_file" && record.apply !== false) {
		return { action: "lsp rename_file", paths: [...file, ...(typeof record.new_name === "string" ? [record.new_name] : [])] };
	}
	if (record.action === "code_actions" && record.apply === true) return { action: "lsp code_actions", paths: file };
	return undefined;
}

// ---------------------------------------------------------------------------
// git commands that change repository state

/** A shell word. `marker` means the word starts with `$PWD`/`$(pwd)` or `$(git rev-parse --show-toplevel)`. */
type Token = { text: string; dynamic: boolean; marker?: "pwd" | "toplevel" };

function substitutionMarker(body: string): Token["marker"] {
	const text = body.trim();
	if (/^pwd(\s+-[LP])?$/.test(text)) return "pwd";
	if (/^git\s+rev-parse\s+--show-toplevel$/.test(text)) return "toplevel";
	return undefined;
}

/** Split a shell command into simple commands (words), collecting $(...) / `...` bodies for recursion. */
function splitShell(source: string, nested: string[]): Token[][] {
	const commands: Token[][] = [];
	let words: Token[] = [];
	let word = "";
	let dynamic = false;
	let inWord = false;
	let marker: Token["marker"];
	const flushWord = () => {
		if (inWord) words.push(marker && !dynamic ? { text: word, dynamic: false, marker } : { text: word, dynamic });
		word = "";
		dynamic = false;
		inWord = false;
		marker = undefined;
	};
	const flushCommand = () => {
		flushWord();
		if (words.length) commands.push(words);
		words = [];
	};
	const substitution = (body: string) => {
		nested.push(body);
		const found = substitutionMarker(body);
		// Only a leading $(pwd) / $(git rev-parse --show-toplevel) is a known place.
		if (found && word === "" && !marker && !dynamic) marker = found;
		else dynamic = true;
	};
	const variable = (index: number): number | undefined => {
		// `$PWD` / `${PWD}` at the start of a word is the shell's current directory.
		const match = /^\$(?:PWD\b|\{PWD\})/.exec(source.slice(index, index + 6));
		if (!match || word !== "" || marker || dynamic) return undefined;
		marker = "pwd";
		return index + match[0].length - 1;
	};
	const readSubstitution = (start: number): number => {
		// source[start] is "(" after "$"; returns the index of the matching ")".
		let depth = 1;
		let quote: string | undefined;
		let index = start + 1;
		for (; index < source.length; index++) {
			const char = source[index];
			if (quote) {
				if (char === "\\" && quote === '"') index++;
				else if (char === quote) quote = undefined;
				continue;
			}
			if (char === "'" || char === '"') quote = char;
			else if (char === "\\") index++;
			else if (char === "(") depth++;
			else if (char === ")" && --depth === 0) break;
		}
		substitution(source.slice(start + 1, index));
		return index;
	};
	const readBackticks = (index: number): number => {
		const end = source.indexOf("`", index + 1);
		substitution(source.slice(index + 1, end < 0 ? undefined : end));
		return end < 0 ? source.length : end;
	};
	const heredocs: Array<{ delimiter: string; stripTabs: boolean; shell: boolean }> = [];
	let quote: string | undefined;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (char === "\\") {
			if (source[index + 1] === "\n") {
				index++;
				continue;
			}
			word += source[index + 1] ?? "";
			inWord = true;
			index++;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "$" && source[index + 1] === "(") index = readSubstitution(index + 1);
			else if (char === "`") index = readBackticks(index);
			else {
				const end = char === "$" ? variable(index) : undefined;
				if (end !== undefined) index = end;
				else {
					if (char === "$") dynamic = true;
					word += char;
				}
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			index = readSubstitution(index + 1);
			inWord = true;
			continue;
		}
		if (char === "`") {
			index = readBackticks(index);
			inWord = true;
			continue;
		}
		if (char === "$") {
			const end = variable(index);
			if (end !== undefined) {
				index = end;
				inWord = true;
				continue;
			}
		}
		if (char === "#" && !inWord) {
			while (index < source.length && source[index] !== "\n") index++;
			index--; // let the newline below end the command and read pending heredocs
			continue;
		}
		if (char === "<" && source[index + 1] === "<" && source[index + 2] !== "<") {
			// Heredoc: its body is data, unless it is fed to a shell.
			flushWord();
			index += 2;
			const stripTabs = source[index] === "-";
			if (stripTabs) index++;
			while (source[index] === " " || source[index] === "\t") index++;
			let delimiter = "";
			while (index < source.length && !/[\s;|&<>()]/.test(source[index])) {
				if (source[index] !== "'" && source[index] !== '"' && source[index] !== "\\") delimiter += source[index];
				index++;
			}
			index--;
			const first = words.find(item => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(item.text) && !Object.hasOwn(WRAPPERS, item.text));
			heredocs.push({ delimiter, stripTabs, shell: SHELLS.has(first?.text.split("/").pop() ?? "") });
			continue;
		}
		if (char === "\n") {
			flushCommand();
			while (heredocs.length) {
				const doc = heredocs.shift()!;
				const bodyStart = index + 1;
				let cursor = bodyStart;
				let bodyEnd = source.length;
				index = source.length;
				while (cursor <= source.length) {
					const lineEnd = source.indexOf("\n", cursor);
					const end = lineEnd < 0 ? source.length : lineEnd;
					const line = source.slice(cursor, end);
					if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
						bodyEnd = cursor;
						index = end;
						break;
					}
					if (lineEnd < 0) break;
					cursor = lineEnd + 1;
				}
				if (doc.shell) nested.push(source.slice(bodyStart, bodyEnd));
			}
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || (!inWord && (char === "{" || char === "}"))) {
			flushCommand();
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			flushWord();
			continue;
		}
		if (char === "$") dynamic = true;
		word += char;
		inWord = true;
	}
	flushCommand();
	return commands;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "case", "esac", "!", "time", "in"]);
/** Command wrappers and the options of theirs that take a separate value. */
const WRAPPERS: Record<string, string[]> = {
	sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"],
	doas: ["-u", "-C"],
	command: [],
	builtin: [],
	exec: ["-a"],
	nohup: [],
	nice: ["-n"],
	ionice: ["-c", "-n", "-p"],
	stdbuf: ["-i", "-o", "-e"],
	caffeinate: ["-w", "-t"],
	env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const XARGS_WITH_VALUE = new Set(["-I", "-i", "-n", "-P", "-L", "-l", "-s", "-d", "-E", "-e", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"]);
const INIT_WITH_VALUE = new Set(["-b", "--initial-branch", "--template", "--separate-git-dir", "--object-format", "--ref-format", "--shared"]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path", "--super-prefix"]);

const ALWAYS_BLOCKED = new Set([
	"commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "restore", "clean",
	"cherry-pick", "revert", "am", "add", "rm", "mv", "update-ref", "update-index", "read-tree",
	"filter-branch", "filter-repo", "bisect", "replace",
]);
const DRY_RUN_SHORT = new Set(["add", "rm", "mv", "push"]);
const BRANCH_WRITE_FLAGS = /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to(=.*)?|--unset-upstream|--edit-description|--track|--no-track|--create-reflog)$/;
const BRANCH_LIST_FLAGS = /^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at|--show-current)$/;
const TAG_WRITE_FLAGS = /^(-d|--delete|-a|--annotate|-s|--sign|-u|--local-user(=.*)?|-f|--force|-m|--message(=.*)?|-F|--file(=.*)?|-e|--edit)$/;
const TAG_LIST_FLAGS = /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at|-v|--verify)$/;
const TAG_VALUE_FLAGS = /^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|-u|--local-user|-m|--message|-F|--file|--color|--column|--cleanup)$/;

/** Whether a git subcommand with these arguments changes repository state. */
function gitSubcommandWrites(sub: string, args: string[]): boolean {
	if (args.includes("-h") || args.includes("--help")) return false;
	if (args.includes("--dry-run")) return false;
	if (DRY_RUN_SHORT.has(sub) && args.includes("-n")) return false;
	if (sub === "clean" && args.some(arg => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg))) return false;
	if (ALWAYS_BLOCKED.has(sub)) return true;
	const positional = (valueFlags?: RegExp) => {
		const out: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--") {
				out.push(...args.slice(index + 1));
				break;
			}
			if (arg.startsWith("-")) {
				if (valueFlags?.test(arg) && !arg.includes("=")) index++;
				continue;
			}
			out.push(arg);
		}
		return out;
	};
	switch (sub) {
		case "stash": {
			const action = args.find(arg => !arg.startsWith("-"));
			return !(action === "list" || action === "show");
		}
		case "branch":
			if (args.some(arg => BRANCH_WRITE_FLAGS.test(arg))) return true;
			if (args.some(arg => BRANCH_LIST_FLAGS.test(arg))) return false;
			return positional(/^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--color|--column|--abbrev)$/).length > 0;
		case "tag":
			if (args.some(arg => TAG_WRITE_FLAGS.test(arg))) return true;
			if (args.some(arg => TAG_LIST_FLAGS.test(arg))) return false;
			return positional(TAG_VALUE_FLAGS).length > 0;
		case "worktree":
		case "submodule":
		case "remote":
		case "notes":
		case "symbolic-ref": {
			const words = positional();
			if (sub === "worktree") return words.length > 0 && words[0] !== "list";
			if (sub === "submodule") return words.length > 0 && !["status", "summary", "foreach"].includes(words[0]);
			if (sub === "remote") return words.length > 0 && !["show", "get-url"].includes(words[0]);
			if (sub === "notes") return words.length > 0 && !["list", "show"].includes(words[0]);
			return args.includes("-d") || args.includes("--delete") || words.length >= 2;
		}
		case "apply":
			if (args.some(arg => arg === "--index" || arg === "--cached" || arg === "--3way" || arg === "-3")) return true;
			return !args.some(arg => ["--check", "--stat", "--numstat", "--summary"].includes(arg));
		default:
			return false;
	}
}

/** Where a shell command runs: a known directory, somewhere in the current repository, or unknown. */
type Place = { kind: "dir"; path: string } | { kind: "repo" } | { kind: "unknown" };

export function normalizePath(value: string): string {
	const parts: string[] = [];
	for (const part of value.replace(/\\/g, "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return "/" + parts.join("/");
}

function relativeFrom(base: Place, relative: string): Place {
	if (base.kind === "dir") return { kind: "dir", path: normalizePath(`${base.path}/${relative}`) };
	if (base.kind === "repo") return /(^|\/)\.\.(\/|$)/.test(relative) ? { kind: "unknown" } : base;
	return base;
}

function resolvePlace(base: Place, token: Token | undefined): Place {
	if (!token || token.dynamic) return { kind: "unknown" };
	if (token.marker === "pwd") return relativeFrom(base, token.text.replace(/^\/+/, ""));
	if (token.marker === "toplevel") {
		// The top level of whatever repository the shell is in right now: git decides which.
		const suffix = token.text.replace(/^\/+/, "");
		if (base.kind === "repo") return relativeFrom(base, suffix);
		return base.kind === "dir" && !/(^|\/)\.\.(\/|$)/.test(suffix) ? base : { kind: "unknown" };
	}
	const text = token.text;
	if (!text || text === "-" || text.startsWith("~")) return { kind: "unknown" };
	if (text.startsWith("/")) return { kind: "dir", path: normalizePath(text) };
	return relativeFrom(base, text);
}

/**
 * A literal git invocation that would change repository state. `sameRepo`
 * says it certainly targets the current repository; otherwise `dir` (or
 * `gitDir`) is where it runs, for the caller to compare with the current
 * repository (a fixture repository elsewhere is fine).
 */
export type GitStateCommand = { command: string; sameRepo?: boolean; dir?: string; gitDir?: string };

type Scan = { out: GitStateCommand[]; inits: Set<string>; session: string };

/**
 * Every git invocation in a shell command line that would change a
 * repository's state (commit, branch/tag/ref, index, stash, working-tree
 * restore/clean, merge/rebase, push/pull), with where it runs. `cwd` is the
 * session directory; `bashCwd` the bash tool's own `cwd` argument, if any.
 * Commands in a place that cannot be known statically (`cd "$TMP"`) and
 * repositories the same line creates with `git init` are left out; only
 * literal git invocations are seen, not git run from scripts.
 */
export function gitStateCommands(command: string, cwd: string, bashCwd?: string): GitStateCommand[] {
	const session = normalizePath(cwd);
	const start: Place = bashCwd ? resolvePlace({ kind: "dir", path: session }, { text: bashCwd, dynamic: false }) : { kind: "dir", path: session };
	const scan: Scan = { out: [], inits: new Set(), session };
	scanShell(command, start, 0, scan);
	return scan.out;
}

/** Whether a found command certainly targets the repository at `cwd` without asking git. */
export function targetsSessionDirectory(found: GitStateCommand, cwd: string): boolean {
	return Boolean(found.sameRepo || (found.dir && !found.gitDir && found.dir === normalizePath(cwd)));
}

function scanShell(command: string, start: Place, depth: number, scan: Scan): void {
	if (depth > 4 || !command.includes("git")) return;
	const nested: string[] = [];
	const commands = splitShell(command, nested);
	let place = start;
	for (const words of commands) place = scanCommand(words, place, depth, scan);
	for (const body of nested) scanShell(body, place, depth + 1, scan);
}

function isAssignment(token: Token): boolean {
	return !token.marker && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text);
}

/** Scan one simple command; returns the place the next command runs in (after `cd`). */
function scanCommand(words: Token[], place: Place, depth: number, scan: Scan): Place {
	let index = 0;
	let here = place;
	let envGitDir: Token | undefined;
	let envWorkTree: Token | undefined;
	const assignment = (token: Token) => {
		if (token.text.startsWith("GIT_DIR=")) envGitDir = { ...token, text: token.text.slice("GIT_DIR=".length) };
		if (token.text.startsWith("GIT_WORK_TREE=")) envWorkTree = { ...token, text: token.text.slice("GIT_WORK_TREE=".length) };
	};
	while (index < words.length) {
		const token = words[index];
		if (isAssignment(token)) {
			assignment(token);
			index++;
			continue;
		}
		if (KEYWORDS.has(token.text)) {
			index++;
			continue;
		}
		const wrapper = token.text.split("/").pop() ?? token.text; // /usr/bin/env is env
		const valueFlags = Object.hasOwn(WRAPPERS, wrapper) ? WRAPPERS[wrapper] : undefined;
		if (!valueFlags) break;
		index++;
		while (index < words.length && words[index].text.startsWith("-") && words[index].text !== "-") {
			const [flag, inline] = words[index].text.split(/=(.*)/s, 2);
			const takesValue = valueFlags.includes(flag) && inline === undefined;
			const value = takesValue ? words[index + 1] : inline !== undefined ? { ...words[index], text: inline } : undefined;
			if (wrapper === "env" && (flag === "-C" || flag === "--chdir")) here = resolvePlace(here, value);
			index += takesValue ? 2 : 1;
		}
		if (wrapper === "env") {
			while (index < words.length && isAssignment(words[index])) assignment(words[index++]);
		}
		if (wrapper === "timeout") index++; // the duration
	}
	if (index >= words.length) return place;
	const head = words[index];
	const name = head.text.split("/").pop() ?? head.text;
	const rest = words.slice(index + 1);
	if (name === "cd" || name === "pushd") {
		const target = rest.find(word => !/^-[LPe@]+$/.test(word.text));
		return target ? resolvePlace(place, target) : { kind: "unknown" };
	}
	if (name === "popd") return { kind: "unknown" };
	if (SHELLS.has(name) || name === "eval") {
		const flag = rest.findIndex(word => /^-[a-z]*c$/.test(word.text));
		const body = name === "eval" ? rest.map(word => word.text).join(" ") : flag >= 0 ? rest[flag + 1]?.text : undefined;
		if (body) scanShell(body, here, depth + 1, scan);
		return place;
	}
	if (name === "xargs") {
		let position = 0;
		while (position < rest.length && rest[position].text.startsWith("-")) position += XARGS_WITH_VALUE.has(rest[position].text) ? 2 : 1;
		if (position < rest.length) scanCommand(rest.slice(position), here, depth + 1, scan);
		return place;
	}
	if (name === "find") {
		for (let position = 0; position < rest.length; position++) {
			if (!/^-(exec|execdir|ok|okdir)$/.test(rest[position].text)) continue;
			const end = rest.findIndex((word, at) => at > position && (word.text === ";" || word.text === "+"));
			scanCommand(rest.slice(position + 1, end < 0 ? undefined : end), here, depth + 1, scan);
		}
		return place;
	}
	if (name !== "git") return place;
	let position = 0;
	let at = envWorkTree ? resolvePlace(here, envWorkTree) : here;
	let gitDir = envGitDir;
	while (position < rest.length && rest[position].text.startsWith("-")) {
		const [flag, inline] = rest[position].text.split(/=(.*)/s, 2);
		let value: Token | undefined;
		if (GIT_GLOBAL_WITH_VALUE.has(flag)) {
			if (inline === undefined) {
				value = rest[position + 1];
				position++;
			} else {
				value = { ...rest[position], text: inline };
			}
		}
		if (value && (flag === "-C" || flag === "--work-tree")) at = resolvePlace(at, value);
		if (value && flag === "--git-dir") gitDir = value;
		position++;
	}
	if (position >= rest.length) return place;
	const sub = rest[position].text;
	const args = rest.slice(position + 1).map(word => word.text);
	if (sub === "init") {
		// A repository this very command line creates is a fixture, not the project.
		let targetIndex = -1;
		for (let i = 0; i < args.length; i++) {
			if (INIT_WITH_VALUE.has(args[i])) i++;
			else if (!args[i].startsWith("-")) {
				targetIndex = i;
				break;
			}
		}
		const target = targetIndex >= 0 ? rest[position + 1 + targetIndex] : undefined;
		const created = target ? resolvePlace(at, target) : at;
		// Re-initializing the session's own repository changes nothing and exempts nothing.
		if (created.kind === "dir" && created.path !== scan.session) scan.inits.add(created.path);
		return place;
	}
	if (!gitSubcommandWrites(sub, args)) return place;
	const commandText = ["git", sub, ...args].join(" ").slice(0, 200);
	const createdHere = (path: string) => [...scan.inits].some(root => path === root || path.startsWith(`${root}/`));
	if (gitDir) {
		const target = resolvePlace(at, gitDir);
		if (target.kind === "repo") scan.out.push({ command: commandText, sameRepo: true });
		else if (target.kind === "dir" && !createdHere(target.path)) scan.out.push({ command: commandText, gitDir: target.path });
		return place;
	}
	if (at.kind === "repo") scan.out.push({ command: commandText, sameRepo: true });
	else if (at.kind === "dir" && !createdHere(at.path)) scan.out.push({ command: commandText, dir: at.path });
	return place;
}

// ---------------------------------------------------------------------------
// guard script results and messages

export type AllowDecision = {
	allowed: boolean;
	mode?: string;
	role?: string;
	agent?: string;
	id?: string | null;
	blocked?: Array<{ path?: string; command?: string; reason?: string }>;
};

export function parseAllow(stdout: string): AllowDecision | undefined {
	try {
		const parsed = JSON.parse(stdout) as AllowDecision;
		return parsed && typeof parsed === "object" && typeof parsed.allowed === "boolean" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Tool error the worker sees when the guard blocks a call. */
export function blockReason(decision: AllowDecision): string {
	const items = (decision.blocked ?? []).map(item => (item.path ? `${item.path} — ${item.reason}` : `\`${item.command}\` — ${item.reason}`));
	return [
		"WORKFLOW GUARD blocked this call before it ran; nothing was changed.",
		...items.map(item => `- ${item}`),
		"Do not work around it (for example through bash). Finish what your role allows, and name what you still need in your result to Main.",
	].join("\n");
}

export type GuardVerdict = {
	id?: string;
	role?: string;
	agent?: string | null;
	step?: string | null;
	verdict?: string;
	violations?: Array<{ path: string; reason: string }>;
	notes?: string[];
	changed?: string[];
	blocked?: Array<{ path?: string; command?: string; reason?: string }>;
	shell_suspects?: string[];
};

export function parseVerdict(stdout: string): GuardVerdict | undefined {
	try {
		const parsed = JSON.parse(stdout) as GuardVerdict;
		return parsed && typeof parsed === "object" && typeof parsed.verdict === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Message injected into Main's context; undefined when there is nothing to act on.
 * Changes made by others while the worker ran (Main, the Human, parallel
 * sessions) never produce a message: they are not the worker's.
 */
export function guardMessage(verdict: GuardVerdict): string | undefined {
	const who = `${verdict.agent ?? verdict.role ?? "worker"} (step ${verdict.step ?? "-"})`;
	if (verdict.verdict === "clean") {
		const notes = verdict.notes ?? [];
		return notes.length
			? [`WORKFLOW GUARD — note on ${who}. Not a violation: accept the result on its merits and continue.`, ...notes.map(note => `- ${note}`)].join("\n")
			: undefined;
	}
	if (verdict.verdict === "violation") {
		const lines = (verdict.violations ?? []).slice(0, 12).map(item => `- ${item.path}: ${item.reason}`);
		return [
			`WORKFLOW GUARD — boundary violation by ${who}: the worker itself changed these files. Do not accept this worker result.`,
			...lines,
			"Record the violation, restore or quarantine the listed changes with the Human, and re-dispatch a fresh worker.",
			`Details: python3 ${GUARD_SCRIPT} status --step ${verdict.step ?? "<step>"}`,
		].join("\n");
	}
	if (verdict.verdict === "unscoped") {
		return [
			`WORKFLOW GUARD — ${who} edited files while STATE.yaml target_files was empty, so its scope could not be checked.`,
			`Edited: ${(verdict.changed ?? []).join(", ") || "-"}`,
			"Review the diff before accepting; a quick close is refused until target_files is recorded before dispatch.",
		].join("\n");
	}
	return undefined;
}
