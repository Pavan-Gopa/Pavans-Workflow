import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Settings, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const MAIN_DEFAULT_ROLE = "default";
export const MAIN_ORCHESTRATOR_ROLE = "workflow_orchestrator";
export const MAIN_ORCHESTRATOR_ALIAS = "@default";

export type MainModelScope = "project" | "global";
export type MainRoleMutation =
	| { kind: "passthrough" }
	| {
			kind: "paired";
			scope: MainModelScope;
			defaultOperation: "set" | "clear";
			defaultValue?: string;
			orchestratorValue: typeof MAIN_ORCHESTRATOR_ALIAS;
			syncLive: boolean;
	  }
	| { kind: "alias-only"; scope: MainModelScope };

/**
 * One logical Main model slot is persisted as `default`; the workflow role is
 * always an alias to it. Assigning the workflow role is therefore translated
 * into an assignment of `default` plus restoration of the alias.
 */
export function planMainRoleMutation(
	scope: MainModelScope,
	operation: "set" | "clear",
	role: string,
	value?: string,
): MainRoleMutation {
	if (role !== MAIN_DEFAULT_ROLE && role !== MAIN_ORCHESTRATOR_ROLE) return { kind: "passthrough" };
	if (role === MAIN_ORCHESTRATOR_ROLE && operation === "set" && value === MAIN_ORCHESTRATOR_ALIAS) {
		return { kind: "alias-only", scope };
	}
	if (operation === "clear") {
		return {
			kind: "paired",
			scope,
			defaultOperation: "clear",
			orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
			syncLive: role === MAIN_ORCHESTRATOR_ROLE,
		};
	}
	if (!value) return { kind: "passthrough" };
	return {
		kind: "paired",
		scope,
		defaultOperation: "set",
		defaultValue: value,
		orchestratorValue: MAIN_ORCHESTRATOR_ALIAS,
		syncLive: role === MAIN_ORCHESTRATOR_ROLE,
	};
}

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

export function explicitThinkingLevel(roleValue: string | undefined): string | undefined {
	return roleValue?.match(THINKING_SUFFIX)?.[1]?.toLowerCase();
}

type Originals = {
	setProjectModelRole: Settings["setProjectModelRole"];
	clearProjectModelRole: Settings["clearProjectModelRole"];
	setModelRole: Settings["setModelRole"];
};

type SyncRuntime = {
	pi: ExtensionAPI;
	ctx?: ExtensionContext;
	internalDepth: number;
	liveRevision: number;
	lastDefault?: string;
	lastOrchestrator?: string;
};

type PatchRegistry = {
	originals: Originals;
	runtimes: WeakMap<Settings, SyncRuntime>;
};

const PATCH_KEY = Symbol.for("pavans-workflow.main-model-sync.v1");

function preferredScope(instance: Settings): MainModelScope {
	return instance.get("modelRoleStorage") === "project" ? "project" : "global";
}

function originalSet(
	registry: PatchRegistry,
	instance: Settings,
	scope: MainModelScope,
	role: string,
	value: string,
): void {
	if (scope === "project") registry.originals.setProjectModelRole.call(instance, role, value);
	else registry.originals.setModelRole.call(instance, role, value);
}

function originalClear(registry: PatchRegistry, instance: Settings, scope: MainModelScope, role: string): void {
	if (scope === "project") registry.originals.clearProjectModelRole.call(instance, role);
	else registry.originals.setModelRole.call(instance, role, undefined);
}

function snapshot(runtime: SyncRuntime, instance: Settings): void {
	runtime.lastDefault = instance.getModelRole(MAIN_DEFAULT_ROLE);
	runtime.lastOrchestrator = instance.getModelRole(MAIN_ORCHESTRATOR_ROLE);
}

