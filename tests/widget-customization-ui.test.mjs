import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/" });
class TestAnimationEvent extends dom.window.Event {
  constructor(type, { animationName = "", ...options } = {}) { super(type, options); this.animationName = animationName; }
}
Object.defineProperty(dom.window, "AnimationEvent", { configurable: true, value: TestAnimationEvent });
for (const name of ["window", "document", "Element", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent", "AnimationEvent"]) globalThis[name] = dom.window[name];
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
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);

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
async function editNotes(value) {
  const textarea = rootNode.querySelector('textarea[aria-label="Quick notes"]');
  assert.ok(textarea, "the Home workspace note is available");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
function saveStatusTrigger() { return rootNode.querySelector(".workspace-save-status-trigger"); }
function workspaceSaveErrorDialog() { return rootNode.querySelector('[role="dialog"][aria-labelledby="workspace-save-error-title"]'); }
function savePopupAnimationEnd(animationName = "widget-menu-dismiss") {
  return new window.AnimationEvent("animationend", { bubbles: true, animationName });
}
async function finishWorkspaceSavePopup(dialog, animationName) {
  await act(async () => dialog.dispatchEvent(savePopupAnimationEnd(animationName)));
}
async function openWorkspaceSaveError() {
  const trigger = saveStatusTrigger();
  assert.ok(trigger, "the Home toolbar exposes workspace save status");
  if (!workspaceSaveErrorDialog()) await act(async () => trigger.click());
  const dialog = workspaceSaveErrorDialog();
  assert.ok(dialog, "the error status opens its recovery details");
  return dialog;
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
  const customizationTrigger = actions.querySelector(".widget-customization-trigger");
  assert.ok(customizationTrigger, "widget customization remains in the workspace toolbar");
  const toolbarButtons = [...actions.querySelectorAll("button")];
  assert.ok(toolbarButtons.indexOf(saveStatusTrigger()) < toolbarButtons.indexOf(customizationTrigger), "the status control is before Widget customization");
  assert.ok(toolbarButtons.indexOf(customizationTrigger) < toolbarButtons.findIndex((button) => button.textContent.trim() === "Customize"), "Widget customization remains before the layout Customize action");
  await act(async () => { customizationTrigger.focus(); customizationTrigger.click(); });
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
  assert.equal(document.activeElement, customizationTrigger, "focus returns to the toolbar action");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, rootNode.querySelector('[aria-label="Search assignments, classes, and files"]'), "Ctrl+K focuses workspace search after the studio closes");
  assert.equal(server.writes, 0);
});

test("Home toolbar save status stays visible through the debounced write without a duplicate toast", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); const server = installServer();
  const actualFetcher = fetcher;
  let writesRequested = 0, finishWrite;
  fetcher = async (url, init = {}) => {
    if (init.method === "PUT") {
      writesRequested++;
      await new Promise((resolve) => { finishWrite = resolve; });
    }
    return actualFetcher(url, init);
  };
  await render(Workspace, { initialProfile: baseProfile });

  const actions = rootNode.querySelector(".workspace-actions");
  const trigger = saveStatusTrigger();
  assert.ok(trigger, "a persistent save control is present in the Home toolbar");
  assert.equal(trigger.dataset.saveState, "saved");
  assert.equal(trigger.getAttribute("aria-label"), "Workspace saved");
  assert.ok([...actions.querySelectorAll("button")].indexOf(trigger) < [...actions.querySelectorAll("button")].indexOf(actions.querySelector(".widget-customization-trigger")), "save status appears before Widget customization");
  assert.equal(rootNode.querySelector(".toast-stack .save-toast-card"), null, "saved workspace status does not use a bottom-right toast");

  await editNotes("A change that remains visible while saving");
  assert.equal(unloadBlocked(), true, "the edit is dirty before the debounce starts the write");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  assert.equal(writesRequested, 0, "the Home status update preserves the autosave debounce");
  assert.equal(trigger.dataset.saveState, "saving");
  await waitUntil(() => writesRequested === 1, "debounced workspace write");
  assert.equal(saveStatusTrigger(), trigger, "the same toolbar control remains mounted during the write");
  assert.equal(trigger.getAttribute("aria-label"), "Saving workspace");
  assert.equal(rootNode.querySelector(".toast-stack .save-toast-card"), null, "Home does not duplicate its toolbar status with a save toast");

  await act(async () => finishWrite());
  await waitUntil(() => trigger.dataset.saveState === "saved" && !unloadBlocked(), "saved toolbar state");
  assert.equal(trigger.getAttribute("aria-label"), "Workspace saved");
  assert.equal(server.writes, 1);
  assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((widget) => widget.instanceId === "notes").note, "A change that remains visible while saving");
  assert.equal(rootNode.querySelector(".toast-stack .save-toast-card"), null, "successful save leaves the persistent status in the toolbar");
});

