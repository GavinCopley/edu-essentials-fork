import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/" });
for (const name of ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout engine. Model visible controls through offsetParent so the
// dialog's actual focus trap can still be exercised by keyboard events.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get() {
    if (!this.isConnected) return null;
    for (let node = this.parentElement; node; node = node.parentElement) {
      if (node.tagName === "DETAILS" && !node.open) return null;
      if (node.hidden) return null;
    }
    return dom.window.document.body;
  },
});
after(() => dom.window.close());
afterEach(async () => { if (root) await unmount(); });

const [{ createElement, act }, { createRoot }, { default: Workspace }, { default: WidgetCustomization }, { validateProfile }, { encodeWorkspaceState, decodeWorkspaceState }, { academicSnapshot }, { emptyStudy }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/workspace-client.tsx")),
  import(await clientModule("app/widget-customization.tsx")),
  import(await clientModule("lib/profile.ts")),
  import(await clientModule("lib/workspace-codec.ts")),
  import(await clientModule("lib/academic-snapshot.ts")),
  import(await clientModule("lib/study.ts")),
]);

const baseProfile = {
  ...validateProfile({ display_name: "Alex", major: "History", study_goal: "Read every day" }),
  id: "profile-a", auth_user_id: "user-a", email: "alex@example.invalid", avatar_url: null,
  initialized: true, updated_at: "2026-10-01T00:00:00.000Z", onboarding_completed_at: "2026-09-30T00:00:00.000Z",
};
const course = { id: "history", code: "HIST 205", name: "History", credits: 3, instructor: "Teacher", room: "Hall", color: "#112233", soft: "#11223318", initials: "HI" };
const savedAssignment = { id: "essay", title: "Archive analysis", courseId: "history", due: "2099-10-08", dateKey: "2099-10-08", status: "later", progress: 30, description: "Saved academic work", weight: "", type: "Assignment" };
const savedEvent = { id: "seminar", title: "Research seminar", courseId: "history", dateKey: "2099-10-09", time: "10:00", type: "Study block" };
const savedStudy = { ...emptyStudy(), dailyMinutes: 45, weeklyMinutes: 240, grades: [{ id: "grade-a", courseId: "history", system: "4.0 scale", term: "Fall", max: 4, value: 3.5 }] };
const savedDashboard = encodeWorkspaceState([
  { id: "day", name: "My Day", widgets: [
    { instanceId: "notes", type: "notes", size: "large", note: "Saved notes" },
    { instanceId: "alerts", type: "red-alerts", size: "small" },
    { instanceId: "timer", type: "pomodoro", size: "medium" },
  ] },
], "day", "", {
  assignments: [savedAssignment], manualEvents: [savedEvent], dashboardView: "cards", calendarView: "month",
  calendarFilter: "all", study: savedStudy, filePreferences: { filter: "all", view: "list" },
});

const rootNode = document.getElementById("root");
let root, fetcher, server, filesFetcher;
globalThis.fetch = (...args) => String(args[0]).startsWith("/api/files")
  ? filesFetcher ? filesFetcher(...args) : Response.json({ files: [] })
  : fetcher(...args);
window.confirm = () => true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};

