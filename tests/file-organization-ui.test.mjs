import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/files?view=my-files&layout=list", pretendToBeVisual: true });
for (const name of [
  "window", "document", "Element", "Node", "HTMLElement", "HTMLFormElement", "HTMLButtonElement",
  "HTMLAnchorElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent",
  "KeyboardEvent", "Event", "FormData", "PopStateEvent", "MutationObserver",
]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id) => clearTimeout(id) });
dom.window.confirm = () => true;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.scrollTo = () => {};

const [{ createElement, act }, { createRoot }, { default: FilesBrowser }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/files-browser.tsx")),
]);

const PROFILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COURSE_ROOT = "11111111-1111-4111-8111-111111111111";
const COURSE_LABS = "22222222-2222-4222-8222-222222222222";
const COURSE_WEEK = "33333333-3333-4333-8333-333333333333";
const PERSONAL_ROOT = "44444444-4444-4444-8444-444444444444";
const PERSONAL_CHILD = "55555555-5555-4555-8555-555555555555";
const EXISTING_NOTES = "66666666-6666-4666-8666-666666666666";
const FILE_ROOT = "aaaaaaaa-1111-4111-8111-111111111111";
const FILE_COURSE = "bbbbbbbb-1111-4111-8111-111111111111";
const NOW = "2026-10-08T12:00:00.000Z";
const course = { id: "biology", code: "BIO 201", name: "Biology", credits: 4, instructor: "Dr. Moss", room: "Science 2", color: "#b23b53", soft: "#b23b5318", initials: "BIO" };

function makeFolder(id, name, parent_id = null, overrides = {}) {
  return {
    id, name, parent_id, kind: "custom", course_id: null, course_code: null, revision: 1,
    created_at: NOW, updated_at: NOW, archived_at: null, semester_label: null,
    course_name_snapshot: null, course_color_snapshot: null, trashed_at: null,
    trash_operation_id: null, original_parent_id: null, ...overrides,
  };
}

function makeFile(id, name, folder_id = null, overrides = {}) {
  return {
    id, name, mime_type: "text/plain", size_bytes: 12, course_id: null, assignment_id: null,
    kind: "resource", state: "ready", created_at: NOW, updated_at: NOW,
    content_sha256: null, folder_id, content_backend: "object", metadata_revision: 1,
    content_revision: 1, trashed_at: null, trash_operation_id: null,
    original_folder_id: null, ...overrides,
  };
}

function initialState() {
  return {
    folders: [
      makeFolder(COURSE_ROOT, "BIO 201", null, { kind: "course", course_id: "biology", course_code: "BIO 201" }),
      makeFolder(COURSE_LABS, "Labs", COURSE_ROOT),
      makeFolder(COURSE_WEEK, "Week 1", COURSE_LABS),
      makeFolder(PERSONAL_ROOT, "Personal"),
      makeFolder(PERSONAL_CHILD, "Research", PERSONAL_ROOT),
      makeFolder(EXISTING_NOTES, "Class notes"),
    ],
    files: [
      makeFile(FILE_ROOT, "Root notes.txt", null, { course_id: "biology", assignment_id: "essay" }),
      makeFile(FILE_COURSE, "Lab notes.txt", COURSE_LABS, { course_id: "biology" }),
    ],
  };
}

const rootNode = document.getElementById("root");
let root;
let state;
let requests;
let mutations;
let callbacks;
let failures;
let holdNextMutation;
let pendingMutation;

globalThis.fetch = (...args) => fetchFixture(...args);

function reset(path = "/files?view=my-files&layout=list") {
  window.history.replaceState({}, "", path);
  rootNode.innerHTML = "";
  root = createRoot(rootNode);
  state = initialState();
  requests = [];
  mutations = [];
  callbacks = { uploads: [], opened: [], edited: [], textFiles: [], saved: 0, reports: [] };
  failures = [];
  holdNextMutation = false;
  pendingMutation = null;
}

