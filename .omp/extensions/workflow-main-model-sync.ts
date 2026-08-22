import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	explicitThinkingLevel,
	MAIN_DEFAULT_ROLE,
	MAIN_ORCHESTRATOR_ALIAS,
	MAIN_ORCHESTRATOR_ROLE,
	shouldAttachMainModelSync,
	type MainModelScope,
} from "../lib/workflow-main-model-sync.ts";

function preferredScope(): MainModelScope {
	return settings.get("modelRoleStorage") === "project" ? "project" : "global";
}


function setRole(scope: MainModelScope, role: string, value: string): void {
	if (scope === "project") settings.setProjectModelRole(role, value);
	else settings.setModelRole(role, value);
}

function clearRole(scope: MainModelScope, role: string): void {
	if (scope === "project") settings.clearProjectModelRole(role);
	else settings.setModelRole(role, undefined);
}

function sameModel(
	left: { provider: string; id: string } | undefined,
	right: { provider: string; id: string } | undefined,
): boolean {
	return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

async function syncLiveToDefault(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const target = ctx.models.resolve("@default");
	if (!target) {
		if (ctx.hasUI) ctx.ui.notify("Main model sync: DEFAULT could not be resolved.", "error");
		return;
	}
	const current = ctx.models.current();
	if (!sameModel(current, target)) {
		const switched = await pi.setModel(target);
		if (!switched) {
			if (ctx.hasUI) ctx.ui.notify(`Main model sync: ${target.provider}/${target.id} is unavailable.`, "error");
			return;
		}
	}
	const level = explicitThinkingLevel(settings.getModelRole(MAIN_DEFAULT_ROLE));
	if (level) pi.setThinkingLevel(level as ThinkingLevel);
	if (ctx.hasUI) ctx.ui.requestRender();
}

export default function workflowMainModelSync(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let timer: Timer | undefined;
	let applying = false;
	let lastDefault: string | undefined;
	let lastOrchestrator: string | undefined;
	let liveRevision = 0;

	const remember = (): void => {
		lastDefault = settings.getModelRole(MAIN_DEFAULT_ROLE);
		lastOrchestrator = settings.getModelRole(MAIN_ORCHESTRATOR_ROLE);
	};

	const writeAlias = (): void => {
		setRole(preferredScope(), MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
	};

	const scheduleLiveSync = (): void => {
		if (!ctx) return;
		const active = ctx;
		const revision = ++liveRevision;
		active.setTimeout(() => {
			if (revision === liveRevision) void syncLiveToDefault(pi, active);
		}, 0);
	};

	const canonicalize = (): void => {
		if (applying) return;
		applying = true;
		try {
			// DEFAULT is authoritative on startup. Existing explicit Orchestrator
			// values from pre-sync installs are replaced by the alias, never allowed
			// to overwrite the user's current DEFAULT selection.
			const defaultValue = settings.getModelRole(MAIN_DEFAULT_ROLE);
			if (!defaultValue && ctx) {
				const current = ctx.models.current();
				if (current) setRole(preferredScope(), MAIN_DEFAULT_ROLE, `${current.provider}/${current.id}`);
			}
			writeAlias();
		} finally {
			applying = false;
			remember();
		}
	};

	const reconcile = (): void => {
		if (applying || !ctx) return;
		const defaultValue = settings.getModelRole(MAIN_DEFAULT_ROLE);
		const orchestratorValue = settings.getModelRole(MAIN_ORCHESTRATOR_ROLE);

		if (orchestratorValue && orchestratorValue !== MAIN_ORCHESTRATOR_ALIAS) {
			// Alt+M changed workflow_orchestrator directly. Promote that choice to
			// DEFAULT, restore the alias, then switch the live Main session.
			applying = true;
			try {
				const scope = preferredScope();
				setRole(scope, MAIN_DEFAULT_ROLE, orchestratorValue);
				setRole(scope, MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
			} finally {
				applying = false;
				remember();
			}
			scheduleLiveSync();
			return;
		}

		if (defaultValue !== lastDefault) {
			applying = true;
			try {
				writeAlias();
			} finally {
				applying = false;
				remember();
			}
			scheduleLiveSync();
			return;
		}

		if (!orchestratorValue) {
			applying = true;
			try {
				writeAlias();
			} finally {
				applying = false;
				remember();
			}
			return;
		}

		if (orchestratorValue !== lastOrchestrator) remember();
	};

	const clearAttachment = (current?: ExtensionContext): void => {
		if (timer && current) current.clearTimer(timer);
		timer = undefined;
		ctx = undefined;
		liveRevision++;
	};

	const attach = (next: ExtensionContext): void => {
		if (!shouldAttachMainModelSync(next.hasUI)) {
			clearAttachment(ctx);
			return;
		}
		if (timer && ctx) ctx.clearTimer(timer);
		ctx = next;
		canonicalize();
		timer = next.setInterval(reconcile, 200);
	};

	pi.on("session_start", async (_event, next) => attach(next));
	pi.on("session_switch", async (_event, next) => attach(next));
	pi.on("session_shutdown", async (_event, current) => clearAttachment(current));
}
