import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/files?view=my-files&layout=list", pretendToBeVisual: true });
for (const name of [
  "window", "document", "Element", "Node", "HTMLElement", "HTMLFormElement", "HTMLButtonElement",
  "HTMLAnchorElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent",
  "KeyboardEvent", "Event", "FormData", "MutationObserver",
]) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id) => clearTimeout(id) });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.scrollTo = () => {};
dom.window.confirm = () => true;

const [{ createElement, act }, { createRoot }, { default: FilesBrowser }] = await Promise.all([
  import("react"), import("react-dom/client"), import(await clientModule("app/files-browser.tsx")),
]);

const PROFILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COURSE_ROOT = "11111111-1111-4111-8111-111111111111";
const PERSONAL_ROOT = "22222222-2222-4222-8222-222222222222";
const PERSONAL_CHILD = "33333333-3333-4333-8333-333333333333";
const ARCHIVE_ROOT = "44444444-4444-4444-8444-444444444444";
const ARCHIVE_CHILD = "55555555-5555-4555-8555-555555555555";
const ROOT_FILE = "aaaaaaaa-1111-4111-8111-111111111111";
const DEEP_FILE = "bbbbbbbb-1111-4111-8111-111111111111";
const OTHER_FILE = "cccccccc-1111-4111-8111-111111111111";
const ARCHIVE_FILE = "dddddddd-1111-4111-8111-111111111111";
const ARCHIVE_CHILD_FILE = "eeeeeeee-1111-4111-8111-111111111111";
const NOW = "2026-10-08T12:00:00.000Z";
const LATER = "2026-10-08T13:00:00.000Z";
const course = { id: "biology", code: "BIO 201", name: "Biology", credits: 4, instructor: "Dr. Moss", room: "Science 2", color: "#b23b53", soft: "#b23b5318", initials: "BIO" };

function makeFolder(id, name, parent_id = null, overrides = {}) {
  return {
    id, name, parent_id, kind: "custom", course_id: null, course_code: null, revision: 1,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: NOW, archived_at: null,
    semester_label: null, course_name_snapshot: null, course_color_snapshot: null,
    trashed_at: null, trash_operation_id: null, original_parent_id: null, ...overrides,
  };
}

function makeFile(id, name, folder_id = null, overrides = {}) {
  return {
    id, name, mime_type: "text/plain", size_bytes: 128, course_id: null, assignment_id: null,
    kind: "resource", state: "ready", created_at: "2026-10-01T00:00:00.000Z", updated_at: NOW,
    content_sha256: null, folder_id, content_backend: "object", metadata_revision: 7,
    content_revision: 11, trashed_at: null, trash_operation_id: null, original_folder_id: null,
    ...overrides,
  };
}

function initialState() {
  const files = [
    makeFile(ROOT_FILE, "Needle root.txt"),
    makeFile(DEEP_FILE, "Needle deep.txt", PERSONAL_CHILD),
    makeFile(OTHER_FILE, "Other notes.txt", PERSONAL_CHILD),
    makeFile(ARCHIVE_FILE, "Needle archived.txt", ARCHIVE_ROOT),
    makeFile(ARCHIVE_CHILD_FILE, "Archived child.txt", ARCHIVE_CHILD),
  ];
  return {
    files,
    folders: [
      makeFolder(COURSE_ROOT, "BIO 201", null, { kind: "course", course_id: "biology", course_code: "BIO 201" }),
      makeFolder(PERSONAL_ROOT, "Class notes"),
      makeFolder(PERSONAL_CHILD, "Research", PERSONAL_ROOT),
      makeFolder(ARCHIVE_ROOT, "Spring archive", null, { archived_at: "2026-09-01T00:00:00.000Z", semester_label: "Spring 2026" }),
      makeFolder(ARCHIVE_CHILD, "Archived subfolder", ARCHIVE_ROOT),
    ],
    fileActivity: new Map(files.map((item) => [item.id, { starred_at: null, last_opened_at: null }])),
  };
}

const rootNode = document.getElementById("root");
let root;
let state;
let requests;
let actions;
let failNextStar;
let failArchiveRefreshAfterAction;
let holdNextArchive;

globalThis.fetch = (...args) => fetchFixture(...args);

function reset(path = "/files?view=my-files&layout=list") {
  window.history.replaceState({}, "", path);
  rootNode.innerHTML = "";
  root = createRoot(rootNode);
  state = initialState();
  requests = [];
  actions = [];
  failNextStar = false;
  failArchiveRefreshAfterAction = false;
  holdNextArchive = null;
}

