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

export type PatchOutcome = { status: "installed" | "unsupported"; reason?: string };

type PatchOptions<C> = {
	isUsableContext(value: unknown): value is C;
	attach(ctx: C): void;
	onUnsupported(reason: string): void;
};

const patchedPrototypes = new WeakSet<object>();

/**
 * Wrap `InputController.prototype.setupKeyHandlers` (an OMP internal, not a
 * public extension API). The original handler always runs first; everything
 * the workflow adds is feature-detected and failure-isolated, so an OMP layout
 * change disables Quick Focus instead of breaking OMP's input handling.
 */
export function patchSetupKeyHandlers<C extends object>(controllerClass: unknown, options: PatchOptions<C>): PatchOutcome {
	const prototype = (controllerClass as { prototype?: unknown } | undefined)?.prototype as
		| (object & { setupKeyHandlers?: unknown })
		| undefined;
	if (!prototype || typeof prototype.setupKeyHandlers !== "function") {
		const reason = "InputController.setupKeyHandlers is not available in this OMP version";
		options.onUnsupported(reason);
		return { status: "unsupported", reason };
	}
	if (patchedPrototypes.has(prototype)) return { status: "installed" };
	patchedPrototypes.add(prototype);

	const original = prototype.setupKeyHandlers as (this: unknown) => void;
	const attached = new WeakSet<object>();
	let reported = false;
	const report = (reason: string) => {
		if (reported) return;
		reported = true;
		options.onUnsupported(reason);
	};
	prototype.setupKeyHandlers = function patchedSetupKeyHandlers(this: unknown): void {
		original.call(this);
		try {
			const ctx = (this as { ctx?: unknown } | null)?.ctx;
			if (!options.isUsableContext(ctx)) {
				report("InputController context shape changed");
				return;
			}
			if (attached.has(ctx)) return;
			attached.add(ctx);
			options.attach(ctx);
		} catch (error) {
			report(error instanceof Error ? error.message : String(error));
		}
	};
	return { status: "installed" };
}