function reset({ preserveServer = false } = {}) {
  window.history.replaceState({}, "", "/home");
  rootNode.innerHTML = "";
  if (!preserveServer) server = undefined;
  filesFetcher = undefined;
  root = createRoot(rootNode);
}
async function render(component, props) { await act(async () => { root.render(createElement(component, props)); await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function unmount() { await act(async () => root.unmount()); root = undefined; rootNode.innerHTML = ""; }
function unloadBlocked() { const event = new window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
async function waitUntil(predicate, description, timeoutMs = 3000) {
  let remaining = timeoutMs;
  await act(async () => {
    while (!predicate() && remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining -= 25;
    }
  });
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}
function installServer(dashboard = savedDashboard, courses = [course]) {
  server = { dashboard: structuredClone(dashboard), courses: structuredClone(courses), profile: structuredClone(baseProfile), revision: baseProfile.updated_at, writes: 0 };
  fetcher = async (_url, init = {}) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      if (body.baseRevision !== server.revision) return Response.json({}, { status: 409 });
      const snapshot = academicSnapshot(body.courses, body.dashboard);
      server.dashboard = snapshot.dashboard;
      server.courses = snapshot.courses;
      server.writes++;
      server.revision = new Date(Date.parse(server.revision) + 1000).toISOString();
      return Response.json({ ok: true, revision: server.revision });
    }
    return Response.json({ initialized: true, courses: server.courses, dashboard: server.dashboard, revision: server.revision, profile: server.profile });
  };
  return server;
}
function button(text, scope = rootNode) {
  const found = [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function click(text, scope = rootNode) {
  const control = button(text, scope);
  await act(async () => control.click());
}
async function clickAria(label, scope = rootNode) {
  const control = [...scope.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
  assert.ok(control, `Missing button ${label}`);
  await act(async () => control.click());
}
function labeledControl(label, scope = rootNode) {
  const labelNode = [...scope.querySelectorAll("label")].find((node) => node.textContent.trim() === label);
  assert.ok(labelNode, `Missing control label ${label}`);
  const id = labelNode.htmlFor;
  const control = scope.querySelector(`[id="${id}"]`);
  assert.ok(control, `Missing input for ${label}`);
  return control;
}
async function edit(label, value, scope = rootNode) {
  const input = labeledControl(label, scope);
  await act(async () => {
    if (input.type === "checkbox") {
      if (input.checked !== value) input.click();
    } else {
      const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
  });
}
async function waitForAutosave() {
  if (unloadBlocked()) await waitUntil(() => !unloadBlocked(), "workspace autosave");
  assert.equal(unloadBlocked(), false, "workspace autosave finishes before reload");
}
async function saveAndReload() {
  await waitForAutosave();
  await unmount();
  reset({ preserveServer: true });
  await render(Workspace, { initialProfile: baseProfile });
}
async function saveCurrent() {
  const previousWrites = server.writes;
  await waitForAutosave();
  assert.equal(server.writes, previousWrites + 1, "the workspace autosave should write one revision");
}
function dashboardData() { return decodeWorkspaceState(server.dashboard).data; }
function appearanceDialog() { return rootNode.querySelector('[role="dialog"][aria-labelledby="wa-title"]'); }
async function setScope(id, scope = appearanceDialog()) {
  const select = scope.querySelector("#wa-scope");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, id);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function openWidgetMenu(instanceId) {
  const card = rootNode.querySelector(`[data-widget-id="${instanceId}"]`);
  assert.ok(card, `Missing widget ${instanceId}`);
  const trigger = card.querySelector(".widget-header .menu-wrap > button");
  assert.ok(trigger, `Missing widget menu trigger for ${instanceId}`);
  await act(async () => trigger.click());
  return rootNode.querySelector(`[data-widget-id="${instanceId}"] .widget-menu`);
}

test("widget appearance opens from the workspace toolbar and exposes its complete accessible studio", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });

  const actions = rootNode.querySelector(".workspace-actions");
  assert.equal(actions.querySelectorAll("button")[0].classList.contains("widget-customization-trigger"), true);
  assert.equal(actions.querySelectorAll("button")[1].textContent.trim(), "Customize");
  await act(async () => { actions.querySelector(".widget-customization-trigger").focus(); actions.querySelector(".widget-customization-trigger").click(); });
  const dialog = appearanceDialog();
  assert.ok(dialog, "toolbar action should open the appearance dialog");
  assert.equal(document.activeElement.id, "wa-tab-basic", "initial keyboard focus enters the studio");
  assert.match(dialog.textContent, /Changes stay in this draft until you apply them/);
  assert.equal(dialog.querySelectorAll("#wa-panel-basic .wa-control").length, 8);
  assert.equal(rootNode.querySelectorAll(".wa-preview-card").length, 6);
  assert.ok(rootNode.querySelector(".wa-preview-cards.widget-grid"), "the appearance gallery uses the shared responsive widget grid");
  assert.deepEqual(
    [...rootNode.querySelectorAll(".wa-preview-card")].map((card) => card.dataset.size),
    ["mini", "mini", "small", "medium", "medium-vertical", "large"],
    "the board preview gallery demonstrates all five footprints, with two mini cards",
  );
  assert.equal(server.writes, 0);

  await click("Advanced", dialog);
  const advanced = dialog.querySelector("#wa-panel-advanced");
  assert.equal(advanced.querySelectorAll(".wa-control").length, 21, "all advanced controls should be available after removing board size sliders");
  assert.equal([...advanced.querySelectorAll("label")].some((label) => /Medium (width|height) reference/.test(label.textContent)), false, "board geometry has no obsolete width or height controls");
  assert.ok(labeledControl("Space between cards", advanced), "board layout retains the shared gap control");
  const boardControls = [...advanced.querySelectorAll(".wa-control-group")].find((group) => group.querySelector("summary strong")?.textContent === "Board layout");
  assert.equal(boardControls.querySelectorAll(".wa-control").length, 1, "board layout exposes only its shared gap control");
  assert.equal(advanced.textContent.includes("Content overflow"), false, "content behavior is not a per-widget sizing control");
  assert.equal(advanced.querySelector(".wa-control-group").querySelector('input[type="range"]').min, "8");
  assert.equal(advanced.querySelector(".wa-control-group").querySelector('input[type="range"]').max, "32");

  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
  assert.notEqual(document.activeElement, rootNode.querySelector('[aria-label="Search assignments, classes, and files"]'), "Ctrl+K must not move focus out of an open studio");
  assert.ok(appearanceDialog(), "Ctrl+K keeps the appearance studio open");

  // Exercise the real focus boundary handlers with the jsdom visibility shim.
  const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null);
  const first = focusable[0], last = focusable.at(-1);
  last.focus();
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  assert.equal(document.activeElement, first, "Tab from the final control wraps to the first control");
  first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, shiftKey: true })));
  assert.equal(document.activeElement, last, "Shift+Tab from the first control wraps to the final control");

  await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(appearanceDialog(), null, "Escape closes the studio");
  assert.equal(document.activeElement, actions.querySelector(".widget-customization-trigger"), "focus returns to the toolbar action");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rootNode.querySelector('[aria-label="Search assignments, classes, and files"]'), "Ctrl+K focuses workspace search after the studio closes");
  assert.equal(server.writes, 0);
});

