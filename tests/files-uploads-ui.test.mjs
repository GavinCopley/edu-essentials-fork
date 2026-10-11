/* eslint-disable react/prop-types -- Minimal React harness for client-hook and dialog acceptance tests. */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<div id="root"></div>', { url: "https://edu.example/files" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Event", "KeyboardEvent", "MutationObserver"]) {
  globalThis[name] = dom.window[name];
}
Object.defineProperty(globalThis, "File", { configurable: true, value: NodeFile });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id) => clearTimeout(id) });

const [React, ReactDom, { useFileUploads }, { default: FileUploadDialog }, { usePrivateFiles }, { hashBytes }, { uploadFileWithProgress }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/use-file-uploads.ts")),
  import(await clientModule("app/file-upload-dialog.tsx")),
  import(await clientModule("app/use-private-files.ts")),
  import(await clientModule("lib/files.ts")),
  import(await clientModule("lib/file-upload.ts")),
]);

const { createElement, act } = React;
const rootNode = document.getElementById("root");
const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";
const ID_A = "10000000-0000-4000-8000-000000000001";
const ID_B = "10000000-0000-4000-8000-000000000002";
const DEFAULTS = { folderId: null, courseId: "" };
let root;
let queue;
let privateStore;
let pendingFolderSelection;
const nativeFetch = globalThis.fetch;
const NativeXMLHttpRequest = globalThis.XMLHttpRequest;
const nativeConfirm = dom.window.confirm;

function UploadHarness({ session = { profileId: PROFILE_A, generation: 1 }, store, onUploaded = async () => {}, enabled = true, showDialog = false, mode = "files" }) {
  queue = useFileUploads(session, store, onUploaded, enabled);
  return showDialog ? createElement(FileUploadDialog, {
    queue,
    currentProfileId: session.profileId,
    defaults: DEFAULTS,
    mode,
    canWrite: enabled,
    onClose: () => {},
  }) : null;
}

function FolderPlanHarness({ store, initialPlan }) {
  const [folderUpload, setFolderUpload] = React.useState(initialPlan);
  pendingFolderSelection = folderUpload;
  queue = useFileUploads({ profileId: PROFILE_A, generation: 1 }, store, async () => {}, true);
  return createElement(FileUploadDialog, {
    queue,
    currentProfileId: PROFILE_A,
    currentSessionGeneration: 1,
    defaults: DEFAULTS,
    mode: "folder",
    folderUpload,
    onFolderUploadChange: setFolderUpload,
    canWrite: true,
    onClose: () => {},
  });
}

function PrivateStoreHarness({ profileId }) {
  privateStore = usePrivateFiles(profileId);
  return null;
}

async function render(element) {
  if (!root) root = ReactDom.createRoot(rootNode);
  await act(async () => { root.render(element); });
}