function addProfile(row, profileId) { return { ...row, profile_id: profileId }; }

async function fetchFixture(input, init = {}) {
  const url = String(input);
  const profileId = new Headers(init.headers).get("x-profile-id") ?? "";
  const method = init.method ?? "GET";
  const entry = { url, method, profileId, init };
  requests.push(entry);
  if (method === "GET") {
    if (url === "/api/files?view=active") return Response.json({ files: state.files.filter((file) => !file.trashed_at), activities: { files: [] } });
    if (url === "/api/files?view=trash") return Response.json({ files: state.files.filter((file) => file.trashed_at), activities: { files: [] } });
    if (url === "/api/file-folders?view=active") return Response.json({ folders: state.folders.filter((folder) => !folder.archived_at && !folder.trashed_at), activities: { folders: [] } });
    if (url === "/api/file-folders?view=archives") return Response.json({ folders: state.folders.filter((folder) => folder.archived_at), activities: { folders: [] } });
    if (url === "/api/file-folders?view=trash") return Response.json({ folders: state.folders.filter((folder) => folder.trashed_at), activities: { folders: [] } });
    throw new Error(`Unexpected GET fixture request: ${url}`);
  }

  const body = JSON.parse(init.body ?? "{}");
  const mutation = { url, method, profileId, body, signal: init.signal };
  mutations.push(mutation);
  if (holdNextMutation) {
    holdNextMutation = false;
    await new Promise((resolve) => { pendingMutation = { resolve }; });
  }
  const failureIndex = failures.findIndex((failure) => failure.method === method && failure.url === url);
  if (failureIndex >= 0) {
    const [failure] = failures.splice(failureIndex, 1);
    return Response.json({ error: failure.message }, { status: failure.status });
  }

  if (method === "POST" && url === "/api/file-folders") {
    const parent = body.parentId ? state.folders.find((folder) => folder.id === body.parentId) : null;
    const created = makeFolder(body.id, body.name, body.parentId, parent?.kind === "course"
      ? { course_code: parent.course_code, course_name_snapshot: parent.name }
      : {});
    state.folders.push(created);
    return Response.json({ folder: addProfile(created, profileId) });
  }

  if (method === "PUT" && url === "/api/file-folders") {
    const index = state.folders.findIndex((folder) => folder.id === body.id);
    if (index < 0) return Response.json({ error: "Folder missing" }, { status: 404 });
    const updated = { ...state.folders[index], name: body.name, revision: state.folders[index].revision + 1, updated_at: NOW };
    state.folders[index] = updated;
    return Response.json({ folder: addProfile(updated, profileId) });
  }

  if (method === "PUT" && url.startsWith("/api/files?id=")) {
    const id = new URL(url, "https://edu.example").searchParams.get("id");
    const index = state.files.findIndex((file) => file.id === id);
    if (index < 0) return Response.json({ error: "File missing" }, { status: 404 });
    const updated = { ...state.files[index], name: body.name, metadata_revision: state.files[index].metadata_revision + 1, updated_at: NOW };
    state.files[index] = updated;
    return Response.json({ file: addProfile(updated, profileId) });
  }

  if (method === "POST" && url === "/api/files/actions" && body.action === "move") {
    const movedFiles = [], movedFolders = [];
    for (const item of body.items) {
      if (item.type === "file") {
        const index = state.files.findIndex((file) => file.id === item.id);
        if (index < 0) return Response.json({ error: "File missing" }, { status: 404 });
        const updated = { ...state.files[index], folder_id: body.destinationId, metadata_revision: state.files[index].metadata_revision + 1, updated_at: NOW };
        state.files[index] = updated;
        movedFiles.push(addProfile(updated, profileId));
      } else {
        const index = state.folders.findIndex((folder) => folder.id === item.id);
        if (index < 0) return Response.json({ error: "Folder missing" }, { status: 404 });
        const updated = { ...state.folders[index], parent_id: body.destinationId, revision: state.folders[index].revision + 1, updated_at: NOW };
        state.folders[index] = updated;
        movedFolders.push(addProfile(updated, profileId));
      }
    }
    return Response.json({ files: movedFiles, folders: movedFolders });
  }

  throw new Error(`Unexpected mutation fixture request: ${method} ${url}`);
}

