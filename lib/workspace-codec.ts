import { validateCourseDetails, validateDraft, type CourseDetails, type SyllabusDraft } from "./academics";
import { validateStudy, type StudyData } from "./study";
import { validateWidgetAppearanceState, type WidgetAppearanceState } from "./widget-appearance";
import { widgetSizes, type WidgetResizePriority, type WidgetSize } from "./widget-layout";
import { validateTodaySections, type TodaySectionId } from "./today-sections";
import type { FilesBrowserPreferences } from "./files-browser";
export { widgetSizes };
export type { WidgetSize };

export const widgetTypes = [
  "daily-goal",
  "weekly-goal",
  "upcoming",
  "stoplight",
  "red-alerts",
  "mini-calendar",
  "pomodoro",
  "focus-timer",
  "task-completion",
  "assignment-pie",
  "gpa",
  "class-links",
  "notes",
  "exams",
  "streak",
  "today",
  "quote",
  "spacer",
] as const;

export type WidgetType = (typeof widgetTypes)[number];

export type WidgetInstance = {
  instanceId: string;
  type: WidgetType;
  size: WidgetSize;
  note?: string;
  startsNewMiniBlock?: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  widgets: WidgetInstance[];
  todayHidden?: boolean;
  todaySections?: TodaySectionId[];
  resizePriorities?: WidgetResizePriority[];
};

type CompactWidget = [type: number, size: number, instanceId: string, noteIndex?: number];
type CompactWorkspace = [id: string, name: string, widgets: CompactWidget[]];
type CompactResizePriority = [workspaceId: string, widgetId: string, columns: 2 | 4, column: number, row: number];

export type CompactWorkspaceState = {
  v: 2;
  a: string;
  w: CompactWorkspace[];
  b?: string[];
  h?: string[];
  ts?: [workspaceId: string, sections: TodaySectionId[]][];
  rp?: CompactResizePriority[];
  n?: string;
  t?: string[];
  d?: WorkspaceData;
};

export type SavedAssignment = {
  id: string; title: string; courseId: string; due: string; dateKey: string;
  status: "overdue" | "today" | "later" | "done"; progress: number; description: string; weight: string;
  notes?: string; checklist?: boolean[];
  type?: "Assignment" | "Exam" | "Project"; dueTime?: string; completedAt?: string | null; progressBeforeCompletion?: number;
};
export type SavedEvent = { id: string; title: string; courseId: string; dateKey: string; time: string; type: string; description?: string; durationMinutes?: number };
export type WorkspaceData = {
  assignments: SavedAssignment[]; manualEvents: SavedEvent[];
  dashboardView: "cards" | "list";
  calendarFilter?: string; courseDetails?: Record<string, CourseDetails>; syllabusDrafts?: SyllabusDraft[];
  study?: StudyData;
  filePreferences?: FilesBrowserPreferences;
  widgetAppearance?: WidgetAppearanceState;
};

export type DecodedWorkspaceState = {
  activeWorkspaceId: string;
  workspaces: Workspace[];
  notes: string;
  data?: WorkspaceData;
};

export const MAX_WORKSPACES = 20;
export const MAX_WIDGETS_PER_WORKSPACE = 100;
export const MAX_NOTES_LENGTH = 20_000;
export const MAX_WORKSPACE_BYTES = 1_000_000;

/**
 * V2 retains stable widget identities and independent note text. The n field
 * holds legacy text only when no notes widget existed to receive it. Equal note
 * strings are packed once in t; references are rebuilt on each save, so edits
 * remain independent and large legacy layouts don't multiply shared text.
 * b stores the mini IDs that start a fresh block. Updated writers always emit
 * it, including an empty array, so legacy saves cannot erase placement choices.
 * h stores workspace IDs with a hidden Today section; an empty list explicitly
 * restores every section and distinguishes updated writers from older clients.
 * ts stores per-workspace Today content choices. An empty list uses the defaults
 * everywhere and distinguishes updated writers from older clients.
 * rp stores per-workspace widget placement priorities. An empty list
 * distinguishes updated writers from older clients.
 */