function activityPayload(id) {
  const saved = state.fileActivity.get(id) ?? { starred_at: null, last_opened_at: null };
  return { file_id: id, starred_at: saved.starred_at, last_opened_at: saved.last_opened_at };
}

async function fetchFixture(input, init = {}) {
  const url = String(input);
  const method = init.method ?? "GET";
  const profileId = new Headers(init.headers).get("x-profile-id") ?? "";
  const request = { url, method, profileId, init, body: init.body ? JSON.parse(init.body) : null };
  requests.push(request);

  if (method === "GET") {
    if (failArchiveRefreshAfterAction && requests.some(({ method: sentMethod }) => sentMethod !== "GET") && url === "/api/file-folders?view=archives") {
      failArchiveRefreshAfterAction = false;
      return Response.json({ error: "Archive refresh unavailable" }, { status: 503 });
    }
    if (url === "/api/files?view=active") return Response.json({
      files: state.files.filter((file) => !file.trashed_at),
      activities: { files: state.files.filter((file) => !file.trashed_at).map((file) => activityPayload(file.id)) },
    });
    if (url === "/api/files?view=trash") return Response.json({ files: [], activities: { files: [] } });
    if (url === "/api/file-folders?view=active") return Response.json({
      folders: state.folders.filter((folder) => !folder.archived_at && !folder.trashed_at), activities: { folders: [] },
    });
    if (url === "/api/file-folders?view=archives") return Response.json({
      folders: state.folders.filter((folder) => folder.archived_at && !folder.trashed_at), activities: { folders: [] },
    });
    if (url === "/api/file-folders?view=trash") return Response.json({ folders: [], activities: { folders: [] } });
    throw new Error(`Unexpected GET fixture request: ${url}`);
  }

  if (method === "POST" && url === "/api/files/actions") {
    actions.push(request);
    const { action, items } = request.body;
    const selected = items[0];
    if (failNextStar && (action === "star" || action === "unstar")) {
      failNextStar = false;
      return Response.json({ error: "Star service is temporarily unavailable" }, { status: 503 });
    }
    if (selected.type !== "file") throw new Error(`Unexpected activity item type: ${selected.type}`);
    state.fileActivity.set(selected.id, {
      starred_at: action === "star" ? LATER : null,
      last_opened_at: state.fileActivity.get(selected.id)?.last_opened_at ?? null,
    });
    const savedFile = state.files.find((file) => file.id === selected.id);
    return Response.json({ activities: { files: [activityPayload(selected.id)], folders: [] }, files: [{ ...savedFile }] });
  }

  if (method === "PUT" && url === "/api/file-folders") {
    const { action, id } = request.body;
    const index = state.folders.findIndex((folder) => folder.id === id);
    if (index < 0) return Response.json({ error: "Folder not found" }, { status: 404 });
    const source = state.folders[index];
    if (holdNextArchive) {
      const held = holdNextArchive;
      holdNextArchive = null;
      held.request = request;
      return await held.promise;
    }
    const saved = action === "archive"
      ? { ...source, archived_at: LATER, semester_label: request.body.semesterLabel, revision: source.revision + 1 }
      : { ...source, archived_at: null, semester_label: null, revision: source.revision + 1 };
    state.folders[index] = saved;
    return Response.json({ folder: { ...saved, profile_id: profileId } });
  }

  throw new Error(`Unexpected request: ${method} ${url}`);
}

function props({ profileId = PROFILE_A, currentTerm = "Fall 2026", canWrite = true, preferences, onPreferencesChange, onUpload, onNewTextFile } = {}) {
  return {
    profileId,
    courses: [course],
    store: { files: state.files, busy: false, url: (item) => `/api/files?id=${item.id}` },
    layout: "list", onLayoutChange() {}, onUpload: onUpload ?? (() => {}), onOpen() {}, onEdit() {}, canWrite,
    currentTerm, preferences, onPreferencesChange, onNewTextFile,
  };
}

async function render(profileProps = props()) {
  await act(async () => root.render(createElement(FilesBrowser, profileProps)));
}

async function unmount() {
  if (!root) return;
  await act(async () => root.unmount());
  root = undefined;
  rootNode.innerHTML = "";
}