function props({ profileId = PROFILE_A, canWrite = true } = {}) {
  return {
    profileId,
    courses: [course],
    assignments: [{ id: "essay", title: "Final essay", courseId: "biology" }],
    store: { files: state.files, url: (file) => `/api/files?id=${file.id}&account=${profileId}` },
    layout: "list",
    onLayoutChange() {},
    onUpload: (...args) => callbacks.uploads.push(args),
    onOpen: (file) => callbacks.opened.push(file.id),
    onEdit: (file) => callbacks.edited.push(file.id),
    onNewTextFile: (...args) => callbacks.textFiles.push(args),
    onOrganizationSaved: async () => { callbacks.saved += 1; },
    onOrganizationStateChange: (report) => callbacks.reports.push(report),
    canWrite,
  };
}

async function render(componentProps = props()) {
  await act(async () => { root.render(createElement(FilesBrowser, componentProps)); });
}

async function unmount() {
  if (!root) return;
  await act(async () => root.unmount());
  root = undefined;
  rootNode.innerHTML = "";
}

after(() => dom.window.close());
afterEach(async () => { await unmount(); });

async function waitUntil(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

function button(label, container = rootNode) {
  const found = [...container.querySelectorAll("button")].find((item) => {
    const ariaLabel = item.getAttribute("aria-label") ?? "";
    return ariaLabel === label || ariaLabel.startsWith(`${label} in `) || item.textContent.trim() === label;
  });
  assert.ok(found, `Missing button ${label}`);
  return found;
}

async function click(label, container = rootNode) {
  const control = button(label, container);
  await act(async () => control.click());
  return control;
}

function itemRow(name) {
  const found = [...rootNode.querySelectorAll(".files-item")].find((item) => item.querySelector(".files-item-title strong")?.textContent === name);
  assert.ok(found, `Missing file item ${name}`);
  return found;
}

async function openItemMenu(name) {
  await act(async () => button(`More options for ${name}`).click());
  await waitUntil(() => Boolean(rootNode.querySelector('[role="menu"]')), `the ${name} menu`);
}

function menuLabels() { return [...rootNode.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim()); }

function dialog() {
  const found = rootNode.querySelector('[role="dialog"]');
  assert.ok(found, "organization dialog is open");
  return found;
}

function field(label) {
  const found = [...dialog().querySelectorAll("input")].find((item) => item.getAttribute("aria-label") === label);
  assert.ok(found, `Missing dialog field ${label}`);
  return found;
}

async function setValue(control, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("create folders at root and nested course locations, allow duplicate names, and rename folder and file by stable IDs", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the initial Files list");
  const newTrigger = button("New");
  await act(async () => newTrigger.click());
  assert.deepEqual(menuLabels(), ["Upload files", "Upload folder", "New folder", "Text document"]);
  await click("New folder");
  assert.match(dialog().textContent, /Create a folder in My files/);
  assert.ok(document.activeElement === field("Folder name"), "the folder name field receives focus");
  await setValue(field("Folder name"), "Class notes");

  failures.push({ method: "POST", url: "/api/file-folders", status: 409, message: "Temporary create conflict" });
  await click("Create folder", dialog());
  await waitUntil(() => dialog().querySelector('[role="alert"]')?.textContent.includes("Temporary create conflict"), "the failed create message");
  assert.equal(field("Folder name").value, "Class notes", "failed saves keep their draft text");
  const firstCreateId = mutations.filter((request) => request.url === "/api/file-folders" && request.method === "POST").at(-1)?.body.id;
  assert.ok(firstCreateId);
  await click("Create folder", dialog());
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]') && state.folders.some((folder) => folder.id === firstCreateId), "the retried duplicate folder");
  const createRequests = mutations.filter((request) => request.url === "/api/file-folders" && request.method === "POST");
  assert.equal(createRequests.length, 2);
  assert.equal(createRequests[0].body.id, createRequests[1].body.id, "the retry keeps its original generated ID");
  const rootDuplicates = state.folders.filter((folder) => folder.name === "Class notes");
  assert.equal(rootDuplicates.length, 2, "duplicate folder names are allowed in one location");
  assert.notEqual(rootDuplicates[0].id, rootDuplicates[1].id);
  assert.ok(document.activeElement === newTrigger, "closing restores focus to the New trigger");

  await click("Open folder: BIO 201");
  await click("Open folder: Labs");
  assert.equal(new URL(window.location.href).searchParams.get("folder"), COURSE_LABS);
  await openItemMenu("Week 1");
  assert.deepEqual(menuLabels(), ["Open folder", "Add to Starred", "New text file", "New folder", "Rename folder", "Move to…", "Move to Trash", "Details"]);
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click("Actions for Labs");
  assert.deepEqual(menuLabels(), ["Select visible", "New folder", "Text document"]);
  await click("New folder");
  await setValue(field("Folder name"), "Week 1");
  await click("Create folder", dialog());
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]') && [...rootNode.querySelectorAll(".files-item-title strong")].filter((item) => item.textContent === "Week 1").length === 2, "the duplicate nested folder");
  const duplicate = state.folders.filter((folder) => folder.name === "Week 1");
  assert.equal(duplicate.length, 2);
  assert.notEqual(duplicate[0].id, duplicate[1].id, "same-parent duplicate names keep separate IDs");
  assert.ok(duplicate.every((folder) => folder.parent_id === COURSE_LABS));
  const firstRenderedDuplicateId = duplicate.map((folder) => folder.id).sort()[0];

  await openItemMenu("Week 1");
  await click("Rename folder");
  assert.equal(dialog().querySelector("h2")?.textContent, "Rename folder");
  await setValue(field("Name"), "Week One");
  await click("Rename", dialog());
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]') && rootNode.textContent.includes("Week One"), "the folder rename");
  assert.equal(new URL(window.location.href).searchParams.get("folder"), COURSE_LABS, "folder navigation remains attached to the parent ID");
  assert.equal(state.folders.find((folder) => folder.name === "Week One")?.id, firstRenderedDuplicateId, "the renamed folder retains its ID");

  const rootPath = button("My files");
  await act(async () => rootPath.click());
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root Files list");
  const badge = itemRow("Root notes.txt").querySelector(".files-association-badges");
  assert.ok(badge, "course and assignment badges show when file associations differ from its location");
  assert.match(badge.textContent, /BIO 201.*Final essay/);
  await openItemMenu("Root notes.txt");
  assert.deepEqual(menuLabels(), ["Add to Starred", "Preview", "Download", "Rename file", "Move to…", "Move to Trash", "Edit details", "Details"]);
  await click("Rename file");
  await setValue(field("Name"), "Renamed notes.txt");
  await click("Rename", dialog());
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]') && rootNode.textContent.includes("Renamed notes.txt"), "the file rename");
  const renamed = state.files.find((file) => file.id === FILE_ROOT);
  assert.equal(renamed.name, "Renamed notes.txt");
  assert.equal(renamed.course_id, "biology");
  assert.equal(renamed.assignment_id, "essay");
  assert.equal(renamed.content_revision, 1, "renaming does not touch content revision");
});

