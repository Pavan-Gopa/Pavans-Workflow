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