test("appearance drafts preview without writing, cancel discards, and Apply saves through reload", async () => {
  reset(); const initial = installServer();
  await render(Workspace, { initialProfile: baseProfile });

  await click("Widget customization");
  await edit("Accent color", "#e32655", appearanceDialog());
  assert.equal(appearanceDialog().querySelector(".wa-preview-card").style.getPropertyValue("--wa-accent"), "#e32655");
  await clickAria("Enlarge preview", appearanceDialog());
  assert.equal(appearanceDialog().querySelector(".wa-controls-panel").hidden, true, "enlarged preview hides the controls pane");
  assert.equal(appearanceDialog().querySelector(".wa-preview-card").style.getPropertyValue("--wa-accent"), "#e32655", "enlarging preserves the live draft preview");
  await clickAria("Show appearance controls", appearanceDialog());
  assert.equal(appearanceDialog().querySelector(".wa-controls-panel").hidden, false);
  assert.equal(labeledControl("Accent color", appearanceDialog()).value, "#e32655", "restoring controls preserves the edited draft value");
  assert.equal(server.writes, 0, "editing a preview does not persist");
  await click("Cancel", appearanceDialog());
  assert.equal(appearanceDialog(), null);
  await click("Widget customization");
  assert.equal(labeledControl("Accent color", appearanceDialog()).value, "#6674ff", "reopening starts from the saved appearance after Cancel");
  assert.equal(server.writes, 0);

  await edit("Corner radius", "24", appearanceDialog());
  assert.equal(appearanceDialog().querySelector(".wa-preview-card").style.getPropertyValue("--wa-radius"), "calc(24 * var(--desktop-density-unit, 1px))");
  await click("Apply appearance", appearanceDialog());
  assert.equal(appearanceDialog(), null, "Apply closes the dialog after accepting the draft");
  assert.equal(server.writes, 0, "Apply enters the ordinary workspace autosave flow");
  const saveToast = rootNode.querySelector(".save-toast-card");
  assert.ok(saveToast, "the debounced workspace save is announced");
  assert.match(saveToast.textContent, /Saving workspace/);
  assert.equal(saveToast.querySelectorAll("button, a").length, 0, "ordinary saving exposes no recovery controls");
  await saveAndReload();

  assert.equal(server.writes, 1);
  assert.equal(dashboardData().widgetAppearance.defaults.radius, 24);
  assert.equal(rootNode.querySelector('[data-widget-id="notes"]').style.getPropertyValue("--wa-radius"), "calc(24 * var(--desktop-density-unit, 1px))");
  assert.equal(server.profile.major, initial.profile.major);
  assert.equal(server.profile.study_goal, initial.profile.study_goal);
  assert.deepEqual(server.courses, [course]);
  assert.deepEqual(dashboardData().assignments, [savedAssignment]);
  assert.deepEqual(dashboardData().manualEvents, [savedEvent]);
  assert.deepEqual(dashboardData().study.grades, savedStudy.grades);
  assert.equal(dashboardData().study.dailyMinutes, savedStudy.dailyMinutes);
});