async function waitUntil(predicate, description, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.ok(predicate(), `Timed out waiting for ${description}; UI: ${rootNode.textContent}; requests: ${requests.map(({ method, url }) => `${method} ${url}`).join(" | ")}`);
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

function select(label) {
  const found = [...rootNode.querySelectorAll("select")].find((item) => item.getAttribute("aria-label") === label);
  assert.ok(found, `Missing select ${label}`);
  return found;
}

async function setValue(control, value) {
  await act(async () => {
    const prototype = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

function rowNames() {
  return [...rootNode.querySelectorAll(".files-item .files-item-title strong")].map((item) => item.textContent);
}

async function openMenu(name) {
  await act(async () => button(`More options for ${name}`).click());
  await waitUntil(() => !!rootNode.querySelector('[role="menu"]'), `${name} menu`);
}

async function openDialogForRootFolder(name, menuAction) {
  await openMenu(name);
  await click(menuAction);
  await waitUntil(() => !!rootNode.querySelector(".file-archive-dialog"), "the archive dialog");
  return rootNode.querySelector(".file-archive-dialog");
}

const menuLabels = () => [...rootNode.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim());

afterEach(async () => { await unmount(); });
after(() => dom.window.close());

test("Files Browser searches current folder or all names, persists only preferences, and clears search when opening a result location", async () => {
  reset();
  const preferenceChanges = [];
  await render(props({ onPreferencesChange: (next) => preferenceChanges.push(next) }));
  await waitUntil(() => rowNames().includes("Needle root.txt"), "the root files");

  const search = rootNode.querySelector('[aria-label="Search files"]');
  const beforeSearch = preferenceChanges.length;
  await setValue(search, "Needle");
  assert.deepEqual(rowNames(), ["Needle root.txt"], "folder scope searches this folder by name");
  assert.equal(preferenceChanges.length, beforeSearch, "search text is transient");

  await setValue(select("Search scope"), "all");
  assert.deepEqual(rowNames(), ["Needle deep.txt", "Needle root.txt"], "all-scope search spans folders but excludes archives by default");
  assert.equal(preferenceChanges.length, beforeSearch, "search scope is transient too");
  assert.equal(rootNode.querySelector(".files-content-heading h2").textContent, "All active files");

  await setValue(select("Course filter"), "personal");
  await setValue(select("File type"), "text");
  await setValue(select("Sort by"), "modified");
  await click("Sort ascending");
  const includeArchived = rootNode.querySelector('[aria-label="Include archived"]');
  await act(async () => includeArchived.click());
  await waitUntil(() => rowNames().includes("Needle archived.txt"), "the archived name result");
  assert.ok(preferenceChanges.length >= 5);
  for (const saved of preferenceChanges) {
    assert.ok(!Object.hasOwn(saved, "query"), "the preferences callback never receives search text");
    assert.ok(!Object.hasOwn(saved, "searchScope"), "the preferences callback never receives search scope");
  }
  assert.equal(preferenceChanges.at(-1).includeArchived, true);
  assert.equal(preferenceChanges.at(-1).filter, "personal");
  assert.equal(preferenceChanges.at(-1).fileType, "text");
  assert.equal(preferenceChanges.at(-1).sortBy, "modified");
  assert.equal(preferenceChanges.at(-1).sortDirection, "desc");

  await openMenu("Needle deep.txt");
  assert.ok(menuLabels().includes("Open containing folder"));
  await click("Open containing folder");
  await waitUntil(() => new URL(window.location.href).searchParams.get("folder") === PERSONAL_CHILD, "the result folder ID in the URL");
  await waitUntil(() => search.value === "", "search to clear after opening the result location");
  assert.deepEqual(rowNames(), ["Needle deep.txt", "Other notes.txt"], "the selected containing folder shows its actual direct children");
});

test("a direct My files route into an archived descendant stays read-only even when archived items are included", async () => {
  reset("/files?view=my-files&folder=" + ARCHIVE_CHILD + "&layout=list");
  const uploads = [];
  const newFiles = [];
  await render(props({
    preferences: { filter: "all", view: "list", includeArchived: true },
    onUpload: (...args) => uploads.push(args),
    onNewTextFile: (...args) => newFiles.push(args),
  }));
  await waitUntil(() => rowNames().includes("Archived child.txt"), "the archived descendant contents on its direct My files URL");

  const newButton = button("New");
  assert.equal(newButton.disabled, true, "including archived results cannot turn an archived descendant into a writable location");
  assert.match(newButton.title, /Upload files from My files/);
  assert.equal(rootNode.querySelector(".files-content-heading h2").textContent, "Archived subfolder");
  assert.deepEqual(uploads, []);
  assert.deepEqual(newFiles, []);
});

test("Star retry keeps the captured item; a refresh retry performs GETs only, then unstar is acknowledged", async () => {
  reset();
  failNextStar = true;
  await render();
  await waitUntil(() => rowNames().includes("Needle root.txt"), "the initial file rows");
  const initialGets = requests.filter(({ method }) => method === "GET").length;
  await openMenu("Needle root.txt");
  assert.ok(menuLabels().includes("Add to Starred"));
  await click("Add to Starred");
  await waitUntil(() => !!rootNode.querySelector('[role="alert"]')?.textContent.includes("Star service is temporarily unavailable"), "the failed star request");
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].body, { action: "star", items: [{ type: "file", id: ROOT_FILE, revision: 7 }] });
  assert.equal(requests.filter(({ method }) => method === "GET").length, initialGets, "a failed mutation does not refresh file state");
  assert.ok(button("Retry Starred change"));

  failArchiveRefreshAfterAction = true;
  await click("Retry Starred change");
  await waitUntil(() => !!button("Retry refresh"), "the committed star refresh failure");
  assert.match(rootNode.querySelector('[role="alert"]')?.textContent ?? "", /Archive refresh unavailable/);
  assert.equal(actions.length, 2, "the explicit failed write retries the captured star action once");
  assert.equal(actions[1].body.items[0].id, ROOT_FILE);
  assert.equal(actions[1].body.items[0].revision, 7);
  assert.ok(button("Retry refresh"));
  const getsBeforeRefreshRetry = requests.filter(({ method }) => method === "GET").length;

  await click("Retry refresh");
  await waitUntil(() => !rootNode.querySelector('[role="alert"]'), "the GET-only star refresh retry");
  assert.equal(actions.length, 2, "the acknowledged star action is not replayed during refresh retry");
  assert.equal(requests.filter(({ method }) => method === "GET").length, getsBeforeRefreshRetry + 5);
  assert.ok(requests.every(({ url }) => !url.includes("/api/workspace")), "star changes do not write academic workspace data");

  await click("Starred", rootNode);
  await waitUntil(() => rowNames().includes("Needle root.txt"), "the acknowledged Starred row");
  await openMenu("Needle root.txt");
  assert.ok(menuLabels().includes("Remove from Starred"));
  await click("Remove from Starred");
  await waitUntil(() => rootNode.textContent.includes("No starred files"), "the unstarred empty Starred view");
  assert.deepEqual(actions.map(({ body }) => body.action), ["star", "star", "unstar"]);
  assert.ok(actions.every(({ body }) => body.items[0].revision === 7), "star and unstar use the same unchanged metadata revision");
  assert.ok(requests.every(({ url }) => !url.includes("/api/workspace")));
});

test("Archive dialog captures the editable term label, downloads its draft, and retries refresh without replaying archive", async () => {
  reset();
  await render();
  await waitUntil(() => rowNames().includes("Needle root.txt"), "the initial rows");

  await openMenu("Class notes");
  assert.ok(menuLabels().includes("Archive folder…"), "a top-level custom folder can be archived");
  await click("Open folder");
  await openMenu("Research");
  assert.ok(!menuLabels().includes("Archive folder…"), "a child folder cannot be archived as a root");
  await click("My files");

  const dialog = await openDialogForRootFolder("Class notes", "Archive folder…");
  const label = dialog.querySelector('[aria-label="Semester label"]');
  assert.equal(label.value, "Fall 2026", "the current term is the initial semester label");
  await setValue(label, "Winter 2027");

  const nativeCreateObjectURL = URL.createObjectURL;
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  let capturedBlob;
  const downloads = [];
  URL.createObjectURL = (blob) => { capturedBlob = blob; return "blob:archive-draft"; };
  HTMLAnchorElement.prototype.click = function clickDownload() { downloads.push({ href: this.href, name: this.download }); };
  try {
    await click("Download draft", dialog);
    assert.deepEqual(downloads, [{ href: "blob:archive-draft", name: "eduessentials-file-archive-draft.json" }]);
    const draft = JSON.parse(await capturedBlob.text());
    assert.deepEqual(draft, {
      capturedProfileId: PROFILE_A,
      action: "archive",
      folder: { id: PERSONAL_ROOT, name: "Class notes", revision: 1, parentId: null, kind: "custom" },
      semesterLabel: "Winter 2027",
      committed: false,
    });
  } finally {
    URL.createObjectURL = nativeCreateObjectURL;
    HTMLAnchorElement.prototype.click = nativeAnchorClick;
  }

  failArchiveRefreshAfterAction = true;
  await click("Archive folder", dialog);
  await waitUntil(() => !!dialog.querySelector('[role="status"]')?.textContent.includes("change was saved"), "the server archive acknowledgement");
  await waitUntil(() => !!button("Retry refresh", dialog), "the archive refresh retry control");
  const archiveMutation = requests.find(({ method, body }) => method === "PUT" && body?.action === "archive");
  assert.deepEqual(archiveMutation.body, { action: "archive", id: PERSONAL_ROOT, revision: 1, semesterLabel: "Winter 2027" });
  assert.equal(label.value, "Winter 2027", "a saved archive keeps its captured label for refresh retry");
  assert.equal(actions.length, 0);
  assert.ok(requests.every(({ url }) => !url.includes("/api/workspace")), "archiving does not mutate academic workspace records");
  const getsBeforeRetry = requests.filter(({ method }) => method === "GET").length;

  await click("Retry refresh", dialog);
  await waitUntil(() => !rootNode.querySelector(".file-archive-dialog"), "the archive refresh retry to close the dialog");
  assert.equal(requests.filter(({ method }) => method === "PUT" && method !== "GET").length, 1, "the archive mutation ran once");
  assert.equal(requests.filter(({ method }) => method === "GET").length, getsBeforeRetry + 5, "retry performs only the five file browser reads");
  assert.ok(requests.every(({ url }) => !url.includes("/api/workspace")));

  await click("Archives");
  await waitUntil(() => rowNames().includes("Class notes"), "the archived root folder");
  await openMenu("Class notes");
  assert.ok(menuLabels().includes("Unarchive folder…"), "an archived root exposes unarchive");
  await click("Open folder");
  await openMenu("Research");
  assert.ok(!menuLabels().includes("Unarchive folder…"), "an archived child cannot be unarchived independently");
  await click("Archives");
  await openMenu("Class notes");
  await click("Unarchive folder…");
  const unarchiveDialog = rootNode.querySelector(".file-archive-dialog");
  assert.ok(unarchiveDialog);
  await click("Unarchive folder", unarchiveDialog);
  await waitUntil(() => !rootNode.querySelector(".file-archive-dialog"), "the root unarchive acknowledgement");
  const unarchiveMutation = requests.find(({ method, body }) => method === "PUT" && body?.action === "unarchive");
  assert.deepEqual(unarchiveMutation.body, { action: "unarchive", id: PERSONAL_ROOT, revision: 2 });
  await click("Files");
  await waitUntil(() => rowNames().includes("Class notes"), "the unarchived root in My files");
});

test("an archive acknowledgement held across A to B to A does not locally commit or refresh", async () => {
  reset();
  await render(props({ profileId: PROFILE_A }));
  await waitUntil(() => rowNames().includes("Class notes"), "profile A files");
  const dialog = await openDialogForRootFolder("Class notes", "Archive folder…");
  const pending = {};
  pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
  holdNextArchive = pending;
  await click("Archive folder", dialog);
  await waitUntil(() => !!pending.request, "the held archive request");
  assert.equal(pending.request.profileId, PROFILE_A);
  assert.equal(pending.request.body.revision, 1);

  await render(props({ profileId: PROFILE_B }));
  await waitUntil(() => rootNode.textContent.includes("active account changed"), "the profile B dialog fence");
  await waitUntil(() => requests.filter(({ method, profileId }) => method === "GET" && profileId === PROFILE_B).length >= 5, "profile B reads");
  await render(props({ profileId: PROFILE_A }));
  await waitUntil(() => requests.filter(({ method, profileId }) => method === "GET" && profileId === PROFILE_A).length >= 10, "the return to profile A");
  const getCountBeforeOldAck = requests.filter(({ method }) => method === "GET").length;
  assert.equal(pending.request.init.signal.aborted, true, "the old archive request was aborted at the account boundary");

  pending.resolve(Response.json({ folder: { ...state.folders.find(({ id }) => id === PERSONAL_ROOT), archived_at: LATER, semester_label: "Fall 2026", revision: 2, profile_id: PROFILE_A } }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  assert.ok(rootNode.querySelector(".file-archive-dialog"), "the captured dialog remains open");
  assert.equal(rootNode.textContent.includes("The folder change was saved"), false, "an old acknowledgement cannot set the committed state");
  assert.equal(rootNode.textContent.includes("active account changed"), false, "the current A session no longer shows B's warning");
  assert.equal(requests.filter(({ method }) => method === "GET").length, getCountBeforeOldAck, "the stale acknowledgement triggers no refresh");
  assert.equal(actions.length, 0);
  assert.equal(button("Archive folder", rootNode.querySelector(".file-archive-dialog")).disabled, false, "the uncommitted captured attempt can be retried");
});