export function encodeWorkspaceState(
  workspaces: Workspace[],
  activeWorkspaceId: string,
  notes: string,
  data?: WorkspaceData,
): CompactWorkspaceState {
  if (!workspaces.length || workspaces.length > MAX_WORKSPACES) {
    throw new Error("A dashboard must contain between 1 and 20 workspaces.");
  }
  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) throw new Error("Duplicate workspace ID.");

  const texts: string[] = [], textIndexes = new Map<string, number>();
  const miniBlockStarts: string[] = [];
  const hiddenTodayWorkspaces: string[] = [];
  const todaySections: [string, TodaySectionId[]][] = [];
  const resizePriorities: CompactResizePriority[] = [];
  const compactWorkspaces: CompactWorkspace[] = workspaces.map((workspace) => {
    if (!workspace.id || workspace.id.length > 120) {
      throw new Error("Invalid workspace ID.");
    }
    if (!workspace.name.trim() || workspace.name.length > 80) {
      throw new Error("Invalid workspace name.");
    }
    if (workspace.todayHidden !== undefined && typeof workspace.todayHidden !== "boolean") throw new Error("Invalid Today section visibility.");
    if (workspace.todayHidden) hiddenTodayWorkspaces.push(workspace.id);
    if (workspace.todaySections !== undefined) todaySections.push([workspace.id, validateTodaySections(workspace.todaySections)]);
    if (workspace.widgets.length > MAX_WIDGETS_PER_WORKSPACE) {
      throw new Error("A workspace cannot contain more than 100 widgets.");
    }

    const widgets: CompactWidget[] = workspace.widgets.map((widget) => {
      const type = widgetTypes.indexOf(widget.type);
      const size = widgetSizes.indexOf(widget.size);
      if (type < 0 || size < 0) throw new Error("Invalid widget layout.");
      if (widget.startsNewMiniBlock !== undefined && typeof widget.startsNewMiniBlock !== "boolean") throw new Error("Invalid mini block placement.");
      if (widget.size === "mini" && widget.startsNewMiniBlock) miniBlockStarts.push(widget.instanceId);
      if (widget.type !== "notes") return [type, size, widget.instanceId];
      const note = widget.note ?? "";
      if (typeof note !== "string" || note.length > MAX_NOTES_LENGTH) throw new Error("Quick notes cannot exceed 20,000 characters.");
      if (!textIndexes.has(note)) { textIndexes.set(note, texts.length); texts.push(note); }
      return [type, size, widget.instanceId, textIndexes.get(note)!];
    });

    return [workspace.id, workspace.name.trim(), widgets];
  });

  const widgetWorkspaces = new Map<string, string>();
  for (const [workspaceId, , widgets] of compactWorkspaces) {
    for (const widget of widgets) {
      if (widgetWorkspaces.has(widget[2])) throw new Error("Invalid or duplicate widget ID.");
      widgetWorkspaces.set(widget[2], workspaceId);
    }
  }
  for (const workspace of workspaces) {
    if (workspace.resizePriorities === undefined) continue;
    if (!Array.isArray(workspace.resizePriorities) || workspace.resizePriorities.length > 2) throw new Error("Invalid widget resize priority.");
    const breakpoints = new Set<number>();
    for (const priority of workspace.resizePriorities) {
      if (!isRecord(priority) || typeof priority.widgetId !== "string" || !priority.widgetId.trim() || priority.widgetId.length > 120
        || (priority.columns !== 2 && priority.columns !== 4) || typeof priority.column !== "number" || !Number.isInteger(priority.column) || priority.column < 1 || priority.column > priority.columns
        || typeof priority.row !== "number" || !Number.isInteger(priority.row) || priority.row < 1 || priority.row > 399 || priority.row % 2 !== 1) throw new Error("Invalid widget resize priority.");
      if (breakpoints.has(priority.columns)) throw new Error("Invalid widget resize priority.");
      breakpoints.add(priority.columns);
      const owner = widgetWorkspaces.get(priority.widgetId);
      if (owner !== undefined && owner !== workspace.id) throw new Error("Invalid widget resize priority.");
      if (owner === workspace.id) resizePriorities.push([workspace.id, priority.widgetId, priority.columns, priority.column, priority.row]);
    }
  }

  if (notes.length > MAX_NOTES_LENGTH) {
    throw new Error("Quick notes cannot exceed 20,000 characters.");
  }

  const active = workspaces.some((workspace) => workspace.id === activeWorkspaceId)
    ? activeWorkspaceId
    : workspaces[0].id;

  const payload: CompactWorkspaceState = {
    v: 2,
    a: active,
    w: compactWorkspaces,
    b: miniBlockStarts,
    h: hiddenTodayWorkspaces,
    ts: todaySections,
    rp: resizePriorities,
    ...(texts.length ? { t: texts } : {}),
    ...(notes ? { n: notes } : {}),
    ...(data ? { d: validateWorkspaceData(data) } : {}),
  };
  decodeWorkspaceState(payload);
  return payload;
}

