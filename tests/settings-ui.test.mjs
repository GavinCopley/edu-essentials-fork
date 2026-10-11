import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/" });
class TestAnimationEvent extends dom.window.Event {
  constructor(type, { animationName = "", ...options } = {}) { super(type, options); this.animationName = animationName; }
}
Object.defineProperty(dom.window, "AnimationEvent", { configurable: true, value: TestAnimationEvent });
for (const name of ["window", "document", "Element", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "AnimationEvent", "MutationObserver"]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// jsdom has no viewport. Keep lazy card thumbnails offscreen so these
// integration tests count deliberate preview reads; the browser harness
// separately verifies real thumbnail visibility and rendering.
globalThis.IntersectionObserver = class OffscreenThumbnailObserver {
  observe() { /* No layout intersections in this fixture. */ }
  disconnect() { /* No observation resources to release. */ }
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ProfileEditor } = await import(await clientModule("app/profile-editor.tsx"));
const { default: Workspace } = await import(await clientModule("app/workspace-client.tsx"));
const { validateProfile } = await import(await clientModule("lib/profile.ts"));
const { encodeWorkspaceState, decodeWorkspaceState } = await import(await clientModule("lib/workspace-codec.ts"));
const { academicSnapshot } = await import(await clientModule("lib/academic-snapshot.ts"));
const { emptyStudy, timerAction } = await import(await clientModule("lib/study.ts"));
const { calculateWidgetPlacements } = await import(await clientModule("lib/widget-layout.ts"));
const { reorderWidgetIds } = await import(await clientModule("lib/widget-reorder.ts"));
const baseProfile = { ...validateProfile({ display_name: "Alex" }), id: "profile-a", auth_user_id: "user-a", email: "alex@example.invalid", avatar_url: null, initialized: true, updated_at: "2026-09-06T00:00:00.000Z", onboarding_completed_at: "2026-09-05T00:00:00.000Z" };
const rootNode = document.getElementById("root");
let root, fetcher, filesFetcher, alerts, media, downloads;
globalThis.fetch = (...args) => {
  const url = String(args[0]);
  return url.startsWith("/api/files") || url.startsWith("/api/file-folders") || url.startsWith("/api/file-documents")
    ? filesFetcher ? filesFetcher(...args) : Response.json({ files: [], folders: [], activities: { files: [], folders: [] } })
    : fetcher(...args);
};
window.confirm = () => true;
window.alert = (text) => alerts.push(text);
// Capture downloaded values without navigating or retaining personal data.
URL.createObjectURL = (blob) => { downloads.push(blob); return "blob:test"; };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {};
function installUploadXhr() {
  const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const windowDescriptor = Object.getOwnPropertyDescriptor(window, "XMLHttpRequest");
  const requests = [];
  class TestXMLHttpRequest {
    constructor() { this.upload = {}; this.headers = new Map(); this.status = 0; this.responseText = ""; this.timeout = 0; this.aborted = false; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); }
    send(body) { this.body = body; requests.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    reportProgress(loaded = this.body.size, total = this.body.size) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
    respond(status, payload) { this.status = status; this.responseText = JSON.stringify(payload); this.onload?.(); }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", { configurable: true, writable: true, value: TestXMLHttpRequest });
  Object.defineProperty(window, "XMLHttpRequest", { configurable: true, writable: true, value: TestXMLHttpRequest });
  return {
    requests,
    restore() {
      if (globalDescriptor) Object.defineProperty(globalThis, "XMLHttpRequest", globalDescriptor); else delete globalThis.XMLHttpRequest;
      if (windowDescriptor) Object.defineProperty(window, "XMLHttpRequest", windowDescriptor); else delete window.XMLHttpRequest;
    },
  };
}
function uploadMetadata(request) { return JSON.parse(decodeURIComponent(request.headers.get("x-file-metadata"))); }
async function uploadedFileForRequest(request) {
  const metadata = uploadMetadata(request), file = request.body;
  const contentSha256 = createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
  return {
    id: new URL(request.url, "https://edu.example").searchParams.get("id"),
    name: metadata.name,
    mime_type: file.type || "application/octet-stream",
    size_bytes: file.size,
    course_id: metadata.courseId || null,
    assignment_id: metadata.assignmentId || null,
    kind: metadata.kind,
    state: "ready",
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
    content_sha256: contentSha256,
    folder_id: metadata.folderId ?? null,
    content_backend: "object",
    metadata_revision: 1,
    content_revision: 1,
    trashed_at: null,
    trash_operation_id: null,
    original_folder_id: null,
  };
}
function reset() {
  alerts = []; downloads = [];
  window.history.replaceState({}, "", "/home");
  window.confirm = () => true;
  media = { matches: false, listeners: new Set(), addEventListener(_event, fn) { this.listeners.add(fn); }, removeEventListener(_event, fn) { this.listeners.delete(fn); } };
  window.matchMedia = () => media;
  root = createRoot(rootNode);
}
async function render(component, props) { await act(async () => root.render(createElement(component, props))); }
async function unmount() { await act(async () => root.unmount()); root = undefined; rootNode.innerHTML = ""; }
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
async function waitForWorkspaceSave(server, writesBefore = server.writes) {
  await waitUntil(() => server.writes > writesBefore && !unloadBlocked(), "workspace autosave");
  assert.equal(server.writes, writesBefore + 1, "one debounced edit writes one workspace revision");
}
async function waitForWorkspaceError(message) {
  await waitUntil(() => rootNode.textContent.includes(message), `workspace save error: ${message}`);
}
function field(label) {
  const scope = rootNode.querySelector(".academic-editor") ?? rootNode;
  const node = [...scope.querySelectorAll("label")].find((node) => node.textContent.startsWith(label));
  assert.ok(node, `Missing field ${label}`); return node.querySelector("input,select,textarea");
}
function uploadChooser() {
  const input = rootNode.querySelector('.files-upload-dialog input[type="file"]');
  assert.ok(input, "The upload panel retains its file picker behind Choose files");
  return input;
}
async function returnToFilesRoot() {
  const button = [...rootNode.querySelectorAll(".files-view-nav button")].find((node) => node.textContent.trim() === "Files");
  assert.ok(button, "Files view navigation is available");
  await act(async () => { button.click(); });
}
async function edit(label, value) {
  const input = field(label);
  await act(async () => {
    if (input.type === "checkbox") { if (input.checked !== value) input.click(); }
    else {
      const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    }
  });
}
async function click(text) {
  const control = [...rootNode.querySelectorAll("button,a")].find((node) => node.textContent.trim() === text);
  assert.ok(control, `Missing control ${text}`);
  await act(async () => {
    if (control.tagName === "A") control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else control.click();
  });
}
async function selectCalendarDate(date) {
  const previousView = rootNode.querySelector('.planner-view-toggle [aria-pressed="true"]').textContent;
  await click("Month");
  const targetMonth = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const months = Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2026, month, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }));
  for (let steps = 0; ; steps++) {
    const [month, year] = rootNode.querySelector(".planner-heading h1").textContent.split(" ");
    const currentMonth = Number(year) * 12 + months.indexOf(month);
    if (currentMonth === targetMonth) break;
    assert.ok(steps < 24, `Could not navigate to ${date}`);
    const control = rootNode.querySelector(`.planner-navigation [aria-label="${currentMonth < targetMonth ? "Next" : "Previous"} period"]`);
    await act(async () => control.click());
  }
  const day = rootNode.querySelector(`.planner-month-day[aria-label="${date}"] .planner-day-number`);
  assert.ok(day, `Missing calendar date ${date}`);
  await act(async () => day.click());
  await click(previousView);
}
function unloadBlocked() { const event = new window.Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
function pointerEvent(type, values = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: 0, clientY: 0, ...values })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}
function widgetMenuAnimationEnd(animationName = "widget-menu-dismiss") {
  return new window.AnimationEvent("animationend", { bubbles: true, animationName });
}
async function finishWidgetMenuDismissal(menu, animationName) {
  await act(async () => menu.dispatchEvent(widgetMenuAnimationEnd(animationName)));
}
function installWidgetMenuGeometry(card, initial = {}) {
  const anchor = card.querySelector(".widget-header .menu-wrap > button");
  assert.ok(anchor, "widget menu trigger exists");
  const geometry = {
    viewportWidth: 1200,
    viewportHeight: 800,
    cardRect: { left: 100, top: 100, width: 400, height: 700 },
    anchorRect: { left: 145, top: 180, width: 24, height: 24 },
    menuWidth: 240,
    naturalMenuHeight: 320,
    ...initial,
  };
  const rect = (value) => ({
    x: value.left, y: value.top, left: value.left, top: value.top,
    right: value.left + value.width, bottom: value.top + value.height,
    width: value.width, height: value.height, toJSON() { return this; },
  });
  const menuHeight = () => Math.min(geometry.naturalMenuHeight, geometry.viewportHeight - 24);
  const grid = card.closest(".widget-grid");
  const cardRect = card.getBoundingClientRect;
  const anchorRect = anchor.getBoundingClientRect;
  const gridRect = grid?.getBoundingClientRect;
  card.getBoundingClientRect = () => rect(geometry.cardRect);
  anchor.getBoundingClientRect = () => rect(geometry.anchorRect);
  if (grid) grid.getBoundingClientRect = () => rect({ left: 12, top: 0, width: geometry.viewportWidth - 24, height: geometry.viewportHeight });

  const documentElement = document.documentElement;
  const viewportDescriptors = {
    innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
    innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight"),
    clientWidth: Object.getOwnPropertyDescriptor(documentElement, "clientWidth"),
    clientHeight: Object.getOwnPropertyDescriptor(documentElement, "clientHeight"),
  };
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: geometry.viewportWidth },
    innerHeight: { configurable: true, value: geometry.viewportHeight },
  });
  Object.defineProperties(documentElement, {
    clientWidth: { configurable: true, get: () => geometry.viewportWidth },
    clientHeight: { configurable: true, get: () => geometry.viewportHeight },
  });

  const menuDimensionDescriptors = new Map();
  for (const [name, getter] of Object.entries({
    offsetWidth() { return geometry.menuWidth; },
    offsetHeight() { return menuHeight(); },
    clientHeight() { return menuHeight(); },
    scrollHeight() { return geometry.naturalMenuHeight; },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    menuDimensionDescriptors.set(name, descriptor);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get() {
        if (this.matches?.(".widget-menu")) return getter.call(this);
        return descriptor?.get ? descriptor.get.call(this) : descriptor?.value;
      },
    });
  }

  const menuRectPrototype = Element.prototype;
  const menuRectDescriptor = Object.getOwnPropertyDescriptor(menuRectPrototype, "getBoundingClientRect");
  Object.defineProperty(menuRectPrototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: function () {
      if (!this.matches?.(".widget-menu")) return menuRectDescriptor.value.call(this);
      const fixed = this.style.position === "fixed";
      const left = Number.parseFloat(this.style.left);
      const right = Number.parseFloat(this.style.right);
      const top = Number.parseFloat(this.style.top);
      const bottom = Number.parseFloat(this.style.bottom);
      const menuLeft = Number.isFinite(left) ? (fixed ? left : geometry.cardRect.left + left)
        : Number.isFinite(right) ? geometry.cardRect.left + geometry.cardRect.width - right - geometry.menuWidth
          : geometry.cardRect.left;
      const menuTop = Number.isFinite(top) ? (fixed ? top : geometry.cardRect.top + top)
        : Number.isFinite(bottom) ? geometry.cardRect.top + geometry.cardRect.height - bottom - menuHeight()
          : geometry.cardRect.top;
      return rect({ left: menuLeft, top: menuTop, width: geometry.menuWidth, height: menuHeight() });
    },
  });

  return {
    geometry,
    restore() {
      card.getBoundingClientRect = cardRect;
      anchor.getBoundingClientRect = anchorRect;
      if (grid && gridRect) grid.getBoundingClientRect = gridRect;
      for (const [name, descriptor] of menuDimensionDescriptors) {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
        else delete HTMLElement.prototype[name];
      }
      if (menuRectDescriptor) Object.defineProperty(menuRectPrototype, "getBoundingClientRect", menuRectDescriptor);
      else delete menuRectPrototype.getBoundingClientRect;
      for (const [name, descriptor] of Object.entries(viewportDescriptors)) {
        const target = name.startsWith("inner") ? window : documentElement;
        if (descriptor) Object.defineProperty(target, name, descriptor);
        else delete target[name];
      }
    },
  };
}
async function waitForMilliseconds(duration) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, duration)));
}
function installFrameQueue() {
  const previousRequestFrame = window.requestAnimationFrame;
  const previousCancelFrame = window.cancelAnimationFrame;
  const frames = new Map(); let nextFrameId = 0;
  window.requestAnimationFrame = (callback) => { const id = ++nextFrameId; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  return {
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); },
    restore() {
      if (previousRequestFrame) window.requestAnimationFrame = previousRequestFrame; else delete window.requestAnimationFrame;
      if (previousCancelFrame) window.cancelAnimationFrame = previousCancelFrame; else delete window.cancelAnimationFrame;
    },
  };
}
function installBoardGeometry(grid, { columns = 4, unit = 100, gap = 16, left = 40, top = 100, bottom = 3100 } = {}) {
  const rowUnit = (unit - gap) / 2;
  grid.style.setProperty("--widget-columns", String(columns));
  grid.style.setProperty("--widget-unit", `${unit}px`);
  grid.style.columnGap = `${gap}px`;
  const gridRect = { left, top, right: left + unit * columns + gap * (columns - 1), bottom, width: unit * columns + gap * (columns - 1), height: bottom - top };
  grid.getBoundingClientRect = () => ({ ...gridRect, x: gridRect.left, y: gridRect.top, toJSON() { return this; } });
  const updateCards = () => {
    for (const card of cards()) {
      card.getBoundingClientRect = () => {
        const column = Number.parseInt(card.style.gridColumn, 10) || 1;
        const columnSpan = Number.parseInt(card.style.gridColumn.split("span ")[1], 10) || 1;
        const row = Number.parseInt(card.style.gridRow, 10) || 1;
        const rowSpan = Number.parseInt(card.style.gridRow.split("span ")[1], 10) || 1;
        const cardLeft = gridRect.left + (column - 1) * (unit + gap);
        const cardTop = gridRect.top + (row - 1) * (rowUnit + gap);
        const width = columnSpan * unit + (columnSpan - 1) * gap;
        const height = rowSpan * rowUnit + (rowSpan - 1) * gap;
        return { left: cardLeft, top: cardTop, right: cardLeft + width, bottom: cardTop + height, x: cardLeft, y: cardTop, width, height, toJSON() { return this; } };
      };
    }
  };
  updateCards();
  return { gridRect, unit, gap, rowUnit, columns, updateCards };
}
function destinationPointer(widgets, draggedId, destinationIndex, geometry, grabOffsetX, grabOffsetY) {
  const order = reorderWidgetIds(widgets.map((widget) => widget.instanceId), draggedId, destinationIndex);
  const ordered = order.map((id) => widgets.find((widget) => widget.instanceId === id));
  const placement = calculateWidgetPlacements(ordered.map((widget) => widget.size), geometry.columns)[order.indexOf(draggedId)];
  return {
    order,
    x: geometry.gridRect.left + (placement.column - 1) * (geometry.unit + geometry.gap) + grabOffsetX,
    y: geometry.gridRect.top + (placement.row - 1) * (geometry.rowUnit + geometry.gap) + grabOffsetY,
  };
}
const savedDashboard = { v: 1, a: "day", w: [["day", "Day", [[12, 1]]]], n: "Saved notes", d: { assignments: [], manualEvents: [], dashboardView: "cards", calendarView: "month" } };
async function editNotes(value) {
  const textarea = rootNode.querySelector('textarea[aria-label="Quick notes"]');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, value); textarea.dispatchEvent(new window.Event("input", { bubbles: true })); });
}

