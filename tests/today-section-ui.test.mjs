import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/" });
for (const name of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get() {
    if (!this.isConnected) return null;
    for (let node = this.parentElement; node; node = node.parentElement) if (node.hidden) return null;
    return dom.window.document.body;
  },
});
Object.defineProperty(dom.window.HTMLElement.prototype, "getClientRects", {
  configurable: true,
  value() {
    if (!this.isConnected || this.hidden || this.closest("[hidden]")) return [];
    return [new dom.window.DOMRect(0, 0, 1, 1)];
  },
});
after(() => dom.window.close());
afterEach(async () => { if (root) await unmount(); });

const [{ createElement, act }, { createRoot }, { default: Workspace }, { validateProfile }, { encodeWorkspaceState, decodeWorkspaceState }, { academicSnapshot }, { emptyStudy }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/workspace-client.tsx")),
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
const assignment = { id: "essay", title: "Archive analysis", courseId: "history", due: "2099-10-08", dateKey: "2099-10-08", status: "later", progress: 30, description: "Saved academic work", weight: "", type: "Assignment" };
const event = { id: "seminar", title: "Research seminar", courseId: "history", dateKey: "2099-10-09", time: "10:00", type: "Study block" };
const study = { ...emptyStudy(), dailyMinutes: 45, weeklyMinutes: 240, grades: [{ id: "grade-a", courseId: "history", system: "4.0 scale", term: "Fall", max: 4, value: 3.5 }] };
const data = { assignments: [assignment], manualEvents: [event], dashboardView: "cards", study };

function dashboard(workspaces = [
  { id: "day", name: "My Day", widgets: [
    { instanceId: "notes-day", type: "notes", size: "large", note: "Saved notes" },
    { instanceId: "glance-day", type: "today", size: "large" },
  ] },
  { id: "study", name: "Study", widgets: [{ instanceId: "notes-study", type: "notes", size: "large", note: "Study workspace notes" }] },
], hiddenIds = []) {
  const state = encodeWorkspaceState(workspaces.map((workspace) => ({
    ...workspace,
    ...(hiddenIds.includes(workspace.id) ? { todayHidden: true } : {}),
  })), workspaces[0].id, "", data);
  // This represents an older saved dashboard whose omitted Today visibility
  // field must continue to decode as visible.
  if (!hiddenIds.length) delete state.h;
  return state;
}

const rootNode = document.getElementById("root");
let root, fetcher, server;
globalThis.fetch = (...args) => fetcher(...args);
window.confirm = () => true;
window.alert = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);

