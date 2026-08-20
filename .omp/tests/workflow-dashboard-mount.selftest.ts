import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const panelPath = path.join(root, ".omp/lib/workflow-dashboard-panel.ts");
const source = fs.readFileSync(panelPath, "utf8");

assert.match(source, /export const DASHBOARD_OVERLAY_OPTIONS/);
assert.match(source, /fullscreen:\s*true/);
assert.match(source, /mouseTracking:\s*true/);
assert.match(source, /overlay:\s*true/);
assert.match(source, /overlayOptions:\s*DASHBOARD_OVERLAY_OPTIONS/);
assert.match(source, /routeSgrMouseInput/);
assert.match(source, /event\.wheel !== null/);
assert.match(source, /viewport\.scroll\(event\.wheel \* MOUSE_SCROLL_LINES\)/);

const customCall = source.slice(source.indexOf("export async function showDashboard"));
assert.match(customCall, /ctx\.ui\.custom<undefined>\([\s\S]*overlay:\s*true[\s\S]*overlayOptions:\s*DASHBOARD_OVERLAY_OPTIONS/);

console.log("workflow dashboard fullscreen mount selftest: ok");