test("settings UI saves, preserves drafts, and recovers without losing account edits", async (t) => {
  t.afterEach(async () => { if (root) await unmount(); });
  await t.test("all settings fields submit together and clear dirty state after confirmation", async () => {
    reset(); let payload;
    fetcher = async (_url, init) => { payload = JSON.parse(init.body); return Response.json({ profile: { ...baseProfile, ...validateProfile(payload), updated_at: "2026-09-06T00:00:01Z" } }); };
    await render(ProfileEditor, { initialProfile: baseProfile });
    for (const [name, value] of Object.entries({ "Display name": "Taylor", "Last name": "Lee", "College or university": "Example University", "Major": "History", "Academic year": "Senior", "Age": "22", "Study goal": "Read every day", "Current term": "Fall", "Academic structure": "Quarter", "GPA system": "Percentage", "Week starts on": "Monday", "Time zone": "America/New_York", "Theme": "system" })) await edit(name, value);
    for (const [name, value] of [["Deadline reminders", false], ["Daily study plan", false], ["Study streak nudges", true], ["Reduce motion", true], ["High-contrast status labels", false]]) await edit(name, value);
    assert.equal(unloadBlocked(), true);
    await click("Save changes");
    assert.equal(payload.display_name, "Taylor"); assert.equal(payload.university, "Example University"); assert.equal(payload.age, 22);
    assert.equal(payload.timezone, "America/New_York"); assert.equal(payload.preferences.theme, "system"); assert.equal(payload.preferences.deadlineReminders, false);
    assert.equal(field("Display name").value, "Taylor"); assert.equal(unloadBlocked(), false);
    assert.match(rootNode.textContent, /profile and preferences are saved/);
    assert.equal(document.documentElement.dataset.motion, "reduced"); assert.equal(document.documentElement.dataset.contrast, "normal");
    await act(async () => { media.matches = true; media.listeners.forEach((fn) => fn()); });
    assert.equal(document.documentElement.dataset.theme, "dark");
    await unmount(); assert.equal(media.listeners.size, 0);
  });

  await t.test("failed saves preserve the draft, block signout, and retry without retyping", async () => {
    reset(); let fail = true;
    fetcher = async (_url, init) => { if (fail) throw new Error("Offline"); return Response.json({ profile: { ...baseProfile, ...validateProfile(JSON.parse(init.body)), updated_at: "2026-09-06T00:00:01Z" } }); };
    await render(ProfileEditor, { initialProfile: baseProfile }); await edit("Major", "Biology"); await click("Save changes");
    assert.equal(field("Major").value, "Biology"); assert.equal(unloadBlocked(), true);
    const signout = document.createElement("form"); signout.action = "/auth/signout"; document.body.append(signout);
    const event = new window.Event("submit", { bubbles: true, cancelable: true }); signout.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(alerts.length, 1); signout.remove();
    await click("Download settings draft"); assert.equal(JSON.parse(await downloads[0].text()).settings.major, "Biology");
    fail = false; await click("Retry settings save"); assert.equal(unloadBlocked(), false); await unmount();
  });

  await t.test("conflicts preserve draft fields and require an explicit reload decision", async () => {
    reset(); let puts = 0;
    fetcher = async (_url, init) => {
      if (init?.method === "PUT") { puts++; return Response.json({ error: "conflict" }, { status: 409 }); }
      return Response.json({ profile: { ...baseProfile, major: "Latest saved major", updated_at: "2026-09-06T00:00:02Z" } });
    };
    await render(ProfileEditor, { initialProfile: baseProfile }); await edit("Major", "My draft"); await click("Save changes");
    assert.equal(field("Major").value, "My draft"); await click("Save changes"); assert.equal(puts, 1);
    window.confirm = () => false; await click("Load latest saved settings"); assert.equal(field("Major").value, "My draft");
    window.confirm = () => true; await click("Load latest saved settings"); assert.equal(field("Major").value, "Latest saved major");
    assert.equal(unloadBlocked(), false); await unmount();
  });

  await t.test("session expiry keeps settings visible and can retry after sign-in", async () => {
    reset(); let expired = true;
    fetcher = async (_url, init) => expired ? Response.json({}, { status: 401 }) : Response.json({ profile: { ...baseProfile, ...validateProfile(JSON.parse(init.body)), updated_at: "2026-09-06T00:00:03Z" } });
    await render(ProfileEditor, { initialProfile: baseProfile }); await edit("Last name", "Retained"); await click("Save changes");
    assert.equal(field("Last name").value, "Retained"); assert.equal(window.location.pathname, "/home");
    assert.ok(rootNode.querySelector('a[target="_blank"]')); expired = false;
    await click("Retry settings save"); assert.equal(unloadBlocked(), false); await unmount();
  });

  await t.test("invalid settings keep the draft and do not send a write", async () => {
    reset(); let writes = 0; fetcher = async () => { writes++; throw new Error("unexpected"); };
    await render(ProfileEditor, { initialProfile: baseProfile }); await edit("Time zone", "Not/A_Zone"); await click("Save changes");
    assert.equal(writes, 0); assert.equal(field("Time zone").value, "Not/A_Zone"); assert.match(rootNode.textContent, /valid time zone/);
    await unmount();
  });

  await t.test("onboarding skip retries preserve existing optional details and keep failed drafts", async () => {
    reset(); const payloads = [];
    fetcher = async (_url, init) => { payloads.push(JSON.parse(init.body)); throw new Error("Offline"); };
    await render(ProfileEditor, { initialProfile: { ...baseProfile, major: "Existing major", onboarding_completed_at: null }, onboarding: true });
    await edit("Display name", "New name"); await click("Continue"); await edit("Major", "Optional draft");
    await click("Skip optional details"); await click("Retry settings save");
    assert.equal(payloads.length, 2); assert.deepEqual(payloads[1], payloads[0]);
    assert.equal(payloads[0].major, "Existing major"); assert.equal(payloads[0].display_name, "New name");
    assert.equal(field("Major").value, "Optional draft"); assert.equal(unloadBlocked(), true);
    await unmount();
  });

  await t.test("onboarding saves custom choices and opens the workspace", async () => {
    reset(); window.history.replaceState({}, "", "/onboarding"); let payload;
    const onboardingProfile = { ...baseProfile, onboarding_completed_at: null };
    fetcher = async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json({ profile: { ...onboardingProfile, ...validateProfile(payload), onboarding_completed_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z" } });
    };
    await render(ProfileEditor, { initialProfile: onboardingProfile, onboarding: true });
    await edit("Display name", "Jordan"); await click("Continue");
    assert.equal(field("College or university").getAttribute("list"), "profile-university-options");
    assert.equal(field("Time zone").getAttribute("list"), "profile-timezone-options");
    await edit("Academic year", "__custom__"); await edit("Your academic year", "Fifth year");
    await edit("Time zone", "America/Los_Angeles"); await click("Use automatic"); assert.equal(field("Time zone").value, "");
    await edit("Time zone", "America/Los_Angeles"); await click("Save and open workspace");
    assert.equal(payload.academic_year, "Other: Fifth year"); assert.equal(payload.timezone, "America/Los_Angeles");
    assert.equal(window.location.pathname, "/home"); assert.equal(unloadBlocked(), false);
    await unmount();
  });

  await t.test("workspace acknowledges a lost save response by readback and preserves true conflicts", async () => {
    reset(); let dashboard = savedDashboard, revision = baseProfile.updated_at, puts = 0;
    fetcher = async (_url, init) => {
      assert.equal(new Headers(init.headers).get("x-profile-id"), baseProfile.id);
      if (init.method === "PUT") {
        puts++; const body = JSON.parse(init.body);
        if (body.baseRevision !== revision) return Response.json({}, { status: 409 });
        dashboard = body.dashboard; revision = "2026-09-06T00:00:02Z";
        throw new Error("Response lost after commit");
      }
      return Response.json({ initialized: true, courses: [], dashboard, revision, profile: baseProfile });
    };
    await render(Workspace, { initialProfile: baseProfile }); await editNotes("First saved edit");
    assert.equal(unloadBlocked(), true); assert.match(rootNode.textContent, /Saving workspace/);
    await waitForWorkspaceError("Response lost");
    const saveErrorToast = rootNode.querySelector(".save-toast-card");
    assert.equal(saveErrorToast.querySelector(".save-toast-details").textContent, "Response lost after commit");
    assert.deepEqual([...saveErrorToast.querySelectorAll("button, a")].map((control) => control.textContent.trim()), ["Retry save", "Download unsaved work"]);
    assert.equal([...saveErrorToast.querySelectorAll("button, a")].some((control) => control.textContent.trim() === "Reload saved workspace"), false);
    assert.equal(rootNode.querySelector("textarea").value, "First saved edit");
    await click("Retry save"); await waitUntil(() => !unloadBlocked(), "retry workspace save");
    assert.equal(puts, 2); assert.equal(unloadBlocked(), false);
    // A second session now changes the server before this tab's next save.
    dashboard = { ...dashboard, t: ["Other tab"] }; revision = "2026-09-06T00:00:03Z";
    await editNotes("Keep this draft"); await waitForWorkspaceError("Another session saved different changes");
    assert.match(rootNode.textContent, /Another session saved different changes/);
    assert.equal(rootNode.querySelector("textarea").value, "Keep this draft"); assert.equal(unloadBlocked(), true);
    const conflictToast = rootNode.querySelector(".save-toast-card");
    assert.deepEqual([...conflictToast.querySelectorAll("button, a")].map((control) => control.textContent.trim()), ["Download unsaved work", "Reload saved workspace"]);
    assert.equal([...conflictToast.querySelectorAll("button, a")].some((control) => control.textContent.trim() === "Retry save"), false);
    await click("Download unsaved work"); assert.equal(JSON.parse(await downloads[0].text()).workspaces[0].widgets[0].note, "Keep this draft");
    window.confirm = () => false; await click("Reload saved workspace"); assert.equal(rootNode.querySelector("textarea").value, "Keep this draft");
    window.confirm = () => true; await click("Reload saved workspace"); assert.equal(rootNode.querySelector("textarea").value, "Other tab");
    assert.equal(unloadBlocked(), false); await unmount();
  });

  await t.test("workspace load retry gates editing and preserves settings across navigation", async () => {
    reset(); let fail = true, writes = 0;
    const dashboard = savedDashboard;
    fetcher = async (_url, init) => {
      if (init?.method) { writes++; throw new Error("No save expected"); }
      if (fail) throw new Error("Offline");
      return Response.json({ initialized: true, courses: [], dashboard, revision: baseProfile.updated_at, profile: baseProfile });
    };
    await render(Workspace, { initialProfile: baseProfile });
    assert.equal(rootNode.querySelector('textarea[aria-label="Quick notes"]'), null);
    assert.match(rootNode.textContent, /could not be loaded/); fail = false; await click("Retry loading");
    assert.equal(rootNode.querySelector('textarea[aria-label="Quick notes"]').value, "Saved notes");
    assert.equal(writes, 0); assert.equal(unloadBlocked(), false);
    await click("Settings"); assert.equal(window.location.pathname, "/settings"); await edit("Major", "Kept while navigating");
    await click("Home"); assert.equal(window.location.pathname, "/home");
    const settingsDraftToast = rootNode.querySelector(".save-toast-card");
    assert.match(settingsDraftToast.textContent, /Settings have unsaved changes/);
    assert.ok([...settingsDraftToast.querySelectorAll("button, a")].some((control) => control.textContent.trim() === "Review settings"));
    await editNotes("Workspace draft while settings remain pending");
    const workspacePendingToast = rootNode.querySelector(".save-toast-card");
    assert.match(workspacePendingToast.textContent, /Saving workspace/);
    assert.doesNotMatch(workspacePendingToast.textContent, /Settings have unsaved changes/);
    assert.equal(workspacePendingToast.querySelectorAll("button, a").length, 0, "a pending workspace save exposes no settings or recovery actions");
    await click("Settings"); assert.equal(window.location.pathname, "/settings");
    assert.equal(field("Major").value, "Kept while navigating"); assert.equal(unloadBlocked(), true);
    assert.equal([...rootNode.querySelectorAll("button")].find((b) => b.textContent === "Sign out").disabled, true);
    await unmount();
  });
});

async function clickAria(label, container = rootNode) {
  const button = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label);
  assert.ok(button, `Missing button ${label}`); await act(async () => button.click());
}
async function clickIn(container, text) {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
  assert.ok(button, `Missing button ${text}`); await act(async () => button.click());
}
function installWorkspaceServer(initial = savedDashboard, courses = [], profile = baseProfile) {
  const server = { dashboard: structuredClone(initial), courses, profile, revision: baseProfile.updated_at, writes: 0, reads: 0, offline: false, loseResponse: false, preservationFailure: false };
  fetcher = async (_url, init) => {
    if (init.method === "PUT") {
      if (server.offline) throw new Error("Offline");
      if (server.preservationFailure) {
        server.preservationFailure = false;
        return Response.json({ error: "Free file capacity or restore the prior course folder before retrying.", code: "syllabus-preservation" }, { status: 409 });
      }
      const body = JSON.parse(init.body);
      if (body.baseRevision !== server.revision) return Response.json({}, { status: 409 });
      const state = academicSnapshot(body.courses, body.dashboard);
      server.dashboard = state.dashboard; server.courses = state.courses;
      server.writes++; server.revision = new Date(Date.parse(server.revision) + 1000).toISOString();
      if (server.loseResponse) { server.loseResponse = false; throw new Error("Response lost"); }
      return Response.json({ ok: true, revision: server.revision });
    }
    server.reads++;
    return Response.json({ initialized: true, courses: server.courses, dashboard: server.dashboard, revision: server.revision, profile: server.profile });
  };
  return server;
}
async function saveAndReload(workspaceProps = {}) {
  if (unloadBlocked()) await waitUntil(() => !unloadBlocked(), "workspace autosave");
  assert.equal(unloadBlocked(), false, "autosave finishes before the workspace is reloaded");
  await unmount(); reset(); await render(Workspace, { initialProfile: baseProfile, ...workspaceProps });
}
const cards = () => [...rootNode.querySelectorAll(".widget-grid > .widget-card[data-widget-id]")];

test("native document creation, draft protection, retry and reload integrate with the saved workspace", async () => {
  reset();
  const profile = { ...baseProfile, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const server = installWorkspaceServer(savedDashboard, [sampleCourse], profile);
  const before = structuredClone({ dashboard: server.dashboard, courses: server.courses, profile: server.profile });
  const folderId = "22222222-2222-4222-8222-222222222222";
  const stamp = "2026-10-01T00:00:00.000Z";
  const folder = { id: folderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  let native = null, text = "", offline = false;
  const creates = [], puts = [], reads = [], activityOpens = [];
  const result = () => ({ file: { ...native }, document: { file_id: native.id, body: text, content_revision: native.content_revision } });
  filesFetcher = async (url, init = {}) => {
    if (url.startsWith("/api/file-documents")) {
      assert.equal(new Headers(init.headers).get("x-profile-id"), profile.id);
      if (init.method === "POST") {
        const body = JSON.parse(init.body); creates.push(body);
        assert.equal(body.body, "", "the first durable create is empty");
        text = body.body;
        native = { id: body.id, name: body.name, mime_type: "text/plain", size_bytes: 0, course_id: body.courseId, assignment_id: null, kind: "resource", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: body.folderId, content_backend: "native-text", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
        return Response.json(result());
      }
      if (init.method === "PUT") {
        const body = JSON.parse(init.body); puts.push(body);
        if (offline) throw new Error("Offline document service");
        assert.equal(body.baseContentRevision, native.content_revision);
        if (body.name !== undefined) { assert.equal(body.baseMetadataRevision, native.metadata_revision); native.name = body.name; native.metadata_revision++; }
        if (text !== body.body) native.content_revision++;
        text = body.body; native.size_bytes = new TextEncoder().encode(text).byteLength;
        return Response.json({ ...result(), requestId: body.requestId, acknowledgedContentRevision: native.content_revision });
      }
      reads.push(url); return Response.json(result());
    }
    if (url === "/api/files/actions" && init.method === "POST") {
      const body = JSON.parse(init.body); activityOpens.push(body);
      assert.equal(body.action, "open");
      assert.deepEqual(body.items, [{ type: "file", id: native.id, revision: native.metadata_revision }]);
      return Response.json({ activities: { files: [{ file_id: native.id, starred_at: null, last_opened_at: stamp }], folders: [] } });
    }
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: native ? [native] : [], activities: { files: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: [folder], activities: { folders: [] } });
    return Response.json({ files: [], folders: [], activities: { files: [], folders: [] } });
  };
  const previousFrame = window.requestAnimationFrame, previousCancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
  window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);
  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder");
    await clickAria(`Open folder: ${sampleCourse.code}`);
    await click("New"); await click("Text document");
    await waitUntil(() => rootNode.querySelector(".native-document-fields input:not(:disabled)"), "durable empty document opens in editor");
    await waitUntil(() => activityOpens.length === 1, "created native document Recent acknowledgement");
    assert.equal(creates.length, 1); assert.equal(creates[0].folderId, folderId); assert.equal(creates[0].courseId, sampleCourse.id);
    assert.equal(field("File name").value, "Untitled.txt"); assert.equal(field("Text").value, "");
    offline = true;
    const localText = "Résumé, 日本語, 🌱\nA complete local draft.";
    await edit("File name", "Course notes.txt"); await edit("Text", localText); await click("Save");
    await waitUntil(() => rootNode.textContent.includes("Failed to save"), "document failure");
    assert.equal(unloadBlocked(), true);
    await click("Settings"); assert.ok(rootNode.querySelector(".native-document-dialog"), "workspace navigation keeps the editor open");
    assert.equal([...rootNode.querySelectorAll("button")].find((button) => button.textContent === "Sign out").disabled, true);
    assert.equal(rootNode.querySelector('a[href^="/api/export"]').getAttribute("aria-disabled"), "true");
    await click("Download current drafts (.json)");
    assert.equal(JSON.parse(await downloads.at(-1).text()).nativeDocumentDraft.body, localText);
    assert.equal(field("Text").value, localText);
    window.confirm = () => false; await click("Close editor"); assert.ok(rootNode.querySelector(".native-document-dialog"));
    await click("Download draft"); assert.equal(await downloads.at(-1).text(), localText);
    offline = false; await click("Retry save");
    await waitUntil(() => !unloadBlocked(), "retry acknowledgement");
    await waitUntil(() => activityOpens.length === 2, "saved native document Recent acknowledgement");
    assert.equal(puts.length, 2); assert.equal(puts[0].requestId, puts[1].requestId); assert.deepEqual(puts[0], puts[1]);
    assert.equal(native.id, creates[0].id); assert.equal(text, localText); assert.equal(native.name, "Course notes.txt");
    await click("Close editor"); await saveAndReload({ initialProfile: profile, filesBrowserEnabled: true });
    await click("Files"); await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "folder after reload");
    await clickAria(`Open folder: ${sampleCourse.code}`);
    await waitUntil(() => rootNode.querySelector('[aria-label="Edit text: Course notes.txt"]'), "saved native file");
    await clickAria("Edit text: Course notes.txt");
    await waitUntil(() => field("Text").value === localText, "saved text readback");
    assert.equal(field("File name").value, "Course notes.txt"); assert.equal(reads.length, 1);
    assert.equal(creates.length, 1, "reopening never creates another document");
    await waitUntil(() => activityOpens.length === 3, "reopened native document Recent acknowledgement");
    assert.deepEqual({ dashboard: server.dashboard, courses: server.courses, profile: server.profile }, before, "native editing preserves all workspace and course data");
    assert.equal(server.writes, 0, "native content writes are independent of workspace saves");
    const previousAccountDraft = "Keep this local draft after account changes — 中文";
    await edit("Text", previousAccountDraft);
    const writesBeforeAccountChange = puts.length;
    const changedProfile = { ...profile, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", auth_user_id: "user-b", email: "second@example.invalid" };
    server.profile = changedProfile;
    await render(Workspace, { initialProfile: changedProfile, filesBrowserEnabled: true });
    await waitUntil(() => rootNode.textContent.includes("previous account session"), "account fence retains editor");
    assert.equal(field("Text").value, previousAccountDraft, "workspace account hydration preserves the captured draft");
    assert.equal(field("Text").matches(":disabled"), true);
    assert.equal(unloadBlocked(), true);
    await waitForMilliseconds(850);
    assert.equal(puts.length, writesBeforeAccountChange, "no queued draft is written to either account after the account switch");
    await click("Download draft"); assert.equal(await downloads.at(-1).text(), previousAccountDraft);
    window.confirm = () => false; await click("Close editor"); assert.ok(rootNode.querySelector(".native-document-dialog"));
    window.confirm = () => true; await click("Close editor"); await click("Settings");
    assert.equal([...rootNode.querySelectorAll("button")].find((button) => button.textContent === "Sign out").disabled, false);
  } finally {
    filesFetcher = undefined;
    if (root) await unmount();
    if (previousFrame) window.requestAnimationFrame = previousFrame; else delete window.requestAnimationFrame;
    if (previousCancelFrame) window.cancelAnimationFrame = previousCancelFrame; else delete window.cancelAnimationFrame;
  }
});

test("folder operations retain workspace drafts, retry creates, preserve associations and fence account changes", async () => {
  reset();
  const organizationProfile = { ...baseProfile, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const assignment = { id: "history-essay", title: "Archive essay", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Keep this assignment", weight: "15%" };
  const initial = { ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment] } };
  const server = installWorkspaceServer(initial, [sampleCourse], organizationProfile);
  const before = structuredClone({ dashboard: server.dashboard, courses: server.courses, profile: server.profile });
  const stamp = "2026-10-01T00:00:00.000Z";
  const courseFolderId = "22222222-2222-4222-8222-222222222222";
  const folders = [{ id: courseFolderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null }];
  const text = "Résumé, 日本語, 🌱\nBody survives organization changes.";
  const native = { id: "33333333-3333-4333-8333-333333333333", name: "Course notes.txt", mime_type: "text/plain", size_bytes: new TextEncoder().encode(text).byteLength, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: courseFolderId, content_backend: "native-text", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
  const creates = [], renames = [], moves = [], documentReads = [], activityOpens = [];
  let loseCreateResponse = true;
  filesFetcher = async (url, init = {}) => {
    if (init.method && init.method !== "GET") {
      assert.equal(new Headers(init.headers).get("x-profile-id"), organizationProfile.id);
      const body = JSON.parse(init.body);
      if (url === "/api/file-folders" && init.method === "POST") {
        creates.push(body);
        let folder = folders.find((row) => row.id === body.id);
        if (!folder) {
          folder = { ...folders[0], id: body.id, name: body.name, kind: "custom", course_id: null, course_code: null, parent_id: body.parentId };
          folders.push(folder);
        }
        assert.equal(folder.name, body.name); assert.equal(folder.parent_id, body.parentId);
        if (loseCreateResponse) { loseCreateResponse = false; throw new Error("Create response lost"); }
        return Response.json({ folder });
      }
      if (url === "/api/file-folders" && init.method === "PUT") {
        renames.push(body); const folder = folders.find((row) => row.id === body.id);
        assert.equal(body.action, "rename"); assert.equal(body.revision, folder.revision);
        folder.name = body.name; folder.revision++;
        return Response.json({ folder });
      }
      if (url === "/api/files/actions") {
        if (body.action === "open") {
          activityOpens.push(body);
          assert.deepEqual(body.items, [{ type: "file", id: native.id, revision: native.metadata_revision }]);
          return Response.json({ activities: { files: [{ file_id: native.id, starred_at: null, last_opened_at: stamp }], folders: [] } });
        }
        moves.push(body); assert.equal(body.action, "move"); assert.equal(body.items.length, 1);
        assert.deepEqual(body.items[0], { type: "file", id: native.id, revision: native.metadata_revision });
        native.folder_id = body.destinationId; native.metadata_revision++;
        return Response.json({ files: [native], folders: [] });
      }
      throw new Error(`Unexpected Files mutation ${url}`);
    }
    if (url.startsWith("/api/file-documents")) {
      documentReads.push(url);
      return Response.json({ file: native, document: { file_id: native.id, body: text, content_revision: native.content_revision } });
    }
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: [native], activities: { files: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders, activities: { folders: [] } });
    return Response.json({ files: [], folders: [], activities: { files: [], folders: [] } });
  };
  const previousFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  const dialog = () => rootNode.querySelector(".file-organization-dialog");
  try {
    await render(Workspace, { initialProfile: organizationProfile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder");
    await clickAria(`Open folder: ${sampleCourse.code}`); await click("New"); await click("New folder");
    await edit("Folder name", "Research notes"); await clickIn(dialog(), "Create folder");
    await waitUntil(() => dialog()?.textContent.includes("could not be reached"), "ambiguous create failure");
    assert.equal(creates.length, 1); assert.equal(creates[0].parentId, courseFolderId);
    const keptInput = field("Folder name");
    await click("Settings");
    assert.ok(dialog(), "the folder draft survives SPA navigation");
    assert.equal(keptInput.value, "Research notes"); assert.equal(unloadBlocked(), true);
    assert.equal([...rootNode.querySelectorAll("button")].find((button) => button.textContent === "Sign out").disabled, true);
    assert.equal(rootNode.querySelector('a[href^="/api/export"]').getAttribute("aria-disabled"), "true");
    const settingsInput = field("Major"); settingsInput.focus();
    const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    settingsInput.dispatchEvent(tab); assert.equal(tab.defaultPrevented, false, "a hidden Files dialog does not trap Settings keyboard input");
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    settingsInput.dispatchEvent(escape); assert.ok(dialog(), "Escape in Settings does not discard the hidden Files draft");
    await click("Download current drafts (.json)");
    const recovery = JSON.parse(await downloads.at(-1).text()).fileOrganizationDraft;
    assert.equal(recovery.capturedProfileId, organizationProfile.id); assert.equal(recovery.id, creates[0].id); assert.equal(recovery.name, "Research notes");
    await click("Review Files"); await clickIn(dialog(), "Create folder");
    await waitUntil(() => !dialog(), "idempotent create retry");
    assert.deepEqual(creates[1], creates[0]); assert.equal(folders.length, 2);
    await clickAria(`Open folder: ${sampleCourse.code}`);
    await waitUntil(() => rootNode.querySelector('[aria-label="More options for Research notes"]'), "created folder readback");
    await clickAria("More options for Research notes"); await click("Rename folder"); await edit("Name", "Research archive"); await clickIn(dialog(), "Rename");
    await waitUntil(() => !dialog(), "folder rename");
    assert.equal(renames[0].id, creates[0].id); assert.equal(folders[1].parent_id, courseFolderId);
    await clickAria("More options for Course notes.txt"); await clickIn(rootNode.querySelector(".files-context-menu"), "Move to…");
    const rootDestination = [...dialog().querySelectorAll(".file-organization-destination")].find((node) => node.querySelector("strong")?.textContent === "My files");
    await clickIn(rootDestination, "Move here"); await clickIn(dialog(), "Move items");
    await waitUntil(() => !dialog(), "file move");
    assert.equal(native.folder_id, null); assert.equal(native.course_id, sampleCourse.id); assert.equal(native.assignment_id, assignment.id); assert.equal(native.content_revision, 1);
    assert.equal(server.writes, 0); assert.deepEqual({ dashboard: server.dashboard, courses: server.courses, profile: server.profile }, before);
    await saveAndReload({ initialProfile: organizationProfile, filesBrowserEnabled: true }); await click("Files");
    await waitUntil(() => rootNode.querySelector('[aria-label="More options for Course notes.txt"]'), "moved file after reload");
    const fileRow = rootNode.querySelector('[aria-label="More options for Course notes.txt"]').closest(".files-item");
    assert.match(fileRow.textContent, /HIST 205/); assert.match(fileRow.textContent, /Archive essay/);
    await clickAria("More options for Course notes.txt"); await click("Edit text");
    await waitUntil(() => rootNode.querySelector(".native-document-fields textarea:not(:disabled)"), "moved document body");
    assert.equal(field("Text").value, text); assert.equal(documentReads.length, 1); assert.equal(activityOpens.length, 1); await click("Close editor");
    await click("New"); await click("New folder"); await edit("Folder name", "Previous account draft");
    const writesBeforeAccountChange = creates.length + renames.length + moves.length;
    const changedProfile = { ...baseProfile, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", auth_user_id: "user-b", email: "second@example.invalid" };
    server.profile = changedProfile;
    await render(Workspace, { initialProfile: changedProfile, filesBrowserEnabled: true });
    await waitUntil(() => dialog()?.textContent.includes("previous account"), "retained organization account fence");
    assert.equal(field("Folder name").value, "Previous account draft"); assert.equal(field("Folder name").disabled, true);
    assert.equal(unloadBlocked(), true); await clickIn(dialog(), "Download draft");
    assert.equal(JSON.parse(await downloads.at(-1).text()).capturedProfileId, organizationProfile.id);
    await waitForMilliseconds(50); assert.equal(creates.length + renames.length + moves.length, writesBeforeAccountChange);
    window.confirm = () => false; await clickAria("Close Files dialog"); assert.ok(dialog());
    window.confirm = () => true; await clickAria("Close Files dialog"); assert.equal(dialog(), null);
    assert.equal(server.writes, 0);
  } finally {
    window.requestAnimationFrame = previousFrame; filesFetcher = undefined;
    if (root) await unmount();
  }
});

test("Trash Undo follows navigation, restores academic links and fences held account acknowledgements", async () => {
  reset();
  const profileA = { ...baseProfile, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const profileB = { ...baseProfile, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", auth_user_id: "user-b" };
  const assignment = { id: "history-essay", title: "Archive essay", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Keep academic data", weight: "15%" };
  const server = installWorkspaceServer({ ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment] } }, [sampleCourse], profileA);
  const before = structuredClone({ dashboard: server.dashboard, courses: server.courses });
  const stamp = "2026-10-01T00:00:00.000Z";
  const file = { id: "33333333-3333-4333-8333-333333333333", name: "Linked notes.txt", mime_type: "text/plain", size_bytes: 40, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: null, content_backend: "native-text", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null, original_location_path: null };
  const writes = [];
  let holdDelete = false, finishDelete, failRestoreRead = false;
  filesFetcher = async (url, init = {}) => {
    if (init.method === "DELETE") {
      writes.push({ profile: new Headers(init.headers).get("x-profile-id"), method: "DELETE" });
      file.trashed_at = "2026-10-08T00:00:00.000Z"; file.trash_operation_id = "44444444-4444-4444-8444-444444444444"; file.original_location_path = "My files"; file.metadata_revision++; file.updated_at = file.trashed_at;
      const response = structuredClone(file);
      if (holdDelete) await new Promise((resolve) => { finishDelete = resolve; });
      return Response.json({ file: response });
    }
    if (url === "/api/files/actions" && init.method === "POST") {
      const body = JSON.parse(init.body);
      writes.push({ profile: new Headers(init.headers).get("x-profile-id"), body });
      assert.equal(body.action, "restore"); assert.deepEqual(body.items, [{ type: "file", id: file.id, revision: file.metadata_revision }]);
      file.trashed_at = null; file.trash_operation_id = null; file.original_location_path = null; file.metadata_revision++;
      failRestoreRead = true;
      return Response.json({ files: [file], folders: [], recoveryFolder: null });
    }
    if (failRestoreRead) { failRestoreRead = false; throw new Error("Read after restore interrupted"); }
    return Response.json({ files: file.trashed_at ? [] : [file], folders: [], activities: { files: [], folders: [] } });
  };
  try {
    await render(Workspace, { initialProfile: profileA }); await waitUntil(() => !rootNode.textContent.includes("Loading workspace"), "workspace hydration"); await click("Files");
    await waitUntil(() => rootNode.querySelector(".private-file-list")?.textContent.includes(file.name), "linked file");
    await click("Move to Trash");
    await waitUntil(() => rootNode.textContent.includes("Linked notes.txt moved to Trash"), "global Trash notification");
    assert.equal(rootNode.querySelector(".private-file-list").textContent.includes(file.name), false);
    await click("Settings"); assert.ok([...rootNode.querySelectorAll("button")].some((node) => node.textContent === "Undo"));
    await click("Undo"); await waitUntil(() => file.trashed_at === null && rootNode.textContent.includes("The restore was saved, but Files could not refresh"), "acknowledged restore with failed refresh");
    assert.equal(writes.length, 2); await click("Retry Files refresh");
    await waitUntil(() => rootNode.textContent.includes("Restored from Trash."), "Undo refresh retry");
    assert.equal(writes.length, 2, "refresh retry never repeats the acknowledged restore");
    await waitUntil(() => ![...rootNode.querySelectorAll("button")].some((node) => node.textContent === "Undo"), "dismissed Undo notification");
    assert.equal(file.course_id, sampleCourse.id); assert.equal(file.assignment_id, assignment.id); assert.equal(file.content_revision, 1);
    await click("Files"); await waitUntil(() => rootNode.querySelector(".private-file-list")?.textContent.includes(file.name), "restored attachment");
    assert.deepEqual({ dashboard: server.dashboard, courses: server.courses }, before); assert.equal(server.writes, 0);
    assert.ok(writes.every((write) => write.profile === profileA.id));
    holdDelete = true; await click("Move to Trash"); await waitUntil(() => !!finishDelete, "held Trash request");
    server.profile = profileB; await render(Workspace, { initialProfile: profileB });
    server.profile = profileA; await render(Workspace, { initialProfile: profileA });
    await act(async () => finishDelete());
    await waitForMilliseconds(75);
    assert.equal([...rootNode.querySelectorAll("button")].some((node) => node.textContent === "Undo"), false, "a late A acknowledgment cannot become Undo after A → B → A");
    assert.equal(writes.length, 3); assert.equal(server.writes, 0);
  } finally { filesFetcher = undefined; if (root) await unmount(); }
});

test("Trash confirmations retain exact requests through workspace navigation and account changes", async () => {
  reset();
  const profileA = { ...baseProfile, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const profileB = { ...baseProfile, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", auth_user_id: "user-b" };
  const server = installWorkspaceServer(savedDashboard, [], profileA);
  const stamp = "2026-10-01T00:00:00.000Z";
  const file = { id: "33333333-3333-4333-8333-333333333333", name: "Résumé 日本語.txt", mime_type: "text/plain", size_bytes: 40, course_id: null, assignment_id: null, kind: "resource", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: null, content_backend: "native-text", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null, original_location_path: null };
  const requests = [];
  let trashFailure = true;
  filesFetcher = async (url, init = {}) => {
    if (url === "/api/files/actions" && init.method === "POST") {
      const body = JSON.parse(init.body); requests.push({ profile: new Headers(init.headers).get("x-profile-id"), body });
      if (body.action === "empty-trash") return Response.json({ error: "Storage cleanup interrupted" }, { status: 503 });
      assert.equal(body.action, "trash");
      if (trashFailure) { trashFailure = false; return Response.json({ error: "Connection interrupted" }, { status: 503 }); }
      file.trashed_at = "2026-10-08T00:00:00.000Z"; file.trash_operation_id = "44444444-4444-4444-8444-444444444444"; file.original_location_path = file.name; file.metadata_revision++;
      return Response.json({ files: [file], folders: [], recoveryFolder: null });
    }
    if (url.startsWith("/api/file-folders")) return Response.json({ folders: [], activities: { folders: [] } });
    const view = new URL(url, window.location.href).searchParams.get("view");
    return Response.json({ files: view === "trash" ? file.trashed_at ? [file] : [] : view === "all" ? [file] : file.trashed_at ? [] : [file], activities: { files: [] } });
  };
  const previousFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => { callback(0); return 1; };
  const dialog = () => rootNode.querySelector(".files-trash-dialog");
  try {
    await render(Workspace, { initialProfile: profileA, filesBrowserEnabled: true }); await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="More options for ${file.name}"]`), "browser file");
    await clickAria(`More options for ${file.name}`); await clickIn(rootNode.querySelector(".files-context-menu"), "Move to Trash");
    assert.ok(dialog()); assert.equal(requests.length, 0, "opening a confirmation does not mutate content");
    await click("Settings"); assert.ok(dialog()); assert.equal(unloadBlocked(), true);
    assert.equal([...rootNode.querySelectorAll("button")].find((node) => node.textContent === "Sign out").disabled, true);
    const input = field("Major"); input.focus();
    const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); input.dispatchEvent(tab); assert.equal(tab.defaultPrevented, false);
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.ok(dialog());
    await click("Download current drafts (.json)");
    const draft = JSON.parse(await downloads.at(-1).text()).fileOrganizationDraft;
    assert.equal(draft.capturedProfileId, profileA.id); assert.equal(draft.action, "trash"); assert.equal(draft.items[0].revision, 1);
    await click("Review Files"); await clickIn(dialog(), "Move to Trash"); await waitUntil(() => dialog()?.textContent.includes("Connection interrupted"), "retained trash failure");
    await clickIn(dialog(), "Retry move to Trash"); await waitUntil(() => !dialog(), "confirmed Trash");
    assert.deepEqual(requests[1], requests[0]); assert.ok(rootNode.textContent.includes(`${file.name} moved to Trash`));
    await click("Dismiss Trash notification"); await click("Trash");
    await waitUntil(() => rootNode.querySelector(".files-trash-empty-button")?.textContent.includes("(1)"), "all Trash count");
    await clickIn(rootNode, "Empty Trash (1)"); assert.match(dialog().textContent, /cannot be undone/);
    await clickIn(dialog(), "Empty Trash"); await waitUntil(() => dialog()?.textContent.includes("Storage cleanup interrupted"), "interrupted purge");
    const purgeRequest = requests.at(-1); assert.equal(purgeRequest.body.action, "empty-trash"); assert.ok(purgeRequest.body.requestId);
    await click("Settings"); await click("Download current drafts (.json)");
    const purgeDraft = JSON.parse(await downloads.at(-1).text()).fileOrganizationDraft;
    assert.equal(purgeDraft.requestId, purgeRequest.body.requestId); assert.equal(purgeDraft.count, 1);
    server.profile = profileB; await render(Workspace, { initialProfile: profileB, filesBrowserEnabled: true });
    await waitUntil(() => dialog()?.textContent.includes("previous account"), "retained old-account purge draft");
    assert.equal(dialog().querySelector(".files-trash-submit").disabled, true);
    await clickIn(dialog(), "Download request"); assert.equal(JSON.parse(await downloads.at(-1).text()).capturedProfileId, profileA.id);
    assert.equal(requests.length, 3); await clickAria("Close Trash dialog"); assert.equal(dialog(), null); assert.equal(server.writes, 0);
  } finally { window.requestAnimationFrame = previousFrame; filesFetcher = undefined; if (root) await unmount(); }
});

test("workspace autosave shows one action-free pending status while the debounced write is held", async (t) => {
  t.after(async () => { if (root) await unmount(); });
  reset(); const server = installWorkspaceServer();
  const saveImmediately = fetcher;
  let writesRequested = 0, finishWrite;
  fetcher = async (url, init = {}) => {
    if (init.method === "PUT") {
      writesRequested++;
      await new Promise((resolve) => { finishWrite = resolve; });
    }
    return saveImmediately(url, init);
  };
  await render(Workspace, { initialProfile: baseProfile });
  await editNotes("A change that is saved automatically");

  const toast = rootNode.querySelector(".save-toast-card");
  assert.ok(toast, "a pending autosave has a visible status card");
  assert.equal(toast.getAttribute("role"), "status");
  assert.equal(toast.getAttribute("aria-busy"), "true");
  assert.match(toast.textContent, /Saving workspace/);
  assert.ok(toast.querySelector(".save-toast-spinner"), "the pending save shows its spinner");
  for (const label of ["Save now", "Download unsaved work", "Reload saved workspace"]) {
    assert.equal([...toast.querySelectorAll("button, a")].some((control) => control.textContent.trim() === label), false, `${label} is absent during normal autosave`);
  }

  await waitUntil(() => writesRequested === 1, "debounced workspace write");
  assert.match(rootNode.querySelector(".save-toast-card").textContent, /Saving workspace/);
  assert.equal(rootNode.querySelector(".save-toast-card").querySelectorAll("button, a").length, 0, "a pending write still has no recovery controls");
  await act(async () => finishWrite());
  await waitForWorkspaceSave(server, 0);
  assert.equal(server.writes, 1);
  await waitUntil(() => !rootNode.querySelector(".save-toast-card"), "saved status card exit", 2000);
});

test("sidebar collapse keeps accessible navigation, persists locally and does not save account data", async () => {
  window.localStorage.removeItem("edu-sidebar-collapsed");
  reset(); const server = installWorkspaceServer();
  try {
    await render(Workspace, { initialProfile: baseProfile });
    assert.equal(rootNode.querySelector(".topbar-avatar"), null);
    await clickAria("Collapse sidebar");
    assert.ok(rootNode.querySelector(".app-shell.sidebar-collapsed"));
    assert.equal(rootNode.querySelector(".sidebar-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(window.localStorage.getItem("edu-sidebar-collapsed"), "true");
    for (const label of ["Home", "Courses", "Calendar", "Tasks", "Files", "Settings"]) {
      assert.ok(rootNode.querySelector(`.sidebar a[aria-label="${label}"][title="${label}"]`));
    }
    await click("Tasks");
    assert.equal(window.location.pathname, "/tasks");
    assert.ok(rootNode.querySelector(".app-shell.sidebar-collapsed"));
    await unmount(); reset(); await render(Workspace, { initialProfile: baseProfile });
    assert.ok(rootNode.querySelector(".app-shell.sidebar-collapsed"));
    await clickAria("Expand sidebar");
    assert.equal(rootNode.querySelector(".app-shell.sidebar-collapsed"), null);
    assert.equal(window.localStorage.getItem("edu-sidebar-collapsed"), "false");
    assert.equal(server.writes, 0);
  } finally { if (root) await unmount(); window.localStorage.removeItem("edu-sidebar-collapsed"); }
});

test("sidebar toggle works when browser storage is blocked", async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
  reset(); installWorkspaceServer();
  try {
    await render(Workspace, { initialProfile: baseProfile });
    await clickAria("Collapse sidebar");
    assert.ok(rootNode.querySelector(".app-shell.sidebar-collapsed"));
    await clickAria("Expand sidebar");
    assert.equal(rootNode.querySelector(".app-shell.sidebar-collapsed"), null);
  } finally { if (root) await unmount(); Object.defineProperty(window, "localStorage", storageDescriptor); }
});

test("widget options fade on outside clicks while inside clicks and actions keep working", async () => {
  reset(); const server = installWorkspaceServer({ ...savedDashboard, w: [["day", "Day", [[12, 1], [12, 1]]]] });
  try {
    await render(Workspace, { initialProfile: baseProfile });
    const [first, second] = cards();
    await clickAria("Quick notes options", first);
    let menu = first.querySelector(".widget-menu");
    await act(async () => menu.querySelector("p").click());
    assert.equal(menu.classList.contains("is-closing"), false, "clicking inside the menu does not start dismissal");
    await act(async () => first.querySelector("textarea").click());
    assert.equal(menu.classList.contains("is-closing"), true, "clicking elsewhere in the widget starts the fade");
    assert.equal(menu.getAttribute("aria-hidden"), "true", "the fading menu is hidden from assistive technology");
    assert.equal(menu.hasAttribute("inert"), true, "the fading menu cannot receive interaction");
    assert.ok(rootNode.querySelector(".widget-menu") === menu, "the menu stays mounted for the fade");
    await act(async () => menu.querySelector("p").dispatchEvent(widgetMenuAnimationEnd()));
    assert.ok(rootNode.querySelector(".widget-menu") === menu, "a child animation does not finish the menu fade");
    await finishWidgetMenuDismissal(menu, "other-animation");
    assert.ok(rootNode.querySelector(".widget-menu") === menu, "unrelated animations do not finish the menu fade");
    await finishWidgetMenuDismissal(menu);
    assert.ok(!rootNode.querySelector(".widget-menu"), "the dismissal animation removes the menu");

    await clickAria("Quick notes options", first);
    await act(async () => rootNode.querySelector(".home-greeting").click());
    menu = rootNode.querySelector(".widget-menu");
    assert.equal(menu.classList.contains("is-closing"), true, "clicking the page starts the fade");
    await finishWidgetMenuDismissal(menu);
    assert.ok(!rootNode.querySelector(".widget-menu"));

    await clickAria("Quick notes options", first);
    await clickAria("Quick notes options", first);
    menu = rootNode.querySelector(".widget-menu");
    assert.equal(menu.classList.contains("is-closing"), true, "the same trigger starts dismissal");
    await finishWidgetMenuDismissal(menu);
    assert.ok(!rootNode.querySelector(".widget-menu"));

    await clickAria("Quick notes options", first);
    await clickAria("Quick notes options", second);
    assert.ok(!first.querySelector(".widget-menu"));
    assert.ok(second.querySelector(".widget-menu"), "a different trigger opens its menu on the first click");
    assert.equal(second.querySelector(".widget-menu").classList.contains("is-closing"), false);
    assert.equal(server.writes, 0, "menu dismissal and opening do not edit the workspace");
    menu = second.querySelector(".widget-menu");
    await clickAria("Large widget", second);
    assert.equal(cards()[1].dataset.size, "large", "inside menu actions still run");
    assert.ok(!rootNode.querySelector(".widget-menu"));
    assert.equal(menu.classList.contains("is-closing"), false, "size action removes its menu immediately without starting a fade");
    assert.equal(menu.isConnected, false);
  } finally { if (root) await unmount(); }
});

test("widget menu positions and repositions within the viewport", async () => {
  reset(); installWorkspaceServer();
  try {
    await render(Workspace, { initialProfile: baseProfile });
    const [first] = cards();
    const layout = installWidgetMenuGeometry(first);
    const frames = installFrameQueue();
    try {
      await clickAria("Quick notes options", first);
      const menu = first.querySelector(".widget-menu");
      assert.ok(menu);
      let bounds = menu.getBoundingClientRect();
      assert.equal(bounds.left, 145, "a left-half trigger aligns the menu's left edge with the trigger");
      assert.equal(bounds.top, 208, "the menu opens below a trigger with room beneath it");

      layout.geometry.cardRect = { left: 800, top: 100, width: 400, height: 700 };
      layout.geometry.anchorRect = { left: 970, top: 350, width: 24, height: 24 };
      await act(async () => {
        window.dispatchEvent(new window.Event("scroll"));
        document.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      });
      bounds = menu.getBoundingClientRect();
      assert.equal(bounds.right, 994, "a right-half trigger aligns the menu's right edge with the trigger");
      assert.equal(bounds.top, 378, "document scrolling recomputes the menu position");

      layout.geometry.viewportWidth = 600;
      layout.geometry.viewportHeight = 400;
      layout.geometry.cardRect = { left: 200, top: 0, width: 400, height: 700 };
      layout.geometry.anchorRect = { left: 570, top: 350, width: 24, height: 24 };
      await act(async () => window.dispatchEvent(new window.Event("resize")));
      frames.flush();
      bounds = menu.getBoundingClientRect();
      assert.equal(bounds.left, 348, "resizing clamps the menu to a 12px viewport margin");
      assert.equal(bounds.top, 26, "the menu flips above when there is not enough room below");

      layout.geometry.naturalMenuHeight = 900;
      await act(async () => window.dispatchEvent(new window.Event("resize")));
      frames.flush();
      bounds = menu.getBoundingClientRect();
      assert.equal(menu.style.maxHeight, "376px", "a tall menu is limited to viewport height minus 24px");
      assert.equal(menu.scrollHeight, 900);
      assert.equal(menu.clientHeight, 376);
      assert.equal(bounds.top, 12, "the tallest menu is clamped to a 12px viewport margin");
      assert.equal(bounds.bottom, 388);
    } finally { layout.restore(); frames.restore(); }
  } finally { if (root) await unmount(); }
});

test("widget menu reopening and switching triggers survive the old dismissal timeout", async () => {
  reset(); const server = installWorkspaceServer({ ...savedDashboard, w: [["day", "Day", [[12, 1], [12, 1]]]] });
  try {
    await render(Workspace, { initialProfile: baseProfile });
    const [first, second] = cards();

    await clickAria("Quick notes options", first);
    await act(async () => rootNode.querySelector(".home-greeting").click());
    const fadingFirstMenu = first.querySelector(".widget-menu");
    assert.equal(fadingFirstMenu.classList.contains("is-closing"), true);
    await clickAria("Quick notes options", first);
    const reopenedMenu = first.querySelector(".widget-menu");
    assert.ok(reopenedMenu, "the same trigger reopens the menu during its fade");
    assert.equal(reopenedMenu.classList.contains("is-closing"), false);
    await waitForMilliseconds(160);
    assert.ok(first.querySelector(".widget-menu") === reopenedMenu, "the cancelled timeout leaves the reopened menu open");

    await act(async () => rootNode.querySelector(".home-greeting").click());
    assert.equal(first.querySelector(".widget-menu").classList.contains("is-closing"), true);
    await clickAria("Quick notes options", second);
    const switchedMenu = second.querySelector(".widget-menu");
    assert.ok(switchedMenu, "switching triggers opens the second menu during the first menu's fade");
    assert.equal(switchedMenu.classList.contains("is-closing"), false);
    await waitForMilliseconds(160);
    assert.ok(second.querySelector(".widget-menu") === switchedMenu, "the old timeout leaves the switched menu open");
    assert.equal(server.writes, 0);
  } finally { if (root) await unmount(); }
});

test("widget menu fallback completes dismissal and unmount clears its pending timeout", async () => {
  reset(); installWorkspaceServer();
  try {
    await render(Workspace, { initialProfile: baseProfile });
    const first = cards()[0];
    await clickAria("Quick notes options", first);
    await act(async () => rootNode.querySelector(".home-greeting").click());
    assert.ok(first.querySelector(".widget-menu.is-closing"));
    await waitForMilliseconds(160);
    assert.ok(!rootNode.querySelector(".widget-menu"), "the fallback removes a menu when animationend is unavailable");

    await clickAria("Quick notes options", first);
    const scheduled = [];
    const cleared = new Set();
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    window.setTimeout = function (callback, delay, ...args) {
      const id = originalSetTimeout.call(this, callback, delay, ...args);
      if (delay === 130) scheduled.push(id);
      return id;
    };
    window.clearTimeout = function (id) {
      if (scheduled.includes(id)) cleared.add(id);
      return originalClearTimeout.call(this, id);
    };
    try {
      await act(async () => rootNode.querySelector(".home-greeting").click());
      assert.equal(scheduled.length, 1, "one fallback timeout is scheduled for the closing menu");
      await unmount();
      assert.ok(cleared.has(scheduled[0]), "unmount clears the pending dismissal timeout");
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  } finally { if (root) await unmount(); }
});

test("topbar search submits the typed query and supports searching again", async () => {
  reset(); const server = installWorkspaceServer();
  try {
    await render(Workspace, { initialProfile: baseProfile });
    const input = rootNode.querySelector('.topbar-search input');
    const setQuery = async (value) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await setQuery("Saved notes");
    const submit = new window.Event("submit", { bubbles: true, cancelable: true });
    await act(async () => input.form.dispatchEvent(submit));
    assert.equal(submit.defaultPrevented, true, "search submits without reloading the workspace");
    assert.equal(window.location.pathname, "/search");
    assert.equal(rootNode.querySelector('[aria-label="Search everything"]').value, "Saved notes");
    assert.match(rootNode.querySelector(".search-results").textContent, /Saved notes/);
    await setQuery("No matching coursework");
    await clickAria("Search");
    assert.match(rootNode.querySelector(".search-meta").textContent, /0 results for “No matching coursework”/);
    assert.ok(rootNode.querySelector(".empty-search"));
    assert.equal(server.writes, 0, "search does not change saved workspace data");
  } finally { if (root) await unmount(); }
});

const sampleCourse = { id: "history", code: "HIST 205", name: "History", credits: 3, instructor: "Teacher", room: "Hall", color: "#112233", soft: "#11223318", initials: "HI" };
test("experimental mode previews each schedule without saving and restores the real workspace", async () => {
  reset(); const server = installWorkspaceServer(savedDashboard, []);
  try {
    await render(Workspace, { initialProfile: baseProfile });
    await clickAria("Experimental mode"); await clickAria("Load Clear experimental data");
    assert.match(rootNode.textContent, /Clear experimental mode/);
    assert.equal(rootNode.querySelector(".nav-count").textContent, "0");
    assert.match(rootNode.textContent, /Nothing due today/);
    assert.match(rootNode.textContent, /No events yet/);
    assert.equal(server.writes, 0); assert.equal(unloadBlocked(), false);

    await clickAria("Experimental mode"); await clickAria("Load Light experimental data");
    assert.match(rootNode.textContent, /Light experimental mode/);
    assert.equal(rootNode.querySelector(".nav-count").textContent, "2");
    assert.equal(server.writes, 0); assert.equal(unloadBlocked(), false);

    await clickAria("Experimental mode"); await clickAria("Load Medium experimental data");
    assert.match(rootNode.textContent, /Medium experimental mode/);
    assert.equal(rootNode.querySelector(".nav-count").textContent, "4");

    await clickAria("Experimental mode"); await clickAria("Load Packed experimental data");
    assert.match(rootNode.textContent, /Packed experimental mode/);
    assert.equal(rootNode.querySelector(".nav-count").textContent, "6");
    assert.equal(server.writes, 0); assert.equal(unloadBlocked(), false);

    await clickAria("Experimental mode"); await click("Exit experimental mode");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.doesNotMatch(rootNode.textContent, /Packed experimental mode/);
    assert.equal(rootNode.querySelector(".nav-count").textContent, "0");
    assert.equal(rootNode.querySelector('textarea[aria-label="Quick notes"]').value, "Saved notes");
    assert.equal(server.writes, 0); assert.equal(unloadBlocked(), false);
  } finally { if (root) await unmount(); }
});

test("study controls persist targets, timers, history and grades", async (t) => {
  t.afterEach(async () => { if (root) await unmount(); });
  await t.test("goals and timer settings retain offline edits and form drafts, then reload", async () => {
    reset(); const server = installWorkspaceServer(savedDashboard, [sampleCourse]); await render(Workspace, { initialProfile: baseProfile });
    assert.equal(server.writes, 0); await click("Study & grades");
    await edit("Daily target", "90"); await edit("Weekly target", "420"); await edit("pomodoro duration", "30"); await edit("focus duration", "50"); await edit("focus class", "history");
    window.confirm = () => false; await click("Close study panel"); assert.ok(rootNode.querySelector('[aria-label="Study and grades"]')); assert.equal(unloadBlocked(), true);
    await click("Save goals and timer settings"); server.offline = true; await waitForWorkspaceError("Offline");
    assert.equal(field("Daily target").value, "90"); server.offline = false; await click("Retry save"); await click("Close study panel"); await saveAndReload();
    assert.equal(server.dashboard.d.study.dailyMinutes, 90); assert.equal(server.dashboard.d.study.weeklyMinutes, 420); assert.deepEqual(server.dashboard.d.study.timers.focus, { minutes: 50, courseId: "history" });
    await click("Study & grades"); assert.equal(field("pomodoro duration").value, "30");
  });
  await t.test("timer pause and resume survive reload and reset requires confirmation", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-07T12:00:00.000Z") });
    reset(); const server = installWorkspaceServer(); await render(Workspace, { initialProfile: baseProfile }); await click("Study & grades"); await click("Start Focus");
    assert.equal([...rootNode.querySelectorAll("button")].find((b) => b.textContent === "Start Pomodoro").disabled, true);
    await click("Close study panel"); await saveAndReload(); const id = server.dashboard.d.study.active.id;
    const writes = server.writes; t.mock.timers.tick(5 * 60000);
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    assert.equal(server.writes, writes); assert.equal(unloadBlocked(), false);
    await click("Study & grades"); await click("Pause Focus"); await click("Close study panel"); await saveAndReload();
    assert.equal(server.dashboard.d.study.active.id, id); assert.equal(server.dashboard.d.study.active.runningSince, null);
    t.mock.timers.tick(60 * 60000); await click("Study & grades"); assert.match(rootNode.querySelector('[aria-label="Focus timer"]').textContent, /40:00/);
    await click("Resume Focus"); t.mock.timers.tick(2 * 60000); await click("Finish Focus"); await click("Close study panel"); await saveAndReload();
    assert.equal(server.dashboard.d.study.active, null); assert.equal(server.dashboard.d.study.sessions.length, 1); assert.equal(server.dashboard.d.study.sessions[0].segments.length, 2);
    await click("Study & grades"); await click("Start Pomodoro"); window.confirm = () => false; await click("Reset Pomodoro"); assert.ok(rootNode.textContent.includes("Pause Pomodoro"));
    window.confirm = () => true; await click("Reset Pomodoro"); await click("Close study panel"); await saveAndReload(); assert.equal(server.dashboard.d.study.active, null); assert.equal(server.dashboard.d.study.sessions.length, 1);
  });
  await t.test("an expired timer completes on load and lost-response retry records it exactly once", async () => {
    reset(); const started = timerAction(emptyStudy(), "start", "pomodoro", Date.now() - 3600000, "closed-page-session");
    const server = installWorkspaceServer({ ...savedDashboard, d: { ...savedDashboard.d, study: started } }); await render(Workspace, { initialProfile: baseProfile });
    server.loseResponse = true; await waitForWorkspaceError("Response lost"); await click("Retry save"); await saveAndReload();
    assert.equal(server.dashboard.d.study.active, null); assert.equal(server.dashboard.d.study.sessions.length, 1); assert.equal(server.dashboard.d.study.sessions[0].id, "closed-page-session");
    await click("Study & grades"); assert.match(rootNode.textContent, /0h 25m/); await click("Delete session"); await click("Close study panel"); await saveAndReload(); assert.equal(server.dashboard.d.study.sessions.length, 0);
  });
  await t.test("widgets, sidebar, class details and dashboard calculate from the same saved records", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-07T12:00:00.000Z") });
    reset(); const profile = { ...baseProfile, gpa_system: "4.0 scale", current_term: "Fall", timezone: "UTC", week_starts_on: "Monday" };
    const study = { ...emptyStudy(), dailyMinutes: 120, weeklyMinutes: 240, sessions: [6, 7].map((day) => ({ id: String(day), kind: "focus", courseId: "history", segments: [{ start: `2026-09-0${day}T09:00:00.000Z`, end: `2026-09-0${day}T10:00:00.000Z` }] })), grades: [{ id: "g", courseId: "history", term: "Fall", system: "4.0 scale", max: 4, value: 3.5 }] };
    const a = { id: "done", title: "Finished essay", courseId: "history", due: "", dateKey: "2026-09-07", status: "done", progress: 100, completedAt: "2026-09-07T11:00:00.000Z", description: "", weight: "" };
    installWorkspaceServer({ ...savedDashboard, w: [["day", "Day", [0, 1, 8, 9, 10, 13, 14, 15].map((type) => [type, 1])]], d: { ...savedDashboard.d, study, assignments: [a, { ...a, id: "essay", title: "Actual essay", status: "later", progress: 30, completedAt: null }, { ...a, id: "exam", title: "Actual exam", courseId: "", type: "Exam", dateKey: "2026-09-08", status: "later", progress: 0, completedAt: null }], manualEvents: [{ id: "event-exam", title: "Calendar exam", courseId: "history", dateKey: "2026-09-09", time: "10:00", type: "Exam" }] } }, [sampleCourse], profile);
    await render(Workspace, { initialProfile: profile });
    assert.match(rootNode.querySelector(".widget-daily-goal").textContent, /1h 00m.*2h 00m.*50%/);
    assert.match(rootNode.querySelector(".widget-weekly-goal").textContent, /1h 00m.*4h 00m.*25%/);
    assert.match(rootNode.querySelector(".widget-task-completion").textContent, /1 of 3 complete33%/);
    assert.match(rootNode.querySelector(".widget-assignment-pie").textContent, /2open.*HIST 205.*1.*Personal.*1/);
    assert.match(rootNode.querySelector(".widget-gpa").textContent, /3.50/); assert.match(rootNode.querySelector(".widget-streak").textContent, /2 days.*Longest: 2/);
    assert.match(rootNode.querySelector(".widget-exams").textContent, /Actual exam.*1 days.*Calendar exam.*2 days/);
    assert.match(rootNode.querySelector(".widget-today").textContent, /2tasks this week/); assert.equal(rootNode.querySelector(".nav-count").textContent, "1");
    await click("Courses"); assert.match(rootNode.querySelector(".summary-strip").textContent, /1Completed this week.*25%/);
    await act(async () => rootNode.querySelector(".class-card").click()); assert.match(rootNode.querySelector('[aria-label="Class details"]').textContent, /2h 00m recorded study · 1 \/ 2 assignments complete.*Grade: 3.50 \/ 4/);
  });
  await t.test("grades create, edit, change scale and delete with account reloads", async () => {
    reset(); const profile = { ...baseProfile, gpa_system: "4.0 scale", current_term: "Fall" };
    const initial = { ...savedDashboard, w: [["day", "Day", [[10, 1]]]] };
    const server = installWorkspaceServer(initial, [sampleCourse], profile); await render(Workspace, { initialProfile: profile });
    assert.match(rootNode.querySelector(".gpa-widget").textContent, /Enter grades/); await click("Edit grades");
    await edit("Grade class", "history"); await edit("Grade value", "3.5"); await click("Save grade"); await click("Close study panel"); await saveAndReload();
    assert.match(rootNode.querySelector(".gpa-widget").textContent, /3.50/); assert.equal(server.dashboard.d.study.grades[0].term, "Fall");
    await click("Edit grades"); await click("Edit grade"); await edit("Grade value", "0"); await click("Save grade"); await click("Close study panel"); await saveAndReload(); assert.match(rootNode.querySelector(".gpa-widget").textContent, /0.00/);
    await click("Edit grades"); await edit("Grade class", "history"); await edit("Grade scale", "Custom"); await edit("Custom scale maximum", "10"); await edit("Grade value", "8"); await click("Save grade"); await click("Close study panel"); await saveAndReload(); assert.equal(server.dashboard.d.study.grades.length, 2); assert.equal(server.dashboard.d.study.grades[1].max, 10);
    await click("Edit grades"); await click("Delete grade"); await click("Close study panel"); await saveAndReload(); assert.equal(server.dashboard.d.study.grades.length, 1); assert.match(rootNode.querySelector(".gpa-widget").textContent, /Enter grades/);
  });
});

test("academic forms, syllabus review and calendar save complete account snapshots", async (t) => {
  t.afterEach(async () => { if (root) await unmount(); });
  await t.test("legacy noon events remain saveable and multiple undated assignments can be repaired individually", async () => {
    reset();
    const initial = { ...savedDashboard, d: { ...savedDashboard.d, assignments: ["First", "Second"].map((title) => ({ id: title, title, courseId: "", dateKey: "", due: "Invalid Date", status: "later", progress: 0, description: "Keep this description", weight: "" })), manualEvents: [{ id: "legacy", title: "Old noon event", courseId: "math", dateKey: "2026-10-15", time: "12:00 PM", type: "Study block" }] } };
    const server = installWorkspaceServer(initial); await render(Workspace, { initialProfile: baseProfile });
    assert.equal(server.writes, 0); assert.equal(unloadBlocked(), true);
    await click("Courses");
    for (const title of ["First", "Second"]) {
      const row = [...rootNode.querySelectorAll(".assignment-row")].find((node) => node.textContent.includes(title));
      await act(async () => row.click()); await click("Edit assignment"); await edit("Due date", "2026-10-15"); await click("Save assignment");
      assert.equal(rootNode.querySelector('[aria-label="Edit assignment"]'), null);
    }
    await saveAndReload();
    assert.ok(server.dashboard.d.assignments.every((a) => a.dateKey === "2026-10-15" && a.description === "Keep this description"));
    assert.equal(server.dashboard.d.manualEvents[0].time, "12:00"); assert.equal(server.dashboard.d.manualEvents[0].courseId, "");
  });

  await t.test("recurring meetings use saved weekdays and date ranges in every calendar view", async () => {
    reset();
    const initial = { ...savedDashboard, d: { ...savedDashboard.d, courseDetails: { history: { officeHours: "", meetings: [{ id: "m", days: [1, 3], start: "09:30", end: "11:00", from: "2026-10-01", until: "2026-10-31", location: "Hall 2" }] } } } };
    installWorkspaceServer(initial, [sampleCourse]); await render(Workspace, { initialProfile: baseProfile }); await click("Calendar");
    await selectCalendarDate("2026-10-05");
    assert.match(rootNode.querySelector('[aria-label="2026-10-05"]').textContent, /History.*9:30 AM.*11:00 AM.*HIST 205.*Hall 2/);
    assert.ok(!rootNode.querySelector('[aria-label="2026-10-06"]').textContent.includes("HIST 205"));
    await click("Week"); assert.equal(rootNode.querySelectorAll(".calendar-chip").length, 2);
    await click("Day"); assert.equal(rootNode.querySelectorAll(".calendar-chip").length, 1);
    await act(async () => rootNode.querySelector(".calendar-chip").click()); assert.match(rootNode.querySelector('[aria-label="Class details"]').textContent, /Hall 2/);
    await click("Close class"); await selectCalendarDate("2026-11-02"); assert.equal(rootNode.querySelectorAll(".calendar-chip").length, 0);
  });

  await t.test("class fields and schedule survive a failed save, retry, edit, and reload", async () => {
    reset(); const server = installWorkspaceServer(); await render(Workspace, { initialProfile: baseProfile }); await click("Courses"); await click("Add class"); await click("Manual entry");
    for (const [key, value] of Object.entries({ "Course code": "BIO 42", "Class name": "Field Biology", "Credits": "4", "Instructor": "Dr. Rivers", "Location / meeting notes": "Lab 4", "Office hours": "Friday by appointment" })) await edit(key, value);
    await click("Add meeting"); await edit("First date", "2026-09-01"); await edit("Last date", "2027-05-31"); await edit("Start time", "10:00"); await edit("End time", "11:30"); await edit("Meeting location", "Garden");
    assert.equal(unloadBlocked(), true); await click("Save class");
    server.offline = true; await waitForWorkspaceError("Offline"); assert.equal(server.courses.length, 0);
    server.offline = false; await click("Retry save"); await saveAndReload(); await click("Courses");
    assert.equal(server.courses.length, 1); const course = server.courses[0]; assert.equal(course.credits, 4); assert.equal(course.room, "Lab 4");
    assert.equal(server.dashboard.d.courseDetails[course.id].meetings[0].location, "Garden");
    await act(async () => rootNode.querySelector(".class-card").click()); await click("Edit class");
    assert.equal(field("Office hours").value, "Friday by appointment"); await edit("Instructor", "Dr. Lake"); await click("Save class"); await saveAndReload();
    assert.equal(server.courses[0].instructor, "Dr. Lake"); assert.equal(server.courses[0].id, course.id);
  });

  await t.test("assignment fields, checklist, completion/reopening and deletion persist", async () => {
    reset(); const server = installWorkspaceServer(savedDashboard, [sampleCourse]); await render(Workspace, { initialProfile: baseProfile }); await click("Courses"); await click("Add assignment");
    await edit("Assignment title", "Archival essay"); await edit("Class", "history"); await edit("Due date", "2026-10-15"); await edit("Due time", "17:00"); await edit("Type", "Project"); await edit("Description", "Use primary sources"); await edit("Weight", "25%"); await edit("Assignment notes", "Outline ready"); await edit("Progress", "37"); await edit("Review instructions", true); await click("Save assignment");
    await saveAndReload(); let a = server.dashboard.d.assignments[0]; assert.equal(a.type, "Project"); assert.equal(a.dueTime, "17:00"); assert.equal(a.notes, "Outline ready"); assert.deepEqual(a.checklist, [true, false, false]);
    await click("Courses"); await act(async () => rootNode.querySelector(".assignment-row").click()); await click("Mark complete"); await click("Close assignment"); await saveAndReload();
    a = server.dashboard.d.assignments[0]; assert.equal(a.progress, 100); assert.ok(a.completedAt); assert.equal(a.progressBeforeCompletion, 37);
    await click("Courses"); await click("View every assignment"); await act(async () => rootNode.querySelector(".assignment-row").click()); await click("Mark incomplete"); await click("Close assignment"); await saveAndReload();
    assert.equal(server.dashboard.d.assignments[0].progress, 37); assert.equal(server.dashboard.d.assignments[0].completedAt, null);
    await click("Courses"); await act(async () => rootNode.querySelector(".assignment-row").click()); await click("Delete assignment"); await saveAndReload(); assert.equal(server.dashboard.d.assignments.length, 0);
  });

  await t.test("calendar event CRUD, all views, week start and filters share saved data", async () => {
    reset(); const profile = { ...baseProfile, week_starts_on: "Monday", timezone: "America/Los_Angeles" };
    const server = installWorkspaceServer(savedDashboard, [sampleCourse], profile); await render(Workspace, { initialProfile: profile }); await click("Calendar"); await click("Add event");
    await edit("Event name", "Personal appointment"); await edit("Event date", "2026-10-15"); await edit("Time", "15:45"); await edit("Description", "Bring notes"); await click("Save event"); await saveAndReload(); await click("Calendar");
    assert.equal(server.dashboard.d.manualEvents[0].courseId, "");
    await selectCalendarDate("2026-10-15"); await click("Month"); assert.equal(rootNode.querySelector(".calendar-weekdays span").textContent, "Mon");
    assert.match(rootNode.querySelector(".academic-calendar").textContent, /Personal appointment/);
    await click("Week"); assert.equal(rootNode.querySelectorAll(".academic-day").length, 7); assert.match(rootNode.querySelector(".academic-calendar").textContent, /Personal appointment/);
    await click("Day"); assert.equal(rootNode.querySelectorAll(".academic-day").length, 1);
    await act(async () => rootNode.querySelector(".academic-calendar .calendar-chip").click());
    assert.equal(field("Description").value, "Bring notes"); await edit("Event name", "Revised appointment"); await click("Save event");
    await edit("Class filter", "history"); assert.ok(!rootNode.querySelector(".academic-calendar").textContent.includes("Revised appointment"));
    await edit("Class filter", "personal"); await saveAndReload(); await click("Calendar");
    assert.equal(field("Class filter").value, "personal"); assert.equal(rootNode.querySelectorAll(".academic-day").length, 1);
    assert.equal(rootNode.querySelector('.planner-view-toggle [aria-pressed="true"]').textContent, "Day", "a remounted calendar restores the browser's selected Day view");
    await selectCalendarDate("2026-10-15"); await act(async () => rootNode.querySelector(".calendar-chip").click()); await click("Delete event"); await saveAndReload(); assert.equal(server.dashboard.d.manualEvents.length, 0);
  });

  await t.test("syllabus source and edited review resume, then approve exactly once after a lost response", async () => {
    reset(); const server = installWorkspaceServer(); await render(Workspace, { initialProfile: baseProfile }); await click("Courses"); await click("Import syllabus");
    await edit("Syllabus text", "HIST 222\nEssay - 2026-10-15\nMidterm exam - 2026-11-03\nRead chapter 1 in September."); await edit("Course code", "HIST 222"); await edit("Class name", "Local history"); await click("Suggest dated items");
    assert.equal(rootNode.querySelectorAll(".meeting-editor").length, 2); await edit("Item title", "Reviewed essay"); await edit("Item weight", "20%");
    await click("Close review"); await saveAndReload(); assert.equal(server.courses.length, 0); assert.equal(server.dashboard.d.assignments.length, 0);
    await click("Courses"); await click("Resume HIST 222"); assert.equal(field("Item title").value, "Reviewed essay"); assert.match(field("Syllabus text").value, /Read chapter/);
    await click("Approve class and items"); server.loseResponse = true; await waitForWorkspaceError("Response lost");
    await click("Retry save"); await saveAndReload(); assert.equal(server.courses.length, 1); assert.equal(server.dashboard.d.assignments.length, 2); assert.equal(server.dashboard.d.syllabusDrafts.length, 0);
    assert.equal(server.dashboard.d.assignments[1].type, "Exam"); assert.equal(server.dashboard.d.assignments[0].weight, "20%"); assert.match(Object.values(server.dashboard.d.courseDetails)[0].syllabusText, /Read chapter/);
  });

  await t.test("existing course syllabus text saves through Files without changing the rest of the workspace", async () => {
    reset();
    const historyFileId = "11111111-1111-4111-8111-111111111111";
    const historyFolderId = "22222222-2222-4222-8222-222222222222";
    const historyDetails = {
      officeHours: "Tuesday, 1–3 PM",
      meetings: [{ id: "history-meeting", days: [1, 3], start: "09:30", end: "11:00", from: "2026-09-01", until: "2026-12-15", location: "Hall 2" }],
      syllabusText: "Original HIST 205 syllabus text", syllabusName: "Original History guide", syllabusFileId: historyFileId,
    };
    const biologyDetails = { officeHours: "Friday by appointment", meetings: [], syllabusText: "BIO text stays separate", syllabusName: "BIO guide" };
    const assignments = [{ id: "history-essay", title: "Archive essay", courseId: "history", dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Keep this assignment", weight: "15%" }];
    const manualEvents = [{ id: "personal-event", title: "Personal appointment", courseId: "", dateKey: "2026-10-18", time: "14:00", type: "Personal" }];
    const filePreferences = { filter: "all", view: "grid" };
    const initial = { ...savedDashboard, d: { ...savedDashboard.d, assignments, manualEvents, courseDetails: { history: historyDetails, biology: biologyDetails }, filePreferences } };
    const biologyCourse = { ...sampleCourse, id: "biology", code: "BIO 201", name: "Biology" };
    const courses = [sampleCourse, biologyCourse];
    const server = installWorkspaceServer(initial, courses);
    const sourceFile = {
      id: historyFileId, name: "HIST 205 source.pdf", mime_type: "application/pdf", size_bytes: 256,
      course_id: "history", assignment_id: null, kind: "syllabus", state: "ready",
      created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-03T00:00:00.000Z",
      content_sha256: null, folder_id: historyFolderId, content_backend: "object", metadata_revision: 1,
      content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null,
    };
    const courseFolder = {
      id: historyFolderId, name: "HIST 205", parent_id: null, kind: "course", course_id: "history", course_code: "HIST 205",
      revision: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-03T00:00:00.000Z",
      archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null,
      trashed_at: null, trash_operation_id: null, original_parent_id: null,
    };
    filesFetcher = async (url) => {
      if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: [sourceFile], activities: { files: [] } });
      if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [] } });
      if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: [courseFolder], activities: { folders: [] } });
      if (url.startsWith("/api/file-folders?view=archives") || url.startsWith("/api/file-folders?view=trash")) return Response.json({ folders: [], activities: { folders: [] } });
      throw new Error(`Unexpected syllabus workspace file request: ${url}`);
    };

    try {
      await render(Workspace, { initialProfile: baseProfile, filesBrowserEnabled: true });
      await click("Files");
      await waitUntil(() => rootNode.querySelector('[aria-label="Open folder: HIST 205"]'), "saved course folder in Files");
      assert.equal(rootNode.querySelector('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true");
      await clickAria("Open folder: HIST 205");
      await waitUntil(() => rootNode.querySelector(".files-syllabus-pin"), "saved course syllabus pin");
      await click("Replace upload");
      assert.ok(rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "Files opens the syllabus editor for the owning course");
      const firstText = "Edited course-bound source: résumé, 日本語, ✓";
      await edit("Syllabus text", firstText);
      await edit("Syllabus name", "Revised History guide");
      const originalWrites = server.writes;
      server.offline = true;
      await click("Save syllabus");
      await waitForWorkspaceError("Offline");
      assert.ok(rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "a failed durable write leaves the attachment form open");
      assert.equal(field("Syllabus text").value, firstText, "the complete text draft survives the failed save");
      assert.match(rootNode.querySelector('[aria-label="Uploaded syllabus source"]').textContent, /HIST 205 source\.pdf/);
      assert.equal(server.writes, originalWrites, "the failed attempt did not change the saved dashboard");
      assert.equal(server.dashboard.d.courseDetails.history.syllabusText, historyDetails.syllabusText);

      server.offline = false;
      await click("Save syllabus");
      await waitUntil(() => !rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "syllabus modal closes after retry");
      await waitForWorkspaceSave(server, originalWrites);
      assert.equal(server.writes, originalWrites + 1, "retry writes one complete workspace snapshot");
      const persisted = server.dashboard.d;
      assert.equal(persisted.courseDetails.history.syllabusText, firstText);
      assert.equal(persisted.courseDetails.history.syllabusName, "Revised History guide");
      assert.equal(persisted.courseDetails.history.syllabusFileId, sourceFile.id, "the existing source remains attached to the same course");
      assert.equal(persisted.courseDetails.history.officeHours, historyDetails.officeHours);
      assert.deepEqual(persisted.courseDetails.history.meetings, historyDetails.meetings);
      assert.deepEqual(persisted.courseDetails.biology, biologyDetails, "a second course's details are unchanged");
      assert.deepEqual(persisted.assignments, assignments);
      assert.deepEqual(persisted.manualEvents, manualEvents);
      assert.deepEqual(persisted.filePreferences, filePreferences);
      assert.deepEqual(server.courses.map((course) => course.id), ["biology", "history"]);
      assert.deepEqual(server.profile, baseProfile);

      await saveAndReload({ filesBrowserEnabled: true });
      await click("Files");
      await clickAria("Open folder: HIST 205");
      await waitUntil(() => rootNode.querySelector(".files-syllabus-pin"), "course syllabus pin after workspace reload");
      assert.equal(rootNode.querySelector('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true", "the existing Files view preference survives the reload");
      await click("View text");
      assert.equal(rootNode.querySelector(".syllabus-text-preview-content").textContent, firstText, "the course-bound text reloads into its read-only preview");
      await click("Close preview");

      await click("Replace upload");
      const afterReloadText = "Second revision after reconnect: café, 日本語";
      await edit("Syllabus text", afterReloadText);
      const beforeLostResponse = server.writes;
      const readsBeforeLostResponse = server.reads;
      server.loseResponse = true;
      await click("Save syllabus");
      await waitForWorkspaceError("Response lost");
      assert.ok(rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "an ambiguous response keeps the text draft open until the user retries");
      assert.equal(field("Syllabus text").value, afterReloadText);
      assert.equal(server.writes, beforeLostResponse + 1, "the first lost-response attempt committed exactly one snapshot");
      await click("Save syllabus");
      await waitUntil(() => !rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "matching readback acknowledges a lost save response");
      await waitForWorkspaceSave(server, beforeLostResponse);
      assert.equal(server.writes, beforeLostResponse + 1, "the lost response retry confirms the saved snapshot without a duplicate write");
      assert.equal(server.reads, readsBeforeLostResponse + 1, "the explicit retry acknowledges the identical saved snapshot by readback");
      assert.equal(server.dashboard.d.courseDetails.history.syllabusText, afterReloadText);
      assert.deepEqual(server.dashboard.d.assignments, assignments);
      assert.deepEqual(server.dashboard.d.manualEvents, manualEvents);
      assert.deepEqual(server.dashboard.d.courseDetails.history.meetings, historyDetails.meetings);

      await saveAndReload({ filesBrowserEnabled: true });
      await click("Files");
      await clickAria("Open folder: HIST 205");
      await waitUntil(() => rootNode.querySelector(".files-syllabus-pin"), "course pin after lost-response reload");
      await click("View text");
      assert.equal(rootNode.querySelector(".syllabus-text-preview-content").textContent, afterReloadText);
      await click("Close preview");

      await click("Replace upload");
      const preservationDraft = "Preserve the old source if replacement capacity is full.";
      await edit("Syllabus text", preservationDraft);
      const beforePreservation = server.writes;
      const readsBeforePreservation = server.reads;
      server.preservationFailure = true;
      await click("Save syllabus");
      await waitForWorkspaceError("Free file capacity");
      assert.ok(rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "preservation rejection keeps the edit form and source ID draft open");
      assert.equal(field("Syllabus text").value, preservationDraft);
      assert.match(rootNode.textContent, /Free file capacity or restore the prior course folder/);
      assert.doesNotMatch(rootNode.textContent, /Another session saved different changes/, "preservation conflicts are shown as retryable capacity errors");
      assert.equal(server.writes, beforePreservation, "preservation rejection does not commit the workspace");
      assert.equal(server.reads, readsBeforePreservation, "preservation rejection is not resolved by reading back or adopting another revision");

      await click("Save syllabus");
      await waitUntil(() => !rootNode.querySelector('[aria-label="Attach syllabus for HIST 205"]'), "syllabus saves after capacity is available");
      await waitForWorkspaceSave(server, beforePreservation);
      assert.equal(server.dashboard.d.courseDetails.history.syllabusText, preservationDraft);
    } finally {
      filesFetcher = undefined;
      if (root) await unmount();
    }
  });

  await t.test("removing a class clears its assignments and schedule but retains personal events", async () => {
    reset(); const initial = { ...savedDashboard, d: { ...savedDashboard.d, calendarFilter: "history", assignments: [{ id: "a", courseId: "history", title: "Essay", dateKey: "2026-10-15", due: "", status: "later", progress: 0, description: "", weight: "" }], manualEvents: [{ id: "e", courseId: "history", title: "Keep event", dateKey: "2026-10-15", time: "", type: "Personal" }], courseDetails: { history: { officeHours: "Mondays", meetings: [] } } } };
    const server = installWorkspaceServer(initial, [sampleCourse]); await render(Workspace, { initialProfile: baseProfile }); await click("Courses"); await act(async () => rootNode.querySelector(".class-card").click()); await click("Remove class"); await saveAndReload();
    assert.equal(server.courses.length, 0); assert.equal(server.dashboard.d.assignments.length, 0); assert.deepEqual(server.dashboard.d.courseDetails, {});
    assert.equal(server.dashboard.d.manualEvents[0].courseId, ""); assert.equal(server.dashboard.d.calendarFilter, "all");
  });
});

test("workspace controls persist configurations and independent notes", async (t) => {
  t.afterEach(async () => { if (root) await unmount(); });
  await t.test("workspace creation, rename, ordering, duplication and confirmed deletion survive reloads", async () => {
    reset(); const server = installWorkspaceServer(); await render(Workspace, { initialProfile: baseProfile });
    await clickAria("Workspace options");
    assert.equal([...rootNode.querySelectorAll(".workspace-menu button")].find((button) => button.textContent.trim() === "Delete").disabled, true);
    await clickAria("Workspace options");
    await clickAria("Add workspace"); await edit("Workspace name", "Research"); await click("Create workspace");
    await clickAria("Workspace options"); await clickIn(rootNode.querySelector(".workspace-menu"), "Rename");
    await edit("Workspace name", "Study"); await click("Save name");
    await clickAria("Workspace options"); await click("Move left");
    assert.deepEqual([...rootNode.querySelectorAll('[role="tab"]')].map((node) => node.textContent), ["Study", "Day"]);
    await clickAria("Workspace options"); await click("Move right");
    await click("Day"); await clickAria("Workspace options"); await clickIn(rootNode.querySelector(".workspace-menu"), "Duplicate");
    await editNotes("Copy only"); await saveAndReload();
    assert.equal(rootNode.querySelector('[role="tab"][aria-selected="true"]').textContent, "Day copy");
    assert.equal(rootNode.querySelector("textarea").value, "Copy only");
    await click("Day"); assert.equal(rootNode.querySelector("textarea").value, "Saved notes");
    await click("Day copy"); await clickAria("Workspace options"); window.confirm = () => false; await click("Delete");
    assert.equal(rootNode.querySelectorAll('[role="tab"]').length, 3);
    window.confirm = () => true; await click("Delete"); await saveAndReload();
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces.map((w) => w.name), ["Day", "Study"]);
    assert.equal(rootNode.querySelector("textarea").value, "Saved notes");
  });

  await t.test("duplicating an 80-character workspace name produces a valid saved name", async () => {
    reset(); const server = installWorkspaceServer({ ...savedDashboard, w: [["day", "x".repeat(80), [[12, 1]]]] });
    await render(Workspace, { initialProfile: baseProfile });
    await clickAria("Workspace options"); await clickIn(rootNode.querySelector(".workspace-menu"), "Duplicate");
    await saveAndReload();
    const copied = decodeWorkspaceState(server.dashboard).workspaces[1];
    assert.equal(copied.name.length, 80); assert.ok(copied.name.endsWith(" copy"));
    assert.equal(copied.widgets[0].note, "Saved notes");
  });

  await t.test("all 18 widget types add and persist; size, move and drag keep stable identities", async (t) => {
    reset(); const server = installWorkspaceServer({ ...savedDashboard, w: [["day", "Day", []]], n: "" });
    await render(Workspace, { initialProfile: baseProfile }); await click("Browse widgets");
    const pickerButtons = [...rootNode.querySelectorAll(".widget-picker-grid button")]; assert.equal(pickerButtons.length, 18);
    for (const button of pickerButtons) await act(async () => button.click());
    await click("Done"); assert.equal(cards().length, 18);
    await clickAria("Quick notes options"); await clickAria("Large widget");
    await clickAria("Quick notes options");
    let moveMenu = rootNode.querySelector(".widget-menu");
    await click("Move earlier");
    assert.ok(!rootNode.querySelector(".widget-menu"), "Move earlier closes its menu immediately");
    assert.equal(moveMenu.isConnected, false);
    await clickAria("Quick notes options");
    moveMenu = rootNode.querySelector(".widget-menu");
    await click("Move later");
    assert.ok(!rootNode.querySelector(".widget-menu"), "Move later closes its menu immediately");
    assert.equal(moveMenu.isConnected, false);
    await saveAndReload();
    const writesBeforeHover = server.writes;
    const widgetsBeforeHover = decodeWorkspaceState(server.dashboard).workspaces[0].widgets;
    const draggedId = widgetsBeforeHover.find((widget) => widget.type === "notes").instanceId;
    await click("Customize");

    const frames = installFrameQueue(); t.after(() => frames.restore());
    const previousInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 4000 });
    t.after(() => Object.defineProperty(window, "innerHeight", { configurable: true, value: previousInnerHeight }));
    const grid = rootNode.querySelector(".widget-grid");
    const geometry = installBoardGeometry(grid);
    const source = cards().find((card) => card.dataset.widgetId === draggedId);
    const sourceRect = source.getBoundingClientRect();
    const startX = sourceRect.left + 20, startY = sourceRect.top + 18;
    const { order: candidate, x: dropX, y: dropY } = destinationPointer(widgetsBeforeHover, draggedId, widgetsBeforeHover.length - 1, geometry, startX - sourceRect.left, startY - sourceRect.top);
    await act(async () => source.querySelector("[data-widget-reorder-handle]").dispatchEvent(pointerEvent("pointerdown", { clientX: startX, clientY: startY })));
    await act(async () => {
      document.dispatchEvent(pointerEvent("pointermove", { clientX: dropX, clientY: dropY }));
      frames.flush();
    });
    assert.deepEqual(cards().map((card) => card.dataset.widgetId), candidate, "hover shows the projected order");
    assert.ok(source.classList.contains("widget-reorder-placeholder"));
    const overlay = document.querySelector(".widget-reorder-overlay");
    assert.ok(overlay); assert.equal(overlay.getAttribute("aria-hidden"), "true"); assert.ok(overlay.hasAttribute("inert"));
    assert.equal(overlay.querySelectorAll("[id], [data-widget-id], [data-widget-reorder-handle]").length, 0, "the inert clone does not duplicate live widget identity or controls");
    assert.equal(overlay.querySelector("textarea")?.value, source.querySelector("textarea")?.value, "the full preview retains current notes content");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 760)));
    assert.equal(server.writes, writesBeforeHover, "hovering for longer than autosave delay does not persist the candidate order");
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.map((widget) => widget.instanceId), widgetsBeforeHover.map((widget) => widget.instanceId));
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", { clientX: dropX, clientY: dropY })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 760)));
    await saveAndReload();
    assert.deepEqual(cards().map((card) => card.dataset.widgetId), candidate);
    assert.equal(rootNode.querySelector(".widget-notes").dataset.size, "large");
    assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.length, 18);
    assert.equal(server.writes, writesBeforeHover + 1, "one valid pointer release schedules one workspace save");
  });

  await t.test("widget corner resizing previews geometry and persists without changing identity", async (t) => {
    reset();
    const widgets = [
      { instanceId: "notes-resize", type: "notes", size: "medium", note: "Resize keeps this note" },
      { instanceId: "mini-resize", type: "quote", size: "mini", startsNewMiniBlock: true },
    ];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
    await render(Workspace, { initialProfile: baseProfile });
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 0);
    await click("Customize");

    const frames = installFrameQueue();
    t.after(() => frames.restore());
    let geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
    const host = rootNode.querySelector(".reorderable-widget-grid");
    let captureAttempts = 0;
    host.setPointerCapture = () => {
      captureAttempts++;
      throw new Error("native pointer capture unavailable");
    };
    const stopPointerPropagation = (event) => event.stopPropagation();
    rootNode.addEventListener("pointermove", stopPointerPropagation);
    rootNode.addEventListener("pointerup", stopPointerPropagation);

    const resize = async ({ widgetId, deltaX = 0, deltaY = 0, size, pointerId, pointerType = "mouse", guardPointerId = false, waitBeforeUp = false }) => {
      geometry.updateCards();
      const card = cards().find((item) => item.dataset.widgetId === widgetId);
      assert.ok(card, `Missing resize card ${widgetId}`);
      const handle = card.querySelector("[data-widget-resize-handle]");
      assert.ok(handle, `Missing resize handle for ${widgetId}`);
      if (widgetId === "notes-resize") assert.equal(handle.getAttribute("aria-label"), "Resize Quick notes");
      const rect = card.getBoundingClientRect();
      const startX = rect.right - 4;
      const startY = rect.bottom - 4;
      const writesBefore = server.writes;
      const persistedBefore = decodeWorkspaceState(server.dashboard).workspaces[0].widgets;
      const pointerValues = { pointerId, pointerType, buttons: 1 };
      await act(async () => handle.dispatchEvent(pointerEvent("pointerdown", { ...pointerValues, clientX: startX, clientY: startY })));

      if (guardPointerId) {
        await act(async () => rootNode.dispatchEvent(pointerEvent("pointermove", { ...pointerValues, pointerId: pointerId + 1, clientX: startX + deltaX, clientY: startY + deltaY })));
        assert.equal(card.dataset.size, persistedBefore.find((item) => item.instanceId === widgetId).size, "another pointer cannot change the preview");
      }

      const move = pointerEvent("pointermove", { ...pointerValues, clientX: startX + deltaX, clientY: startY + deltaY });
      await act(async () => rootNode.dispatchEvent(move));
      assert.equal(move.defaultPrevented, true, "document capture handles pointer movement when native capture fails");
      let previewCard = cards().find((item) => item.dataset.widgetId === widgetId);
      assert.equal(previewCard.dataset.size, size);
      assert.ok(previewCard.classList.contains("widget-resizing"));
      assert.ok(rootNode.querySelector(".reorderable-widget-grid").classList.contains("is-widget-resizing"));
      assert.equal(document.querySelector(".widget-reorder-overlay"), null);
      assert.equal(rootNode.querySelector(".widget-reorder-placeholder"), null);
      assert.deepEqual(cards().map((item) => item.dataset.widgetId), persistedBefore.map((item) => item.instanceId));
      assert.equal(server.writes, writesBefore);
      assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((item) => item.instanceId === widgetId).size, persistedBefore.find((item) => item.instanceId === widgetId).size);

      if (guardPointerId) {
        await act(async () => rootNode.dispatchEvent(pointerEvent("pointerup", { ...pointerValues, pointerId: pointerId + 1, buttons: 0, clientX: startX + deltaX, clientY: startY + deltaY })));
        assert.ok(rootNode.querySelector(".reorderable-widget-grid").classList.contains("is-widget-resizing"), "another pointer cannot finish the resize");
        assert.equal(server.writes, writesBefore);
      }
      if (waitBeforeUp) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 760)));
        assert.equal(server.writes, writesBefore, "previewing for longer than the autosave delay does not write before release");
        assert.equal(unloadBlocked(), false);
      }

      await act(async () => rootNode.dispatchEvent(pointerEvent("pointerup", { ...pointerValues, buttons: 0, clientX: startX + deltaX, clientY: startY + deltaY })));
      assert.equal(rootNode.querySelector(".reorderable-widget-grid").classList.contains("is-widget-resizing"), false);
      await waitForWorkspaceSave(server, writesBefore);
      assert.equal(server.writes, writesBefore + 1, "one changed release writes one workspace revision");
      const savedWidget = decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((item) => item.instanceId === widgetId);
      assert.equal(savedWidget.size, size);
      if (widgetId === "notes-resize") assert.equal(savedWidget.note, "Resize keeps this note");
      await saveAndReload();
      assert.deepEqual(cards().map((item) => item.dataset.widgetId), widgets.map((item) => item.instanceId));
      assert.equal(cards().find((item) => item.dataset.widgetId === widgetId).dataset.size, size);
      assert.equal(rootNode.querySelector('[data-widget-id="notes-resize"] textarea').value, "Resize keeps this note");
      await click("Customize");
      geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
    };

    try {
      await resize({ widgetId: "notes-resize", deltaX: -116, size: "small", pointerId: 31, pointerType: "touch", guardPointerId: true, waitBeforeUp: true });
      await resize({ widgetId: "notes-resize", deltaY: 116, size: "medium-vertical", pointerId: 32 });
      await resize({ widgetId: "notes-resize", deltaX: 116, size: "large", pointerId: 33 });
      await resize({ widgetId: "notes-resize", deltaY: -116, size: "medium", pointerId: 34 });
      await resize({ widgetId: "mini-resize", deltaY: 58, size: "small", pointerId: 35 });
      assert.equal(captureAttempts, 1, "the host capture failure falls back to document listeners");
      const grownMini = decodeWorkspaceState(server.dashboard).workspaces[0].widgets.find((item) => item.instanceId === "mini-resize");
      assert.equal(grownMini.size, "small");
      assert.equal(grownMini.startsNewMiniBlock, undefined, "growing out of mini clears its mini-block marker");
    } finally {
      rootNode.removeEventListener("pointermove", stopPointerPropagation);
      rootNode.removeEventListener("pointerup", stopPointerPropagation);
    }
  });

  await t.test("continuous resize geometry stays unsaved until release chooses a new size", async () => {
    reset();
    const widgets = [{ instanceId: "continuous-resize", type: "notes", size: "medium", note: "Keep this note" }];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
    await render(Workspace, { initialProfile: baseProfile });
    await click("Customize");
    const geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
    const source = cards()[0];
    const writesBefore = server.writes;
    const startRect = source.getBoundingClientRect();
    const startX = startRect.right - 4;
    const startY = startRect.bottom - 4;

    await act(async () => source.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", {
      pointerId: 240, buttons: 1, clientX: startX, clientY: startY,
    })));
    await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
      pointerId: 240, buttons: 1, clientX: startX + 6, clientY: startY + 6,
    })));
    const firstWidth = source.style.width;
    const firstHeight = source.style.height;
    assert.equal(source.dataset.size, "medium");
    const expectedWidth = 216 + 15 * (1 - Math.exp(-6 / 15));
    assert.ok(Math.abs(Number.parseFloat(firstWidth) - expectedWidth) < 1e-9);
    assert.equal(firstHeight, "106px");
    assert.equal(server.writes, writesBefore);
    assert.equal(unloadBlocked(), false);

    await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
      pointerId: 240, buttons: 1, clientX: startX + 9, clientY: startY + 9,
    })));
    assert.equal(source.dataset.size, "medium", "continuous geometry can change before the nearest-size boundary");
    assert.notEqual(source.style.width, firstWidth);
    assert.notEqual(source.style.height, firstHeight);
    assert.equal(server.writes, writesBefore, "a held preview never reaches workspace persistence");
    assert.equal(unloadBlocked(), false);

    await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
      pointerId: 240, buttons: 0, clientX: startX + 9, clientY: startY + 9,
    })));
    assert.equal(source.dataset.size, "medium");
    assert.equal(source.dataset.widgetResizeLive, undefined);
    assert.equal(server.writes, writesBefore, "releasing the unchanged nearest size does not save");
    await waitForMilliseconds(760);
    assert.equal(server.writes, writesBefore);

    geometry.updateCards();
    const nextRect = source.getBoundingClientRect();
    const nextStartX = nextRect.right - 4;
    const nextStartY = nextRect.bottom - 4;
    await act(async () => source.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", {
      pointerId: 241, buttons: 1, clientX: nextStartX, clientY: nextStartY,
    })));
    await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
      pointerId: 241, buttons: 1, clientX: nextStartX, clientY: nextStartY + 63,
    })));
    assert.equal(source.dataset.size, "medium");
    assert.equal(server.writes, writesBefore);
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
      pointerId: 241, buttons: 0, clientX: nextStartX, clientY: nextStartY + 63,
    })));
    assert.equal(source.dataset.size, "large");
    assert.equal(server.writes, writesBefore, "the release schedules persistence after the final size is chosen");
    await waitForWorkspaceSave(server, writesBefore);
    assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].widgets[0].size, "large");
    assert.equal(server.writes, writesBefore + 1);
  });

  await t.test("regrabbing a settling resize starts from its visible dimensions", async () => {
    reset();
    const widgets = [{ instanceId: "settling-resize", type: "notes", size: "small", note: "Keep this note" }];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
    const animateDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "animate");
    const animations = [];
    Object.defineProperty(window.HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value(frames, options) {
        const animation = { cancelled: false, onfinish: null, oncancel: null, cancel() { this.cancelled = true; this.oncancel?.(); } };
        animations.push({ element: this, frames, options, animation });
        return animation;
      },
    });
    let source, originalRect;
    try {
      await render(Workspace, { initialProfile: baseProfile });
      await click("Customize");
      installBoardGeometry(rootNode.querySelector(".widget-grid"));
      source = cards()[0];
      const writesBefore = server.writes;
      let rect = source.getBoundingClientRect();
      let startX = rect.right - 4;
      let startY = rect.bottom - 4;
      await act(async () => source.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 242, buttons: 1, clientX: startX, clientY: startY,
      })));
      await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
        pointerId: 242, buttons: 1, clientX: startX + 10, clientY: startY + 10,
      })));
      assert.equal(source.dataset.size, "small");
      assert.equal(server.writes, writesBefore);
      await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
        pointerId: 242, buttons: 0, clientX: startX + 116, clientY: startY + 116,
      })));
      await waitForWorkspaceSave(server, writesBefore);
      assert.equal(source.dataset.size, "large");
      assert.equal(source.dataset.widgetResizeSettling, "true");
      assert.ok(animations.some(({ element }) => element === source));

      originalRect = source.getBoundingClientRect;
      const layoutRect = originalRect();
      source.getBoundingClientRect = () => ({
        left: layoutRect.left,
        top: layoutRect.top,
        right: layoutRect.left + 180,
        bottom: layoutRect.top + 170,
        width: 180,
        height: 170,
        toJSON() { return this; },
      });
      rect = source.getBoundingClientRect();
      startX = rect.right - 4;
      startY = rect.bottom - 4;
      const writesAfterSave = server.writes;
      await act(async () => source.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", {
        pointerId: 243, buttons: 1, clientX: startX, clientY: startY,
      })));
      assert.equal(source.dataset.widgetResizeLive, "true");
      assert.equal(source.style.width, "180px", "pointer-down captures the visible spring width immediately");
      assert.equal(source.style.height, "170px", "pointer-down captures the visible spring height immediately");

      await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
        pointerId: 243, buttons: 1, clientX: startX, clientY: startY + 12,
      })));
      assert.equal(source.dataset.size, "large");
      assert.equal(source.style.width, "180px");
      assert.equal(source.style.height, "182px", "the next move tracks the pointer from the visible height");
      assert.equal(server.writes, writesAfterSave);
      await act(async () => document.dispatchEvent(pointerEvent("pointercancel", {
        pointerId: 243, buttons: 0, clientX: startX, clientY: startY + 12,
      })));
      assert.equal(source.dataset.widgetResizeLive, undefined);
      assert.equal(server.writes, writesAfterSave);
    } finally {
      if (source && originalRect) source.getBoundingClientRect = originalRect;
      if (animateDescriptor) Object.defineProperty(window.HTMLElement.prototype, "animate", animateDescriptor);
      else delete window.HTMLElement.prototype.animate;
    }
  });

  await t.test("resizing a paired mini reserves its row and saves displaced neighbors", async (t) => {
    for (const columns of [4, 2]) {
      await t.test(`${columns}-column board`, async () => {
        reset();
        const widgets = [
          { instanceId: "mini-before", type: "quote", size: "mini" },
          { instanceId: "mini-priority", type: "notes", size: "mini", note: "Keep this content" },
          { instanceId: "small-before", type: "pomodoro", size: "small" },
          { instanceId: "large-neighbor", type: "upcoming", size: "large" },
          { instanceId: "mini-after", type: "quote", size: "mini" },
        ];
        const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
        await render(Workspace, { initialProfile: baseProfile });
        await click("Customize");
        const frames = installFrameQueue();
        installBoardGeometry(rootNode.querySelector(".widget-grid"), { columns });
        await act(async () => { window.dispatchEvent(new window.Event("resize")); frames.flush(); });
        const getCard = (id) => cards().find((card) => card.dataset.widgetId === id);
        const source = getCard("mini-priority");
        const sourceCellRow = Math.floor((Number.parseInt(source.style.gridRow, 10) - 1) / 2) * 2 + 1;
        const originalLargeRow = Number.parseInt(getCard("large-neighbor").style.gridRow, 10);
        const sourceInput = source.querySelector("textarea");
        const bounds = source.getBoundingClientRect();
        const pointerId = 170 + columns;
        const start = { pointerId, buttons: 1, clientX: bounds.right - 4, clientY: bounds.bottom - 4 };
        const end = { ...start, clientY: start.clientY + 58 };
        const writesBefore = server.writes;
        try {
          await act(async () => source.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", start)));
          await act(async () => document.dispatchEvent(pointerEvent("pointermove", end)));
          assert.equal(source.dataset.size, "small");
          assert.equal(Number.parseInt(source.style.gridRow, 10), sourceCellRow, "the resized mini keeps its original small-cell row");
          assert.ok(Number.parseInt(getCard("large-neighbor").style.gridRow, 10) > originalLargeRow, "the large neighbor moves down instead");
          assert.equal(server.writes, writesBefore, "priority remains a preview until release");
          assert.equal(source.querySelector("textarea"), sourceInput, "content keeps its mounted identity");
          const previewPositions = cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]);
          await act(async () => document.dispatchEvent(pointerEvent("pointerup", { ...end, buttons: 0 })));
          assert.deepEqual(cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]), previewPositions, "release keeps the preview layout");
          await waitForWorkspaceSave(server, writesBefore);
          const saved = decodeWorkspaceState(server.dashboard).workspaces[0];
          assert.deepEqual(saved.resizePriorities, [{ widgetId: "mini-priority", columns, column: 1, row: sourceCellRow }]);
          await saveAndReload();
          const grid = rootNode.querySelector(".widget-grid");
          installBoardGeometry(grid, { columns });
          await act(async () => { window.dispatchEvent(new window.Event("resize")); frames.flush(); });
          assert.deepEqual(cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]), previewPositions, "reload reproduces the saved priority layout");
          assert.equal(getCard("mini-priority").querySelector("textarea").value, "Keep this content");
          await click("Customize");
          const savedPositions = cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]);
          const savedWrites = server.writes;
          const resizedCard = getCard("mini-priority");
          const resizedBounds = resizedCard.getBoundingClientRect();
          const nextStart = { pointerId: pointerId + 10, buttons: 1, clientX: resizedBounds.right - 4, clientY: resizedBounds.bottom - 4 };
          await act(async () => resizedCard.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", nextStart)));
          await act(async () => document.dispatchEvent(pointerEvent("pointermove", { ...nextStart, clientX: nextStart.clientX + 116, clientY: nextStart.clientY + 116 })));
          assert.equal(resizedCard.dataset.size, "large");
          await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
          assert.deepEqual(cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]), savedPositions, "cancellation restores the previous priority layout");
          assert.equal(server.writes, savedWrites);
          const savedWidgets = decodeWorkspaceState(server.dashboard).workspaces[0].widgets;
          for (const destinationIndex of [1, savedWidgets.length - 1]) {
            const dragGeometry = installBoardGeometry(grid, { columns });
            const dragBounds = resizedCard.getBoundingClientRect();
            const dragStart = { pointerId: pointerId + 20 + destinationIndex, buttons: 1, clientX: dragBounds.left + 20, clientY: dragBounds.top + 18 };
            const dragDestination = destinationPointer(savedWidgets, "mini-priority", destinationIndex, dragGeometry, 20, 18);
            await act(async () => resizedCard.querySelector("[data-widget-reorder-handle]").dispatchEvent(pointerEvent("pointerdown", dragStart)));
            await act(async () => {
              document.dispatchEvent(pointerEvent("pointermove", { ...dragStart, clientX: dragDestination.x, clientY: dragDestination.y }));
              frames.flush();
            });
            const overlay = document.querySelector(".widget-reorder-overlay");
            assert.ok(overlay);
            for (const card of cards()) {
              for (const [property, dimension] of [["offsetWidth", "width"], ["offsetHeight", "height"]]) {
                Object.defineProperty(card, property, { configurable: true, get: () => card.getBoundingClientRect()[dimension] });
              }
            }
            let finishDrop;
            let dropCancelled = false;
            overlay.animate = () => ({
              finished: new Promise((resolve) => { finishDrop = resolve; }),
              cancel() { dropCancelled = true; finishDrop?.(); },
            });
            await act(async () => document.dispatchEvent(pointerEvent("pointerup", { ...dragStart, clientX: dragDestination.x, clientY: dragDestination.y, buttons: 0 })));
            assert.equal(document.querySelector(".widget-reorder-overlay"), overlay, "clearing resize priority does not cancel the reorder drop animation");
            assert.equal(dropCancelled, false);
            assert.equal(typeof finishDrop, "function");
            if (destinationIndex === 1) {
              assert.deepEqual(cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]), savedPositions, "a no-op reorder settles back into its saved priority layout");
              assert.equal(server.writes, savedWrites);
            }
            await act(async () => finishDrop());
            assert.equal(document.querySelector(".widget-reorder-overlay"), null);
            if (destinationIndex === 1) assert.deepEqual(cards().map((card) => [card.dataset.widgetId, card.style.gridColumn, card.style.gridRow]), savedPositions, "finishing a no-op drop does not move the anchored widgets again");
          }
          await waitForWorkspaceSave(server, server.writes);
          assert.equal(decodeWorkspaceState(server.dashboard).workspaces[0].resizePriorities, undefined, "explicit reordering removes the resize anchor");
        } finally {
          frames.restore();
          if (root) await unmount();
        }
      });
    }
  });

  await t.test("resize priority survives note edits and remaps when a workspace is copied", async () => {
    reset();
    const resizePriorities = [{ widgetId: "anchored-note", columns: 4, column: 2, row: 3 }, { widgetId: "anchored-note", columns: 2, column: 1, row: 3 }];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets: [{ instanceId: "anchored-note", type: "notes", size: "small", note: "Original" }], resizePriorities }], "day", ""));
    await render(Workspace, { initialProfile: baseProfile });
    await editNotes("Updated without moving");
    await waitForWorkspaceSave(server, 0);
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces[0].resizePriorities, resizePriorities);
    await clickAria("Workspace options");
    const writesBeforeCopy = server.writes;
    await clickIn(rootNode.querySelector(".workspace-menu"), "Duplicate");
    await waitForWorkspaceSave(server, writesBeforeCopy);
    let saved = decodeWorkspaceState(server.dashboard).workspaces;
    const copiedId = saved[1].widgets[0].instanceId;
    assert.notEqual(copiedId, "anchored-note");
    assert.deepEqual(saved[1].resizePriorities, resizePriorities.map((priority) => ({ ...priority, widgetId: copiedId })));
    assert.equal(saved[1].widgets[0].note, "Updated without moving");
    await clickAria("Quick notes options");
    const writesBeforeRemove = server.writes;
    await clickIn(rootNode.querySelector(".widget-menu"), "Remove");
    await waitForWorkspaceSave(server, writesBeforeRemove);
    saved = decodeWorkspaceState(server.dashboard).workspaces;
    assert.equal(saved[1].resizePriorities, undefined, "removing the priority widget removes its anchor");
    assert.deepEqual(saved[0].resizePriorities, resizePriorities, "the original workspace keeps its own anchors");
  });

  await t.test("corner resize no-op and interruptions never save", async (t) => {
    reset();
    const workspaces = [
      { id: "day", name: "Day", widgets: [{ instanceId: "notes-day", type: "notes", size: "medium", note: "Day note" }] },
      { id: "other", name: "Other", widgets: [{ instanceId: "notes-other", type: "notes", size: "medium", note: "Other note" }] },
    ];
    const server = installWorkspaceServer(encodeWorkspaceState(workspaces, "day", ""));
    await render(Workspace, { initialProfile: baseProfile });
    await click("Customize");
    const frames = installFrameQueue();
    t.after(() => frames.restore());
    let geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
    const writesBefore = server.writes;
    let nextPointerId = 50;

    const beginPreview = async (widgetId = "notes-day") => {
      geometry.updateCards();
      const card = cards().find((item) => item.dataset.widgetId === widgetId);
      const handle = card.querySelector("[data-widget-resize-handle]");
      const rect = card.getBoundingClientRect();
      const pointerId = nextPointerId++;
      const startX = rect.right - 4;
      const startY = rect.bottom - 4;
      await act(async () => handle.dispatchEvent(pointerEvent("pointerdown", { pointerId, buttons: 1, clientX: startX, clientY: startY })));
      await act(async () => document.dispatchEvent(pointerEvent("pointermove", { pointerId, buttons: 1, clientX: startX, clientY: startY + 116 })));
      assert.equal(cards().find((item) => item.dataset.widgetId === widgetId).dataset.size, "large");
      assert.ok(rootNode.querySelector(".reorderable-widget-grid").classList.contains("is-widget-resizing"));
      return pointerId;
    };
    const assertCancelled = (widgetId = "notes-day") => {
      assert.equal(rootNode.querySelector(".reorderable-widget-grid").classList.contains("is-widget-resizing"), false);
      assert.equal(rootNode.querySelector(".widget-resizing"), null);
      assert.equal(document.querySelector(".widget-reorder-overlay"), null);
      const card = cards().find((item) => item.dataset.widgetId === widgetId);
      if (card) assert.equal(card.dataset.size, "medium");
      assert.equal(server.writes, writesBefore);
    };

    const noOpPointer = nextPointerId++;
    let card = cards().find((item) => item.dataset.widgetId === "notes-day");
    let rect = card.getBoundingClientRect();
    await act(async () => card.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", { pointerId: noOpPointer, buttons: 1, clientX: rect.right - 4, clientY: rect.bottom - 4 })));
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", { pointerId: noOpPointer, buttons: 0, clientX: rect.right - 4, clientY: rect.bottom - 4 })));
    assertCancelled();
    assert.ok(rootNode.querySelector(".widget-menu"), "a no-drag handle release opens the existing size choices");
    const capturedClick = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => rootNode.querySelector(".reorderable-widget-grid").dispatchEvent(capturedClick));
    assert.equal(capturedClick.defaultPrevented, true, "the capture-retargeted native click is suppressed");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 160)));
    assert.ok(rootNode.querySelector(".widget-menu"), "the native click does not dismiss the size choices");

    const animatedPointer = nextPointerId++;
    card.getBoundingClientRect = () => ({ left: 40, top: 100, right: 140, bottom: 200, width: 100, height: 100 });
    await act(async () => card.querySelector("[data-widget-resize-handle]").dispatchEvent(pointerEvent("pointerdown", { pointerId: animatedPointer, buttons: 1, clientX: 136, clientY: 196 })));
    await act(async () => document.dispatchEvent(pointerEvent("pointermove", { pointerId: animatedPointer, buttons: 1, clientX: 142, clientY: 196 })));
    assert.equal(card.dataset.size, "medium", "a tiny outward drag during an interrupted FLIP uses the committed footprint");
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", { pointerId: animatedPointer, buttons: 0, clientX: 142, clientY: 196 })));
    await act(async () => rootNode.querySelector(".reorderable-widget-grid").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    assertCancelled();
    assert.equal(rootNode.querySelector(".widget-menu"), null, "an activated drag does not open size choices");

    let pointerId = await beginPreview();
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    assertCancelled();
    const cancelledHandle = cards()[0].querySelector("[data-widget-resize-handle]");
    await act(async () => cancelledHandle.dispatchEvent(pointerEvent("pointerup", { pointerId, buttons: 0 })));
    const cancelledClick = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => cancelledHandle.dispatchEvent(cancelledClick));
    assert.equal(cancelledClick.defaultPrevented, true);
    assert.equal(rootNode.querySelector(".widget-menu"), null, "Escape prevents the cancelled gesture from opening size choices on release");

    pointerId = await beginPreview();
    await act(async () => rootNode.querySelector(".reorderable-widget-grid").dispatchEvent(pointerEvent("lostpointercapture", { pointerId, buttons: 1 })));
    assertCancelled();
    await act(async () => cancelledHandle.dispatchEvent(pointerEvent("pointerup", { pointerId, buttons: 0 })));
    await act(async () => cancelledHandle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    assert.equal(rootNode.querySelector(".widget-menu"), null, "capture loss suppresses the cancelled release click");

    pointerId = await beginPreview();
    await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", { pointerId, buttons: 0, clientX: 0, clientY: 0 })));
    const optionsButton = rootNode.querySelector('[aria-label="Quick notes options"]');
    await act(async () => optionsButton.dispatchEvent(pointerEvent("pointerdown", { pointerId: pointerId + 100, buttons: 1 })));
    await act(async () => optionsButton.dispatchEvent(pointerEvent("pointerup", { pointerId: pointerId + 100, buttons: 0 })));
    const unrelatedClick = new window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    await act(async () => optionsButton.dispatchEvent(unrelatedClick));
    assert.equal(unrelatedClick.defaultPrevented, false, "a new pointer-down clears suppression for unrelated actions");
    assert.ok(rootNode.querySelector(".widget-menu"));

    pointerId = await beginPreview();
    await act(async () => document.dispatchEvent(pointerEvent("pointercancel", { pointerId, buttons: 0 })));
    assertCancelled();

    await beginPreview();
    await act(async () => window.dispatchEvent(new window.Event("blur")));
    assertCancelled();

    await beginPreview();
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
      frames.flush();
    });
    assertCancelled();

    await beginPreview();
    await click("Other");
    assertCancelled("notes-other");
    await click("Day");
    geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));

    await beginPreview();
    await click("Widget customization");
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 0, "opening a dialog removes resize handles and cancels the preview");
    assertCancelled();
    await clickAria("Close appearance studio");

    await act(async () => new Promise((resolve) => setTimeout(resolve, 760)));
    assert.equal(server.writes, writesBefore);
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces.map((workspace) => workspace.widgets.map(({ instanceId, size, note }) => ({ instanceId, size, note }))), [
      [{ instanceId: "notes-day", size: "medium", note: "Day note" }],
      [{ instanceId: "notes-other", size: "medium", note: "Other note" }],
    ]);
  });

  await t.test("resize handles follow Customize eligibility and support keyboard size choices", async () => {
    reset();
    const widgets = [{ instanceId: "notes-keyboard", type: "notes", size: "small", note: "Keyboard keeps this note" }];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
    await render(Workspace, { initialProfile: baseProfile });
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 0, "resize handles are absent outside Customize");
    await click("Customize");
    installBoardGeometry(rootNode.querySelector(".widget-grid"));
    let handle = rootNode.querySelector('[data-widget-id="notes-keyboard"] [data-widget-resize-handle]');
    assert.ok(handle);
    assert.equal(handle.getAttribute("aria-label"), "Resize Quick notes");
    const writesBefore = server.writes;

    for (const [key, expectedSize] of [
      ["ArrowRight", "medium"],
      ["ArrowDown", "large"],
      ["ArrowLeft", "medium-vertical"],
      ["ArrowUp", "small"],
      ["ArrowRight", "medium"],
    ]) {
      handle = rootNode.querySelector('[data-widget-id="notes-keyboard"] [data-widget-resize-handle]');
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => handle.dispatchEvent(event));
      assert.equal(event.defaultPrevented, true);
      assert.equal(cards()[0].dataset.size, expectedSize, `${key} selects ${expectedSize}`);
      const description = document.getElementById(handle.getAttribute("aria-describedby"));
      assert.equal(description.getAttribute("role"), "status");
      assert.equal(description.textContent.trim(), `Quick notes size: ${{ small: "Small", medium: "Medium horizontal", large: "Large", "medium-vertical": "Medium vertical" }[expectedSize]}`);
    }

    handle = rootNode.querySelector('[data-widget-id="notes-keyboard"] [data-widget-resize-handle]');
    await act(async () => {
      handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      handle.click();
    });
    assert.equal(cards()[0].dataset.size, "medium", "Enter activation does not change the size");
    assert.equal(rootNode.querySelectorAll(".widget-menu .size-options button").length, 5, "click opens the existing size menu");
    assert.equal(rootNode.querySelector('.widget-menu [aria-label="Medium horizontal widget"]').getAttribute("aria-pressed"), "true");

    await click("Widget customization");
    assert.ok(rootNode.querySelector('[role="dialog"]'));
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 0, "resize handles are absent while a dialog is open");
    await clickAria("Close appearance studio");
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 1, "closing the dialog restores handles while Customize remains active");
    await click("Done customizing");
    assert.equal(rootNode.querySelectorAll("[data-widget-resize-handle]").length, 0);

    await waitForWorkspaceSave(server, writesBefore);
    await saveAndReload();
    assert.equal(cards()[0].dataset.size, "medium");
    assert.equal(cards()[0].dataset.widgetId, "notes-keyboard");
    assert.equal(rootNode.querySelector('textarea[aria-label="Quick notes"]').value, "Keyboard keeps this note");
  });

  await t.test("widget headers reorder in Customize while body controls and guarded headers do not", async () => {
    reset();
    const widgets = [
      { instanceId: "notes-a", type: "notes", size: "medium", note: "Header drag keeps this note" },
      { instanceId: "timer-a", type: "pomodoro", size: "small" },
      { instanceId: "quote-a", type: "quote", size: "mini" },
    ];
    const server = installWorkspaceServer(encodeWorkspaceState([{ id: "day", name: "Day", widgets }], "day", ""));
    await render(Workspace, { initialProfile: baseProfile });

    const frames = installFrameQueue();
    try {
      const geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
      let currentWidgets = [...widgets];
      let currentIds = widgets.map((widget) => widget.instanceId);
      const startFor = (widgetId) => {
        const source = cards().find((card) => card.dataset.widgetId === widgetId);
        assert.ok(source, `Missing source card ${widgetId}`);
        const rect = source.getBoundingClientRect();
        return { source, startX: rect.left + 20, startY: rect.top + 18 };
      };
      const assertNoDrag = async (target, startX, startY, message) => {
        assert.ok(target, `Missing pointer target for ${message}`);
        const writesBefore = server.writes;
        await act(async () => target.dispatchEvent(pointerEvent("pointerdown", { clientX: startX, clientY: startY })));
        await act(async () => {
          document.dispatchEvent(pointerEvent("pointermove", { clientX: startX + 28, clientY: startY + 12, buttons: 1 }));
          frames.flush();
        });
        assert.equal(document.querySelector(".widget-reorder-overlay"), null, message);
        await act(async () => document.dispatchEvent(pointerEvent("pointerup", { clientX: startX + 28, clientY: startY + 12, buttons: 0 })));
        assert.deepEqual(cards().map((card) => card.dataset.widgetId), currentIds);
        assert.equal(server.writes, writesBefore);
      };

      let disabledHeader = startFor("notes-a");
      await assertNoDrag(disabledHeader.source.querySelector("h2"), disabledHeader.startX, disabledHeader.startY, "a header cannot start dragging outside Customize");
      assert.equal(rootNode.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed"), "false");

      await click("Customize");
      for (const { widgetId, selector, destinationIndex } of [
        { widgetId: "notes-a", selector: "h2", destinationIndex: 2 },
        { widgetId: "notes-a", selector: ".widget-icon", destinationIndex: 0 },
        { widgetId: "timer-a", selector: ".widget-header", destinationIndex: 2 },
      ]) {
        const { source, startX, startY } = startFor(widgetId);
        const target = source.querySelector(selector);
        assert.ok(target, `Missing header region ${selector}`);
        const { order, x, y } = destinationPointer(currentWidgets, widgetId, destinationIndex, geometry, 20, 18);
        const writesBefore = server.writes;
        await act(async () => target.dispatchEvent(pointerEvent("pointerdown", { clientX: startX, clientY: startY })));
        await act(async () => {
          document.dispatchEvent(pointerEvent("pointermove", { clientX: x, clientY: y }));
          frames.flush();
        });
        assert.ok(document.querySelector(".widget-reorder-overlay"), `${selector} starts a header drag`);
        assert.ok(source.classList.contains("widget-reorder-placeholder"));
        await act(async () => document.dispatchEvent(pointerEvent("pointerup", { clientX: x, clientY: y })));
        assert.deepEqual(cards().map((card) => card.dataset.widgetId), order);
        await waitForWorkspaceSave(server, writesBefore);
        const persistedWidgets = decodeWorkspaceState(server.dashboard).workspaces[0].widgets;
        assert.deepEqual(persistedWidgets.map((widget) => widget.instanceId), order);
        assert.deepEqual([...new Set(persistedWidgets.map((widget) => widget.instanceId))].sort(), [...currentIds].sort());
        assert.equal(persistedWidgets.find((widget) => widget.instanceId === "notes-a").note, "Header drag keeps this note");
        currentIds = order;
        currentWidgets = order.map((id) => currentWidgets.find((widget) => widget.instanceId === id));
        geometry.updateCards();
      }

      let notesCard = cards().find((card) => card.dataset.widgetId === "notes-a");
      let notesStart = startFor("notes-a");
      await assertNoDrag(notesCard.querySelector(".widget-body textarea"), notesStart.startX, notesStart.startY, "editable widget body content cannot start dragging");
      await assertNoDrag(notesCard.querySelector(".widget-header .menu-wrap > button"), notesStart.startX, notesStart.startY, "the widget menu button cannot start dragging");

      await clickAria("Quick notes options", notesCard);
      await assertNoDrag(notesCard.querySelector(".widget-menu button"), notesStart.startX, notesStart.startY, "a widget menu control cannot start dragging");
      await clickAria("Quick notes options", notesCard);

      await click("Widget customization");
      assert.ok(rootNode.querySelector('[role="dialog"]'), "the customization dialog is open");
      notesCard = cards().find((card) => card.dataset.widgetId === "notes-a");
      notesStart = startFor("notes-a");
      await assertNoDrag(notesCard.querySelector(".widget-header"), notesStart.startX, notesStart.startY, "an open customization dialog disables header dragging");
      assert.equal(server.writes, 3, "only the three committed header reorders save");
      await saveAndReload();
      assert.deepEqual(cards().map((card) => card.dataset.widgetId), currentIds);
      assert.equal(cards().find((card) => card.dataset.widgetId === "notes-a").querySelector("textarea").value, "Header drag keeps this note");
      assert.equal(server.writes, 3, "reloading does not create another workspace write");
    } finally { frames.restore(); }
  });

  await t.test("widget reorder cancels cleanly before activation, on Escape, pointercancel, outside release, blur, and workspace change", async () => {
    reset();
    const widgets = [
      { instanceId: "notes-a", type: "notes", size: "medium", note: "Keep this note" },
      { instanceId: "timer-a", type: "pomodoro", size: "small" },
      { instanceId: "calendar-a", type: "mini-calendar", size: "mini" },
      { instanceId: "quote-a", type: "quote", size: "mini" },
    ];
    const otherWidgets = widgets.map((widget) => ({ ...widget, instanceId: `other-${widget.instanceId}` }));
    const dashboard = encodeWorkspaceState([
      { id: "day", name: "Day", widgets },
      { id: "other", name: "Other", widgets: otherWidgets },
    ], "day", "");
    const server = installWorkspaceServer(dashboard);
    await render(Workspace, { initialProfile: baseProfile });
    await click("Customize");

    const frames = installFrameQueue();
    try {
      const geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
      const origin = widgets.map((widget) => widget.instanceId);
      const startFor = (widgetId, destinationIndex) => {
        const source = cards().find((card) => card.dataset.widgetId === widgetId);
        assert.ok(source, `Missing source card ${widgetId}`);
        const rect = source.getBoundingClientRect();
        const startX = rect.left + 20, startY = rect.top + 18;
        const target = destinationPointer(widgets, widgetId, destinationIndex, geometry, 20, 18);
        return { source, startX, startY, ...target };
      };
      const pointerDown = async ({ source, startX, startY }) => act(async () => source.querySelector("[data-widget-reorder-handle]").dispatchEvent(pointerEvent("pointerdown", { clientX: startX, clientY: startY })));
      const preview = async (widgetId, destinationIndex) => {
        const drag = startFor(widgetId, destinationIndex);
        await pointerDown(drag);
        await act(async () => {
          document.dispatchEvent(pointerEvent("pointermove", { clientX: drag.x, clientY: drag.y }));
          frames.flush();
        });
        assert.notDeepEqual(cards().map((card) => card.dataset.widgetId), origin, "the active gesture displays a changed preview order");
        assert.ok(document.querySelector(".widget-reorder-overlay"));
        return drag;
      };
      const assertRestored = () => {
        assert.equal(document.querySelector(".widget-reorder-overlay"), null);
        assert.deepEqual(cards().map((card) => card.dataset.widgetId), origin);
        assert.equal(server.writes, 0);
      };

      const clickOnly = startFor("notes-a", 3);
      await pointerDown(clickOnly);
      await act(async () => document.dispatchEvent(pointerEvent("pointermove", { clientX: clickOnly.startX + 3, clientY: clickOnly.startY + 1 })));
      assert.equal(document.querySelector(".widget-reorder-overlay"), null, "movement below the drag threshold does not lift the card");
      await act(async () => document.dispatchEvent(pointerEvent("pointerup", { clientX: clickOnly.startX + 3, clientY: clickOnly.startY + 1 })));
      assert.deepEqual(cards().map((card) => card.dataset.widgetId), origin);
      assert.equal(server.writes, 0);

      await preview("notes-a", 2);
      await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      assertRestored();

      await preview("timer-a", 0);
      await act(async () => document.dispatchEvent(pointerEvent("pointercancel", { clientX: 180, clientY: 210 })));
      assertRestored();

      await preview("calendar-a", 0);
      await act(async () => {
        document.dispatchEvent(pointerEvent("pointermove", { clientX: -200, clientY: 200 }));
        frames.flush();
        document.dispatchEvent(pointerEvent("pointerup", { clientX: -200, clientY: 200 }));
      });
      assertRestored();

      await preview("quote-a", 0);
      await act(async () => window.dispatchEvent(new window.Event("blur")));
      assertRestored();

      await preview("notes-a", 2);
      await click("Other");
      assert.equal(document.querySelector(".widget-reorder-overlay"), null, "switching workspace invalidates the active drag context");
      await click("Day");
      assert.deepEqual(cards().map((card) => card.dataset.widgetId), origin);
      assert.equal(server.writes, 0);
    } finally { frames.restore(); }
  });

  await t.test("a mouse header shake hands off directly to reorder and invalidates stale gestures", async (t) => {
    reset();
    const widgets = [
      { instanceId: "notes-a", type: "notes", size: "medium", note: "Shake keeps this note" },
      { instanceId: "timer-a", type: "pomodoro", size: "small" },
      { instanceId: "calendar-a", type: "mini-calendar", size: "mini" },
      { instanceId: "quote-a", type: "quote", size: "mini" },
    ];
    const otherWidgets = widgets.map((widget) => ({ ...widget, instanceId: `other-${widget.instanceId}` }));
    const dashboard = encodeWorkspaceState([
      { id: "day", name: "Day", widgets },
      { id: "other", name: "Other", widgets: otherWidgets },
    ], "day", "");
    const server = installWorkspaceServer(dashboard);
    await render(Workspace, { initialProfile: baseProfile });

    const frames = installFrameQueue();
    t.after(() => frames.restore());
    const geometry = installBoardGeometry(rootNode.querySelector(".widget-grid"));
    const pointerId = 23;
    const customizePressed = () => rootNode.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed");
    const orderNow = () => cards().map((card) => card.dataset.widgetId);
    const beginShake = async (widgetId = "notes-a", strokeCount = 3) => {
      geometry.updateCards();
      const source = cards().find((card) => card.dataset.widgetId === widgetId);
      assert.ok(source, `Missing source card ${widgetId}`);
      const header = source.querySelector(".widget-header");
      assert.ok(header);
      const rect = source.getBoundingClientRect();
      const startX = rect.left + 36;
      const startY = rect.top + 22;
      const strokeXs = [startX + 20, startX, startX + 20];
      await act(async () => header.dispatchEvent(pointerEvent("pointerdown", {
        pointerId, pointerType: "mouse", isPrimary: true, button: 0, buttons: 1, clientX: startX, clientY: startY,
      })));
      const drag = { source, header, startX, startY, grabOffsetX: 36, grabOffsetY: 22, strokeXs };
      await continueShake(drag, 0, strokeCount);
      return drag;
    };
    const continueShake = async (drag, from, to = drag.strokeXs.length) => {
      for (const clientX of drag.strokeXs.slice(from, to)) {
        await act(async () => document.dispatchEvent(pointerEvent("pointermove", {
          pointerId, pointerType: "mouse", buttons: 1, clientX, clientY: drag.startY,
        })));
      }
    };
    const assertHandoff = (drag) => {
      assert.equal(customizePressed(), "true", "the shake enables Customize");
      const overlay = document.querySelector(".widget-reorder-overlay");
      assert.ok(overlay, "the same pointer immediately lifts the original widget");
      assert.ok(drag.source.classList.contains("widget-reorder-placeholder"));
      assert.equal(overlay.style.left, `${drag.startX + 20 - drag.grabOffsetX}px`, "the original horizontal grab offset is preserved");
      assert.equal(overlay.style.top, `${drag.startY - drag.grabOffsetY}px`, "the original vertical grab offset is preserved");
      assert.equal(overlay.querySelector("textarea")?.value, "Shake keeps this note", "the inert clone retains the notes content");
      return overlay;
    };
    const previewTo = async (drag, model, destinationIndex) => {
      const target = destinationPointer(model, "notes-a", destinationIndex, geometry, drag.grabOffsetX, drag.grabOffsetY);
      await act(async () => {
        document.dispatchEvent(pointerEvent("pointermove", {
          pointerId, pointerType: "mouse", buttons: 1, clientX: target.x, clientY: target.y,
        }));
        frames.flush();
      });
      return target;
    };

    const startingOrder = widgets.map((widget) => widget.instanceId);
    const writesBeforeDrag = server.writes;
    assert.equal(customizePressed(), "false", "the shake starts outside Customize");
    const drag = await beginShake();
    const overlay = assertHandoff(drag);
    const host = rootNode.querySelector(".reorderable-widget-grid");
    await act(async () => host.dispatchEvent(pointerEvent("lostpointercapture", {
      pointerId: pointerId + 1, pointerType: "mouse", buttons: 0,
    })));
    assert.equal(document.querySelector(".widget-reorder-overlay"), overlay, "capture loss from another pointer is ignored");
    await act(async () => drag.header.dispatchEvent(pointerEvent("lostpointercapture", {
      pointerId, pointerType: "mouse", buttons: 0,
    })));
    assert.equal(document.querySelector(".widget-reorder-overlay"), overlay, "the old header's bubbling capture loss does not cancel the handed-off drag");
    assert.deepEqual(orderNow(), startingOrder);

    const destination = await previewTo(drag, widgets, 2);
    assert.deepEqual(orderNow(), destination.order, "a later move previews a destination without another pointerdown");
    assert.equal(server.writes, writesBeforeDrag, "previewing the handoff does not save the order");
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.map((widget) => widget.instanceId), startingOrder);
    await waitForMilliseconds(760);
    assert.equal(server.writes, writesBeforeDrag, "hovering beyond the autosave delay still does not save");
    await act(async () => {
      document.dispatchEvent(pointerEvent("pointerup", {
        pointerId, pointerType: "mouse", buttons: 0, clientX: destination.x, clientY: destination.y,
      }));
      frames.flush();
    });
    await waitForWorkspaceSave(server, writesBeforeDrag);
    assert.deepEqual(orderNow(), destination.order);
    let persisted = decodeWorkspaceState(server.dashboard).workspaces[0].widgets;
    assert.deepEqual(persisted.map((widget) => widget.instanceId), destination.order);
    assert.equal(persisted.find((widget) => widget.instanceId === "notes-a").note, "Shake keeps this note", "the same notes identity and content survive the reorder");
    assert.equal(server.writes, writesBeforeDrag + 1, "one release commits exactly one workspace write");

    let currentWidgets = destination.order.map((id) => widgets.find((widget) => widget.instanceId === id));
    let currentOrder = [...destination.order];
    const cancelHandoff = async (reason) => {
      await click("Done customizing");
      const cancelledDrag = await beginShake();
      assertHandoff(cancelledDrag);
      const cancelledDestination = await previewTo(cancelledDrag, currentWidgets, 0);
      assert.notDeepEqual(orderNow(), currentOrder, "the cancellation case first previews a different order");
      const writesBeforeCancel = server.writes;
      if (reason === "Escape") {
        await act(async () => window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      } else if (reason === "pointercancel") {
        await act(async () => document.dispatchEvent(pointerEvent("pointercancel", { pointerId, pointerType: "mouse", buttons: 0 })));
      } else if (reason === "blur") {
        await act(async () => window.dispatchEvent(new window.Event("blur")));
      } else {
        const host = rootNode.querySelector(".reorderable-widget-grid");
        await act(async () => host.dispatchEvent(pointerEvent("lostpointercapture", { pointerId, pointerType: "mouse", buttons: 0 })));
      }
      assert.equal(document.querySelector(".widget-reorder-overlay"), null, `${reason} removes the lifted preview`);
      assert.deepEqual(orderNow(), currentOrder, `${reason} restores the original order`);
      assert.equal(customizePressed(), "true", `${reason} leaves Customize enabled`);
      assert.equal(server.writes, writesBeforeCancel, `${reason} does not persist a preview`);
      assert.notDeepEqual(cancelledDestination.order, currentOrder);
    };
    for (const reason of ["Escape", "pointercancel", "blur", "host capture loss"]) await cancelHandoff(reason);

    await click("Done customizing");
    const noDestinationDrag = await beginShake();
    assertHandoff(noDestinationDrag);
    const writesBeforeNoDestination = server.writes;
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
      pointerId, pointerType: "mouse", buttons: 0, clientX: noDestinationDrag.startX + 20, clientY: noDestinationDrag.startY,
    })));
    await waitForMilliseconds(760);
    assert.deepEqual(orderNow(), currentOrder, "releasing without a destination change leaves the order intact");
    assert.equal(customizePressed(), "true");
    assert.equal(server.writes, writesBeforeNoDestination, "releasing without a destination change does not save");

    await click("Done customizing");
    const contextShake = await beginShake("notes-a", 1);
    await click("Other");
    await continueShake(contextShake, 1);
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
      pointerId, pointerType: "mouse", buttons: 0, clientX: contextShake.strokeXs.at(-1), clientY: contextShake.startY,
    })));
    assert.equal(customizePressed(), "false", "changing workspace invalidates the pending shake");
    assert.deepEqual(orderNow(), otherWidgets.map((widget) => widget.instanceId));
    assert.equal(document.querySelector(".widget-reorder-overlay"), null);

    await click("Day");
    geometry.updateCards();
    const dialogShake = await beginShake("notes-a", 1);
    await click("Widget customization");
    await continueShake(dialogShake, 1);
    await act(async () => document.dispatchEvent(pointerEvent("pointerup", {
      pointerId, pointerType: "mouse", buttons: 0, clientX: dialogShake.strokeXs.at(-1), clientY: dialogShake.startY,
    })));
    assert.ok(rootNode.querySelector('[role="dialog"]'), "the appearance dialog remains open");
    assert.equal(customizePressed(), "false", "opening a dialog invalidates the pending shake");
    assert.deepEqual(orderNow(), currentOrder);
    assert.equal(document.querySelector(".widget-reorder-overlay"), null);
    assert.equal(server.writes, writesBeforeDrag + 1, "cancelled and invalidated handoffs do not add writes");
    await clickAria("Close appearance studio");
    assert.deepEqual(decodeWorkspaceState(server.dashboard).workspaces[0].widgets.map((widget) => widget.instanceId), currentOrder);
    assert.equal(persisted.find((widget) => widget.instanceId === "notes-a").note, "Shake keeps this note");
  });

  await t.test("note copies edit, clear and delete independently; search opens the exact note", async () => {
    reset(); const server = installWorkspaceServer(); await render(Workspace, { initialProfile: baseProfile });
    const originalId = cards()[0].dataset.widgetId;
    await clickAria("Quick notes options"); await clickIn(rootNode.querySelector(".widget-menu"), "Duplicate");
    const duplicateId = cards()[1].dataset.widgetId; assert.notEqual(duplicateId, originalId);
    await editNotes("Unique searchable original"); assert.equal(cards()[1].querySelector("textarea").value, "Saved notes");
    await clickAria("Clear notes", cards()[1]); assert.equal(cards()[1].querySelector("textarea").value, "");
    await saveAndReload(); assert.equal(cards()[0].querySelector("textarea").value, "Unique searchable original");
    assert.equal(cards()[1].querySelector("textarea").value, "");
    await click("Search");
    const search = rootNode.querySelector('[aria-label="Search everything"]');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, "Unique searchable original"); search.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const result = rootNode.querySelector(".search-results button"); assert.ok(result); await act(async () => result.click());
    assert.equal(document.activeElement.id, `note-${originalId}`);
    await clickAria("Quick notes options", cards()[0]); window.confirm = () => false; await click("Remove"); assert.equal(cards().length, 2);
    window.confirm = () => true; await click("Remove"); await saveAndReload();
    assert.equal(cards().length, 1); assert.equal(cards()[0].dataset.widgetId, duplicateId);
    assert.ok(!JSON.stringify(server.dashboard).includes("Unique searchable original"));
  });

  await t.test("legacy note recovery and failed saves preserve content until retry", async () => {
    reset(); const server = installWorkspaceServer({ ...savedDashboard, w: [["day", "Day", []]] });
    await render(Workspace, { initialProfile: baseProfile }); assert.match(rootNode.textContent, /earlier shared note/);
    await click("Add saved note here"); assert.equal(rootNode.querySelector("textarea").value, "Saved notes");
    server.offline = true; await waitForWorkspaceError("Offline"); assert.equal(unloadBlocked(), true);
    await editNotes("Recovered and edited"); server.offline = false; await click("Retry save"); await saveAndReload();
    assert.equal(rootNode.querySelector("textarea").value, "Recovered and edited"); assert.equal(server.dashboard.n, undefined);
  });

  await t.test("workspace and widget limits prevent unsavable operations", async () => {
    reset(); installWorkspaceServer({ ...savedDashboard, w: Array.from({ length: 20 }, (_, i) => [`w${i}`, i === 0 ? "x".repeat(80) : `Space ${i}`, Array.from({ length: 100 }, () => [17, 0])]), a: "w0", n: "" });
    await render(Workspace, { initialProfile: baseProfile });
    assert.equal(rootNode.querySelector('[aria-label="Add workspace"]').disabled, true);
    await clickAria("Workspace options"); assert.equal([...rootNode.querySelectorAll(".workspace-menu button")].find((b) => b.textContent.trim() === "Duplicate").disabled, true);
    await clickAria("Workspace options"); await clickAria("Empty spacer options", cards()[0]);
    assert.equal([...rootNode.querySelectorAll(".widget-menu button")].find((b) => b.textContent.trim() === "Duplicate").disabled, true);
    await clickAria("Empty spacer options", cards()[0]); await clickIn(rootNode.querySelector(".workspace-actions"), "Add widget");
    assert.ok([...rootNode.querySelectorAll(".widget-picker-grid button")].every((b) => b.disabled));
    await click("Done"); assert.equal(unloadBlocked(), false);
  });
});

test("private files UI retains upload retries, restores file preferences, searches real metadata and downloads originals", async () => {
  reset(); const server = installWorkspaceServer(); let stored = [], fail = true; const ids = [];
  filesFetcher = async (url, init) => {
    assert.equal(new Headers(init.headers).get('x-profile-id'), baseProfile.id);
    if (init.method === 'POST') {
      const id = new URL(url, 'https://edu.example').searchParams.get('id'); ids.push(id);
      if (fail) return Response.json({ error: 'Storage offline' }, { status: 503 });
      const metadata = JSON.parse(decodeURIComponent(new Headers(init.headers).get('x-file-metadata')));
      const file = { id, name: metadata.name, course_id: metadata.courseId || null, assignment_id: metadata.assignmentId || null, kind: metadata.kind, state: 'ready', mime_type: 'text/plain', size_bytes: 12, created_at: baseProfile.updated_at, updated_at: baseProfile.updated_at, content_sha256: null };
      stored = [file]; return Response.json({ file }, { status: 201 });
    }
    if (url.includes('?id=')) return new Response('Actual bytes', { headers: { 'content-type': 'text/plain' } });
    return Response.json({ files: stored });
  };
  try {
    await render(Workspace, { initialProfile: baseProfile }); await click('Files'); await click('Upload file');
    const chooser = field('Choose file');
    await act(async () => { Object.defineProperty(chooser, 'files', { value: [new File(['Actual bytes'], 'Unique private reading.txt')] }); chooser.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.equal(unloadBlocked(), true); await click('Upload / retry file');
    assert.match(rootNode.textContent, /Storage offline/); assert.equal(field('File name').value, 'Unique private reading.txt');
    assert.equal(field('File name').matches(':disabled'), true); assert.match(rootNode.textContent, /edit its details after the upload finishes/);
    fail = false; await click('Upload / retry file'); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(unloadBlocked(), false);
    assert.match(rootNode.textContent, /Unique private reading/);
    await edit('File class filter', 'personal'); await edit('File view', 'grid'); await saveAndReload();
    await click('Files'); assert.equal(field('File class filter').value, 'personal'); assert.equal(field('File view').value, 'grid');
    assert.deepEqual(server.dashboard.d.filePreferences, {
      filter: 'personal', view: 'grid', sortBy: 'modified', sortDirection: 'desc', appearanceVersion: 2,
    });
    await click('Search'); const search = rootNode.querySelector('[aria-label="Search everything"]');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Unique private reading'); search.dispatchEvent(new window.Event('input', { bubbles: true })); });
    const result = rootNode.querySelector('.search-results button'); assert.ok(result); await act(async () => result.click());
    assert.match(rootNode.textContent, /Actual bytes/); assert.ok(rootNode.querySelector('a[download][href*="account=profile-a"]'));
  } finally { filesFetcher = undefined; if (root) await unmount(); }
});

test("legacy Files appearance preferences migrate on edit, preserve an explicit List choice, and validate the version marker", async () => {
  reset();
  const legacyPreferences = { filter: "all", view: "list", sortBy: "name" };
  const initial = { ...savedDashboard, d: { ...savedDashboard.d, filePreferences: legacyPreferences } };
  const server = installWorkspaceServer(initial, [sampleCourse]);
  const migrationFile = {
    id: "55555555-5555-4555-8555-555555555555", name: "Migration sample.pdf", mime_type: "application/pdf", size_bytes: 12,
    course_id: null, assignment_id: null, kind: "resource", state: "ready", created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z", content_sha256: null, folder_id: null, content_backend: "object",
    metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null,
  };
  filesFetcher = async (url) => {
    if (url.startsWith("/api/files?view=active")) return Response.json({ files: [migrationFile], activities: { files: [] } });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [] } });
    if (url.startsWith("/api/file-folders")) return Response.json({ folders: [], activities: { folders: [] } });
    throw new Error(`Unexpected preference migration request: ${url}`);
  };

  try {
    await render(Workspace, { initialProfile: baseProfile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(".files-browser"), "Files browser route for markerless preferences");
    window.history.replaceState({}, "", "/files?layout=list");
    await waitForMilliseconds(0);
    await waitUntil(() => rootNode.querySelector(".files-layout-toggle"), "Files browser for markerless saved Files preferences");
    assert.ok(rootNode.querySelector(".files-items.is-grid"), `markerless list preference should render grid; current Files UI: ${rootNode.textContent.slice(0, 500)}`);
    assert.equal(rootNode.querySelector('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true");
    assert.deepEqual(server.dashboard.d.filePreferences, legacyPreferences, "displaying the migration does not rewrite the legacy workspace payload");
    assert.equal(server.writes, 0, "the default upgrade does not autosave before a preference edit");

    await clickAria("Filters");
    await edit("File type", "pdf");
    await waitForWorkspaceSave(server);
    assert.deepEqual(server.dashboard.d.filePreferences, {
      filter: "all", view: "grid", sortBy: "modified", sortDirection: "desc", fileType: "pdf", appearanceVersion: 2,
    }, "the first preference edit keeps the user's filter and persists the new defaults");
    assert.equal(new URL(window.location.href).searchParams.get("layout"), "grid", "the first edit replaces the legacy list URL with grid");

    const writesBeforeList = server.writes;
    await clickAria("List view");
    await waitForWorkspaceSave(server, writesBeforeList);
    assert.equal(server.dashboard.d.filePreferences.view, "list");
    assert.equal(server.dashboard.d.filePreferences.appearanceVersion, 2);

    const writesBeforeReload = server.writes;
    await saveAndReload({ filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(".files-items.is-list"), "saved explicit List layout after reload");
    assert.equal(rootNode.querySelector('.files-layout-toggle button[aria-label="List view"]').getAttribute("aria-pressed"), "true");
    assert.equal(server.dashboard.d.filePreferences.view, "list");
    assert.equal(server.dashboard.d.filePreferences.appearanceVersion, 2);
    assert.equal(server.writes, writesBeforeReload, "loading the explicit List preference does not create another workspace revision");

    const versionedPreferences = { filter: "all", view: "grid", sortBy: "modified", sortDirection: "desc", appearanceVersion: 2 };
    const decodePreferences = (filePreferences) => decodeWorkspaceState({
      ...savedDashboard,
      d: { ...savedDashboard.d, filePreferences },
    }).data.filePreferences;
    assert.deepEqual(decodePreferences(versionedPreferences), versionedPreferences, "the workspace codec round-trips appearance version 2");
    assert.deepEqual(decodePreferences(legacyPreferences), legacyPreferences, "markerless legacy preferences remain valid input");
    for (const appearanceVersion of [0, 1, 3, "2", null]) {
      assert.throws(() => decodePreferences({ ...versionedPreferences, appearanceVersion }), /Invalid file preferences/, `the workspace codec rejects appearance version ${String(appearanceVersion)}`);
    }
  } finally {
    filesFetcher = undefined;
    if (root) await unmount();
  }
});

test("real Files preferences save with academic data while temporary search is discarded on reload", async () => {
  reset();
  const profile = { ...baseProfile, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", current_term: "Fall 2026" };
  const assignment = { id: "history-essay", title: "Keep this assignment", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Academic data stays saved", weight: "15%" };
  const manualEvents = [{ id: "history-event", title: "Keep this event", courseId: sampleCourse.id, dateKey: "2026-10-16", time: "10:00", type: "Study block" }];
  const courseDetails = { [sampleCourse.id]: { officeHours: "Tuesday afternoons", meetings: [], syllabusText: "History syllabus remains intact", syllabusName: "History guide" } };
  const initial = { ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment], manualEvents, courseDetails, filePreferences: { filter: "all", view: "list" } } };
  const server = installWorkspaceServer(initial, [sampleCourse], profile);
  const folderId = "22222222-2222-4222-8222-222222222222";
  const stamp = "2026-10-01T00:00:00.000Z";
  const folder = { id: folderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  const file = { id: "33333333-3333-4333-8333-333333333333", name: "Course guide.pdf", mime_type: "application/pdf", size_bytes: 128, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: folderId, content_backend: "object", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
  filesFetcher = async (url) => {
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: [file], activities: { files: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: [folder], activities: { folders: [] } });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [] } });
    if (url.startsWith("/api/file-folders?view=")) return Response.json({ folders: [], activities: { folders: [] } });
    throw new Error(`Unexpected preferences fixture request: ${url}`);
  };

  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder for preferences");
    await clickAria("Filters");
    await edit("Course filter", sampleCourse.id);
    await edit("File type", "pdf");
    await edit("Sort by", "modified");
    await clickAria("Sort descending");
    assert.equal(rootNode.querySelector('[aria-label="Sort ascending"]').textContent.trim(), "Ascending");
    await clickAria("Sort ascending");
    await edit("Include archived", true);
    await clickAria("Grid view");

    const expected = { filter: sampleCourse.id, view: "grid", sortBy: "modified", sortDirection: "desc", fileType: "pdf", includeArchived: true, appearanceVersion: 2 };
    const writesBeforePreferences = server.writes;
    await waitForWorkspaceSave(server, writesBeforePreferences);
    assert.deepEqual(server.dashboard.d.filePreferences, expected);
    assert.deepEqual(server.dashboard.d.assignments, [assignment]);
    assert.deepEqual(server.dashboard.d.manualEvents, manualEvents);
    assert.deepEqual(server.dashboard.d.courseDetails, courseDetails);
    assert.deepEqual(server.courses, [sampleCourse]);
    const writesAfterPreferences = server.writes;

    await edit("Search files", "temporary-query-only");
    await waitForMilliseconds(450);
    assert.equal(server.writes, writesAfterPreferences, "typing into the temporary query does not save a workspace revision");
    assert.deepEqual(server.dashboard.d.filePreferences, expected);
    assert.equal(JSON.stringify(server.dashboard).includes("temporary-query-only"), false, "search text is absent from the saved workspace payload");

    await saveAndReload({ initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector('[aria-label="Search files"]'), "Files tools after workspace reload");
    await clickAria("Filters");
    assert.equal(rootNode.querySelector('[aria-label="Search files"]').value, "", "a reload clears the temporary query");
    assert.equal(field("Course filter").value, sampleCourse.id);
    assert.equal(field("File type").value, "pdf");
    assert.equal(field("Sort by").value, "modified");
    assert.equal(rootNode.querySelector('[aria-label="Sort descending"]').textContent.trim(), "Descending");
    assert.equal(field("Include archived").checked, true);
    assert.equal(rootNode.querySelector('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true");
    assert.deepEqual(server.dashboard.d.filePreferences, expected);
    assert.equal(server.writes, writesAfterPreferences, "reloading the saved browser state does not write another workspace revision");
  } finally {
    filesFetcher = undefined;
    if (root) await unmount();
  }
});

test("real Files activity records successful upload previews and native reads/saves but ignores failed attempts", async () => {
  reset();
  const previousFrame = window.requestAnimationFrame, previousCancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
  window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);
  const assignment = { id: "history-essay", title: "Archive essay", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Keep academic links", weight: "15%" };
  const profile = { ...baseProfile, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", current_term: "Fall 2026" };
  const server = installWorkspaceServer({ ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment] } }, [sampleCourse], profile);
  const stamp = "2026-10-01T00:00:00.000Z";
  const folderId = "22222222-2222-4222-8222-222222222222";
  const nativeId = "33333333-3333-4333-8333-333333333333";
  const failedPreviewId = "44444444-4444-4444-8444-444444444444";
  const folder = { id: folderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  let nativeBody = "Original native text";
  let nativeOffline = true;
  let uploadRow = null;
  let activityClock = 0;
  const native = { id: nativeId, name: "Native notes.txt", mime_type: "text/plain", size_bytes: new TextEncoder().encode(nativeBody).byteLength, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: folderId, content_backend: "native-text", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
  const failedPreview = { id: failedPreviewId, name: "Unavailable reading.txt", mime_type: "text/plain", size_bytes: 40, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: folderId, content_backend: "object", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
  const filesById = new Map([[native.id, native], [failedPreview.id, failedPreview]]);
  const uploadIds = [], openActions = [], nativeWrites = [], renameRequests = [], byteReads = [];
  const uploadXhr = installUploadXhr();
  const fileRows = () => [...filesById.values()].map((file) => ({ ...file }));
  const activityRows = () => ({ files: [...filesById.keys()].filter((id) => lastOpened.has(id)).map((file_id) => ({ file_id, starred_at: null, last_opened_at: lastOpened.get(file_id) })), folders: [] });
  const lastOpened = new Map();
  const nativeResult = () => ({ file: { ...native }, document: { file_id: native.id, body: nativeBody, content_revision: native.content_revision } });
  filesFetcher = async (url, init = {}) => {
    assert.equal(new Headers(init.headers).get("x-profile-id"), profile.id);
    if (url.startsWith("/api/file-documents")) {
      if (init.method === "PUT") {
        const body = JSON.parse(init.body); nativeWrites.push(body);
        assert.equal(body.baseContentRevision, native.content_revision);
        if (nativeOffline) { nativeOffline = false; return Response.json({ error: "Native document save offline" }, { status: 503 }); }
        if (body.name !== undefined && body.name !== native.name) { assert.equal(body.baseMetadataRevision, native.metadata_revision); native.name = body.name; native.metadata_revision++; }
        if (body.body !== nativeBody) native.content_revision++;
        nativeBody = body.body; native.size_bytes = new TextEncoder().encode(nativeBody).byteLength; native.updated_at = "2026-10-08T00:00:02.000Z";
        return Response.json({ ...nativeResult(), requestId: body.requestId, acknowledgedContentRevision: native.content_revision });
      }
      return Response.json(nativeResult());
    }
    if (url === "/api/files/actions" && init.method === "POST") {
      const body = JSON.parse(init.body); openActions.push(body);
      assert.equal(body.action, "open"); assert.equal(body.items.length, 1);
      const item = body.items[0], file = filesById.get(item.id);
      assert.equal(item.type, "file"); assert.ok(file, "an open ACK must refer to a stored file");
      assert.equal(item.revision, file.metadata_revision);
      activityClock++;
      const openedAt = `2026-10-08T00:00:${String(activityClock).padStart(2, "0")}.000Z`;
      lastOpened.set(file.id, openedAt);
      return Response.json({ activities: { files: [{ file_id: file.id, starred_at: null, last_opened_at: openedAt }], folders: [] } });
    }
    if (url.startsWith("/api/files?id=") && init.method === "PUT") {
      const body = JSON.parse(init.body); renameRequests.push(body);
      assert.equal(body.action, "rename"); assert.equal(body.baseMetadataRevision, uploadRow.metadata_revision);
      uploadRow.name = body.name; uploadRow.metadata_revision++; uploadRow.updated_at = "2026-10-08T00:00:01.000Z";
      return Response.json({ file: { ...uploadRow } });
    }
    if (url.startsWith("/api/files?id=")) {
      const id = new URL(url, "https://edu.example").searchParams.get("id"); byteReads.push(id);
      if (id === failedPreview.id) return Response.json({ error: "Preview bytes unavailable" }, { status: 503 });
      if (uploadRow && id === uploadRow.id) return new Response("Uploaded bytes", { headers: { "content-type": "text/plain" } });
      throw new Error(`Unexpected file-byte read: ${url}`);
    }
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: fileRows(), activities: activityRows() });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: [folder], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=")) return Response.json({ folders: [], activities: { files: [], folders: [] } });
    throw new Error(`Unexpected activity fixture request: ${url}`);
  };

  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder for file activity");
    await clickAria(`Open folder: ${sampleCourse.code}`);

    await clickAria(`Preview file: ${failedPreview.name}`);
    await waitUntil(() => rootNode.textContent.includes("Preview bytes unavailable"), "failed file preview");
    assert.equal(openActions.length, 0, "a failed read does not create a Recent record");
    await click("Close file preview");

    await click("New"); await click("Upload files");
    const selectedUpload = new File(["Uploaded bytes"], "Uploaded notes.txt", { type: "text/plain" });
    const chooser = uploadChooser();
    await act(async () => { Object.defineProperty(chooser, "files", { configurable: true, value: [selectedUpload] }); chooser.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await waitUntil(() => uploadXhr.requests.length === 1, "failed upload attempt starts");
    const firstUpload = uploadXhr.requests[0];
    const uploadedId = new URL(firstUpload.url, "https://edu.example").searchParams.get("id");
    uploadIds.push(uploadedId);
    const originalMetadata = uploadMetadata(firstUpload);
    assert.equal(originalMetadata.folderId, folderId); assert.equal(originalMetadata.courseId, sampleCourse.id);
    await act(async () => firstUpload.respond(503, { error: "Storage offline" }));
    await waitUntil(() => rootNode.querySelector(`[data-upload-id="${uploadedId}"] .files-upload-error`)?.textContent.includes("Storage offline"), "failed upload attempt");
    assert.equal(openActions.length, 0, "a failed upload attempt does not create a Recent record");
    await clickIn(rootNode.querySelector(`[data-upload-id="${uploadedId}"]`), "Retry upload");
    await waitUntil(() => uploadXhr.requests.length === 2, "retry of uploaded file");
    const retryUpload = uploadXhr.requests[1];
    uploadIds.push(new URL(retryUpload.url, "https://edu.example").searchParams.get("id"));
    assert.equal(retryUpload.body, selectedUpload); assert.deepEqual(uploadMetadata(retryUpload), originalMetadata);
    uploadRow = await uploadedFileForRequest(retryUpload);
    filesById.set(uploadRow.id, uploadRow);
    await act(async () => retryUpload.respond(201, { file: uploadRow }));
    await waitUntil(() => rootNode.querySelector(`[aria-label="Preview file: Uploaded notes.txt"]`), "uploaded file after retry");
    assert.deepEqual(uploadIds, [uploadedId, uploadedId], "the successful upload retries the same reserved file ID");
    assert.equal(openActions.length, 0, "a successful upload alone is not a file open");

    await clickAria("Close upload panel");
    await clickAria("Preview file: Uploaded notes.txt");
    await waitUntil(() => rootNode.querySelector(".syllabus-source")?.textContent === "Uploaded bytes", "uploaded file bytes read successfully");
    await waitUntil(() => openActions.length === 1, "uploaded preview Recent acknowledgement");
    await click("Close file preview"); await click("Recent");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Preview file: Uploaded notes.txt"]`), "uploaded file in Recent");
    assert.equal(rootNode.querySelector(`[aria-label="Preview file: ${failedPreview.name}"]`), null, "failed preview is absent from Recent");

    await returnToFilesRoot(); await clickAria(`Open folder: ${sampleCourse.code}`);
    await clickAria("More options for Uploaded notes.txt"); await click("Rename file");
    await edit("Name", "Uploaded renamed.txt"); await click("Rename");
    await waitUntil(() => !rootNode.querySelector(".file-organization-dialog"), "successful uploaded file rename");
    await waitUntil(() => openActions.filter((action) => action.items[0].id === uploadedId).length === 2, "renamed file Recent acknowledgement");
    assert.equal(renameRequests.length, 1); assert.equal(renameRequests[0].name, "Uploaded renamed.txt");
    assert.equal(uploadRow.name, "Uploaded renamed.txt"); assert.equal(uploadRow.metadata_revision, 2);

    await clickAria(`Edit text: ${native.name}`);
    await waitUntil(() => rootNode.querySelector(".native-document-fields textarea")?.value === nativeBody, "native document read");
    await waitUntil(() => openActions.filter((action) => action.items[0].id === native.id).length === 1, "native read Recent acknowledgement");
    assert.equal(native.content_revision, 1);
    const changedText = "Successfully saved the real native document.";
    await edit("Text", changedText);
    await waitUntil(() => rootNode.textContent.includes("Failed to save"), "failed native save attempt");
    assert.equal(nativeWrites.length, 1); assert.equal(native.content_revision, 1);
    assert.equal(openActions.filter((action) => action.items[0].id === native.id).length, 1, "a failed native save does not add another Recent event");
    await click("Retry save");
    await waitUntil(() => native.content_revision === 2 && openActions.filter((action) => action.items[0].id === native.id).length === 2, "successful native save Recent acknowledgement", 6000);
    assert.equal(nativeBody, changedText); assert.equal(native.size_bytes, new TextEncoder().encode(changedText).byteLength);
    await click("Close editor"); await click("Recent");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Edit text: ${native.name}"]`), "native document in Recent");
    assert.equal(server.writes, 0, "file reads and native content saves do not rewrite academic workspace data");
    assert.deepEqual(server.dashboard.d.assignments, [assignment]);
    assert.equal(byteReads.filter((id) => id === failedPreview.id).length, 1);
    assert.equal(uploadRow?.content_revision, 1);
  } finally {
    filesFetcher = undefined;
    uploadXhr.restore();
    if (root) await unmount();
    if (previousFrame) window.requestAnimationFrame = previousFrame; else delete window.requestAnimationFrame;
    if (previousCancelFrame) window.cancelAnimationFrame = previousCancelFrame; else delete window.cancelAnimationFrame;
  }
});

test("real course archive uses a captured editable term label and unarchives without changing academic links or file bytes", async () => {
  reset();
  const previousFrame = window.requestAnimationFrame, previousCancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
  window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);
  const profile = { ...baseProfile, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", current_term: "Fall 2026" };
  const assignment = { id: "history-essay", title: "Keep linked assignment", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Academic link remains", weight: "15%" };
  const manualEvents = [{ id: "history-event", title: "Keep linked event", courseId: sampleCourse.id, dateKey: "2026-10-16", time: "10:00", type: "Study block" }];
  const courseDetails = { [sampleCourse.id]: { officeHours: "Tuesday afternoons", meetings: [], syllabusText: "Saved syllabus stays linked", syllabusName: "History guide" } };
  const initial = { ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment], manualEvents, courseDetails, filePreferences: { filter: "all", view: "list" } } };
  const server = installWorkspaceServer(initial, [sampleCourse], profile);
  const workspaceBeforeArchive = structuredClone({ dashboard: server.dashboard, courses: server.courses });
  const stamp = "2026-10-01T00:00:00.000Z";
  const folderId = "22222222-2222-4222-8222-222222222222";
  const childFolderId = "33333333-3333-4333-8333-333333333333";
  const fileId = "44444444-4444-4444-8444-444444444444";
  const folder = { id: folderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  const child = { id: childFolderId, name: "Research", kind: "custom", course_id: null, course_code: null, parent_id: folderId, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  const bytes = "Course attachment bytes stay exactly the same.";
  const file = { id: fileId, name: "Linked notes.txt", mime_type: "text/plain", size_bytes: new TextEncoder().encode(bytes).byteLength, course_id: sampleCourse.id, assignment_id: assignment.id, kind: "attachment", state: "ready", created_at: stamp, updated_at: stamp, content_sha256: null, folder_id: childFolderId, content_backend: "object", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
  const originalFile = structuredClone(file);
  const archiveRequests = [], byteReads = [];
  let archived = false, failArchiveOnce = true;
  const workspaceFetch = fetcher;
  fetcher = async (url, init = {}) => {
    if (url === "/api/profile" && init.method === "PUT") {
      const body = JSON.parse(init.body);
      server.profile = { ...server.profile, ...validateProfile(body), updated_at: "2026-10-08T00:00:03.000Z" };
      return Response.json({ profile: server.profile });
    }
    return workspaceFetch(url, init);
  };
  filesFetcher = async (url, init = {}) => {
    assert.equal(new Headers(init.headers).get("x-profile-id"), profile.id);
    if (url === "/api/file-folders" && init.method === "PUT") {
      const body = JSON.parse(init.body); archiveRequests.push(structuredClone(body));
      assert.equal(body.id, folder.id); assert.equal(body.revision, folder.revision);
      if (body.action === "archive") {
        if (failArchiveOnce) { failArchiveOnce = false; return Response.json({ error: "Archive service offline" }, { status: 503 }); }
        folder.archived_at = "2026-10-08T00:00:04.000Z"; folder.semester_label = body.semesterLabel;
        folder.course_name_snapshot = sampleCourse.name; folder.course_color_snapshot = sampleCourse.color;
      } else {
        assert.equal(body.action, "unarchive");
        folder.archived_at = null; folder.semester_label = null; folder.course_name_snapshot = null; folder.course_color_snapshot = null;
      }
      folder.revision++; folder.updated_at = "2026-10-08T00:00:05.000Z";
      return Response.json({ folder: { ...folder } });
    }
    if (url.startsWith("/api/files?id=")) {
      byteReads.push(url);
      return new Response(bytes, { headers: { "content-type": "text/plain" } });
    }
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: [{ ...file }], activities: { files: [] } });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: archived ? [] : [{ ...folder }, { ...child }], activities: { folders: [] } });
    if (url.startsWith("/api/file-folders?view=archives")) return Response.json({ folders: archived ? [{ ...folder }, { ...child }] : [], activities: { folders: [] } });
    if (url.startsWith("/api/file-folders?view=trash")) return Response.json({ folders: [], activities: { folders: [] } });
    throw new Error(`Unexpected archive fixture request: ${url}`);
  };
  const saveArchive = filesFetcher;
  filesFetcher = async (url, init = {}) => {
    const response = await saveArchive(url, init);
    if (url === "/api/file-folders" && init.method === "PUT" && response.ok) {
      const body = JSON.parse(init.body); archived = body.action === "archive";
    }
    return response;
  };

  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="More options for ${sampleCourse.code}"]`), "course folder available to archive");
    await clickAria(`More options for ${sampleCourse.code}`); await click("Archive folder…");
    assert.equal(field("Semester label").value, "Fall 2026", "the archive label starts with the account's current term");
    await edit("Semester label", "My fall archive");
    await click("Settings");
    await edit("Current term", "Spring 2027"); await click("Save changes");
    await waitUntil(() => server.profile.current_term === "Spring 2027", "account term update while archive draft is open");
    await click("Review Files");
    assert.equal(field("Semester label").value, "My fall archive", "an account term change does not rewrite the captured archive draft");
    await click("Archive folder");
    await waitUntil(() => rootNode.textContent.includes("Archive service offline"), "archive request failure retained for retry");
    assert.equal(field("Semester label").value, "My fall archive");
    assert.equal(field("Semester label").disabled, true, "the captured label is immutable once the archive request starts");
    assert.deepEqual(archiveRequests[0], { action: "archive", id: folderId, revision: 1, semesterLabel: "My fall archive" });
    await click("Archive folder");
    await waitUntil(() => !rootNode.querySelector(".file-archive-dialog"), "archive retry succeeds");
    assert.deepEqual(archiveRequests[1], archiveRequests[0], "retry uses the identical captured label and folder revision");
    assert.equal(folder.semester_label, "My fall archive");
    assert.equal(folder.course_name_snapshot, sampleCourse.name); assert.equal(folder.course_color_snapshot, sampleCourse.color);

    await click("Archives");
    await waitUntil(() => [...rootNode.querySelectorAll(".files-archive-group h3")].some((heading) => heading.textContent === "My fall archive"), "archived course group");
    await clickAria(`More options for ${sampleCourse.code}`); await click("Unarchive folder…");
    await click("Unarchive folder");
    await waitUntil(() => !rootNode.querySelector(".file-archive-dialog"), "course unarchive succeeds");
    assert.equal(folder.archived_at, null); assert.equal(folder.semester_label, null);
    await returnToFilesRoot();
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "unarchived course in My files");

    assert.deepEqual(server.dashboard, workspaceBeforeArchive.dashboard, "archive and unarchive do not rewrite workspace data");
    assert.deepEqual(server.courses, workspaceBeforeArchive.courses);
    assert.deepEqual(server.dashboard.d.assignments, [assignment]);
    assert.deepEqual(server.dashboard.d.manualEvents, manualEvents);
    assert.deepEqual(server.dashboard.d.courseDetails, courseDetails);
    assert.deepEqual(file, originalFile, "the file's academic links, metadata revisions and content revision remain unchanged");
    assert.equal(byteReads.length, 0, "archiving does not read or rewrite file bytes");
    assert.equal(server.writes, 0, "archive and unarchive do not write a workspace revision");
    assert.equal(server.profile.current_term, "Spring 2027", "the deliberate term edit is saved independently of the archive operation");
  } finally {
    filesFetcher = undefined;
    if (root) await unmount();
    if (previousFrame) window.requestAnimationFrame = previousFrame; else delete window.requestAnimationFrame;
    if (previousCancelFrame) window.cancelAnimationFrame = previousCancelFrame; else delete window.cancelAnimationFrame;
  }
});

test("Workspace multi-file uploads retain independent retries, block account actions, and record Recent only after opening", async () => {
  reset();
  const previousFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
  const profile = { ...baseProfile, id: "12121212-1212-4121-8121-121212121212" };
  const server = installWorkspaceServer(savedDashboard, [sampleCourse], profile);
  const folderId = "23232323-2323-4323-8323-232323232323";
  const stamp = "2026-10-01T00:00:00.000Z";
  const folder = { id: folderId, name: sampleCourse.code, kind: "course", course_id: sampleCourse.id, course_code: sampleCourse.code, parent_id: null, revision: 1, created_at: stamp, updated_at: stamp, archived_at: null, semester_label: null, course_name_snapshot: null, course_color_snapshot: null, trashed_at: null, trash_operation_id: null, original_parent_id: null };
  const storedFiles = new Map(), fileBytes = new Map(), lastOpened = new Map(), activityActions = [], fileReads = [];
  const xhr = installUploadXhr();
  const rows = () => [...storedFiles.values()].map((file) => ({ ...file }));
  const activityRows = () => ({ files: [...lastOpened].map(([file_id, last_opened_at]) => ({ file_id, starred_at: null, last_opened_at })), folders: [] });
  filesFetcher = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === "/api/files/actions" && method === "POST") {
      const body = JSON.parse(init.body); activityActions.push(body);
      assert.equal(body.action, "open"); assert.equal(body.items.length, 1);
      const file = storedFiles.get(body.items[0].id);
      assert.ok(file, "open must refer to an uploaded file");
      assert.equal(body.items[0].revision, file.metadata_revision);
      const openedAt = "2026-10-09T00:00:01.000Z"; lastOpened.set(file.id, openedAt);
      return Response.json({ activities: { files: [{ file_id: file.id, starred_at: null, last_opened_at: openedAt }], folders: [] } });
    }
    if (url.startsWith("/api/files?id=") && method === "GET") {
      const id = new URL(url, "https://edu.example").searchParams.get("id"); fileReads.push(id);
      const bytes = fileBytes.get(id); assert.ok(bytes, `Missing bytes for ${id}`);
      return new Response(bytes, { headers: { "content-type": storedFiles.get(id)?.mime_type ?? "application/octet-stream" } });
    }
    if (url === "/api/files" && method === "GET") return Response.json({ files: rows() });
    if (url.startsWith("/api/files?view=active")) return Response.json({ files: rows(), activities: activityRows() });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=active")) return Response.json({ folders: [folder], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=")) return Response.json({ folders: [], activities: { files: [], folders: [] } });
    throw new Error(`Unexpected Workspace upload request: ${method} ${url}`);
  };

  const failedFile = new File(["first upload body"], "Retry me.txt", { type: "text/plain" });
  const successfulFile = new File(["second upload body"], "Open me.txt", { type: "text/plain" });
  const oversizedFile = new File([new Uint8Array(26_214_401)], "Too large.txt", { type: "text/plain" });
  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder for multi-file upload");
    await clickAria(`Open folder: ${sampleCourse.code}`);
    await click("New"); await click("Upload files");
    const chooser = uploadChooser();
    await act(async () => {
      Object.defineProperty(chooser, "files", { configurable: true, value: [failedFile, successfulFile, oversizedFile] });
      chooser.dispatchEvent(new window.Event("change", { bubbles: true }));
    });

    await waitUntil(() => xhr.requests.length === 1, "first queued upload");
    const failedRequest = xhr.requests[0];
    const failedId = new URL(failedRequest.url, "https://edu.example").searchParams.get("id");
    const failedMetadata = uploadMetadata(failedRequest);
    assert.deepEqual(failedMetadata, { name: failedFile.name, courseId: sampleCourse.id, assignmentId: "", kind: "resource", folderId });
    await act(async () => failedRequest.reportProgress(failedFile.size, failedFile.size));
    assert.equal(rootNode.querySelector(`[data-upload-id="${failedId}"] progress`).value, 99, "progress stays below completion until the server confirms the upload");
    assert.match(rootNode.querySelector(`[data-upload-id="${failedId}"] .files-upload-status`).textContent, /99%/);
    await act(async () => failedRequest.respond(503, { error: "Storage offline" }));

    await waitUntil(() => xhr.requests.length === 2, "second file continues after first upload failure");
    const successfulRequest = xhr.requests[1];
    const successfulRow = await uploadedFileForRequest(successfulRequest);
    storedFiles.set(successfulRow.id, successfulRow); fileBytes.set(successfulRow.id, "second upload body");
    await act(async () => successfulRequest.respond(201, { file: successfulRow }));
    await waitUntil(() => rootNode.querySelector(`[data-upload-id="${successfulRow.id}"] .files-upload-status`)?.textContent === "Uploaded and verified", "second file success");
    assert.equal(xhr.requests.length, 2, "an oversized selection is retained as a row without starting an upload");
    assert.match(rootNode.querySelector(`[data-upload-id="${failedId}"] .files-upload-error`).textContent, /Storage offline/);
    const oversizedRow = [...rootNode.querySelectorAll(".files-upload-row")].find((row) => row.textContent.includes(oversizedFile.name));
    assert.match(oversizedRow.querySelector(".files-upload-error").textContent, /25 MiB/);
    assert.equal(activityActions.length, 0, "upload completion alone never marks a file Recent");

    await clickAria("Close upload panel");
    assert.equal(rootNode.querySelector('[role="dialog"][aria-labelledby="files-upload-title"]'), null, "closing the chooser leaves its queue mounted in Workspace");
    await click("Recent");
    await waitUntil(() => rootNode.querySelector(".files-state-panel h3")?.textContent === "No recent files", "empty Recent view before a real open");
    assert.doesNotMatch(rootNode.querySelector(".files-browser-content").textContent, /Open me\.txt/);
    await clickIn(rootNode.querySelector('.files-view-nav'), "Files");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Open folder: ${sampleCourse.code}"]`), "course folder after Recent view");
    await clickAria(`Open folder: ${sampleCourse.code}`);
    await waitUntil(() => rootNode.querySelector(`[aria-label="Preview file: ${successfulFile.name}"]`), "uploaded file in My files");
    await clickAria(`Preview file: ${successfulFile.name}`);
    await waitUntil(() => rootNode.querySelector(".syllabus-source")?.textContent === "second upload body", "uploaded file preview read");
    await waitUntil(() => activityActions.length === 1, "open acknowledged to Recent");
    assert.deepEqual(fileReads, [successfulRow.id]);
    await click("Close file preview"); await click("Recent");
    await waitUntil(() => rootNode.querySelector(`[aria-label="Preview file: ${successfulFile.name}"]`), "file appears in Recent only after opening");

    await click("Settings");
    assert.equal(window.location.pathname, "/settings");
    assert.equal(unloadBlocked(), true, "retained failed and oversized rows protect the workspace from unload");
    assert.equal(rootNode.querySelector('a[href^="/api/export"]').getAttribute("aria-disabled"), "true");
    assert.equal([...rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "Sign out").disabled, true);
    await click("Download current drafts (.json)");
    const currentDraft = JSON.parse(await downloads.at(-1).text());
    const failedDraft = currentDraft.fileUploads.uploads.find((upload) => upload.id === failedId);
    assert.ok(failedDraft, "the current-work draft preserves the failed selection for recovery");
    assert.deepEqual(failedDraft.metadata, failedMetadata);
    assert.ok(currentDraft.fileUploads.uploads.some((upload) => upload.name === oversizedFile.name));

    await click("Review uploads");
    const failedRow = rootNode.querySelector(`[data-upload-id="${failedId}"]`);
    await clickIn(failedRow, "Download original");
    assert.equal(downloads.at(-1), failedFile, "each failed row can download its exact original selection");
    await clickIn(failedRow, "Download request draft");
    const requestDraft = JSON.parse(await downloads.at(-1).text());
    assert.equal(requestDraft.id, failedId); assert.deepEqual(requestDraft.metadata, failedMetadata);
    await clickIn(failedRow, "Retry upload");
    await waitUntil(() => xhr.requests.length === 3, "retry of failed selection");
    const retryRequest = xhr.requests[2];
    assert.equal(new URL(retryRequest.url, "https://edu.example").searchParams.get("id"), failedId, "retry reuses the reserved file ID");
    assert.equal(retryRequest.body, failedFile, "retry uses the original File object");
    assert.deepEqual(uploadMetadata(retryRequest), failedMetadata, "retry preserves the captured folder and class metadata");
    const retriedRow = await uploadedFileForRequest(retryRequest);
    storedFiles.set(retriedRow.id, retriedRow); fileBytes.set(retriedRow.id, "first upload body");
    await act(async () => retryRequest.respond(201, { file: retriedRow }));
    await waitUntil(() => rootNode.querySelector(`[data-upload-id="${failedId}"] .files-upload-status`)?.textContent === "Uploaded and verified", "failed selection retry success");
    assert.equal(rootNode.querySelector('a[href^="/api/export"]').getAttribute("aria-disabled"), "true", "the invalid oversized row still blocks account export");
    await clickAria(`Dismiss upload ${oversizedFile.name}`);
    assert.equal(unloadBlocked(), false, "completing retry and dismissing the invalid row clears upload protection");
    assert.notEqual(rootNode.querySelector('a[href^="/api/export"]').getAttribute("aria-disabled"), "true");
    assert.equal([...rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "Sign out").disabled, false);
    assert.equal(server.writes, 0, "upload progress and file reads do not rewrite the academic workspace");
  } finally {
    filesFetcher = undefined;
    xhr.restore();
    if (root) await unmount();
    if (previousFrame) window.requestAnimationFrame = previousFrame; else delete window.requestAnimationFrame;
  }
});