async function waitFor(predicate, message = "Timed out waiting for the upload queue.") {
  for (let count = 0; count < 150; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

async function waitForReact(predicate, message) {
  for (let count = 0; count < 150; count++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  assert.fail(message || "Timed out waiting for the upload queue.");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeFile(name, contents = `bytes for ${name}`) {
  return new File([contents], name, { type: "text/plain", lastModified: 1_791_500_000_000 });
}

async function makeAck(file, metadata, id) {
  const sha = await hashBytes(new Uint8Array(await file.arrayBuffer()));
  return {
    id,
    name: metadata.name,
    mime_type: "text/plain",
    size_bytes: file.size,
    course_id: metadata.courseId || null,
    assignment_id: metadata.assignmentId || null,
    kind: metadata.kind,
    state: "ready",
    created_at: "2026-10-09T00:00:00.000Z",
    updated_at: "2026-10-09T00:00:00.000Z",
    content_sha256: sha,
    folder_id: metadata.folderId ?? null,
    content_backend: "object",
    metadata_revision: 1,
    content_revision: 1,
    trashed_at: null,
    trash_operation_id: null,
    original_folder_id: null,
  };
}

function makeStore(upload) { return { upload }; }

function allRowsSettled() {
  return queue?.rows.length > 0 && queue.rows.every((row) => row.status === "complete" || row.status === "error" || row.status === "refresh-error");
}

afterEach(async () => {
  if (root) {
    await act(async () => { root.unmount(); });
    root = null;
  }
  queue = null;
  privateStore = null;
  pendingFolderSelection = undefined;
  rootNode.innerHTML = "";
  globalThis.fetch = nativeFetch;
  globalThis.XMLHttpRequest = NativeXMLHttpRequest;
  dom.window.confirm = nativeConfirm;
});

test("uploads are serial and independent; retry keeps the selected File, metadata, and UUID", async () => {
  const calls = [];
  const refreshes = [];
  let failSecond = true;
  const store = makeStore(async (file, metadata, id, options) => {
    calls.push({ file, metadata, id });
    options.onProgress(file.size, file.size);
    if (file.name === "b.txt" && failSecond) { failSecond = false; throw new Error("connection dropped"); }
    return makeAck(file, metadata, id);
  });
  const selected = [makeFile("a.txt"), makeFile("b.txt"), makeFile("c.txt")];
  await render(createElement(UploadHarness, { store, onUploaded: async (file) => { refreshes.push(file.id); } }));

  await act(async () => { queue.enqueue(selected, DEFAULTS); });
  await waitForReact(allRowsSettled);

  assert.deepEqual(calls.map((call) => call.file.name), ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(queue.rows.map((row) => row.status), ["complete", "error", "complete"]);
  assert.equal(queue.busy, false);
  assert.equal(queue.dirty, true);
  const failed = queue.rows[1];
  assert.match(failed.error, /connection dropped/);
  assert.equal(queue.draft.uploads.length, 1);
  assert.equal(queue.draft.uploads[0].id, failed.id);
  assert.equal(queue.draft.uploads[0].profileId, PROFILE_A);
  assert.equal("bytes" in queue.draft.uploads[0], false);
  assert.doesNotThrow(() => JSON.stringify(queue.draft));

  await act(async () => { await queue.retry(failed.id); });
  assert.deepEqual(queue.rows.map((row) => row.status), ["complete", "complete", "complete"]);
  assert.equal(queue.dirty, false);
  assert.equal(calls[1].id, calls[3].id);
  assert.equal(calls[1].file, calls[3].file);
  assert.equal(calls[1].metadata, calls[3].metadata);
  assert.equal(refreshes.length, 3);
});

test("a failed post-ACK refresh retries only the refresh callback", async () => {
  let uploads = 0;
  let refreshes = 0;
  const store = makeStore(async (file, metadata, id) => { uploads++; return makeAck(file, metadata, id); });
  await render(createElement(UploadHarness, {
    store,
    onUploaded: async () => { refreshes++; if (refreshes === 1) throw new Error("Files list is offline"); },
  }));
  await act(async () => { queue.enqueue([makeFile("refresh.txt")], DEFAULTS); });
  await waitForReact(allRowsSettled);
  const row = queue.rows[0];
  assert.equal(row.status, "refresh-error");
  assert.equal(row.acknowledged, true);
  assert.equal(queue.draft.uploads[0].acknowledged, true);

  await act(async () => { await queue.retry(row.id); });
  assert.equal(queue.rows[0].status, "complete");
  assert.equal(uploads, 1);
  assert.equal(refreshes, 2);
});

test("late A-to-B-to-A response is fenced until explicit retry in the new generation", async () => {
  const held = deferred();
  const calls = [];
  let refreshes = 0;
  const store = makeStore(async (file, metadata, id, options) => {
    calls.push({ file, metadata, id, signal: options.signal });
    if (calls.length === 1) return held.promise;
    return makeAck(file, metadata, id);
  });
  const onUploaded = async () => { refreshes++; };
  await render(createElement(UploadHarness, { store, onUploaded, session: { profileId: PROFILE_A, generation: 1 } }));
  await act(async () => {
    queue.enqueue([makeFile("late.txt")], DEFAULTS);
    await waitFor(() => calls.length === 1);
  });
  const uploadId = queue.rows[0].id;
  await render(createElement(UploadHarness, { store, onUploaded, session: { profileId: PROFILE_B, generation: 2 } }));
  await render(createElement(UploadHarness, { store, onUploaded, session: { profileId: PROFILE_A, generation: 3 } }));
  assert.equal(calls[0].signal.aborted, true);

  await act(async () => { held.resolve(await makeAck(calls[0].file, calls[0].metadata, calls[0].id)); });
  await waitForReact(() => queue.rows[0].status === "error");
  assert.equal(queue.rows[0].acknowledged, false);
  assert.equal(refreshes, 0);
  assert.equal(calls.length, 1);

  await act(async () => { await queue.retry(uploadId); });
  assert.equal(queue.rows[0].status, "complete");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].id, uploadId);
  assert.equal(calls[1].file, calls[0].file);
  assert.equal(refreshes, 1);
});

test("the chooser enqueues multiple files and keeps visible progress below 100% until ACK", async () => {
  const pending = [];
  const calls = [];
  const store = makeStore((file, metadata, id, options) => {
    calls.push({ file, metadata, id });
    options.onProgress(file.size, file.size);
    const task = deferred();
    pending.push({ task, file, metadata, id });
    return task.promise;
  });
  await render(createElement(UploadHarness, { store, showDialog: true }));
  const dialog = document.querySelector('[role="dialog"][aria-labelledby="files-upload-title"]');
  assert.ok(dialog);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.activeElement, dialog.querySelector(".files-upload-choose"), "the chooser receives initial focus");
  const input = [...dialog.querySelectorAll("input[type=file]")].find((element) => element.multiple);
  assert.ok(input);
  const selected = [makeFile("one.txt"), makeFile("two.txt")];
  Object.defineProperty(input, "files", { configurable: true, value: selected });
  await act(async () => {
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await waitFor(() => calls.length === 1);
  });
  assert.equal(queue.rows.length, 2);
  assert.equal(queue.rows[0].status, "uploading");
  assert.equal(queue.rows[1].status, "queued");
  const progress = dialog.querySelector("progress");
  assert.equal(progress.value, 99);
  assert.equal(dialog.querySelectorAll(".files-upload-row").length, 2);
  assert.ok([...dialog.querySelectorAll("button")].some((button) => button.textContent === "Download original"));
  assert.ok([...dialog.querySelectorAll("button")].some((button) => button.textContent === "Download request draft"));

  await act(async () => {
    pending[0].task.resolve(await makeAck(pending[0].file, pending[0].metadata, pending[0].id));
    await waitFor(() => calls.length === 2);
  });
  await act(async () => { pending[1].task.resolve(await makeAck(pending[1].file, pending[1].metadata, pending[1].id)); });
  await waitForReact(allRowsSettled);
  assert.deepEqual(queue.rows.map((row) => row.status), ["complete", "complete"]);
});

test("dismissing a partial folder plan clears the selection and leaves created folders intact", async () => {
  const selectedFile = makeFile("notes.txt");
  const initialPlan = {
    id: "folder-plan-1",
    profileId: PROFILE_A,
    sessionGeneration: 1,
    folderId: null,
    courseId: null,
    files: [{ file: selectedFile, relativePath: "Course/lab/notes.txt", targetPath: "Course/lab" }],
    directories: [
      { id: ID_A, path: "Course", name: "Course", parentPath: null, created: true },
      { id: ID_B, path: "Course/lab", name: "lab", parentPath: "Course", created: false },
    ],
    status: "error",
    error: "The folder request failed.",
  };
  const createdFolders = [{ id: ID_A, parent_id: null, name: "Course" }];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, method: init.method ?? "GET" });
    if (path.startsWith("/api/file-folders")) {
      const view = new URL(path, dom.window.location.origin).searchParams.get("view");
      return new Response(JSON.stringify({ folders: view === "active" ? createdFolders : [], activities: { folders: [] } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ files: [], activities: { files: [], folders: [] } }), { headers: { "content-type": "application/json" } });
  };
  dom.window.confirm = (message) => { requests.push({ confirm: message }); return true; };

  await render(createElement(FolderPlanHarness, { store: makeStore(async () => { assert.fail("Dismissal must not upload files."); }), initialPlan }));
  await waitForReact(() => requests.filter((request) => request.path).length >= 5);
  const dialog = document.querySelector('[role="dialog"][aria-labelledby="files-upload-title"]');
  const dismiss = [...dialog.querySelectorAll("button")].find((button) => button.textContent.trim() === "Dismiss selection");
  assert.ok(dismiss, "an idle partial folder plan can be dismissed");

  await act(async () => { dismiss.click(); });
  await waitForReact(() => pendingFolderSelection === null);
  assert.deepEqual(createdFolders, [{ id: ID_A, parent_id: null, name: "Course" }], "the server-created folder remains in Files");
  assert.ok(requests.some((request) => request.confirm?.includes("Folders already created in Files will stay in place.")), "dismissing explains that created folders are retained");
  assert.ok(requests.filter((request) => request.path).every((request) => request.method === "GET"), "dismissal does not delete folders or start uploads");
  assert.equal(queue.rows.length, 0, "the selected original file is not uploaded during dismissal");
});

