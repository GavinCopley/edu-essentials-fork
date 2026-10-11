import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/files?view=my-files&layout=list", pretendToBeVisual: true });
for (const name of [
  "window", "document", "Element", "Node", "HTMLElement", "HTMLFormElement", "HTMLButtonElement",
  "HTMLAnchorElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent",
  "KeyboardEvent", "Event", "FormData", "PopStateEvent", "MutationObserver", "File",
]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id) => clearTimeout(id) });
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
const COURSE_CHILD = "66666666-6666-4666-8666-666666666666";
const PERSONAL_ROOT = "22222222-2222-4222-8222-222222222222";
const FILE_ROOT = "33333333-3333-4333-8333-333333333333";
const FILE_OTHER = "44444444-4444-4444-8444-444444444444";
const TRASH_OP = "55555555-5555-4555-8555-555555555555";
const OVERLAP_FOLDER = "77777777-7777-4777-8777-777777777777";
const OVERLAP_FILE = "88888888-8888-4888-8888-888888888888";
const BULK_TRASH_ROOT = "99999999-9999-4999-8999-999999999999";
const BULK_TRASH_CHILD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BULK_TRASH_DESCENDANT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const BULK_TRASH_INDEPENDENT = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
const BULK_TRASH_OP = "dddddddd-eeee-4fff-8000-bbbbbbbbbbbb";
const INDEPENDENT_TRASH_OP = "eeeeeeee-ffff-4000-8111-cccccccccccc";
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
      makeFolder(COURSE_CHILD, "Labs", COURSE_ROOT),
      makeFolder(PERSONAL_ROOT, "Personal"),
    ],
    files: [
      makeFile(FILE_ROOT, "Root notes.txt", null, { course_id: "biology" }),
      makeFile(FILE_OTHER, "Reading list.txt"),
    ],
  };
}

const rootNode = document.getElementById("root");
let root;
let state;
let requests;
let callbacks;
let failDownload;
let invalidZip;
let holdDownload;
let getFailures;

globalThis.fetch = (...args) => fetchFixture(...args);

function reset(path = "/files?view=my-files&layout=list") {
  window.history.replaceState({}, "", path);
  rootNode.innerHTML = "";
  root = createRoot(rootNode);
  state = initialState();
  requests = [];
  callbacks = { uploads: [], reports: [], trashCompleted: [] };
  failDownload = false;
  invalidZip = false;
  holdDownload = null;
  getFailures = [];
}

function zipResponse() {
  const archive = new Uint8Array(22);
  new DataView(archive.buffer).setUint32(0, 0x06054b50, true);
  return new Response(archive, { headers: {
    "content-type": "application/zip",
    "content-disposition": 'attachment; filename="eduessentials-selected-files.zip"',
    "content-length": "22",
  } });
}