test("managed course roots stay protected while file moves and internal drag preserve course assignments", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the initial Files list");
  await openItemMenu("BIO 201");
  assert.deepEqual(menuLabels(), ["Open folder", "Add to Starred", "Archive folder…", "New text file", "New folder", "Details"]);
  assert.match(rootNode.querySelector('[role="menu"]')?.textContent ?? "", /Course folder names follow your Courses/);
  assert.equal(menuLabels().some((label) => /Rename|Move/.test(label)), false, "managed course roots have no generic rename or move actions");
  await act(async () => document.body.dispatchEvent(new Event("keydown", { key: "Escape", bubbles: true })));

  const source = itemRow("Root notes.txt");
  const transfer = {
    types: [], files: [], values: new Map(), effectAllowed: "", dropEffect: "",
    setData(type, value) { this.values.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData(type) { return this.values.get(type) ?? ""; },
  };
  const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(dragStart, "dataTransfer", { value: transfer });
  await act(async () => source.dispatchEvent(dragStart));
  const target = itemRow("Personal");

  const foreignSessionTransfer = {
    types: [...transfer.types], files: [],
    getData(type) { return type === "application/x-eduessentials-files-browser" ? "another-session-token" : ""; },
  };
  const foreignSessionDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(foreignSessionDrop, "dataTransfer", { value: foreignSessionTransfer });
  await act(async () => target.dispatchEvent(foreignSessionDrop));
  assert.equal(foreignSessionDrop.defaultPrevented, false, "a different in-app drag token cannot trigger a move");
  assert.equal(mutations.some((request) => request.url === "/api/files/actions"), false);

  const externalTransfer = { types: ["Files"], files: [{ name: "outside.txt" }], getData() { return ""; } };
  const externalDrop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(externalDrop, "dataTransfer", { value: externalTransfer });
  await act(async () => target.dispatchEvent(externalDrop));
  assert.equal(externalDrop.defaultPrevented, false, "external file drops are ignored by the organization flow");
  assert.equal(mutations.some((request) => request.url === "/api/files/actions"), false);

  const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(dragOver, "dataTransfer", { value: transfer });
  await act(async () => target.dispatchEvent(dragOver));
  assert.equal(dragOver.defaultPrevented, true, "a same-session internal drag can target an allowed folder");
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: transfer });
  await act(async () => target.dispatchEvent(drop));
  await waitUntil(() => mutations.some((request) => request.url === "/api/files/actions"), "the internal move request");
  await waitUntil(() => state.files.find((file) => file.id === FILE_ROOT).folder_id === PERSONAL_ROOT && callbacks.saved === 1, "the completed internal move");
  const move = mutations.find((request) => request.url === "/api/files/actions");
  assert.equal(move.profileId, PROFILE_A);
  assert.deepEqual(move.body.items, [{ type: "file", id: FILE_ROOT, revision: 1 }]);
  assert.equal(state.files.find((file) => file.id === FILE_ROOT).course_id, "biology");
  assert.equal(state.files.find((file) => file.id === FILE_ROOT).assignment_id, "essay");
  await click("Open folder: Personal");
  await waitUntil(() => new URL(window.location.href).searchParams.get("folder") === PERSONAL_ROOT, "the Personal folder after move");
  await waitUntil(() => itemRow("Root notes.txt").querySelector(".files-association-badges"), "association badges after moving into a personal folder");
});

