import assert from "node:assert/strict";
import {
	DEFAULT_CONTEXT_ECONOMY_POLICY,
	evaluateContextEconomy,
	initialContextEconomyState,
	normalizeContextEconomyPolicy,
} from "../lib/workflow-context-economy-core.ts";

const policy = normalizeContextEconomyPolicy(DEFAULT_CONTEXT_ECONOMY_POLICY);
const baseState = initialContextEconomyState(1_000);
const usage = (percent: number) => ({ tokens: percent * 10_000, contextWindow: 1_000_000, percent });

let decision = evaluateContextEconomy({
	usage: usage(22.9),
	policy,
	state: baseState,
	now: 2_000,
	mainIdle: true,
	activeWorker: false,
	pendingMessages: false,
});
assert.equal(decision.phase, "below");
assert.equal(decision.shouldCompact, false);

decision = evaluateContextEconomy({
	usage: usage(23.1),
	policy,
	state: baseState,
	now: 2_000,
	mainIdle: false,
	activeWorker: false,
	pendingMessages: false,
});
assert.equal(decision.phase, "waiting_safe_boundary");
assert.equal(decision.armed, true);
assert.match(decision.reason, /Main is active/);

decision = evaluateContextEconomy({
	usage: usage(24.5),
	policy,
	state: { ...baseState, armed: true },
	now: 2_000,
	mainIdle: true,
	activeWorker: true,
	pendingMessages: false,
});
assert.equal(decision.phase, "waiting_safe_boundary");
assert.equal(decision.shouldCompact, false);
assert.match(decision.reason, /worker/);

decision = evaluateContextEconomy({
	usage: usage(25.2),
	policy,
	state: { ...baseState, armed: true },
	now: 2_000,
	mainIdle: true,
	activeWorker: false,
	pendingMessages: false,
});
assert.equal(decision.phase, "armed");
assert.equal(decision.shouldCompact, true);

decision = evaluateContextEconomy({
	usage: usage(28),
	policy,
	state: { ...baseState, armed: true },
	now: 2_000,
	mainIdle: true,
	activeWorker: false,
	pendingMessages: false,
});
assert.equal(decision.phase, "hard_threshold");
assert.equal(decision.shouldCompact, false);

decision = evaluateContextEconomy({
	usage: usage(17.5),
	policy,
	state: { ...baseState, armed: true },
	now: 2_000,
	mainIdle: true,
	activeWorker: false,
	pendingMessages: false,
});
assert.equal(decision.phase, "below");
assert.equal(decision.armed, false);

const normalized = normalizeContextEconomyPolicy({
	softArmPercent: 27,
	hardThresholdPercent: 24,
	rearmPercent: 99,
	cooldownSeconds: -1,
	methodOrder: ["shake", "shake", "soft"],
});
assert.equal(normalized.softArmPercent, 27);
assert.equal(normalized.hardThresholdPercent, 28);
assert.equal(normalized.rearmPercent, 26);
assert.equal(normalized.cooldownSeconds, 0);
assert.deepEqual(normalized.methodOrder, ["shake", "soft"]);

console.log("workflow context economy selftest: PASS");