test("all five size choices persist across reload, and note duplication or deletion preserves academic work", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });

  const choices = [
    { value: "mini", label: "Mini" },
    { value: "small", label: "Small" },
    { value: "medium", label: "Medium horizontal" },
    { value: "large", label: "Large" },
    { value: "medium-vertical", label: "Medium vertical" },
  ];
  const expectedLabels = ["Mini widget", "Small widget", "Medium horizontal widget", "Medium vertical widget", "Large widget"];
  let decoded;
  let noteWidget;
  for (const choice of choices) {
    const menu = await openWidgetMenu("notes");
    assert.deepEqual(
      [...menu.querySelectorAll(".size-options button")].map((control) => control.getAttribute("aria-label")),
      expectedLabels,
      "the widget menu exposes all five named footprints",
    );
    const control = [...menu.querySelectorAll(".size-options button")].find((item) => item.getAttribute("aria-label") === `${choice.label} widget`);
    assert.ok(control, `Missing ${choice.label} size option`);
    await act(async () => control.click());
    assert.equal(rootNode.querySelector('[data-widget-id="notes"]').dataset.size, choice.value, `${choice.label} updates the selected widget`);

    await saveAndReload();
    decoded = decodeWorkspaceState(server.dashboard);
    noteWidget = decoded.workspaces.flatMap((workspace) => workspace.widgets).find((widget) => widget.instanceId === "notes");
    assert.equal(noteWidget.size, choice.value, `${choice.label} survives save and reload`);
    assert.equal(noteWidget.note, "Saved notes", `${choice.label} preserves the note text`);
    assert.equal(rootNode.querySelector('[data-widget-id="notes"] textarea')?.value, "Saved notes");
  }

  let menu = await openWidgetMenu("notes");
  await click("Duplicate", menu);
  const duplicatedNotes = [...rootNode.querySelectorAll(".widget-card.widget-notes")];
  assert.equal(duplicatedNotes.length, 2);
  const duplicateId = duplicatedNotes.find((card) => card.dataset.widgetId !== "notes").dataset.widgetId;
  assert.equal(rootNode.querySelector(`[data-widget-id="${duplicateId}"]`).dataset.size, "medium-vertical");
  assert.equal(rootNode.querySelector(`[data-widget-id="${duplicateId}"] textarea`)?.value, "Saved notes");
  await saveAndReload();

  decoded = decodeWorkspaceState(server.dashboard);
  let widgets = decoded.workspaces.flatMap((workspace) => workspace.widgets);
  const duplicateWidget = widgets.find((widget) => widget.instanceId === duplicateId);
  assert.equal(duplicateWidget?.size, "medium-vertical", "a duplicate keeps the source footprint after reload");
  assert.equal(duplicateWidget?.note, "Saved notes", "a duplicate keeps the source note after reload");

  menu = await openWidgetMenu(duplicateId);
  await click("Remove", menu);
  await saveAndReload();
  decoded = decodeWorkspaceState(server.dashboard);
  widgets = decoded.workspaces.flatMap((workspace) => workspace.widgets);
  assert.equal(widgets.some((widget) => widget.instanceId === duplicateId), false, "removing the duplicate deletes that note widget");
  noteWidget = widgets.find((widget) => widget.instanceId === "notes");
  assert.equal(noteWidget?.size, "medium-vertical", "deleting a duplicate leaves the source footprint intact");
  assert.equal(noteWidget?.note, "Saved notes", "deleting a duplicate leaves the source note intact");

  assert.deepEqual(server.courses, [course]);
  assert.deepEqual(dashboardData().assignments, [savedAssignment]);
  assert.deepEqual(dashboardData().manualEvents, [savedEvent]);
  assert.deepEqual(dashboardData().study.grades, savedStudy.grades);
  assert.equal(dashboardData().study.dailyMinutes, savedStudy.dailyMinutes);
});