test("oversize and invalid-name selections remain as per-file validation errors", async () => {
  let uploads = 0;
  const store = makeStore(async () => { uploads++; throw new Error("Validation should prevent upload."); });
  await render(createElement(UploadHarness, { store }));
  const oversize = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.bin");
  const invalidName = makeFile("x".repeat(256));
  await act(async () => { queue.enqueue([oversize, invalidName], DEFAULTS); });
  await waitForReact(() => queue.rows.length === 2 && queue.rows.every((row) => row.status === "error"));
  assert.match(queue.rows[0].error, /25 MiB/);
  assert.match(queue.rows[1].error, /1–255 characters/);
  assert.equal(queue.rows[0].retryable, false);
  assert.equal(queue.rows[1].retryable, false);
  assert.equal(uploads, 0);
  assert.equal(queue.dirty, true);
});

test("progress transport sends captured account headers and reports bytes only when requested", async () => {
  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.headers = {};
      FakeXMLHttpRequest.last = this;
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name.toLowerCase()] = value; }
    send(file) {
      this.body = file;
      this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size });
      queueMicrotask(() => {
        this.status = 201;
        this.responseText = JSON.stringify({ file: { id: ID_A } });
        this.onload?.();
      });
    }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeXMLHttpRequest;
  const file = makeFile("xhr.txt");
  const metadata = { name: file.name, courseId: "", assignmentId: "", kind: "resource", folderId: null };
  const progress = [];
  const result = await uploadFileWithProgress(PROFILE_A, ID_A, file, metadata, { onProgress: (loaded, total) => progress.push([loaded, total]) });
  const xhr = FakeXMLHttpRequest.last;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, `/api/files?id=${ID_A}`);
  assert.equal(xhr.headers["x-profile-id"], PROFILE_A);
  assert.equal(xhr.headers["content-type"], "application/octet-stream");
  assert.equal(decodeURIComponent(xhr.headers["x-file-metadata"]), JSON.stringify(metadata));
  assert.equal(xhr.timeout, 120_000);
  assert.deepEqual(progress, [[file.size, file.size]]);
  assert.equal(result.id, ID_A);
});

