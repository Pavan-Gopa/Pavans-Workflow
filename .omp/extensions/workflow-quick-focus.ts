import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { currentWorker } from "../lib/workflow-dashboard-data.ts";
import { decideQuickFocus } from "../lib/workflow-quick-focus.ts";

let activeApi: ExtensionAPI | undefined;
const patchedPrototypes = new WeakSet<object>();
const patchedContexts = new WeakSet<object>();

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

function installInputControllerPatch(): void {
	const prototype = InputController.prototype as object & { setupKeyHandlers(): void };
	if (patchedPrototypes.has(prototype)) return;
	patchedPrototypes.add(prototype);

	const original = prototype.setupKeyHandlers;
	prototype.setupKeyHandlers = function patchedSetupKeyHandlers(this: InputController): void {
		original.call(this);
		// InputController intentionally keeps ctx private. This compatibility hook
		// is bounded to the controller seam and doctor/selftests guard it.
		const ctx = (this as unknown as { ctx: InteractiveModeContext }).ctx;
		if (patchedContexts.has(ctx)) return;
		patchedContexts.add(ctx);

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
	};
}

// Project extensions are loaded before InteractiveMode.init() wires
// InputController. The guarded pre-editor listener consumes Tab only for the
// explicit Quick Focus cases; every other Tab reaches OMP's normal completion.
installInputControllerPatch();

export default function workflowQuickFocus(pi: ExtensionAPI): void {
	activeApi = pi;
	// Runtime behavior is installed at module load. No task/headless event hooks
	// are registered, so worker sessions do not receive a separate input policy.
}
