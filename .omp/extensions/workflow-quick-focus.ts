import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { currentWorker } from "../lib/workflow-dashboard-data.ts";

const patchedPrototypes = new WeakSet<object>();
const patchedContexts = new WeakSet<object>();

export type QuickFocusDecision = "focus-worker" | "return-main" | "passthrough";

export function decideQuickFocus(options: {
	isTab: boolean;
	editorFocused: boolean;
	editorEmpty: boolean;
	autocompleteVisible: boolean;
	overlayOpen: boolean;
	focusedAgentId?: string;
	workerId?: string;
	workerStatus?: string;
}): QuickFocusDecision {
	if (!options.isTab || !options.editorFocused || !options.editorEmpty || options.autocompleteVisible || options.overlayOpen) {
		return "passthrough";
	}
	if (options.focusedAgentId) return "return-main";
	if (options.workerId && options.workerStatus === "running") return "focus-worker";
	return "passthrough";
}

function installInputControllerPatch(): void {
	const prototype = InputController.prototype as object & { setupKeyHandlers(): void };
	if (patchedPrototypes.has(prototype)) return;
	patchedPrototypes.add(prototype);

	const original = prototype.setupKeyHandlers;
	prototype.setupKeyHandlers = function patchedSetupKeyHandlers(this: InputController): void {
		original.call(this);
		// InputController intentionally keeps ctx private. This compatibility hook
		// is bounded to the OMP 17.x controller seam and doctor/selftests guard it.
		const ctx = (this as unknown as { ctx: InteractiveModeContext }).ctx;
		if (patchedContexts.has(ctx)) return;
		patchedContexts.add(ctx);

		ctx.ui.addInputListener(data => {
			const worker = currentWorker();
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

export default function workflowQuickFocus(_pi: ExtensionAPI): void {
	// Runtime behavior is installed at module load. No task/headless event hooks
	// are registered, so worker sessions do not receive a separate input policy.
}
