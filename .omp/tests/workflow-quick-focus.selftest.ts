import assert from "node:assert/strict";
import { decideQuickFocus, patchSetupKeyHandlers } from "../lib/workflow-quick-focus.ts";

const base = {
	isTab: true,
	editorFocused: true,
	editorEmpty: true,
	autocompleteVisible: false,
	overlayOpen: false,
};

assert.equal(
	decideQuickFocus({ ...base, workerId: "CoderS31", workerStatus: "running" }),
	"focus-worker",
	"empty Main Tab focuses the one active workflow worker",
);
assert.equal(
	decideQuickFocus({ ...base, focusedAgentId: "CoderS31", workerId: "CoderS31", workerStatus: "running" }),
	"return-main",
	"empty focused-worker Tab returns to Main",
);
assert.equal(
	decideQuickFocus({ ...base, editorEmpty: false, workerId: "CoderS31", workerStatus: "running" }),
	"passthrough",
	"typed drafts preserve normal Tab completion",
);
assert.equal(
	decideQuickFocus({ ...base, autocompleteVisible: true, workerId: "CoderS31", workerStatus: "running" }),
	"passthrough",
	"an open autocomplete popup owns Tab",
);
assert.equal(
	decideQuickFocus({ ...base, overlayOpen: true, workerId: "CoderS31", workerStatus: "running" }),
	"passthrough",
	"fullscreen/selector overlays own Tab",
);
assert.equal(decideQuickFocus(base), "passthrough", "no running worker leaves native Tab untouched");
assert.equal(
	decideQuickFocus({ ...base, workerId: "CoderS31", workerStatus: "pending" }),
	"passthrough",
	"queued/pending work is not focused as if it were live",
);
assert.equal(
	decideQuickFocus({ ...base, isTab: false, workerId: "CoderS31", workerStatus: "running" }),
	"passthrough",
	"non-Tab input is never intercepted",
);

// --- OMP compatibility seam: feature-detected and failure-isolated -------------
type FakeCtx = { id: string };
const isFakeCtx = (value: unknown): value is FakeCtx =>
	Boolean(value && typeof value === "object" && typeof (value as FakeCtx).id === "string");

{
	const reasons: string[] = [];
	const outcome = patchSetupKeyHandlers<FakeCtx>(class NoHandlers {}, {
		isUsableContext: isFakeCtx,
		attach: () => assert.fail("attach must not run when the method is missing"),
		onUnsupported: reason => reasons.push(reason),
	});
	assert.equal(outcome.status, "unsupported", "renamed setupKeyHandlers disables Quick Focus");
	assert.equal(reasons.length, 1);
}

{
	const calls: string[] = [];
	const reasons: string[] = [];
	class PrivateCtxController {
		#ctx = { id: "hidden" };
		setupKeyHandlers(): void {
			calls.push(`native:${this.#ctx.id}`);
		}
	}
	const outcome = patchSetupKeyHandlers<FakeCtx>(PrivateCtxController, {
		isUsableContext: isFakeCtx,
		attach: () => assert.fail("attach must not run without a usable context"),
		onUnsupported: reason => reasons.push(reason),
	});
	assert.equal(outcome.status, "installed");
	assert.doesNotThrow(() => new PrivateCtxController().setupKeyHandlers(), "a #private ctx must never break OMP input");
	new PrivateCtxController().setupKeyHandlers();
	assert.deepEqual(calls, ["native:hidden", "native:hidden"], "native key handlers always run");
	assert.equal(reasons.length, 1, "unsupported is reported once");
}

{
	const attached: string[] = [];
	const order: string[] = [];
	class Controller {
		ctx: FakeCtx;
		constructor(id: string) {
			this.ctx = { id };
		}
		setupKeyHandlers(): void {
			order.push("native");
		}
	}
	patchSetupKeyHandlers<FakeCtx>(Controller, {
		isUsableContext: isFakeCtx,
		attach: ctx => {
			order.push("attach");
			attached.push(ctx.id);
		},
		onUnsupported: reason => assert.fail(`unexpected unsupported: ${reason}`),
	});
	const first = new Controller("main");
	first.setupKeyHandlers();
	first.setupKeyHandlers();
	new Controller("second").setupKeyHandlers();
	assert.deepEqual(attached, ["main", "second"], "each context is attached exactly once");
	assert.deepEqual(order.slice(0, 2), ["native", "attach"], "native handlers run before Quick Focus");
	const again = patchSetupKeyHandlers<FakeCtx>(Controller, {
		isUsableContext: isFakeCtx,
		attach: () => assert.fail("double patch must be a no-op"),
		onUnsupported: () => assert.fail("double patch must not report"),
	});
	assert.equal(again.status, "installed");
	new Controller("third").setupKeyHandlers();
	assert.deepEqual(attached, ["main", "second", "third"]);
}

{
	const reasons: string[] = [];
	class Throwing {
		ctx = { id: "x" };
		setupKeyHandlers(): void {}
	}
	patchSetupKeyHandlers<FakeCtx>(Throwing, {
		isUsableContext: isFakeCtx,
		attach: () => {
			throw new Error("listener API changed");
		},
		onUnsupported: reason => reasons.push(reason),
	});
	assert.doesNotThrow(() => new Throwing().setupKeyHandlers());
	assert.deepEqual(reasons, ["listener API changed"]);
}

console.log("OK workflow quick-focus deterministic selftest");
