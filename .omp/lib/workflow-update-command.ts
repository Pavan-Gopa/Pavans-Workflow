// Argument handling for /workflow-update and /work-update. Pure and
// dependency-free so the selftest can prove the command always reaches the
// canonical updater (AI_Workflow_Kit/script/workflow_update.sh).

export const UPDATER_SCRIPT = "AI_Workflow_Kit/script/workflow_update.sh";
export const UPDATE_TIMEOUT_MS = 600_000;

const CHECK_WORDS = new Set(["check", "--check", "status", "dry-run", "--dry-run", "plan"]);
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export type UpdaterInvocation = {
	mode: "check" | "apply";
	argv: string[];
	errors: string[];
};

export function updaterInvocation(args: string): UpdaterInvocation {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const errors: string[] = [];
	let mode: "check" | "apply" = "apply";
	let refreshGraphify = false;
	let ref: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (CHECK_WORDS.has(token)) mode = "check";
		else if (token === "apply" || token === "update") mode = "apply";
		else if (token === "--refresh-graphify") refreshGraphify = true;
		else if (token === "--ref" || token.startsWith("--ref=")) {
			const value = token === "--ref" ? tokens[++index] : token.slice("--ref=".length);
			if (value && SAFE_REF.test(value)) ref = value;
			else errors.push(`invalid --ref value: ${value ?? "<missing>"}`);
		} else errors.push(`unknown argument: ${token}`);
	}
	const argv = [UPDATER_SCRIPT, mode];
	if (ref) argv.push("--ref", ref);
	if (refreshGraphify && mode === "apply") argv.push("--refresh-graphify");
	return { mode, argv, errors };
}