function applyPlan(
	registry: PatchRegistry,
	instance: Settings,
	runtime: SyncRuntime,
	plan: MainRoleMutation,
	fallback: () => void,
): void {
	if (plan.kind === "passthrough") {
		fallback();
		return;
	}
	if (runtime.internalDepth > 0) {
		fallback();
		return;
	}

	runtime.internalDepth++;
	try {
		if (plan.kind === "alias-only") {
			originalSet(registry, instance, plan.scope, MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
			return;
		}
		if (plan.defaultOperation === "clear") {
			originalClear(registry, instance, plan.scope, MAIN_DEFAULT_ROLE);
		} else if (plan.defaultValue) {
			originalSet(registry, instance, plan.scope, MAIN_DEFAULT_ROLE, plan.defaultValue);
		}
		originalSet(registry, instance, plan.scope, MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
	} finally {
		runtime.internalDepth--;
		snapshot(runtime, instance);
	}
	if (plan.kind === "paired" && plan.syncLive) scheduleLiveSync(runtime, instance);
}

async function syncLiveToDefault(runtime: SyncRuntime, instance: Settings, revision: number): Promise<void> {
	if (revision !== runtime.liveRevision) return;
	const ctx = runtime.ctx;
	if (!ctx) return;
	const target = ctx.models.resolve("@default");
	if (!target) {
		if (ctx.hasUI) ctx.ui.notify("Main model sync: DEFAULT could not be resolved.", "error");
		return;
	}
	const current = ctx.models.current();
	if (!current || current.provider !== target.provider || current.id !== target.id) {
		const switched = await runtime.pi.setModel(target);
		if (!switched) {
			if (ctx.hasUI) ctx.ui.notify(`Main model sync: ${target.provider}/${target.id} is unavailable.`, "error");
			return;
		}
	}
	const level = explicitThinkingLevel(instance.getModelRole(MAIN_DEFAULT_ROLE));
	if (level) runtime.pi.setThinkingLevel(level as ThinkingLevel);
	if (ctx.hasUI) ctx.ui.requestRender();
}

function scheduleLiveSync(runtime: SyncRuntime, instance: Settings): void {
	const ctx = runtime.ctx;
	if (!ctx) return;
	const revision = ++runtime.liveRevision;
	ctx.setTimeout(() => syncLiveToDefault(runtime, instance, revision), 0);
}

function installSettingsPatch(): PatchRegistry {
	const root = globalThis as unknown as Record<PropertyKey, unknown>;
	const existing = root[PATCH_KEY] as PatchRegistry | undefined;
	if (existing) return existing;

	const proto = Settings.prototype;
	const registry: PatchRegistry = {
		originals: {
			setProjectModelRole: proto.setProjectModelRole,
			clearProjectModelRole: proto.clearProjectModelRole,
			setModelRole: proto.setModelRole,
		},
		runtimes: new WeakMap(),
	};

	proto.setProjectModelRole = function patchedProjectSet(role, value) {
		const runtime = registry.runtimes.get(this);
		if (!runtime || runtime.internalDepth > 0) {
			return registry.originals.setProjectModelRole.call(this, role, value);
		}
		const plan = planMainRoleMutation("project", "set", String(role), value);
		applyPlan(registry, this, runtime, plan, () => registry.originals.setProjectModelRole.call(this, role, value));
	};

	proto.clearProjectModelRole = function patchedProjectClear(role) {
		const runtime = registry.runtimes.get(this);
		if (!runtime || runtime.internalDepth > 0) {
			return registry.originals.clearProjectModelRole.call(this, role);
		}
		const plan = planMainRoleMutation("project", "clear", String(role));
		applyPlan(registry, this, runtime, plan, () => registry.originals.clearProjectModelRole.call(this, role));
	};

	proto.setModelRole = function patchedGlobalSet(role, value) {
		const runtime = registry.runtimes.get(this);
		if (!runtime || runtime.internalDepth > 0) {
			return registry.originals.setModelRole.call(this, role, value);
		}
		const plan = planMainRoleMutation("global", value === undefined ? "clear" : "set", String(role), value);
		applyPlan(registry, this, runtime, plan, () => registry.originals.setModelRole.call(this, role, value));
	};

	root[PATCH_KEY] = registry;
	return registry;
}

function canonicalize(instance: Settings, registry: PatchRegistry, runtime: SyncRuntime): void {
	const scope = preferredScope(instance);
	runtime.internalDepth++;
	try {
		// DEFAULT is the startup authority. Do not overwrite an existing default
		// merely because an older workflow_orchestrator value drifted away from it.
		const defaultValue = instance.getModelRole(MAIN_DEFAULT_ROLE);
		if (!defaultValue) {
			const current = runtime.ctx?.models.current();
			if (current) {
				originalSet(registry, instance, scope, MAIN_DEFAULT_ROLE, `${current.provider}/${current.id}`);
			}
		}
		originalSet(registry, instance, scope, MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
	} finally {
		runtime.internalDepth--;
		snapshot(runtime, instance);
	}
}

function reconcile(instance: Settings, registry: PatchRegistry, runtime: SyncRuntime): void {
	if (runtime.internalDepth > 0) return;
	const defaultValue = instance.getModelRole(MAIN_DEFAULT_ROLE);
	const orchestratorValue = instance.getModelRole(MAIN_ORCHESTRATOR_ROLE);

	// A non-alias value can only come from a layer reload/external writer that
	// bypassed the patched Settings API. Treat it as an explicit orchestrator
	// choice, promote it to DEFAULT in the same persisted layer, then restore
	// the invariant.
	if (orchestratorValue && orchestratorValue !== MAIN_ORCHESTRATOR_ALIAS) {
		const source = instance.getModelRoleSource(MAIN_ORCHESTRATOR_ROLE);
		const scope: MainModelScope = source === "global" ? "global" : preferredScope(instance);
		applyPlan(
			registry,
			instance,
			runtime,
			planMainRoleMutation(scope, "set", MAIN_ORCHESTRATOR_ROLE, orchestratorValue),
			() => {},
		);
		return;
	}

	if (defaultValue !== runtime.lastDefault) {
		const scope = preferredScope(instance);
		runtime.internalDepth++;
		try {
			originalSet(registry, instance, scope, MAIN_ORCHESTRATOR_ROLE, MAIN_ORCHESTRATOR_ALIAS);
		} finally {
			runtime.internalDepth--;
			snapshot(runtime, instance);
		scheduleLiveSync(runtime, instance);
		return;
	}

	if (orchestratorValue !== runtime.lastOrchestrator) snapshot(runtime, instance);
}

export default function workflowMainModelSync(pi: ExtensionAPI): void {
	const registry = installSettingsPatch();
	let runtime: SyncRuntime | undefined;
	let instance: Settings | undefined;

	const attach = (ctx: ExtensionContext): void => {
		instance = Settings.instance;
		runtime ??= {
			pi,
			internalDepth: 0,
			liveRevision: 0,
		};
		runtime.ctx = ctx;
		registry.runtimes.set(instance, runtime);
		canonicalize(instance, registry, runtime);
		ctx.setInterval(() => {
			if (instance && runtime) reconcile(instance, registry, runtime);
		}, 200);
	};

	pi.on("session_start", async (_event, ctx) => attach(ctx));
	pi.on("session_switch", async (_event, ctx) => attach(ctx));
	pi.on("session_shutdown", async () => {
		if (instance) registry.runtimes.delete(instance);
	});
}