test("stale rename and move drafts remain visible, blocked descendant destinations stay disabled, and reselect clears stale selection", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the initial Files list");

  await openItemMenu("Root notes.txt");
  await click("Rename file");
  await setValue(field("Name"), "Draft title.txt");
  failures.push({ method: "PUT", url: `/api/files?id=${FILE_ROOT}`, status: 409, message: "Stale file revision" });
  await click("Rename", dialog());
  await waitUntil(() => dialog().querySelector('[role="alert"]')?.textContent.includes("Stale file revision"), "the stale rename error");
  assert.equal(field("Name").value, "Draft title.txt", "the stale snapshot keeps the submitted draft");
  assert.ok(rootNode.querySelector('[role="dialog"]'), "the stale rename dialog remains open for recovery");
  await click("Refresh Files", dialog());
  await waitUntil(() => requests.filter((request) => request.url === "/api/files?view=active").length >= 2, "the explicit Files refresh");
  assert.equal(field("Name").value, "Draft title.txt");
  await click("Discard draft…", dialog());
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]'), "closing the rename draft");

  const selectRootFolder = rootNode.querySelector(`input[aria-label^="Select Personal in"]`);
  assert.ok(selectRootFolder);
  await act(async () => { selectRootFolder.click(); });
  await click("Move to…");
  const moveDialog = dialog();
  await click("Open folder: Personal", moveDialog);
  const descendantRow = [...moveDialog.querySelectorAll('[role="listitem"]')].find((item) => item.querySelector("strong")?.textContent === "Research");
  assert.ok(descendantRow, "the selected folder descendant is listed as a possible destination");
  const descendantMove = [...descendantRow.querySelectorAll("button")].find((item) => item.textContent.trim() === "Move here");
  assert.ok(descendantMove?.disabled, "a selected folder cannot be moved into its descendant");
  await click("My files", moveDialog);
  await click("Move here", moveDialog);
  failures.push({ method: "POST", url: "/api/files/actions", status: 409, message: "Stale folder revision" });
  await click("Move items", moveDialog);
  await waitUntil(() => dialog().querySelector('[role="alert"]')?.textContent.includes("Stale folder revision"), "the stale move error");
  assert.match(dialog().textContent, /Refresh Files, then close and reselect/i);
  assert.ok(rootNode.querySelector('[role="dialog"]'), "the failed move draft remains open");
  await click("Close and reselect items", moveDialog);
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]') && !rootNode.querySelector(".files-selection-toolbar"), "clearing stale selection for reselection");
  assert.equal(state.folders.find((folder) => folder.id === PERSONAL_ROOT)?.parent_id, null, "a rejected move leaves its folder where it was");
});