function reset({ preserveServer = false } = {}) {
  window.history.replaceState({}, "", "/home");
  rootNode.innerHTML = "";
  if (!preserveServer) server = undefined;
  root = createRoot(rootNode);
}
async function render() {
  await act(async () => {
    root.render(createElement(Workspace, { initialProfile: baseProfile }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function unmount() {
  await act(async () => root.unmount());
  root = undefined;
  rootNode.innerHTML = "";
}
async function waitUntil(predicate, description, timeoutMs = 4000) {
  let remaining = timeoutMs;
  await act(async () => {
    while (!predicate() && remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      remaining -= 25;
    }
  });
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}
function installServer(saved = dashboard()) {
  server = { dashboard: structuredClone(saved), courses: [course], profile: structuredClone(baseProfile), revision: baseProfile.updated_at, writes: 0 };
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
function buttonAria(label, scope = rootNode) {
  const found = [...scope.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}
function todayEditorOrNull() {
  return [...rootNode.querySelectorAll('[role="dialog"]')].find((node) => node.querySelector("h2")?.textContent.trim() === "Edit Today sections") ?? null;
}
function todayEditor() {
  const found = todayEditorOrNull();
  assert.ok(found, "Missing the Edit Today sections dialog");
  assert.equal(found.getAttribute("aria-modal"), "true");
  return found;
}
function sectionChoice(dialog, name) {
  const row = [...dialog.querySelectorAll(".today-section-editor-choice")].find((node) => node.querySelector("strong")?.textContent.trim() === name);
  assert.ok(row, `Missing Today section choice ${name}`);
  const input = row.querySelector('input[type="checkbox"]');
  assert.ok(input, `Missing checkbox for ${name}`);
  return input;
}
function selectedSectionNames(dialog) {
  return [...dialog.querySelectorAll(".today-section-editor-choice")]
    .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
    .map((row) => row.querySelector("strong")?.textContent.trim());
}
function todayHeadings() {
  return [...rootNode.querySelectorAll(".today-panel-grid > .today-panel-section h2")].map((heading) => heading.textContent.trim());
}
async function click(text, scope = rootNode) {
  const control = button(text, scope);
  await act(async () => control.click());
}
async function clickAria(label, scope = rootNode) {
  const control = buttonAria(label, scope);
  await act(async () => control.click());
}
async function key(target, key, extra = {}) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })));
}
async function openTodayEditor() {
  await clickAria("Today section options");
  const menu = rootNode.querySelector(".today-section-menu");
  assert.ok(menu, "Today options menu opens");
  await click("Edit section", menu);
  await waitUntil(() => todayEditorOrNull(), "Today section editor");
  return todayEditor();
}
async function setSectionChoice(dialog, name, checked) {
  const input = sectionChoice(dialog, name);
  assert.equal(input.disabled, false, `${name} can be changed`);
  await act(async () => input.click());
  assert.equal(input.checked, checked, `${name} selection updates`);
}
function decoded() { return decodeWorkspaceState(server.dashboard); }
function activeWorkspace() { return decoded().workspaces.find((workspace) => workspace.id === decoded().activeWorkspaceId); }
async function waitForWrite(count) { await waitUntil(() => server.writes === count, `workspace save ${count}`); }
async function reloadSavedWorkspace() {
  await unmount();
  reset({ preserveServer: true });
  await render();
  await waitUntil(() => rootNode.querySelector('[role="tab"][aria-selected="true"]'), "workspace hydration");
}

test("legacy layouts show Today by default and its options stay accessible without navigation or writes", async () => {
  reset();
  const saved = dashboard();
  assert.equal(Object.hasOwn(saved, "h"), false, "the legacy fixture omits the Today visibility field");
  installServer(saved);
  await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.writes, 0, "loading an old layout does not trigger a migration write");
  assert.equal(window.location.pathname, "/home", "initial render stays on the workspace page");
  assert.equal(activeWorkspace().todayHidden, undefined, "an omitted visibility flag means visible");
  const trigger = buttonAria("Today section options");
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  await act(async () => trigger.click());
  const menu = rootNode.querySelector('.today-section-menu[role="menu"]');
  assert.ok(menu, "the options trigger opens an accessible menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const edit = [...menu.querySelectorAll("button")].find((control) => control.textContent.includes("Edit section"));
  assert.ok(edit, "Edit section is available");
  assert.equal(edit.disabled, false);
  assert.equal([...menu.querySelectorAll("button")].find((control) => control.textContent.includes("Hide section")).disabled, false);
  await act(async () => edit.click());
  await waitUntil(() => todayEditorOrNull(), "Today section editor");
  assert.deepEqual(todayHeadings(), ["Next Class", "Due Today (0)", "Today’s Schedule"], "legacy workspaces retain the default Today content");
  await key(todayEditor(), "Escape");
  await waitUntil(() => todayEditorOrNull() === null && document.activeElement === trigger, "Escape closes the editor and restores focus");
  assert.equal(server.writes, 0);

  await key(menu, "Escape");
  assert.equal(rootNode.querySelector(".today-section-menu") === null, true, "Escape dismisses the menu");
  assert.equal(document.activeElement === trigger, true, "Escape returns focus to the menu trigger");
  await key(trigger, "ArrowDown");
  const reopenedMenu = rootNode.querySelector(".today-section-menu");
  const editItem = [...reopenedMenu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Edit section"));
  await waitUntil(() => document.activeElement === editItem, "ArrowDown focuses the first enabled menu item");
  await key(reopenedMenu, "Tab");
  assert.equal(rootNode.querySelector(".today-section-menu") === null, true, "Tab closes the menu without trapping focus");
  assert.equal(document.activeElement.closest(".home-today-panel") === null, true, "Tab moves focus outside the Today panel");
  await act(async () => trigger.click());
  await act(async () => rootNode.querySelector(".home-greeting").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  assert.equal(rootNode.querySelector(".today-section-menu") === null, true, "an outside pointer press dismisses the menu");
  assert.equal(window.location.pathname, "/home");
  assert.equal(server.writes, 0);
});

test("Today content editing enforces 1–3 choices, cancels drafts, saves only changes, and survives reload", async () => {
  reset(); installServer(); await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");

  let dialog = await openTodayEditor();
  assert.deepEqual([...dialog.querySelectorAll(".today-section-editor-choice strong")].map((node) => node.textContent.trim()), [
    "Next Class", "Due Today", "Today’s Schedule", "Study Goal", "Upcoming Deadlines", "Study Streak",
  ], "all catalog choices are named in the editor");
  assert.deepEqual(selectedSectionNames(dialog), ["Next Class", "Due Today", "Today’s Schedule"]);
  assert.equal(sectionChoice(dialog, "Next Class").disabled, false);
  assert.equal(sectionChoice(dialog, "Study Goal").disabled, true, "unchecked choices are disabled at the three-section limit");
  assert.equal(document.activeElement, sectionChoice(dialog, "Next Class"), "opening the dialog focuses its first checkbox");
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const focusedChoice = document.activeElement;
    await key(focusedChoice, "k", modifier);
    assert.equal(document.activeElement, focusedChoice, "the search shortcut cannot move focus outside the modal editor");
  }
  await click("Apply", dialog);
  await waitUntil(() => todayEditorOrNull() === null, "unchanged editor closes");
  assert.equal(server.writes, 0, "applying an unchanged layout does not write");

  dialog = await openTodayEditor();
  await setSectionChoice(dialog, "Next Class", false);
  assert.match(dialog.querySelector(".today-section-editor-count").textContent, /2 of 3 selected/);
  await setSectionChoice(dialog, "Due Today", false);
  assert.deepEqual(selectedSectionNames(dialog), ["Today’s Schedule"]);
  assert.equal(sectionChoice(dialog, "Today’s Schedule").disabled, true, "the final selected section cannot be removed");
  await setSectionChoice(dialog, "Next Class", true);
  await click("Cancel", dialog);
  await waitUntil(() => todayEditorOrNull() === null, "cancel closes the editor");
  assert.deepEqual(todayHeadings(), ["Next Class", "Due Today (0)", "Today’s Schedule"], "cancel discards the draft");
  assert.equal(server.writes, 0, "cancelling a draft does not write");

  dialog = await openTodayEditor();
  await setSectionChoice(dialog, "Next Class", false);
  assert.deepEqual(selectedSectionNames(dialog), ["Due Today", "Today’s Schedule"]);
  await click("Apply", dialog);
  await waitForWrite(1);
  assert.deepEqual(activeWorkspace().todaySections, ["due-today", "schedule"]);
  assert.deepEqual(todayHeadings(), ["Due Today (0)", "Today’s Schedule"]);
  assert.equal(rootNode.querySelectorAll(".today-panel-grid > .today-panel-section").length, 2);

  dialog = await openTodayEditor();
  await setSectionChoice(dialog, "Due Today", false);
  assert.equal(sectionChoice(dialog, "Today’s Schedule").disabled, true);
  assert.deepEqual(selectedSectionNames(dialog), ["Today’s Schedule"]);
  await click("Apply", dialog);
  await waitForWrite(2);
  assert.deepEqual(activeWorkspace().todaySections, ["schedule"]);
  assert.deepEqual(todayHeadings(), ["Today’s Schedule"]);
  assert.equal(rootNode.querySelectorAll(".today-panel-grid > .today-panel-section").length, 1);

  dialog = await openTodayEditor();
  assert.equal(sectionChoice(dialog, "Today’s Schedule").disabled, true);
  await setSectionChoice(dialog, "Upcoming Deadlines", true);
  assert.equal(sectionChoice(dialog, "Study Streak").disabled, false);
  await setSectionChoice(dialog, "Study Streak", true);
  assert.deepEqual(selectedSectionNames(dialog), ["Today’s Schedule", "Upcoming Deadlines", "Study Streak"]);
  assert.equal(sectionChoice(dialog, "Next Class").disabled, true, "unchecked choices are disabled again at three selections");

  const firstFocusable = buttonAria("Close Today section editor", dialog);
  const lastFocusable = button("Apply", dialog);
  await act(async () => firstFocusable.focus());
  await key(firstFocusable, "Tab", { shiftKey: true });
  assert.equal(document.activeElement, lastFocusable, "Shift+Tab wraps to the last dialog control");
  await key(lastFocusable, "Tab");
  assert.equal(document.activeElement, firstFocusable, "Tab wraps to the first dialog control");

  await click("Apply", dialog);
  await waitForWrite(3);
  assert.deepEqual(activeWorkspace().todaySections, ["schedule", "upcoming-deadlines", "study-streak"]);
  assert.deepEqual(todayHeadings(), ["Today’s Schedule", "Upcoming Deadlines", "Study Streak"]);
  assert.equal(rootNode.querySelectorAll(".today-panel-grid > .today-panel-section").length, 3);
  assert.equal(decoded().workspaces.find((workspace) => workspace.id === "study").todaySections, undefined, "saving one workspace leaves the other workspace choices unchanged");
  assert.deepEqual(decoded().data.assignments, [assignment], "Today layout saves preserve assignments");
  assert.deepEqual(decoded().data.manualEvents, [event], "Today layout saves preserve events");
  assert.deepEqual(decoded().data.study.grades, study.grades, "Today layout saves preserve grades");

  await reloadSavedWorkspace();
  assert.deepEqual(activeWorkspace().todaySections, ["schedule", "upcoming-deadlines", "study-streak"]);
  assert.deepEqual(todayHeadings(), ["Today’s Schedule", "Upcoming Deadlines", "Study Streak"], "the selected order survives save and reload");
  assert.equal(server.writes, 3, "each changed layout produces one workspace save");
});

test("hiding and restoring Today saves one workspace revision each and preserves other workspace data", async () => {
  reset(); installServer(); await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");

  await clickAria("Today section options");
  const menu = rootNode.querySelector(".today-section-menu");
  await click("Hide section", menu);
  await waitUntil(() => !rootNode.querySelector(".home-today-panel"), "hidden Today panel");
  await waitUntil(() => document.activeElement === button("Customize"), "focus outside the removed Today panel");
  assert.equal(rootNode.querySelector('[data-widget-id="notes-day"] textarea')?.value, "Saved notes", "the Notes widget stays visible with its contents");
  assert.ok(rootNode.querySelector('[data-widget-id="glance-day"]'), "the separate At a Glance widget stays visible");
  assert.equal(rootNode.querySelector(".today-section-restore") === null, true, "normal view does not expose the restore control");
  await waitForWrite(1);
  assert.equal(activeWorkspace().todayHidden, true);
  assert.equal(decoded().workspaces.find((workspace) => workspace.id === "study").todayHidden, undefined, "visibility is scoped to the active workspace");
  assert.deepEqual(decoded().workspaces.map((workspace) => workspace.id), ["day", "study"], "saving visibility keeps workspace order stable");

  await reloadSavedWorkspace();
  assert.equal(rootNode.querySelector(".home-today-panel") === null, true, "the hidden state survives reload");
  assert.equal(rootNode.querySelector(".today-section-restore") === null, true, "restore remains tucked away outside Customize after reload");
  await click("Customize");
  assert.equal(rootNode.querySelector(".home-today-panel"), null, "Today stays collapsed in Customize");
  assert.equal(rootNode.querySelector('[aria-label="Restore Today section"]'), null, "restore is tucked into Workspace options");
  await clickAria("Workspace options");
  const restore = buttonAria("Restore Today section");
  assert.ok(restore.closest(".workspace-menu"), "Workspace options contains the restore action");
  await clickAria("Restore Today section");
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "restored Today panel");
  await waitUntil(() => document.activeElement === buttonAria("Today section options"), "restoring focuses Today options");
  assert.equal(rootNode.querySelector(".workspace-menu"), null, "restoring closes Workspace options");
  await waitForWrite(2);
  assert.notEqual(activeWorkspace().todayHidden, true, "restoring removes the hidden state");

  await reloadSavedWorkspace();
  assert.ok(rootNode.querySelector(".home-today-panel"), "the restored state survives reload");
  assert.equal(server.writes, 2, "hide and restore each create exactly one save");
  assert.deepEqual(server.courses, [course]);
  const saved = decoded().data;
  assert.deepEqual(saved.assignments, [assignment]);
  assert.deepEqual(saved.manualEvents, [event]);
  assert.deepEqual(saved.study.grades, study.grades);
  assert.equal(saved.study.dailyMinutes, study.dailyMinutes);
  assert.equal(rootNode.querySelector('[data-widget-id="notes-day"] textarea')?.value, "Saved notes");
});

test("hiding Today while customizing moves focus to Workspace options and restores through its menu", async () => {
  reset(); installServer(); await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");
  await click("Customize");
  await clickAria("Today section options");
  await click("Hide section", rootNode.querySelector(".today-section-menu"));
  await waitUntil(() => !rootNode.querySelector(".home-today-panel"), "collapsed Today");
  await waitUntil(() => document.activeElement === buttonAria("Workspace options"), "focus moves to Workspace options");
  await waitForWrite(1);
  await clickAria("Workspace options");
  assert.ok(buttonAria("Restore Today section").closest(".workspace-menu"));
  await clickAria("Restore Today section");
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "restored Today");
  await waitForWrite(2);
  assert.equal(rootNode.querySelector(".today-remove-target-dock"), null, "visible Today uses its original removal target");
});

test("workspace copies retain Today content and visibility, new workspaces start visible, and deletion prunes the hidden ID", async () => {
  reset(); installServer(); await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");
  const editor = await openTodayEditor();
  await setSectionChoice(editor, "Next Class", false);
  await setSectionChoice(editor, "Today’s Schedule", false);
  await click("Apply", editor);
  await waitForWrite(1);
  assert.deepEqual(activeWorkspace().todaySections, ["due-today"]);

  await clickAria("Today section options");
  await click("Hide section", rootNode.querySelector(".today-section-menu"));
  await waitForWrite(2);

  await clickAria("Workspace options");
  await click("Duplicate", rootNode.querySelector(".workspace-menu"));
  await waitUntil(() => rootNode.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes("copy"), "duplicated workspace");
  assert.equal(rootNode.querySelector(".home-today-panel") === null, true, "duplicating carries the source Today visibility setting");
  await waitForWrite(3);
  const duplicateId = decoded().activeWorkspaceId;
  assert.equal(activeWorkspace().todayHidden, true);
  assert.deepEqual(activeWorkspace().todaySections, ["due-today"], "duplicating copies the source Today content choices");

  await act(async () => buttonAria("Add workspace").click());
  const nameInput = rootNode.querySelector('.small-modal input');
  assert.ok(nameInput, "Add workspace opens the normal create flow");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(nameInput, "Fresh space");
    nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    nameInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await click("Create workspace", rootNode);
  await waitUntil(() => rootNode.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Fresh space", "new workspace");
  assert.ok(rootNode.querySelector(".home-today-panel"), "a new workspace starts with Today visible");
  await waitForWrite(4);
  const freshId = decoded().activeWorkspaceId;
  assert.notEqual(activeWorkspace().todayHidden, true);
  assert.deepEqual(todayHeadings(), ["Next Class", "Due Today (0)", "Today’s Schedule"], "a new workspace uses the default Today content");

  await clickAria("Today section options");
  await click("Hide section", rootNode.querySelector(".today-section-menu"));
  await waitForWrite(5);
  assert.equal(activeWorkspace().todayHidden, true);
  await clickAria("Workspace options");
  await click("Delete", rootNode.querySelector(".workspace-menu"));
  await waitUntil(() => decoded().activeWorkspaceId !== freshId, "deleted workspace");
  await waitForWrite(6);
  assert.equal(decoded().workspaces.some((workspace) => workspace.id === freshId), false);
  assert.deepEqual(server.dashboard.h, ["day", duplicateId], "deleting a hidden workspace prunes its visibility ID");
  await act(async () => [...rootNode.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === "My Day").click());
  assert.equal(rootNode.querySelector(".home-today-panel") === null, true, "deleting the new workspace leaves the source workspace hidden");
  assert.equal(server.writes, 6);
});

test("experimental Today content and visibility changes are local and never overwrite the saved workspace", async () => {
  reset(); installServer(); await render();
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "Today panel");
  await clickAria("Experimental mode");
  await clickAria("Load Light experimental data");
  assert.match(rootNode.textContent, /Light experimental mode/);
  assert.ok(rootNode.querySelector(".home-today-panel"));

  const editor = await openTodayEditor();
  await setSectionChoice(editor, "Next Class", false);
  await setSectionChoice(editor, "Due Today", false);
  await setSectionChoice(editor, "Study Streak", true);
  await click("Apply", editor);
  await waitUntil(() => todayHeadings().join("|") === "Today’s Schedule|Study Streak", "experimental Today content preview");
  assert.equal(server.writes, 0, "experimental content choices never write to the account");

  await clickAria("Today section options");
  await click("Hide section", rootNode.querySelector(".today-section-menu"));
  assert.equal(rootNode.querySelector(".home-today-panel") === null, true, "experimental preview responds to the visibility control");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  assert.equal(server.writes, 0, "experimental changes never write to the account");
  await clickAria("Experimental mode");
  await click("Exit experimental mode", rootNode.querySelector(".experimental-menu"));
  await waitUntil(() => rootNode.querySelector(".home-today-panel"), "saved workspace restore");
  assert.deepEqual(todayHeadings(), ["Next Class", "Due Today (0)", "Today’s Schedule"], "leaving the preview restores saved Today content choices");
  assert.equal(server.writes, 0);
  assert.equal(activeWorkspace().todayHidden, undefined, "leaving the preview restores the saved visible state");
  assert.equal(activeWorkspace().todaySections, undefined, "experimental choices are not written into the saved workspace");
});