test("legacy class and assignment upload controls keep their associations beside the Files upload queue", async () => {
  reset();
  const profile = { ...baseProfile, id: "34343434-3434-4434-8434-343434343434" };
  const assignment = { id: "history-essay", title: "History essay", courseId: sampleCourse.id, dateKey: "2026-10-15", due: "", status: "later", progress: 20, description: "Keep the course link", weight: "15%" };
  installWorkspaceServer({ ...savedDashboard, d: { ...savedDashboard.d, assignments: [assignment] } }, [sampleCourse], profile);
  const uploads = [], storedFiles = new Map();
  const xhr = installUploadXhr();
  filesFetcher = async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url.startsWith("/api/files?id=") && method === "POST") {
      const metadata = JSON.parse(decodeURIComponent(new Headers(init.headers).get("x-file-metadata")));
      const id = new URL(url, "https://edu.example").searchParams.get("id");
      uploads.push({ id, metadata, file: init.body });
      const file = { id, name: metadata.name, mime_type: init.body.type || "application/octet-stream", size_bytes: init.body.size, course_id: metadata.courseId || null, assignment_id: metadata.assignmentId || null, kind: metadata.kind, state: "ready", created_at: "2026-10-09T00:00:00.000Z", updated_at: "2026-10-09T00:00:00.000Z", content_sha256: null, folder_id: metadata.folderId ?? null, content_backend: "object", metadata_revision: 1, content_revision: 1, trashed_at: null, trash_operation_id: null, original_folder_id: null };
      storedFiles.set(id, file);
      return Response.json({ file }, { status: 201 });
    }
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files: [...storedFiles.values()], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=")) return Response.json({ folders: [], activities: { files: [], folders: [] } });
    throw new Error(`Unexpected legacy upload request: ${method} ${url}`);
  };
  try {
    await render(Workspace, { initialProfile: profile, filesBrowserEnabled: true });
    await click("Courses");
    await waitUntil(() => rootNode.querySelector(".class-card"), "course card for class attachment");
    await act(async () => rootNode.querySelector(".class-card").click());
    await waitUntil(() => [...rootNode.querySelectorAll("button")].some((button) => button.textContent.trim() === "Add class file" && !button.disabled), "class upload control enabled");
    await click("Add class file");
    const classFile = new File(["class file bytes"], "Class handout.txt", { type: "text/plain" });
    const classChooser = field("Choose file");
    await act(async () => { Object.defineProperty(classChooser, "files", { configurable: true, value: [classFile] }); classChooser.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await click("Upload / retry file");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].metadata.courseId, sampleCourse.id); assert.equal(uploads[0].metadata.assignmentId, "");
    assert.equal(uploads[0].metadata.name, classFile.name); assert.equal(uploads[0].metadata.kind, "resource");
    assert.equal(xhr.requests.length, 0, "class attachments retain the existing single-file fetch flow");

    await click("Close class"); await click("Courses");
    await act(async () => rootNode.querySelector(".class-card").click());
    const assignmentRow = [...rootNode.querySelectorAll(".assignment-row")].find((row) => row.textContent.includes(assignment.title));
    assert.ok(assignmentRow, "the class detail retains its assignment row");
    await act(async () => assignmentRow.click());
    await waitUntil(() => rootNode.querySelector('[aria-label="Assignment details"]'), "assignment details after opening the linked row");
    await waitUntil(() => [...rootNode.querySelectorAll("button")].some((button) => button.textContent.trim() === "Attach file" && !button.disabled), "assignment upload control enabled");
    await click("Attach file");
    const assignmentFile = new File(["assignment bytes"], "Essay source.txt", { type: "text/plain" });
    const assignmentChooser = rootNode.querySelector('[aria-label="File editor"] input[type="file"]');
    assert.ok(assignmentChooser, "assignment attachment opens the legacy file editor");
    await act(async () => { Object.defineProperty(assignmentChooser, "files", { configurable: true, value: [assignmentFile] }); assignmentChooser.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await click("Upload / retry file");
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].metadata.courseId, sampleCourse.id); assert.equal(uploads[1].metadata.assignmentId, assignment.id);
    assert.equal(uploads[1].metadata.name, assignmentFile.name); assert.equal(uploads[1].metadata.kind, "attachment");
    assert.equal(xhr.requests.length, 0, "assignment attachments retain the existing single-file fetch flow");
    await waitUntil(() => rootNode.querySelector('[aria-label="Assignment details"] .private-file-list')?.textContent.includes(assignmentFile.name), "assignment attachment displayed with its saved association");
  } finally {
    filesFetcher = undefined;
    xhr.restore();
    if (root) await unmount();
  }
});

