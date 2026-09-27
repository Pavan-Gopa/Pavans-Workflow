import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { currentWorker } from "../lib/workflow-dashboard-data.ts";
import { decideQuickFocus, patchSetupKeyHandlers } from "../lib/workflow-quick-focus.ts";

let activeApi: ExtensionAPI | undefined;

/**
 * Worker lookup must not depend on cross-extension module state: OMP may load
 * extensions with isolated module registries, so the dashboard's in-memory
 * worker map can be invisible here. The Main session's own async-job snapshot
 * is authoritative — task workers are async jobs of the Main session, and
 * their ids match the task:subagent:lifecycle ids used by focusAgentSession.
 */
type JobSnapshotSession = {
	getAsyncJobSnapshot?(options: { recentLimit: number }): {
		running?: Array<{ id?: string; status?: string }>;
	} | null;
};

function snapshotSession(source: unknown): JobSnapshotSession | undefined {
	if (source && typeof source === "object" && "session" in source) {
		const session = (source as { session?: unknown }).session;
		if (session && typeof session === "object" && "getAsyncJobSnapshot" in session) {
			return session as JobSnapshotSession;
		}
	}
	return undefined;
}

function activeWorker(ctx: InteractiveModeContext): { id: string; status: string } | undefined {
	try {
		const snapshot = snapshotSession(ctx)?.getAsyncJobSnapshot?.({ recentLimit: 5 });
		const job = (snapshot?.running ?? []).find(entry => entry.status === "running" && entry.id);
		if (job?.id) return { id: job.id, status: "running" };
	} catch {
		// Session snapshot unavailable; fall through to the dashboard tracker.
	}
	const tracked = currentWorker();
	if (tracked && (tracked.status === "running" || tracked.status === "pending")) {
		return { id: tracked.id, status: tracked.status };
	}
	return undefined;
}

function usableContext(value: unknown): value is InteractiveModeContext {
	const ctx = value as Partial<InteractiveModeContext> | undefined;
	return Boolean(
		ctx &&
			typeof ctx === "object" &&
			typeof ctx.ui?.addInputListener === "function" &&
			typeof ctx.ui?.getFocused === "function" &&
			typeof ctx.ui?.hasOverlay === "function" &&
			typeof ctx.editor?.getText === "function" &&
			typeof ctx.focusAgentSession === "function" &&
			typeof ctx.unfocusSession === "function",
	);
}

let patchStatus: "pending" | "installed" | "unsupported" = "pending";
let unsupportedReason = "";

function markUnsupported(reason: string): void {
	patchStatus = "unsupported";
	unsupportedReason = reason;
	activeApi?.logger.warn(`[quick-focus] disabled: ${reason}. Tab keeps OMP's native behavior; Alt+A still opens Agent Hub.`);
}

function attachQuickFocus(ctx: InteractiveModeContext): void {
	ctx.ui.addInputListener(data => {
		const worker = activeWorker(ctx);
		const decision = decideQuickFocus({
			isTab: matchesKey(data, "tab"),
			editorFocused: ctx.ui.getFocused() === ctx.editor,
			editorEmpty: ctx.editor.getText().trim().length === 0,
			autocompleteVisible: ctx.editor.isShowingAutocomplete(),
			overlayOpen: ctx.ui.hasOverlay(),
			focusedAgentId: ctx.focusedAgentId,
			workerId: worker?.id,
			workerStatus: worker?.status,
		});

		activeApi?.logger.debug(`[quick-focus] decision=${decision} focused=${ctx.focusedAgentId ?? "-"} worker=${worker ? `${worker.id}:${worker.status}` : "-"}`);
		if (decision === "passthrough") return undefined;
		if (decision === "return-main") {
			void ctx.unfocusSession().catch(error => {
				ctx.showStatus(`Quick Focus: ${error instanceof Error ? error.message : String(error)}`);
			});
			return { consume: true };
		}

		const workerId = worker?.id;
		if (!workerId) return undefined;
		void ctx.focusAgentSession(workerId).catch(error => {
			ctx.showStatus(`Quick Focus: ${error instanceof Error ? error.message : String(error)}`);
		});
		return { consume: true };
	});
}

function installInputControllerPatch(controllerClass: unknown): void {
	const outcome = patchSetupKeyHandlers<InteractiveModeContext>(controllerClass, {
		isUsableContext: usableContext,
		attach: attachQuickFocus,
		onUnsupported: markUnsupported,
	});
	if (outcome.status === "installed" && patchStatus === "pending") patchStatus = "installed";
}

// Project extension modules load before InteractiveMode.init() wires the
// InputController, and OMP awaits the factory below. The deep import is
// dynamic so a future OMP layout change disables Quick Focus instead of
// failing the whole extension load.
const patchReady: Promise<void> = import("@oh-my-pi/pi-coding-agent/modes/controllers/input-controller")
	.then(module => installInputControllerPatch((module as { InputController?: unknown }).InputController))
	.catch(error => markUnsupported(`input controller module unavailable (${error instanceof Error ? error.message : String(error)})`));

export function quickFocusStatus(): { status: typeof patchStatus; reason: string } {
	return { status: patchStatus, reason: unsupportedReason };
}

export default async function workflowQuickFocus(pi: ExtensionAPI): Promise<void> {
	activeApi = pi;
	await patchReady;
	if (patchStatus === "unsupported") markUnsupported(unsupportedReason);
	// No task/headless event hooks are registered, so worker sessions do not
	// receive a separate input policy.
}
