// Idempotent schema v2 migration for STEPS.md and STATE.yaml.
//
// Guarantees:
// - never reorders cards, never flips checkbox state;
// - preserves item text verbatim (only prepends a stable ID token);
// - never touches Goal / Out of scope / Stop-gate content;
// - skips fenced template blocks and parser-excluded template cards;
// - re-running on migrated files is a no-op.

import { isValidWorkItemId, normalizeWorkItemText } from "./workflow-dashboard-core.ts";

export type MigrationNote = {
	level: "warn" | "fail" | "info";
	code: string;
	message: string;
};

export type MigrationCheckResult = {
	schemaVersion: number | null;
	findings: MigrationNote[];
};

export type MigrationEdit = {
	output: string;
	changed: boolean;
	notes: MigrationNote[];
};

const STEP_HEADING = /^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)[ \t]+(?:—|-)[ \t]+(.+?)\s*$/;
const CHECKLIST_LINE = /^\s*(?:[-*]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*\S)\s*$/;
const BARE_CHECKBOX_LINE = /^\s*\[([ xX])\]\s*(.*\S)\s*$/;
const ID_TOKEN = /^\[([^\]\s]+)\]\s*/;
const FENCE = /^\s*```/;

type ItemKind = "D" | "O" | "J";

function normalizedTitle(title: string): string {
	return title.replace(/^_\((.*)\)_$/, "$1").replace(/^_+|_+$/g, "").trim();
}

function isTemplateCardTitle(title: string): boolean {
	const normalized = normalizedTitle(title).toLowerCase().replace(/[()]/g, "").trim();
	if (["title", "short title", "step title", "placeholder", ""].includes(normalized)) return true;
	return /\btemplate(?: card)?\b/.test(normalized);
}

function sectionKind(line: string): ItemKind | "reset" | null {
	const trimmed = line.trim();
	if (/^\*\*Do:\*\*/i.test(trimmed)) return "D";
	if (/^(?:#{3,}\s+Objective gates\s*$|\*\*Objective gates:\*\*)/i.test(trimmed)) return "O";
	if (/^(?:#{3,}\s+Judgment gates\s*$|\*\*Judgment gates:\*\*)/i.test(trimmed)) return "J";
	if (/^(?:#{3,}\s+Done when\s*$|\*\*Done when:\*\*)/i.test(trimmed)) return "O";
	if (/^\*\*[A-Za-z][^*\n]*:\*\*/.test(trimmed) || /^#{2,}\s+/.test(trimmed)) return "reset";
	return null;
}

function existingId(text: string): string | undefined {
	const match = text.match(ID_TOKEN);
	if (!match) return undefined;
	return isValidWorkItemId(match[1]) ? match[1] : undefined;
}

/**
 * Add stable IDs to checkbox items in STEPS.md. Items that already carry a
 * valid ID keep it; numbering continues around existing IDs.
 */
export function migrateStepsSource(source: string): MigrationEdit {
	const lines = source.split("\n");
	const notes: MigrationNote[] = [];
	let changed = false;
	let inFence = false;
	let stepId: string | undefined;
	let inTemplateCard = false;
	let kind: ItemKind | undefined;
	let used = new Set<number>();
	let nextNumber = 1;

	const resetNumbering = () => {
		used = new Set<number>();
		nextNumber = 1;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (FENCE.test(line)) {
			inFence = !inFence;
			kind = undefined;
			continue;
		}
		if (inFence) continue;

		const heading = line.match(STEP_HEADING);
		if (heading) {
			stepId = heading[1];
			inTemplateCard = isTemplateCardTitle(heading[2]);
			kind = undefined;
			resetNumbering();
			continue;
		}
		if (/^#{1,2}\s/.test(line) && !STEP_HEADING.test(line)) {
			// Non-card heading (e.g. "## Verification" belongs to the card,
			// but "# Step cards" or "## How to write a card" ends card scope).
			if (!/^##[ \t]+Verification\s*$/.test(line.trim())) {
				stepId = undefined;
				inTemplateCard = false;
			}
			kind = undefined;
			continue;
		}

		const section = sectionKind(line);
		if (section === "reset") {
			kind = undefined;
			continue;
		}
		if (section) {
			kind = section;
			resetNumbering();
			// Pre-scan existing IDs in this section so new IDs never collide.
			for (let look = index + 1; look < lines.length; look += 1) {
				const ahead = lines[look];
				if (FENCE.test(ahead) || STEP_HEADING.test(ahead)) break;
				const aheadSection = sectionKind(ahead);
				if (aheadSection) break;
				const checklist = ahead.match(CHECKLIST_LINE) ?? ahead.match(BARE_CHECKBOX_LINE);
				if (!checklist) continue;
				const id = existingId(checklist[2].trim());
				if (id && id.startsWith(`${stepId}.${kind}`)) {
					const number = Number(id.slice(`${stepId}.${kind}`.length));
					if (Number.isInteger(number) && number > 0) used.add(number);
				}
			}
			continue;
		}

		if (!kind || !stepId || inTemplateCard) continue;
		const checklist = line.match(CHECKLIST_LINE) ?? line.match(BARE_CHECKBOX_LINE);
		if (!checklist || checklist[1] === undefined) continue; // only checkbox items
		const text = checklist[2].trim();
		if (!text) continue; // empty template checkbox
		if (existingId(text)) continue; // already migrated
		while (used.has(nextNumber)) nextNumber += 1;
		const id = `${stepId}.${kind}${nextNumber}`;
		used.add(nextNumber);
		nextNumber += 1;
		lines[index] = line.replace(text, () => `[${id}] ${text}`);
		changed = true;
	}

	if (changed) notes.push({ level: "info", code: "ids_added", message: "stable IDs added to checklist items" });
	return { output: lines.join("\n"), changed, notes };
}

/**
 * Add schema_version and current_work_item_id to STATE.yaml, filling the ID
 * when the legacy text linkage is unambiguous.
 */
export function migrateStateSource(stateSource: string, stepsSource: string): MigrationEdit {
	const notes: MigrationNote[] = [];
	let output = stateSource;
	let changed = false;

	const versionMatch = output.match(/^schema_version:\s*(\S+)\s*$/m);
	if (!versionMatch) {
		const insertAt = output.search(/^[A-Za-z_][A-Za-z0-9_]*:/m);
		const line = "schema_version: 2\n";
		if (insertAt < 0) {
			output = output.endsWith("\n") || output.length === 0 ? `${output}${line}` : `${output}\n${line}`;
		} else {
			output = output.slice(0, insertAt) + line + output.slice(insertAt);
		}
		changed = true;
		notes.push({ level: "info", code: "schema_version_added", message: "schema_version: 2 added" });
	} else if (versionMatch[1] !== "2") {
		notes.push({ level: "warn", code: "schema_version_unexpected", message: `schema_version is ${versionMatch[1]}, expected 2` });
	}

	if (!/^current_work_item_id:/m.test(output)) {
		const itemMatch = output.match(/^current_work_item:.*$/m);
		const idLine = "current_work_item_id: null";
		if (itemMatch && itemMatch.index !== undefined) {
			const at = itemMatch.index;
			output = `${output.slice(0, at)}${idLine}\n${output.slice(at)}`;
		} else {
			const stepMatch = output.match(/^current_step:.*$/m);
			const at = stepMatch?.index !== undefined ? stepMatch.index + stepMatch[0].length : output.length;
			output = `${output.slice(0, at)}\n${idLine}${output.slice(at)}`;
		}
		changed = true;
		notes.push({ level: "info", code: "work_item_id_added", message: "current_work_item_id key added" });
	}

	// Try to fill current_work_item_id from an unambiguous text match.
	const idValue = output.match(/^current_work_item_id:\s*(\S+)\s*$/m)?.[1];
	const itemValue = output.match(/^current_work_item:\s*(.+)\s*$/m)?.[1]?.trim();
	const hasId = idValue && idValue !== "null" && idValue !== "~";
	if (!hasId && itemValue && itemValue !== "null" && itemValue !== "~") {
		const clean = itemValue.replace(/^["']|["']$/g, "");
		const needle = normalizeWorkItemText(clean);
		const stepMatch = output.match(/^current_step:\s*(\S+)\s*$/m);
		const currentStep = stepMatch?.[1];
		const matches: string[] = [];
		for (const card of scanStepIds(stepsSource)) {
			if (currentStep && card.stepId !== currentStep) continue;
			for (const item of card.items) {
				if (item.kind === "D" && item.id && normalizeWorkItemText(item.text) === needle) matches.push(item.id);
			}
		}
		if (matches.length === 1) {
			output = output.replace(/^current_work_item_id:.*$/m, `current_work_item_id: ${matches[0]}`);
			changed = true;
			notes.push({ level: "info", code: "work_item_id_filled", message: `current_work_item_id set to ${matches[0]}` });
		} else if (matches.length > 1) {
			notes.push({
				level: "warn",
				code: "work_item_id_ambiguous",
				message: `current_work_item matches ${matches.length} items; current_work_item_id left null`,
			});
		}
	}

	return { output, changed, notes };
}

type ScannedItem = { kind: ItemKind; id?: string; text: string };
type ScannedCard = { stepId: string; items: ScannedItem[] };

/** Lightweight scan of step cards and their checklist items (post-migration shape). */
export function scanStepIds(source: string): ScannedCard[] {
	const cards: ScannedCard[] = [];
	let inFence = false;
	let card: ScannedCard | undefined;
	let kind: ItemKind | undefined;
	for (const line of source.split("\n")) {
		if (FENCE.test(line)) {
			inFence = !inFence;
			kind = undefined;
			continue;
		}
		if (inFence) continue;
		const heading = line.match(STEP_HEADING);
		if (heading) {
			card = isTemplateCardTitle(heading[2]) ? undefined : { stepId: heading[1], items: [] };
			if (card) cards.push(card);
			kind = undefined;
			continue;
		}
		const section = sectionKind(line);
		if (section === "reset") {
			kind = undefined;
			continue;
		}
		if (section) {
			kind = section;
			continue;
		}
		if (!card || !kind) continue;
		const checklist = line.match(CHECKLIST_LINE) ?? line.match(BARE_CHECKBOX_LINE);
		if (!checklist || checklist[1] === undefined) continue;
		const text = checklist[2].trim();
		if (!text) continue;
		const id = existingId(text);
		card.items.push({ kind, id, text: id ? text.replace(ID_TOKEN, "").trim() : text });
	}
	return cards;
}

/** Read-only migration check: schema version, IDs, duplicates, linkage, enums. */
export function migrationCheck(stateSource: string, stepsSource: string): MigrationCheckResult {
	const findings: MigrationNote[] = [];
	const versionMatch = stateSource.match(/^schema_version:\s*(\S+)\s*$/m);
	const schemaVersion = versionMatch ? Number(versionMatch[1]) : null;
	if (!versionMatch) {
		findings.push({ level: "warn", code: "schema_version_missing", message: "schema_version missing (legacy v1)" });
	} else if (!Number.isFinite(schemaVersion as number) || schemaVersion !== 2) {
		findings.push({ level: "fail", code: "schema_version_invalid", message: `schema_version ${versionMatch[1]} is not 2` });
	}

	const cards = scanStepIds(stepsSource);
	const seen = new Map<string, string>();
	let missingIds = 0;
	for (const card of cards) {
		for (const item of card.items) {
			if (!item.id) {
				missingIds += 1;
				continue;
			}
			const owner = seen.get(item.id);
			if (owner) {
				findings.push({ level: "fail", code: "duplicate_id", message: `duplicate work item ID ${item.id}` });
			} else {
				seen.set(item.id, card.stepId);
			}
			const prefix = `${card.stepId}.`;
			if (!item.id.startsWith(prefix)) {
				findings.push({
					level: "warn",
					code: "id_wrong_step",
					message: `ID ${item.id} appears in step ${card.stepId}`,
				});
			}
		}
	}
	if (missingIds > 0) {
		findings.push({ level: "warn", code: "ids_missing", message: `legacy checklist without stable IDs (${missingIds} items)` });
	}

	// current_work_item linkage.
	const hasIdKey = /^current_work_item_id:/m.test(stateSource);
	const idValue = stateSource.match(/^current_work_item_id:\s*(\S+)\s*$/m)?.[1];
	const itemValue = stateSource.match(/^current_work_item:\s*(.+)\s*$/m)?.[1]?.trim();
	if (itemValue && itemValue !== "null" && itemValue !== "~") {
		const clean = itemValue.replace(/^["']|["']$/g, "");
		const needle = normalizeWorkItemText(clean);
		const exact = cards.flatMap(card => card.items).filter(item => item.kind === "D" && normalizeWorkItemText(item.text) === needle);
		if (exact.length === 0) {
			findings.push({ level: "warn", code: "work_item_unresolved", message: "current_work_item matches no checklist item exactly" });
		} else if (exact.length > 1) {
			findings.push({ level: "warn", code: "work_item_ambiguous", message: `current_work_item matches ${exact.length} items` });
		} else if (!hasIdKey || !idValue || idValue === "null" || idValue === "~") {
			findings.push({ level: "warn", code: "work_item_id_unset", message: "current_work_item is resolvable but current_work_item_id is unset" });
		}
	}

	// Legacy onboarding fields (informational until PR2 migrates them).
	if (/^\s{2}model_pairs_confirmed:/m.test(stateSource) && !/^\s{2}mode:/m.test(stateSource)) {
		findings.push({ level: "info", code: "onboarding_legacy", message: "legacy onboarding fields present (mode added in UX v2 PR2)" });
	}

	const enums: Array<[string, RegExp, Set<string>]> = [
		["implementation.status", /^implementation:\s*\n(?:[ \t]+\S.*\n)*?[ \t]+status:\s*(\S+)/m, new Set(["pending", "running", "waiting_review", "changes_requested", "blocked", "complete"])],
	];
	for (const [name, pattern, allowed] of enums) {
		const match = stateSource.match(pattern);
		if (match && !allowed.has(match[1])) {
			findings.push({ level: "warn", code: "enum_unknown", message: `unknown ${name} "${match[1]}"` });
		}
	}

	return { schemaVersion: versionMatch ? schemaVersion : null, findings };
}