test("dialog keyboard focus is trapped, account changes preserve but disable drafts, and late acknowledgements cannot refresh the new account", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the initial Files list");
  const trigger = button("New");
  await act(async () => trigger.click());
  await click("New folder");
  const createDialog = dialog();
  await waitUntil(() => document.activeElement === field("Folder name"), "the initial dialog focus");
  const closeButton = button("Close Files dialog", createDialog);
  const lastEnabledButton = button("Cancel", createDialog);
  closeButton.focus();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.ok(document.activeElement === lastEnabledButton, "Shift+Tab from the first control wraps to the last enabled dialog control");
  lastEnabledButton.focus();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.ok(document.activeElement === closeButton, "Tab from the last control wraps to the first dialog control");
  await setValue(field("Folder name"), "Account A draft");
  await render(props({ profileId: PROFILE_B }));
  await waitUntil(() => dialog().querySelector('[role="alert"]')?.textContent.includes("previous account"), "the account-switch warning");
  assert.equal(field("Folder name").value, "Account A draft", "account changes retain the captured account draft");
  assert.equal(field("Folder name").disabled, true);
  assert.equal(button("Create folder", dialog()).disabled, true);
  assert.equal(mutations.length, 0, "the previous account draft cannot submit under the new account");
  assert.ok(requests.some((request) => request.profileId === PROFILE_B), "the browser reload is scoped to the new account");

  await unmount();
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the restarted Files list");
  await act(async () => button("New").click());
  await click("New folder");
  await setValue(field("Folder name"), "Late response draft");
  holdNextMutation = true;
  await click("Create folder", dialog());
  await waitUntil(() => pendingMutation !== null, "the held folder create request");
  await render(props({ profileId: PROFILE_B }));
  await waitUntil(() => field("Folder name").disabled, "the new-account dialog fence");
  pendingMutation.resolve();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.ok(rootNode.querySelector('[role="dialog"]'), "late old-account acknowledgement does not close the draft");
  assert.equal(field("Folder name").value, "Late response draft");
  assert.equal(callbacks.saved, 0, "late acknowledgement does not run the browser's post-save refresh callback");
  assert.equal(state.folders.some((folder) => folder.name === "Late response draft"), true, "the mock server accepted the old request to exercise the client response fence");
  assert.ok(document.activeElement === field("Folder name"), "the late acknowledgement does not steal focus from the draft");
});