test("appearance history, per-widget overrides, and board reset stay scoped", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });
  await click("Widget customization");
  const dialog = appearanceDialog();
  await edit("Accent color", "#e32655", dialog);
  assert.equal(dialog.querySelector(".wa-preview-card").style.getPropertyValue("--wa-accent"), "#e32655");
  await clickAria("Undo appearance change", dialog);
  assert.equal(labeledControl("Accent color", dialog).value, "#6674ff");
  await clickAria("Redo appearance change", dialog);
  assert.equal(labeledControl("Accent color", dialog).value, "#e32655");
  await clickAria("Undo appearance change", dialog);
  assert.equal(labeledControl("Accent color", dialog).value, "#6674ff");

  await setScope("notes", dialog);
  assert.equal(labeledControl("Accent color", dialog).value, "#6674ff", "new widget scope starts from its inherited appearance");
  await click("Advanced", dialog);
  const boardLayout = [...dialog.querySelectorAll(".wa-control-group")].find((group) => group.querySelector("summary strong")?.textContent === "Board layout");
  assert.ok(boardLayout, "advanced settings include board layout controls");
  for (const label of ["Space between cards"]) {
    assert.equal(labeledControl(label, boardLayout).disabled, true, `${label} is disabled when editing one widget`);
  }
  await click("Basic", dialog);
  await edit("Accent color", "#1759d1", dialog);
  assert.equal(dialog.querySelector('.wa-preview-card[data-wa-show-icons]')?.style.getPropertyValue("--wa-accent"), "#1759d1");
  await click("Apply appearance", dialog);
  await saveAndReload();

  const state = dashboardData().widgetAppearance;
  assert.equal(state.defaults.accent, "#6674ff", "editing one widget does not change the board default");
  assert.equal(state.overrides.notes.accent, "#1759d1");
  assert.equal(rootNode.querySelector('[data-widget-id="notes"]').style.getPropertyValue("--wa-accent"), "#1759d1");
  assert.equal(rootNode.querySelector('[data-widget-id="alerts"]').style.getPropertyValue("--wa-accent"), "#6674ff");

  await click("Widget customization");
  await click("Reset all widgets", appearanceDialog());
  assert.equal(labeledControl("Accent color", appearanceDialog()).value, "#6674ff");
  assert.equal(labeledControl("Corner radius", appearanceDialog()).value, "14");
  await click("Apply appearance", appearanceDialog());
  await saveAndReload();
  assert.equal(dashboardData().widgetAppearance.defaults.radius, 14);
  assert.deepEqual(dashboardData().widgetAppearance.overrides, {}, "global reset clears every per-widget override");
});

