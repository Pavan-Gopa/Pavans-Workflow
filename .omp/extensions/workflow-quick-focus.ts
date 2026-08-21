import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { matchesKey } from "@oh-my-pi/pi-tui";
import { currentWorker } from "../lib/workflow-dashboard-data.ts";

const PATCH_MARK = Symbol.for("pavans-workflow.quick-focus.v3.2");
const LISTENER_MARK = Symbol.for("pavans-workflow.quick-focus.listener.v3.2");

type PatchedPrototype = InputController["prototype"] & { [PATCH_MARK]?: boolean };
type PatchedContext = InteractiveModeContext & { [LISTENER_MARK]?: boolean };
type ControllerWithContext = InputController & { ctx: InteractiveModeContext };

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
	const prototype = InputController.prototype as PatchedPrototype;
	if (prototype[PATCH_MARK]) return;
	prototype[PATCH_MARK] = true;

	const original = prototype.setupKeyHandlers;
	prototype.setupKeyHandlers = function patchedSetupKeyHandlers(this: InputController): void {
		original.call(this);
		const ctx = (this as ControllerWithContext).ctx as PatchedContext;
		if (ctx[LISTENER_MARK]) return;
		ctx[LISTENER_MARK] = true;

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

// Extensions are loaded into the session before InteractiveMode.init() wires
// InputController, so installing this guarded prototype hook here gives the
// workflow one pre-editor Tab listener without changing OMP's global keymap.
installInputControllerPatch();

export default function workflowQuickFocus(_pi: ExtensionAPI): void {
	// Runtime behavior is installed at module load; no worker/headless hooks are
	// registered, so task sessions retain normal input behavior.
}