test("legacy three-argument store upload continues to use fetch", async () => {
  const file = makeFile("legacy.txt");
  const metadata = { name: file.name, courseId: "", assignmentId: "", kind: "resource", folderId: null };
  const canonical = await makeAck(file, metadata, ID_A);
  const requests = [];
  globalThis.XMLHttpRequest = class { constructor() { assert.fail("Legacy upload unexpectedly used XHR."); } };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(url === "/api/files" ? { files: [] } : { file: canonical }), { status: 201, headers: { "content-type": "application/json" } });
  };
  await render(createElement(PrivateStoreHarness, { profileId: PROFILE_A }));
  let saved;
  await act(async () => { saved = await privateStore.upload(file, metadata, ID_A); });
  assert.equal(saved.id, ID_A);
  const post = requests.find((request) => request.init?.method === "POST");
  assert.equal(post.url, `/api/files?id=${ID_A}`);
  assert.equal(post.init.body, file);
  assert.equal(new Headers(post.init.headers).get("x-profile-id"), PROFILE_A);
  assert.equal(privateStore.files[0].id, ID_A);
});

test("a late previous-account upload cannot write files or busy state into the next account", async () => {
  const heldPost = deferred();
  let postWasStarted = false;
  const selected = makeFile("old-account.txt");
  const metadata = { name: selected.name, courseId: "", assignmentId: "", kind: "resource", folderId: null };
  const nextAccountFile = await makeAck(makeFile("new-account.txt"), { ...metadata, name: "new-account.txt" }, ID_B);
  globalThis.fetch = async (url, init = {}) => {
    const requestProfile = new Headers(init.headers).get("x-profile-id");
    if (init.method === "POST") {
      postWasStarted = true;
      return heldPost.promise;
    }
    return new Response(JSON.stringify({ files: requestProfile === PROFILE_B ? [nextAccountFile] : [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await render(createElement(PrivateStoreHarness, { profileId: PROFILE_A }));
  await waitForReact(() => privateStore.loading === false);
  let oldUpload;
  await act(async () => { oldUpload = privateStore.upload(selected, metadata, ID_A); });
  await waitForReact(() => privateStore.busy && postWasStarted);
  await render(createElement(PrivateStoreHarness, { profileId: PROFILE_B }));
  await waitForReact(() => privateStore.loading === false && privateStore.files.some((file) => file.id === ID_B));
  assert.equal(privateStore.busy, false);

  await act(async () => {
    heldPost.resolve(new Response(JSON.stringify({ file: await makeAck(selected, metadata, ID_A) }), { status: 201, headers: { "content-type": "application/json" } }));
    await assert.rejects(oldUpload, (error) => error.name === "AbortError");
  });
  assert.deepEqual(privateStore.files.map((file) => file.id), [ID_B]);
  assert.equal(privateStore.busy, false);
});