test("save error details keep the latest draft and recover through the toolbar popup", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); const server = installServer();
  const actualFetcher = fetcher;
  let allowSave = false, attempts = 0;
  fetcher = async (url, init = {}) => {
    if (init.method === "PUT") {
      attempts++;
      if (!allowSave) return Response.json({ error: "Offline for the save-status test" }, { status: 503 });
    }
    return actualFetcher(url, init);
  };
  await render(Workspace, { initialProfile: baseProfile });
  await editNotes("First retained edit");
  await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "error", "save error in the toolbar");
  assert.equal(unloadBlocked(), true, "a failed save keeps unsaved work protected from reload");
  assert.equal(rootNode.querySelector("textarea[aria-label=\"Quick notes\"]").value, "First retained edit");
  assert.equal(rootNode.querySelector(".toast-stack .save-toast-card"), null, "Home errors are announced from the toolbar status");

  const trigger = saveStatusTrigger();
  trigger.focus();
  const dialog = await openWorkspaceSaveError();
  assert.equal(trigger.getAttribute("aria-label"), "Unable to save workspace");
  assert.equal(dialog.getAttribute("aria-labelledby"), "workspace-save-error-title");
  assert.equal(dialog.getAttribute("aria-modal"), null, "the anchored recovery popup is nonmodal");
  assert.match(dialog.textContent, /Offline for the save-status test/);
  assert.deepEqual([...dialog.querySelectorAll("button, a")].map((control) => control.textContent.trim()), ["Retry save", "Download unsaved work"]);
  await waitUntil(() => document.activeElement === dialog.querySelector("button, a"), "focus enters the recovery popup");
  assert.equal(rootNode.querySelector("textarea[aria-label=\"Quick notes\"]").value, "First retained edit");

  await editNotes("Latest edit kept for retry");
  assert.equal(saveStatusTrigger().dataset.saveState, "error", "editing after failure preserves the recovery state");
  assert.equal(rootNode.querySelector("textarea[aria-label=\"Quick notes\"]").value, "Latest edit kept for retry");
  allowSave = true;
  await click("Retry save", dialog);
  await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "saved" && !unloadBlocked(), "retry of latest workspace draft");
  assert.match(rootNode.querySelector(".workspace-save-status [role=\"status\"]").textContent, /Workspace saved/);
  assert.equal(attempts, 2, "retry performs exactly one additional write");
  assert.equal(server.writes, 1);
  assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((widget) => widget.instanceId === "notes").note, "Latest edit kept for retry");
});

test("session errors retain the draft and expose sign-in recovery in the toolbar popup", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); const server = installServer();
  const actualFetcher = fetcher;
  let signedIn = false, attempts = 0;
  fetcher = async (url, init = {}) => {
    if (init.method === "PUT") {
      attempts++;
      if (!signedIn) return Response.json({}, { status: 401 });
    }
    return actualFetcher(url, init);
  };
  await render(Workspace, { initialProfile: baseProfile });
  await editNotes("Draft retained after session expiry");
  await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "error", "session error in the toolbar");
  assert.equal(saveStatusTrigger().getAttribute("aria-label"), "Unable to save workspace");
  assert.equal(unloadBlocked(), true);
  const dialog = await openWorkspaceSaveError();
  assert.match(dialog.textContent, /Your session ended or the account changed/);
  const signIn = [...dialog.querySelectorAll("a")].find((link) => link.textContent.trim() === "Sign in in a new tab");
  assert.ok(signIn, "session recovery offers sign-in in a separate tab");
  assert.equal(signIn.getAttribute("href"), "/login?error=session");
  assert.equal(signIn.getAttribute("target"), "_blank");
  assert.ok([...dialog.querySelectorAll("button")].some((button) => button.textContent.trim() === "Retry after signing in"));
  assert.equal(rootNode.querySelector("textarea[aria-label=\"Quick notes\"]").value, "Draft retained after session expiry");

  signedIn = true;
  await click("Retry after signing in", dialog);
  await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "saved" && !unloadBlocked(), "session retry success");
  assert.match(rootNode.querySelector(".workspace-save-status [role=\"status\"]").textContent, /Workspace saved/);
  assert.equal(attempts, 2);
  assert.equal(server.writes, 1);
  assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((widget) => widget.instanceId === "notes").note, "Draft retained after session expiry");
});