async function fetchFixture(input, init = {}) {
  const url = String(input);
  const method = init.method ?? "GET";
  const profileId = new Headers(init.headers).get("x-profile-id") ?? "";
  const request = { url, method, profileId, signal: init.signal, body: init.body ? JSON.parse(init.body) : null };
  requests.push(request);
  if (method === "GET") {
    const failureIndex = getFailures.findIndex((failure) => failure.url === url && (!failure.profileId || failure.profileId === profileId));
    if (failureIndex >= 0) {
      const [failure] = getFailures.splice(failureIndex, 1);
      return Response.json({ error: failure.message }, { status: failure.status });
    }
    if (url === "/api/files?view=active") return Response.json({ files: state.files.filter((file) => !file.trashed_at), activities: { files: [] } });
    if (url === "/api/files?view=trash") return Response.json({ files: state.files.filter((file) => file.trashed_at), activities: { files: [] } });
    if (url === "/api/file-folders?view=active") return Response.json({ folders: state.folders.filter((folder) => !folder.archived_at && !folder.trashed_at), activities: { folders: [] } });
    if (url === "/api/file-folders?view=archives") return Response.json({ folders: state.folders.filter((folder) => folder.archived_at), activities: { folders: [] } });
    if (url === "/api/file-folders?view=trash") return Response.json({ folders: state.folders.filter((folder) => folder.trashed_at), activities: { folders: [] } });
    throw new Error(`Unexpected GET fixture request: ${url}`);
  }
  if (method === "POST" && url === "/api/files/download") {
    if (holdDownload) await holdDownload.promise;
    if (failDownload) {
      failDownload = false;
      return Response.json({ error: "ZIP service unavailable." }, { status: 503 });
    }
    if (invalidZip) {
      invalidZip = false;
      return new Response(new Uint8Array(22), { headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="eduessentials-selected-files.zip"',
        "content-length": "22",
      } });
    }
    return zipResponse();
  }
  if (method === "POST" && url === "/api/files/actions") {
    if (request.body.action === "restore") {
      const selectedFolders = new Set(request.body.items.filter((item) => item.type === "folder").map((item) => item.id));
      const operationByFolder = new Map();
      for (const item of request.body.items) {
        if (item.type === "folder") {
          const folder = state.folders.find((candidate) => candidate.id === item.id);
          if (folder) operationByFolder.set(folder.id, folder.trash_operation_id);
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of state.folders) {
          const parentId = folder.original_parent_id;
          const parentOperation = parentId ? operationByFolder.get(parentId) : undefined;
          if (folder.trashed_at && parentOperation && folder.trash_operation_id === parentOperation && !selectedFolders.has(folder.id)) {
            selectedFolders.add(folder.id);
            operationByFolder.set(folder.id, folder.trash_operation_id);
            changed = true;
          }
        }
      }
      const folders = [];
      for (const folder of state.folders) {
        if (!selectedFolders.has(folder.id)) continue;
        const updated = { ...folder, parent_id: folder.original_parent_id, original_parent_id: null, trashed_at: null, trash_operation_id: null, revision: folder.revision + 1, updated_at: NOW };
        Object.assign(folder, updated);
        folders.push({ ...updated, profile_id: profileId });
      }
      const selectedFiles = new Set(request.body.items.filter((item) => item.type === "file").map((item) => item.id));
      const files = [];
      for (const file of state.files) {
        const coveredByFolder = file.original_folder_id && operationByFolder.get(file.original_folder_id) === file.trash_operation_id;
        if (!selectedFiles.has(file.id) && !(file.trashed_at && coveredByFolder)) continue;
        const updated = { ...file, folder_id: file.original_folder_id, original_folder_id: null, trashed_at: null, trash_operation_id: null, metadata_revision: file.metadata_revision + 1, updated_at: NOW };
        Object.assign(file, updated);
        files.push({ ...updated, profile_id: profileId });
      }
      return Response.json({ files, folders, recoveryFolder: null });
    }
    const files = [];
    for (const item of request.body.items) {
      const index = state.files.findIndex((file) => file.id === item.id);
      const current = state.files[index];
      const updated = { ...current, folder_id: null, original_folder_id: current.folder_id, trashed_at: NOW, trash_operation_id: TRASH_OP, metadata_revision: current.metadata_revision + 1, updated_at: NOW };
      state.files[index] = updated;
      files.push({ ...updated, profile_id: profileId });
    }
    return Response.json({ files, folders: [] });
  }
  throw new Error(`Unexpected fixture request: ${method} ${url}`);
}

function props({ profileId = PROFILE_A, dataRevision, onUploadFiles = true, canWrite = true } = {}) {
  return {
    profileId, courses: [course], assignments: [],
    store: { files: state.files, url: (file) => `/api/files?id=${file.id}&account=${profileId}` },
    layout: "list", onLayoutChange() {}, onUpload() {}, onOpen() {}, onEdit() {}, canWrite,
    onUploadFiles: onUploadFiles ? (files, folderId, courseId) => callbacks.uploads.push({ files, folderId, courseId }) : undefined,
    onOrganizationSaved: async () => {},
    onOrganizationStateChange: (report) => callbacks.reports.push(report),
    onTrashCompleted: (receipt) => callbacks.trashCompleted.push(receipt),
    dataRevision,
  };
}