test("widget and workspace duplicates copy overrides, while removing widgets prunes them", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });

  await click("Widget customization");
  await setScope("notes");
  await edit("Accent color", "#1759d1", appearanceDialog());
  await click("Apply appearance", appearanceDialog());
  await saveCurrent();
  assert.equal(dashboardData().widgetAppearance.overrides.notes.accent, "#1759d1");

  let menu = await openWidgetMenu("notes");
  await click("Duplicate", menu);
  let notes = [...rootNode.querySelectorAll(".widget-card.widget-notes")];
  assert.equal(notes.length, 2);
  const copiedWidgetId = notes.find((card) => card.dataset.widgetId !== "notes").dataset.widgetId;
  assert.equal(notes.find((card) => card.dataset.widgetId === copiedWidgetId).style.getPropertyValue("--wa-accent"), "#1759d1");
  await saveCurrent();
  assert.equal(dashboardData().widgetAppearance.overrides[copiedWidgetId].accent, "#1759d1", "duplicating a widget copies its override to the new identity");

  await clickAria("Workspace options");
  await click("Duplicate", rootNode.querySelector(".workspace-menu"));
  assert.ok(rootNode.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes("copy"));
  notes = [...rootNode.querySelectorAll(".widget-card.widget-notes")];
  assert.equal(notes.length, 2, "the duplicated workspace contains both note widgets");
  assert.ok(notes.every((card) => card.style.getPropertyValue("--wa-accent") === "#1759d1"), "workspace duplicate copies each source widget override");
  const copiedWorkspaceWidgetIds = notes.map((card) => card.dataset.widgetId);
  await saveCurrent();
  for (const id of copiedWorkspaceWidgetIds) assert.equal(dashboardData().widgetAppearance.overrides[id].accent, "#1759d1");

  await click("My Day");
  notes = [...rootNode.querySelectorAll(".widget-card.widget-notes")];
  assert.equal(notes.length, 2, "the source workspace retains its original note widgets");
  assert.ok(notes.every((card) => card.style.getPropertyValue("--wa-accent") === "#1759d1"));
  menu = await openWidgetMenu("notes");
  await click("Remove", menu);
  await saveCurrent();
  assert.equal(dashboardData().widgetAppearance.overrides.notes, undefined, "removing a widget prunes only that widget's override");
  assert.equal(dashboardData().widgetAppearance.overrides[copiedWidgetId].accent, "#1759d1");

  menu = await openWidgetMenu(copiedWidgetId);
  await click("Remove", menu);
  await saveCurrent();
  assert.equal(dashboardData().widgetAppearance.overrides[copiedWidgetId], undefined);

  const copiedWorkspaceTab = [...rootNode.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes("copy"));
  assert.ok(copiedWorkspaceTab);
  await act(async () => copiedWorkspaceTab.click());
  for (const id of copiedWorkspaceWidgetIds) {
    menu = await openWidgetMenu(id);
    await click("Remove", menu);
    await saveCurrent();
  }
  assert.deepEqual(dashboardData().widgetAppearance.overrides, {}, "removing the remaining overridden widgets prunes their entries");
});

test("appearance applies in experimental mode only to the preview and never writes", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });
  await clickAria("Experimental mode");
  await clickAria("Load Clear experimental data");
  assert.match(rootNode.textContent, /Clear experimental mode/);
  await click("Widget customization");
  await edit("Accent color", "#b12fc1", appearanceDialog());
  await click("Apply appearance", appearanceDialog());
  assert.match(rootNode.textContent, /Appearance preview updated — nothing saved to your account/);
  assert.equal(server.writes, 0);
  assert.equal(appearanceDialog(), null);
});