test("late upload acknowledgements are fenced across an A to B to A profile session change", async () => {
  reset();
  const previousFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(window.performance.now()), 0);
  const profileA = { ...baseProfile, id: "45454545-4545-4454-8454-454545454545" };
  const profileB = { ...baseProfile, id: "56565656-5656-4565-8565-565656565656", email: "other@example.invalid" };
  const profiles = new Map([[profileA.id, profileA], [profileB.id, profileB]]);
  fetcher = async (_url, init = {}) => {
    const profileId = new Headers(init.headers).get("x-profile-id");
    const profile = profiles.get(profileId);
    assert.ok(profile, `Workspace request used an unknown profile ${profileId}`);
    if (init.method === "PUT") return Response.json({ ok: true, revision: profile.updated_at });
    return Response.json({ initialized: true, courses: [], dashboard: savedDashboard, revision: profile.updated_at, profile });
  };
  const requests = [], xhr = installUploadXhr();
  let accountAFileStore = [], accountBFileStore = [];
  const storeFor = (profileId) => profileId === profileA.id ? accountAFileStore : accountBFileStore;
  filesFetcher = async (url, init = {}) => {
    const profileId = new Headers(init.headers).get("x-profile-id");
    requests.push({ url, method: init.method ?? "GET", profileId });
    const files = storeFor(profileId);
    if (url === "/api/files" || url.startsWith("/api/files?view=active")) return Response.json({ files, activities: { files: [], folders: [] } });
    if (url.startsWith("/api/files?view=trash")) return Response.json({ files: [], activities: { files: [], folders: [] } });
    if (url.startsWith("/api/file-folders?view=")) return Response.json({ folders: [], activities: { files: [], folders: [] } });
    throw new Error(`Unexpected cross-profile upload request: ${init.method ?? "GET"} ${url}`);
  };
  const lateFile = new File(["late account A bytes"], "A only.txt", { type: "text/plain" });
  try {
    await render(Workspace, { initialProfile: profileA, filesBrowserEnabled: true });
    await click("Files"); await waitUntil(() => rootNode.querySelector(".files-browser"), "Files browser for account A");
    await click("New"); await click("Upload files");
    const chooser = uploadChooser();
    await act(async () => { Object.defineProperty(chooser, "files", { configurable: true, value: [lateFile] }); chooser.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await waitUntil(() => xhr.requests.length === 1, "account A upload starts");
    const heldRequest = xhr.requests[0];
    assert.equal(heldRequest.headers.get("x-profile-id"), profileA.id);
    const heldId = new URL(heldRequest.url, "https://edu.example").searchParams.get("id");

    await render(Workspace, { initialProfile: profileB, filesBrowserEnabled: true });
    await waitUntil(() => rootNode.querySelector(`[data-upload-id="${heldId}"] .files-upload-error`)?.textContent.includes("original account"), "account switch aborts and retains the original queue row");
    assert.equal(uploadChooser().disabled, true, "an old account chooser cannot add files to the new account");
    const retryButton = [...rootNode.querySelectorAll(`[data-upload-id="${heldId}"] button`)].find((button) => button.textContent.trim() === "Retry upload");
    assert.ok(retryButton?.disabled, "the old account's retry is disabled while account B is active");

    await render(Workspace, { initialProfile: profileA, filesBrowserEnabled: true });
    await waitUntil(() => requests.some((request) => request.url === "/api/files" && request.profileId === profileA.id) && !rootNode.querySelector(".files-browser")?.textContent.includes("Loading your files"), "account A rehydrates with its new session generation");
    const aReadsBeforeLateResponse = requests.filter((request) => request.url === "/api/files" && request.profileId === profileA.id).length;
    const bReadsBeforeLateResponse = requests.filter((request) => request.url === "/api/files" && request.profileId === profileB.id).length;
    const lateResponseFile = await uploadedFileForRequest(heldRequest);
    await act(async () => heldRequest.respond(201, { file: lateResponseFile }));
    await waitForMilliseconds(100);
    assert.equal(heldRequest.aborted, true, "the original XHR was aborted when the profile session changed");
    assert.equal(rootNode.querySelector(`[data-upload-id="${heldId}"] .files-upload-status`)?.textContent.includes("Uploaded and verified"), false, "a late response cannot acknowledge an upload from an earlier A session");
    assert.equal(rootNode.querySelector(".files-browser-content").textContent.includes(lateFile.name), false, "the late acknowledgement does not insert account A data into the re-entered Workspace");
    assert.equal(requests.filter((request) => request.url === "/api/files" && request.profileId === profileA.id).length, aReadsBeforeLateResponse, "stale completion does not refresh files through a later A session");
    assert.equal(requests.filter((request) => request.url === "/api/files" && request.profileId === profileB.id).length, bReadsBeforeLateResponse, "stale completion never reads account B files");
    assert.equal(accountAFileStore.length, 0); assert.equal(accountBFileStore.length, 0);
    assert.equal(requests.filter((request) => request.method === "POST" && request.url.startsWith("/api/files")).length, 0, "no fetch-based write is redirected to either account");
  } finally {
    filesFetcher = undefined;
    xhr.restore();
    if (root) await unmount();
    if (previousFrame) window.requestAnimationFrame = previousFrame; else delete window.requestAnimationFrame;
  }
});