async function render(componentProps = props()) {
  await act(async () => root.render(createElement(FilesBrowser, componentProps)));
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
  const found = [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

async function click(label, container = rootNode) {
  const found = button(label, container);
  await act(async () => found.click());
  return found;
}

async function selectItem(name) {
  const checkbox = [...rootNode.querySelectorAll('input[type="checkbox"]')].find((input) => input.getAttribute("aria-label")?.startsWith(`Select ${name} in `));
  assert.ok(checkbox, `Missing selection checkbox for ${name}`);
  await act(async () => checkbox.click());
}

async function setValue(control, value) {
  await act(async () => {
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function transfer({ files = [], directory = false } = {}) {
  const items = directory ? [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }] : [];
  return { files, items, types: ["Files"], dropEffect: "", getData: () => "" };
}

function dropEvent(dataTransfer) {
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

test("zero selection hides the bulk toolbar while location actions expose Select visible", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  assert.equal(rootNode.querySelector('[role="group"][aria-label="Bulk file actions"]'), null, "no bulk toolbar renders before a selection");

  await click("Actions for My files");
  assert.ok(rootNode.querySelector('[role="menu"]'), "the current location actions menu opens");
  assert.ok([...rootNode.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.trim() === "Select visible"));
  await click("Select visible");
  assert.ok(rootNode.querySelector('[role="group"][aria-label="Bulk file actions"]'), "selecting visible items opens the bulk toolbar");
  assert.match(rootNode.textContent, /items selected/);
  await click("Clear selection");
  assert.equal(rootNode.querySelector('[role="group"][aria-label="Bulk file actions"]'), null, "clearing selection hides the zero-selection toolbar");
});

test("bulk download accepts managed course folders, sends scoped revisions, and downloads only a complete ZIP", async () => {
  reset();
  await render(props({ dataRevision: 1 }));
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("BIO 201");
  await selectItem("Root notes.txt");
  assert.equal(button("Move to…").disabled, true, "managed course roots block moving the whole selection");
  assert.equal(button("Move to Trash").disabled, true, "managed course roots block trashing the whole selection");
  assert.equal(button("Download ZIP").disabled, false, "managed course roots remain downloadable");

  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloaded = [];
  URL.createObjectURL = (blob) => { downloaded.push({ size: blob.size, type: blob.type }); return "blob:selected.zip"; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function clickAnchor() { downloaded.push({ href: this.href, name: this.download }); };
  try {
    await click("Download ZIP");
    await waitUntil(() => requests.some((request) => request.url === "/api/files/download"), "the selected ZIP request");
    const request = requests.find((entry) => entry.url === "/api/files/download");
    assert.equal(request.method, "POST");
    assert.equal(request.profileId, PROFILE_A);
    assert.deepEqual(request.body.items, [
      { type: "folder", id: COURSE_ROOT, revision: 1 },
      { type: "file", id: FILE_ROOT, revision: 1 },
    ]);
    await waitUntil(() => downloaded.some((entry) => entry.name === "eduessentials-selected-files.zip"), "the complete archive download");
    assert.deepEqual(downloaded[0], { size: 22, type: "application/zip" });
    assert.ok(callbacks.reports.some((report) => report?.busy === true && report.draft?.kind === "files-download"));
    assert.ok(callbacks.reports.some((report) => report === null), "completed downloads release the root account-action guard");
    assert.equal(rootNode.querySelector('[role="group"][aria-label="Bulk file actions"]'), null, "the zero-selection toolbar is hidden when a completed download clears selection");
  } finally {
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
  }
});

test("download failure retains the exact selection for retry and blocks account actions until resolved", async () => {
  reset();
  failDownload = true;
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("Root notes.txt");
  await click("Download ZIP");
  await waitUntil(() => rootNode.querySelector(".files-download-error"), "the retained ZIP error");
  assert.match(rootNode.querySelector(".files-download-error").textContent, /ZIP service unavailable/);
  const failedRequest = requests.find((request) => request.url === "/api/files/download");
  assert.deepEqual(failedRequest.body.items, [{ type: "file", id: FILE_ROOT, revision: 1 }]);
  assert.ok(callbacks.reports.some((report) => report?.dirty === true && report.draft?.kind === "files-download"));
  assert.match(rootNode.textContent, /1 item selected/);

  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    await click("Retry download");
    await waitUntil(() => requests.filter((request) => request.url === "/api/files/download").length === 2, "the exact ZIP retry");
    assert.deepEqual(requests.filter((request) => request.url === "/api/files/download").map((request) => request.body.items), [failedRequest.body.items, failedRequest.body.items]);
    await waitUntil(() => !rootNode.querySelector(".files-download-error"), "successful download recovery");
    assert.ok(callbacks.reports.at(-1) === null);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
  }
});

test("a failed download stays recoverable in empty and unavailable views, with an always-available Dismiss action", async () => {
  reset();
  failDownload = true;
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the active file list");
  await selectItem("Root notes.txt");
  await click("Download ZIP");
  await waitUntil(() => rootNode.querySelector(".files-download-error"), "the failed ZIP recovery state");

  await click("Archives");
  await waitUntil(() => rootNode.textContent.includes("No archived files"), "the empty Archives view");
  assert.ok(button("Retry download"), "the captured ZIP recovery remains available outside the selection view");
  assert.ok(button("Dismiss"), "the user can release the account-action guard from an empty view");

  await act(async () => {
    window.history.replaceState({}, "", "/files?view=my-files&folder=ffffffff-ffff-4fff-8fff-ffffffffffff&layout=list");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitUntil(() => rootNode.textContent.includes("This folder is unavailable"), "the unavailable folder view");
  assert.ok(button("Dismiss"), "the recovery can still be dismissed when the current folder is unavailable");
  await click("Dismiss");
  assert.equal(rootNode.querySelector(".files-download-error"), null);
  assert.equal(callbacks.reports.at(-1), null, "Dismiss releases the root account-action guard");
});

test("a ZIP response without its complete archive footer never starts a partial download", async () => {
  reset();
  invalidZip = true;
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("Root notes.txt");
  const oldCreate = URL.createObjectURL;
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  let createdUrls = 0;
  let clickedAnchors = 0;
  URL.createObjectURL = () => { createdUrls += 1; return "blob:partial.zip"; };
  dom.window.HTMLAnchorElement.prototype.click = () => { clickedAnchors += 1; };
  try {
    await click("Download ZIP");
    await waitUntil(() => rootNode.querySelector(".files-download-error"), "the incomplete archive warning");
    assert.match(rootNode.textContent, /archive footer arrived/);
    assert.equal(createdUrls, 0);
    assert.equal(clickedAnchors, 0);
    assert.match(rootNode.textContent, /1 item selected/);
  } finally {
    URL.createObjectURL = oldCreate;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
  }
});

test("a selected revision stays captured after refresh until the user clears and reselects it", async () => {
  reset();
  await render(props({ dataRevision: 0 }));
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("Root notes.txt");
  state.files = state.files.map((file) => file.id === FILE_ROOT ? { ...file, metadata_revision: 2 } : file);
  await render(props({ dataRevision: 1 }));
  await waitUntil(() => rootNode.textContent.includes("changed after you selected it"), "the refreshed stale-selection warning");
  assert.equal(button("Download ZIP").disabled, true, "refresh does not silently replace a selected revision");
  assert.match(rootNode.textContent, /1 item selected/);

  await click("Clear selection");
  await selectItem("Root notes.txt");
  assert.equal(button("Download ZIP").disabled, false, "explicit reselection captures the current revision");
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  try {
    await click("Download ZIP");
    await waitUntil(() => requests.some((request) => request.url === "/api/files/download"), "the reselected ZIP request");
    assert.deepEqual(requests.find((request) => request.url === "/api/files/download").body.items, [{ type: "file", id: FILE_ROOT, revision: 2 }]);
  } finally {
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
  }
});

test("external drops over a child row upload into the captured current folder; directory and invalid drops are rejected", async () => {
  reset();
  await render(props());
  await waitUntil(() => rootNode.textContent.includes("BIO 201"), "the root folder list");
  await click("Open folder: BIO 201");
  await waitUntil(() => rootNode.textContent.includes("Labs"), "the course folder contents");
  const childRow = [...rootNode.querySelectorAll(".files-item")].find((item) => item.querySelector(".files-item-title strong")?.textContent === "Labs");
  assert.ok(childRow, "the child folder row is visible");
  const file = new File(["new upload"], "lecture.txt", { type: "text/plain" });
  const externalDrop = dropEvent(transfer({ files: [file] }));
  await act(async () => childRow.dispatchEvent(externalDrop));
  assert.equal(externalDrop.defaultPrevented, true, "the browser does not navigate to the dropped file");
  assert.deepEqual(callbacks.uploads.map((upload) => ({ folderId: upload.folderId, courseId: upload.courseId, names: upload.files.map((item) => item.name) })), [
    { folderId: COURSE_ROOT, courseId: "biology", names: ["lecture.txt"] },
  ], "dropping over a child row uses the active folder and inherited course");

  const directoryDrop = dropEvent(transfer({ files: [file], directory: true }));
  await act(async () => rootNode.querySelector(".files-browser-content").dispatchEvent(directoryDrop));
  assert.equal(directoryDrop.defaultPrevented, true);
  assert.match(rootNode.textContent, /Choose Upload folder from New to add a folder/);
  assert.equal(callbacks.uploads.length, 1, "directory drops never enqueue a partial file set");

  await act(async () => button("Archives").click());
  const invalidDrop = dropEvent(transfer({ files: [file] }));
  await act(async () => rootNode.querySelector(".files-browser-content").dispatchEvent(invalidDrop));
  assert.equal(invalidDrop.defaultPrevented, true, "invalid external drops cannot open in the browser");
  assert.match(rootNode.textContent, /Drop files into an active folder in My files/);
  assert.equal(callbacks.uploads.length, 1);
});

test("a bulk Trash confirmation names all selected files and retries one atomic array request", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("Root notes.txt");
  await selectItem("Reading list.txt");
  await click("Move to Trash");
  const dialog = rootNode.querySelector(".files-trash-dialog");
  assert.ok(dialog);
  assert.match(dialog.textContent, /Move 2 items/);
  assert.match(dialog.textContent, /Root notes\.txt/);
  assert.match(dialog.textContent, /Reading list\.txt/);
  await click("Move to Trash", dialog);
  await waitUntil(() => requests.some((request) => request.url === "/api/files/actions"), "the atomic Trash action");
  const trashRequest = requests.find((request) => request.url === "/api/files/actions");
  assert.deepEqual(trashRequest.body.items, [
    { type: "file", id: FILE_ROOT, revision: 1 },
    { type: "file", id: FILE_OTHER, revision: 1 },
  ]);
  await waitUntil(() => !rootNode.querySelector(".files-trash-dialog"), "the completed bulk Trash action");
  assert.equal(callbacks.trashCompleted.length, 1);
});

test("all-files search counts a selected folder and its selected descendant only once in Trash confirmation", async () => {
  reset();
  state.folders.push(makeFolder(OVERLAP_FOLDER, "Overlap folder"));
  state.files.push(makeFile(OVERLAP_FILE, "Overlap child.txt", OVERLAP_FOLDER));
  await render();
  await waitUntil(() => rootNode.textContent.includes("Overlap folder"), "the active file list");
  await setValue(rootNode.querySelector('[aria-label="Search files"]'), "Overlap");
  await setValue(rootNode.querySelector('[aria-label="Search scope"]'), "all");
  await waitUntil(() => rootNode.textContent.includes("Overlap child.txt"), "the all-files search result");
  await selectItem("Overlap folder");
  await selectItem("Overlap child.txt");
  await click("Move to Trash");

  const dialog = rootNode.querySelector(".files-trash-dialog");
  assert.ok(dialog);
  assert.match(dialog.textContent, /Move 2 items \(2 items including folder contents\) to Trash\?/);
  assert.match(dialog.textContent, /2 items total, including folder contents/);
  assert.equal(requests.some((request) => request.url === "/api/files/actions"), false, "the deduplicated count still waits for confirmation");
});

test("bulk Restore names every selected root, counts covered descendants once, and retries only refresh after canonical acknowledgement", async () => {
  reset("/files?view=trash&layout=list");
  state.folders.push(makeFolder(BULK_TRASH_ROOT, "Restorable folder", null, {
    trashed_at: NOW, trash_operation_id: BULK_TRASH_OP,
  }));
  state.folders.push(makeFolder(BULK_TRASH_CHILD, "Covered folder", null, {
    trashed_at: NOW, trash_operation_id: BULK_TRASH_OP, original_parent_id: BULK_TRASH_ROOT,
  }));
  state.files.push(makeFile(BULK_TRASH_DESCENDANT, "Covered descendant.txt", null, {
    trashed_at: NOW, trash_operation_id: BULK_TRASH_OP, original_folder_id: BULK_TRASH_CHILD,
  }));
  state.files.push(makeFile(BULK_TRASH_INDEPENDENT, "Independent child.txt", null, {
    trashed_at: NOW, trash_operation_id: INDEPENDENT_TRASH_OP, original_folder_id: null,
  }));
  await render();
  await waitUntil(() => rootNode.textContent.includes("Restorable folder") && rootNode.textContent.includes("Independent child.txt"), "the Trash root rows");
  await selectItem("Restorable folder");
  await selectItem("Independent child.txt");
  await click("Restore");

  const dialog = rootNode.querySelector(".files-trash-dialog");
  assert.ok(dialog);
  assert.match(dialog.textContent, /Restore 2 items \(4 items including folder contents\)/);
  assert.match(dialog.textContent, /Restorable folder/);
  assert.match(dialog.textContent, /Independent child\.txt/);
  getFailures.push({ url: "/api/files?view=trash", profileId: PROFILE_A, status: 503, message: "Refresh temporarily unavailable." });
  await click("Restore", dialog);
  await waitUntil(() => dialog.querySelector('[role="alert"]')?.textContent.includes("Files refresh did not finish"), "the failed post-Restore refresh");

  const restoreRequests = requests.filter((request) => request.url === "/api/files/actions");
  assert.equal(restoreRequests.length, 1, "the server mutation is sent once");
  assert.equal(restoreRequests[0].body.action, "restore");
  assert.deepEqual(restoreRequests[0].body.items, [
    { type: "folder", id: BULK_TRASH_ROOT, revision: 1 },
    { type: "file", id: BULK_TRASH_INDEPENDENT, revision: 1 },
  ]);
  assert.equal(state.folders.find((folder) => folder.id === BULK_TRASH_ROOT).trashed_at, null);
  assert.equal(state.folders.find((folder) => folder.id === BULK_TRASH_CHILD).trashed_at, null, "canonical acknowledgement includes same-operation covered descendants");
  assert.equal(state.files.find((file) => file.id === BULK_TRASH_DESCENDANT).trashed_at, null);
  assert.equal(state.files.find((file) => file.id === BULK_TRASH_INDEPENDENT).trashed_at, null, "the independent selected item is restored separately");

  await click("Retry Files refresh", dialog);
  await waitUntil(() => !rootNode.querySelector(".files-trash-dialog"), "refresh-only Restore recovery");
  assert.equal(requests.filter((request) => request.url === "/api/files/actions").length, 1, "acknowledged Restore is never reposted");
  assert.equal(requests.filter((request) => request.method === "GET" && request.url === "/api/files?view=trash").length, 3,
    "initial load, failed refresh, and retry each read the Trash snapshot");
});

test("Escape from the bulk Move dialog focuses the current replacement toolbar trigger", async () => {
  reset();
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the active file list");
  await selectItem("Root notes.txt");
  const originalTrigger = button("Move to…");
  await act(async () => originalTrigger.click());
  const moveDialog = rootNode.querySelector('[role="dialog"]');
  assert.ok(moveDialog, "the selected file opens the bulk Move dialog");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await waitUntil(() => !rootNode.querySelector('[role="dialog"]'), "the closed bulk Move dialog");

  const replacementTrigger = button("Move to…");
  assert.notEqual(replacementTrigger, originalTrigger, "the selection toolbar remounts after the dialog closes");
  assert.equal(originalTrigger.isConnected, false, "the captured trigger belongs to the unmounted toolbar");
  assert.equal(replacementTrigger.isConnected, true);
  assert.equal(replacementTrigger.disabled, false, "the replacement trigger is eligible for focus");
  await waitUntil(() => document.activeElement === replacementTrigger, "focus on the replacement Move trigger");
});

test("an A-B-A account change aborts a late ZIP response before it can create a download", async () => {
  reset();
  let release;
  holdDownload = { promise: new Promise((resolve) => { release = resolve; }) };
  await render();
  await waitUntil(() => rootNode.textContent.includes("Root notes.txt"), "the root file list");
  await selectItem("Root notes.txt");
  const oldCreate = URL.createObjectURL;
  const oldClick = dom.window.HTMLAnchorElement.prototype.click;
  let createdUrls = 0;
  let clickedAnchors = 0;
  URL.createObjectURL = () => { createdUrls += 1; return "blob:late.zip"; };
  dom.window.HTMLAnchorElement.prototype.click = () => { clickedAnchors += 1; };
  try {
    await click("Download ZIP");
    await waitUntil(() => requests.some((request) => request.url === "/api/files/download"), "the pending ZIP request");
    assert.match(rootNode.querySelector('.files-download-status')?.textContent ?? "", /Preparing your ZIP download/,
      "download progress stays visible while the request is pending");
    await render(props({ profileId: PROFILE_B }));
    await render(props({ profileId: PROFILE_A }));
    release();
    await waitUntil(() => rootNode.querySelector(".files-download-error"), "the previous-account recovery notice");
    assert.equal(createdUrls, 0, "a completed late response cannot create an object URL");
    assert.equal(clickedAnchors, 0, "a completed late response cannot trigger a download");
    assert.equal(button("Retry download").disabled, true, "A-B-A cannot replay a prior session request");
    assert.match(rootNode.textContent, /previous account/);
  } finally {
    release();
    URL.createObjectURL = oldCreate;
    dom.window.HTMLAnchorElement.prototype.click = oldClick;
  }
});
