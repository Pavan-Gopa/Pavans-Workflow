import {
	renderDashboard,
	type DashboardViewModel,
	type RenderResult,
	type StatsFooterInfo,
} from "./workflow-dashboard-core.ts";

const MAX_EXPANDED_BODY_HEIGHT = 4096;
const PLAN_WINDOW_MARKER = /(?:↑\s+\d+\s+earlier|↓\s+\d+\s+later)/;
const DETAIL_WINDOW_MARKER = /(?:↑\s+\d+\s+detail lines?|↓\s+\d+\s+more detail lines?)/;

export type ExpandedDashboardRender = RenderResult & {
	bodyHeight: number;
	expanded: boolean;
};

export function dashboardHasWindowMarkers(result: RenderResult): boolean {
	return result.lines.some(line => PLAN_WINDOW_MARKER.test(line.text) || DETAIL_WINDOW_MARKER.test(line.text));
}

/**
 * Render the dashboard at its natural terminal body height first. If any
 * existing per-column window is still hiding plan/checklist/Todo content,
 * progressively enlarge the logical body until those windows disappear.
 *
 * The caller then places these complete logical lines inside one outer
 * ScrollView. This keeps short dashboards exactly as compact as before while
 * making long dashboards fully reachable instead of replacing content with
 * "N more detail lines" placeholders.
 */
export function renderExpandedDashboard(
	view: DashboardViewModel,
	width: number,
	minimumBodyHeight: number,
	statsFooter?: StatsFooterInfo,
): ExpandedDashboardRender {
	const initialHeight = Math.max(8, Math.trunc(minimumBodyHeight));
	let bodyHeight = initialHeight;
	let result = renderDashboard(view, width, bodyHeight, 0, statsFooter);

	for (let attempt = 0; attempt < 10; attempt += 1) {
		const hasMarkers = dashboardHasWindowMarkers(result);
		if (!hasMarkers && result.maxDetailScroll === 0) break;
		if (bodyHeight >= MAX_EXPANDED_BODY_HEIGHT) break;

		const detailDeficit = Math.max(0, result.maxDetailScroll);
		const growth = Math.max(8, detailDeficit, Math.ceil(bodyHeight * 0.5));
		bodyHeight = Math.min(MAX_EXPANDED_BODY_HEIGHT, bodyHeight + growth);
		result = renderDashboard(view, width, bodyHeight, 0, statsFooter);
	}

	return {
		...result,
		bodyHeight,
		expanded: bodyHeight > initialHeight,
	};
}
