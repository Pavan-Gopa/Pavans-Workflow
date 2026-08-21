import assert from "node:assert/strict";
import { decideQuickFocus } from "../extensions/workflow-quick-focus.ts";

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

console.log("OK workflow quick-focus deterministic selftest");