export function decodeWorkspaceState(value: unknown): DecodedWorkspaceState {
  if (!isRecord(value) || ![1, 2].includes(value.v as number) || typeof value.a !== "string" || !Array.isArray(value.w)) {
    throw new Error("Unsupported dashboard layout.");
  }
  if (!value.w.length || value.w.length > MAX_WORKSPACES) {
    throw new Error("Invalid workspace count.");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_WORKSPACE_BYTES) throw new Error("Workspace storage limit reached. Shorten notes or remove unused widgets before adding more content.");
  const notes = value.n === undefined ? "" : value.n;
  if (typeof notes !== "string" || notes.length > MAX_NOTES_LENGTH) throw new Error("Invalid quick notes.");
  const widgetIds = new Set<string>();
  const miniBlockStarts = value.b;
  if (miniBlockStarts !== undefined && (value.v !== 2 || !Array.isArray(miniBlockStarts)
    || miniBlockStarts.length > MAX_WORKSPACES * MAX_WIDGETS_PER_WORKSPACE
    || miniBlockStarts.some((id) => typeof id !== "string" || !id.trim() || id.length > 120)
    || new Set(miniBlockStarts).size !== miniBlockStarts.length)) throw new Error("Invalid mini block placement.");
  const miniBlockStartIds = new Set<string>(miniBlockStarts as string[] | undefined);
  const miniIds = new Set<string>();
  const hiddenTodayWorkspaces = value.h;
  if (hiddenTodayWorkspaces !== undefined && (value.v !== 2 || !Array.isArray(hiddenTodayWorkspaces)
    || hiddenTodayWorkspaces.length > MAX_WORKSPACES
    || hiddenTodayWorkspaces.some((id) => typeof id !== "string" || !id.trim() || id.length > 120)
    || new Set(hiddenTodayWorkspaces).size !== hiddenTodayWorkspaces.length)) throw new Error("Invalid Today section visibility.");
  const hiddenTodayWorkspaceIds = new Set<string>(hiddenTodayWorkspaces as string[] | undefined);
  const todaySections = new Map<string, TodaySectionId[]>();
  if (value.ts !== undefined) {
    if (value.v !== 2 || !Array.isArray(value.ts) || value.ts.length > MAX_WORKSPACES) throw new Error("Invalid Today section choices.");
    for (const entry of value.ts) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0].trim()
        || entry[0].length > 120 || todaySections.has(entry[0])) throw new Error("Invalid Today section choices.");
      todaySections.set(entry[0], validateTodaySections(entry[1]));
    }
  }
  const texts = value.t ?? [];
  if (!Array.isArray(texts) || texts.length > MAX_WORKSPACES * MAX_WIDGETS_PER_WORKSPACE || texts.some((text) => typeof text !== "string" || text.length > MAX_NOTES_LENGTH)) throw new Error("Invalid note content.");

  const workspaces = value.w.map((workspace, workspaceIndex): Workspace => {
    if (
      !Array.isArray(workspace) ||
      workspace.length !== 3 ||
      typeof workspace[0] !== "string" ||
      !workspace[0] ||
      workspace[0].length > 120 ||
      typeof workspace[1] !== "string" ||
      !workspace[1].trim() ||
      workspace[1].length > 80 ||
      !Array.isArray(workspace[2]) ||
      workspace[2].length > MAX_WIDGETS_PER_WORKSPACE
    ) {
      throw new Error("Invalid workspace layout.");
    }

    const widgets = workspace[2].map((widget, widgetIndex): WidgetInstance => {
      if (
        !Array.isArray(widget) ||
        (value.v === 1 ? widget.length !== 2 : widget.length !== (widget[0] === 12 ? 4 : 3)) ||
        !Number.isInteger(widget[0]) ||
        !Number.isInteger(widget[1]) ||
        !widgetTypes[widget[0]] ||
        !widgetSizes[widget[1]]
      ) {
        throw new Error("Invalid widget layout.");
      }
      const instanceId = value.v === 1 ? `legacy-${workspaceIndex}-${widgetIndex}` : widget[2];
      if (typeof instanceId !== "string" || !instanceId.trim() || instanceId.length > 120 || widgetIds.has(instanceId)) throw new Error("Invalid or duplicate widget ID.");
      widgetIds.add(instanceId);
      if (widgetSizes[widget[1]] === "mini") miniIds.add(instanceId);
      if (value.v === 2 && widgetTypes[widget[0]] === "notes" && (!Number.isInteger(widget[3]) || widget[3] < 0 || widget[3] >= texts.length)) throw new Error("Invalid note reference.");
      const note = value.v === 1 ? notes : texts[widget[3]];
      if (widgetTypes[widget[0]] === "notes" && (typeof note !== "string" || note.length > MAX_NOTES_LENGTH)) throw new Error("Quick notes cannot exceed 20,000 characters.");

      return {
        instanceId,
        type: widgetTypes[widget[0]],
        size: widgetSizes[widget[1]],
        ...(miniBlockStartIds.has(instanceId) ? { startsNewMiniBlock: true } : {}),
        ...(widgetTypes[widget[0]] === "notes" ? { note } : {}),
      };
    });

    return { id: workspace[0], name: workspace[1].trim(), widgets,
      ...(hiddenTodayWorkspaceIds.has(workspace[0]) ? { todayHidden: true } : {}),
      ...(todaySections.has(workspace[0]) ? { todaySections: todaySections.get(workspace[0])! } : {}),
    };
  });

  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) throw new Error("Duplicate workspace ID.");
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  if ([...hiddenTodayWorkspaceIds].some((id) => !workspaceIds.has(id))) throw new Error("Invalid Today section visibility.");
  if ([...todaySections.keys()].some((id) => !workspaceIds.has(id))) throw new Error("Invalid Today section choices.");
  if ([...miniBlockStartIds].some((id) => !miniIds.has(id))) throw new Error("Invalid mini block placement.");

  const resizePrioritiesByWorkspace = new Map<string, WidgetResizePriority[]>();
  if (value.rp !== undefined) {
    if (value.v !== 2 || !Array.isArray(value.rp) || value.rp.length > 40) throw new Error("Invalid widget resize priority.");
    const widgetIdsByWorkspace = new Map(workspaces.map((workspace) => [workspace.id, new Set(workspace.widgets.map((widget) => widget.instanceId))]));
    const breakpoints = new Set<string>();
    for (const entry of value.rp) {
      if (!Array.isArray(entry) || entry.length !== 5) throw new Error("Invalid widget resize priority.");
      const [workspaceId, widgetId, columns, column, row] = entry;
      if (typeof workspaceId !== "string" || !workspaceId.trim() || workspaceId.length > 120
        || typeof widgetId !== "string" || !widgetId.trim() || widgetId.length > 120
        || (columns !== 2 && columns !== 4) || !Number.isInteger(column) || column < 1 || column > columns
        || !Number.isInteger(row) || row < 1 || row > 399 || row % 2 !== 1) throw new Error("Invalid widget resize priority.");
      const widgetIds = widgetIdsByWorkspace.get(workspaceId);
      if (!widgetIds?.has(widgetId)) throw new Error("Invalid widget resize priority.");
      const breakpoint = `${workspaceId}\u0000${columns}`;
      if (breakpoints.has(breakpoint)) throw new Error("Invalid widget resize priority.");
      breakpoints.add(breakpoint);
      const priorities = resizePrioritiesByWorkspace.get(workspaceId) ?? [];
      priorities.push({ widgetId, columns, column, row });
      resizePrioritiesByWorkspace.set(workspaceId, priorities);
    }
  }

  return {
    activeWorkspaceId: workspaces.some((workspace) => workspace.id === value.a)
      ? value.a
      : workspaces[0].id,
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      ...(resizePrioritiesByWorkspace.has(workspace.id) ? { resizePriorities: resizePrioritiesByWorkspace.get(workspace.id)! } : {}),
    })),
    notes: value.v === 1 && workspaces.some((workspace) => workspace.widgets.some((widget) => widget.type === "notes")) ? "" : notes,
    ...(value.d !== undefined ? { data: validateWorkspaceData(value.d) } : {}),
  };
}