test("workspace save popup closes on Escape and outside interaction with expected focus handling", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); installServer();
  const successfulFetcher = fetcher;
  fetcher = async (url, init = {}) => init.method === "PUT"
    ? Response.json({ error: "Temporary save failure" }, { status: 503 })
    : successfulFetcher(url, init);
  await render(Workspace, { initialProfile: baseProfile });
  await editNotes("Keep this draft");
  await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "error", "save error before opening details");

  const trigger = saveStatusTrigger();
  trigger.focus();
  let dialog = await openWorkspaceSaveError();
  assert.equal(dialog.classList.contains("is-opening"), true, "opening uses the shared pop-in animation state");
  await waitUntil(() => document.activeElement === dialog.querySelector("button, a"), "popup initial focus");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(workspaceSaveErrorDialog(), dialog, "Escape keeps the popup mounted while its dismissal animation runs");
  assert.equal(dialog.classList.contains("is-closing"), true);
  assert.equal(dialog.getAttribute("aria-hidden"), "true", "the closing popup is hidden from assistive technology");
  assert.equal(dialog.hasAttribute("inert"), true, "the closing popup cannot receive interaction");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  await waitUntil(() => document.activeElement === trigger, "focus returns to save-status trigger after Escape");
  await act(async () => dialog.querySelector("p").dispatchEvent(savePopupAnimationEnd()));
  assert.equal(workspaceSaveErrorDialog(), dialog, "a child animation does not finish the popup dismissal");
  await finishWorkspaceSavePopup(dialog, "other-animation");
  assert.equal(workspaceSaveErrorDialog(), dialog, "an unrelated animation does not finish the popup dismissal");
  await finishWorkspaceSavePopup(dialog);
  assert.equal(workspaceSaveErrorDialog(), null, "the popup unmounts after its own dismissal animation");

  dialog = await openWorkspaceSaveError();
  const outside = rootNode.querySelector('.workspace-tabs [role="tab"]');
  await act(async () => {
    outside.focus();
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(workspaceSaveErrorDialog(), dialog, "an outside interaction retains the popup for its exit fade");
  assert.equal(dialog.classList.contains("is-closing"), true);
  assert.equal(dialog.getAttribute("aria-hidden"), "true");
  assert.equal(dialog.hasAttribute("inert"), true);
  assert.equal(document.activeElement, outside, "outside dismissal does not steal focus from its target");
  assert.equal(rootNode.querySelector("textarea[aria-label=\"Quick notes\"]").value, "Keep this draft");
  await finishWorkspaceSavePopup(dialog);
  assert.equal(workspaceSaveErrorDialog(), null, "outside dismissal unmounts after the popup exit fade");
});

test("workspace save popup reopening cancels dismissal fallback and reduced motion closes immediately", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); installServer();
  const successfulFetcher = fetcher;
  fetcher = async (url, init = {}) => init.method === "PUT"
    ? Response.json({ error: "Temporary save failure" }, { status: 503 })
    : successfulFetcher(url, init);
  const previousMatchMedia = window.matchMedia;
  const previousMotion = document.documentElement.getAttribute("data-motion");
  try {
    await render(Workspace, { initialProfile: baseProfile });
    await editNotes("Keep this draft");
    await waitUntil(() => saveStatusTrigger()?.dataset.saveState === "error", "save error before animation lifecycle checks");

    const trigger = saveStatusTrigger();
    let dialog = await openWorkspaceSaveError();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(dialog.classList.contains("is-closing"), true, "Escape begins the fade");
    await act(async () => trigger.click());
    assert.equal(workspaceSaveErrorDialog(), dialog, "the trigger reopens the mounted popup during its fade");
    assert.equal(dialog.classList.contains("is-closing"), false);
    assert.equal(dialog.classList.contains("is-opening"), true);
    assert.equal(dialog.hasAttribute("inert"), false);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 170)));
    assert.equal(workspaceSaveErrorDialog(), dialog, "the canceled dismissal timeout does not close the reopened popup");

    const outside = rootNode.querySelector('.workspace-tabs [role="tab"]');
    await act(async () => outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true })));
    assert.equal(dialog.classList.contains("is-closing"), true, "outside dismissal starts a new fade after reopening");
    await waitUntil(() => workspaceSaveErrorDialog() === null, "popup fallback dismissal", 1000);

    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    document.documentElement.dataset.motion = "reduced";
    dialog = await openWorkspaceSaveError();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assert.equal(workspaceSaveErrorDialog(), null, "reduced motion closes the popup immediately");
    assert.equal(document.activeElement, trigger, "immediate Escape dismissal restores trigger focus");
  } finally {
    window.matchMedia = previousMatchMedia;
    if (previousMotion === null) delete document.documentElement.dataset.motion;
    else document.documentElement.setAttribute("data-motion", previousMotion);
  }
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
  const saveStatus = saveStatusTrigger();
  assert.ok(saveStatus, "the toolbar keeps the workspace save status visible");
  assert.equal(saveStatus.dataset.saveState, "saving", "the applied appearance enters the normal autosave state");
  assert.equal(saveStatus.getAttribute("aria-label"), "Saving workspace");
  assert.equal(rootNode.querySelector(".toast-stack .save-toast-card"), null, "ordinary Home saving has no duplicate toast");
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
  assert.notEqual(saveStatusTrigger()?.getAttribute("aria-label"), "Workspace saved", "experimental data never makes a persisted-save claim");
  assert.notEqual(saveStatusTrigger()?.dataset.saveState, "saved");
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