test("a rejected Apply keeps the edited draft open for correction", async () => {
  reset();
  let calls = 0;
  await render(WidgetCustomization, {
    value: undefined,
    widgets: [{ instanceId: "notes", title: "Quick Notes", size: "large" }],
    onClose: () => { calls++; },
    onApply: () => false,
  });
  const dialog = appearanceDialog();
  await edit("Accent color", "#e32655", dialog);
  await click("Apply appearance", dialog);
  assert.ok(appearanceDialog(), "failed Apply leaves the studio open");
  assert.equal(labeledControl("Accent color", appearanceDialog()).value, "#e32655", "the draft remains available for retry");
  assert.match(dialog.querySelector('[role="status"]').textContent, /Unable to apply/);
  assert.equal(calls, 0, "rejected Apply does not close the studio");
});

test("shaking a held widget title enters Customize and holds the widget without saving the layout", async (context) => {
  const originalRequestFrame = window.requestAnimationFrame;
  const originalCancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
  context.after(() => {
    window.requestAnimationFrame = originalRequestFrame;
    window.cancelAnimationFrame = originalCancelFrame;
  });
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });
  const originalOrder = [...rootNode.querySelectorAll("[data-widget-id]")].map((card) => card.dataset.widgetId);
  const title = rootNode.querySelector('[data-widget-id="notes"] .widget-header h2');
  const pointer = async (target, type, clientX, buttons = 1) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX, clientY: 20 });
    Object.defineProperties(event, {
      pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true },
    });
    await act(async () => target.dispatchEvent(event));
  };

  await click("Widget customization");
  await pointer(title, "pointerdown", 100);
  for (const clientX of [125, 75, 125]) await pointer(window, "pointermove", clientX);
  assert.equal(button("Customize").getAttribute("aria-pressed"), "false", "open dialogs block the shortcut");
  await click("Cancel", appearanceDialog());

  await openWidgetMenu("notes");
  await pointer(title, "pointerdown", 100);
  for (const clientX of [125, 75, 125]) await pointer(window, "pointermove", clientX);
  assert.equal(button("Done customizing").getAttribute("aria-pressed"), "true");
  assert.ok(rootNode.querySelector(".reference-ui.is-customizing"));
  assert.ok(rootNode.querySelector('[data-widget-id="notes"].widget-reorder-placeholder'), "the same widget is already held");
  assert.ok(rootNode.querySelector(".widget-reorder-overlay"), "the gesture lifts the widget immediately");
  assert.equal(rootNode.querySelector(".widget-menu"), null, "activation dismisses the widget menu");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await pointer(window, "pointerup", 125, 0);
  assert.deepEqual([...rootNode.querySelectorAll("[data-widget-id]")].map((card) => card.dataset.widgetId), originalOrder);
  assert.equal(server.writes, 0);
  assert.equal(button("Done customizing").getAttribute("aria-pressed"), "true", "Escape cancels the held widget before exiting customization");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(button("Customize").getAttribute("aria-pressed"), "false", "Escape exits customization after the gesture is canceled");
  assert.equal(rootNode.querySelector(".reference-ui.is-customizing"), null);
  assert.equal(document.activeElement, button("Customize"), "exiting returns focus to Customize");
  await click("Customize");
  await click("Done customizing");
  assert.equal(button("Customize").getAttribute("aria-pressed"), "false", "the normal button still exits Customize");
});

test("Escape exits widget customization from a focused widget after a dialog closes", async () => {
  reset(); installServer(); await render(Workspace, { initialProfile: baseProfile });
  await click("Customize");
  await click("Widget customization");
  await act(async () => appearanceDialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(appearanceDialog(), null);
  assert.equal(button("Done customizing").getAttribute("aria-pressed"), "true", "closing the dialog preserves customization mode");

  const notes = rootNode.querySelector('textarea[aria-label="Quick notes"]');
  await act(async () => {
    notes.focus();
    notes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.ok(rootNode.querySelector(".reference-ui.is-customizing"), "other keys preserve customization mode");
  await act(async () => notes.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(button("Customize").getAttribute("aria-pressed"), "false");
  assert.equal(rootNode.querySelector(".reference-ui.is-customizing"), null);
  assert.equal(document.activeElement, button("Customize"));
  assert.equal(server.writes, 0, "exiting does not change the saved widget layout");
});