function validateWorkspaceData(value: unknown): WorkspaceData {
  if (!isRecord(value) || !Array.isArray(value.assignments) || value.assignments.length > 2000 || !Array.isArray(value.manualEvents) || value.manualEvents.length > 2000) throw new Error("Invalid workspace data.");
  if (!["cards", "list"].includes(value.dashboardView as string)) throw new Error("Invalid workspace view.");
  const bounded = (record: Record<string, unknown>, key: string, max = 500) => {
    if (typeof record[key] !== "string" || (record[key] as string).length > max) throw new Error(`Invalid ${key}.`);
  };
  for (const item of value.assignments) {
    if (!isRecord(item)) throw new Error("Invalid assignment.");
    for (const key of ["id", "title", "courseId", "due", "dateKey", "weight"]) bounded(item, key);
    bounded(item, "description", 20000);
    if (item.notes !== undefined) bounded(item, "notes", 20000);
    if (!item.id || !item.title || !["overdue", "today", "later", "done"].includes(item.status as string) || typeof item.progress !== "number" || !Number.isFinite(item.progress) || item.progress < 0 || item.progress > 100) throw new Error("Invalid assignment progress.");
    if (item.checklist !== undefined && (!Array.isArray(item.checklist) || item.checklist.length !== 3 || item.checklist.some((item) => typeof item !== "boolean"))) throw new Error("Invalid assignment checklist.");
  }
  for (const item of value.manualEvents) {
    if (!isRecord(item)) throw new Error("Invalid calendar event.");
    for (const key of ["id", "title", "courseId", "dateKey", "time", "type"]) bounded(item, key);
    if (!item.id || !item.title) throw new Error("Invalid calendar event.");
    if (item.durationMinutes !== undefined && (!Number.isInteger(item.durationMinutes) || Number(item.durationMinutes) < 1 || Number(item.durationMinutes) > 1440)) throw new Error("Invalid event duration.");
  }
  if (JSON.stringify(value).length > 500000) throw new Error("Workspace data is too large.");
  const normalized = { ...value };
  // Older snapshots stored the calendar view here. Ignore it while decoding so
  // the next real save naturally removes the obsolete account preference.
  delete normalized.calendarView;
  for (const items of [value.assignments, value.manualEvents]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Duplicate record ID.");
  }
  if (value.calendarFilter !== undefined && (typeof value.calendarFilter !== "string" || value.calendarFilter.length > 120)) throw new Error("Invalid calendar filter.");
  if (value.study !== undefined) validateStudy(value.study);
  if (value.filePreferences !== undefined && (!isRecord(value.filePreferences) || typeof value.filePreferences.filter !== "string" || value.filePreferences.filter.length > 120 || !["list", "grid"].includes(String(value.filePreferences.view)))) throw new Error("Invalid file preferences.");
  if (isRecord(value.filePreferences)) {
    const preferences = value.filePreferences;
    const fields = new Set(["filter", "view", "sortBy", "sortDirection", "fileType", "includeArchived", "appearanceVersion"]);
    if (Object.keys(preferences).some((key) => !fields.has(key)) ||
        (preferences.appearanceVersion !== undefined && preferences.appearanceVersion !== 2) ||
        (preferences.sortBy !== undefined && (typeof preferences.sortBy !== "string" || !["name", "modified"].includes(preferences.sortBy))) ||
        (preferences.sortDirection !== undefined && (typeof preferences.sortDirection !== "string" || !["asc", "desc"].includes(preferences.sortDirection))) ||
        (preferences.fileType !== undefined && (typeof preferences.fileType !== "string" || !["all", "text", "pdf", "image", "other"].includes(preferences.fileType))) ||
        (preferences.includeArchived !== undefined && typeof preferences.includeArchived !== "boolean")) throw new Error("Invalid file preferences.");
  }
  if (value.courseDetails !== undefined) { if (!isRecord(value.courseDetails) || Object.keys(value.courseDetails).length > 100) throw new Error("Invalid class details."); Object.values(value.courseDetails).forEach(validateCourseDetails); }
  if (value.syllabusDrafts !== undefined) { if (!Array.isArray(value.syllabusDrafts) || value.syllabusDrafts.length > 10) throw new Error("Keep at most 10 syllabus reviews."); value.syllabusDrafts.forEach(validateDraft); if (new Set(value.syllabusDrafts.map((d) => d.id)).size !== value.syllabusDrafts.length) throw new Error("Duplicate syllabus review ID."); }
  return { ...normalized, ...(value.widgetAppearance !== undefined ? { widgetAppearance: validateWidgetAppearanceState(value.widgetAppearance) } : {}) } as WorkspaceData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
