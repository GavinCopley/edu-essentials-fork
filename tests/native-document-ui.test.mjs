import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const dom = new JSDOM('<button id="return-focus">Open editor</button><div id="root"></div>', { url: "https://edu.example/files" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "HTMLFormElement", "HTMLFieldSetElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent", "KeyboardEvent", "Event", "FormData"]) {
  globalThis[name] = dom.window[name];
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: (callback) => setTimeout(() => callback(Date.now()), 0) });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: (id) => clearTimeout(id) });
dom.window.confirm = () => true;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const [{ createElement, act }, { createRoot }, { default: NativeDocumentEditor }] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import(await clientModule("app/native-document-editor.tsx")),
]);

const profileId = "profile-a";
const rootNode = document.getElementById("root");
const returnFocus = document.getElementById("return-focus");
const fixedTime = "2026-10-08T00:00:00.000Z";
const fileId = "00000000-0000-4000-8000-000000000101";
const creationId = "00000000-0000-4000-8000-000000000102";
let root;
let downloads = [];
let originalCreateObjectURL;
let originalRevokeObjectURL;
let originalAnchorClick;

const makeRecord = ({ id = fileId, name = "Notes.txt", body = "saved text", folderId = null, courseId = "", contentRevision = 1, metadataRevision = 1 } = {}) => ({
  id, name, body, folderId, courseId: courseId || null, contentRevision, metadataRevision,
});

function responseFor(record, requestId) {
  const file = {
    id: record.id,
    name: record.name,
    mime_type: "text/plain",
    size_bytes: new TextEncoder().encode(record.body).byteLength,
    course_id: record.courseId,
    assignment_id: null,
    kind: "resource",
    state: "ready",
    created_at: fixedTime,
    updated_at: fixedTime,
    content_sha256: null,
    folder_id: record.folderId,
    content_backend: "native-text",
    metadata_revision: record.metadataRevision,
    content_revision: record.contentRevision,
    trashed_at: null,
    trash_operation_id: null,
    original_folder_id: null,
  };
  return {
    file,
    document: { file_id: record.id, body: record.body, content_revision: record.contentRevision },
    ...(requestId ? { requestId, acknowledgedContentRevision: record.contentRevision } : {}),
  };
}

function makeApi({ initialRecords = [], onCreate, onPut, onRead } = {}) {
  const records = new Map(initialRecords.map((record) => [record.id, { ...record }]));
  const requests = [];
  const counts = { create: 0, put: 0, read: 0 };
  const api = { records, requests, counts };

  api.applyPut = ({ record, data }) => {
    if (data.baseContentRevision !== record.contentRevision ||
        (data.baseMetadataRevision !== undefined && data.baseMetadataRevision !== record.metadataRevision)) {
      return Response.json({ error: "The document changed elsewhere." }, { status: 409 });
    }
    const renamed = typeof data.name === "string" && data.name !== record.name;
    const updated = {
      ...record,
      name: renamed ? data.name : record.name,
      body: data.body,
      contentRevision: record.contentRevision + 1,
      metadataRevision: record.metadataRevision + (renamed ? 1 : 0),
    };
    records.set(record.id, updated);
    return Response.json(responseFor(updated, data.requestId));
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), window.location.href);
    const method = init.method ?? "GET";
    const profile = new Headers(init.headers).get("x-profile-id");
    const data = init.body ? JSON.parse(init.body) : undefined;
    const request = { url: `${url.pathname}${url.search}`, method, profile, data };
    requests.push(request);

    if (url.pathname !== "/api/file-documents") return Response.json({ error: `Unexpected URL ${url.pathname}` }, { status: 404 });
    if (method === "POST") {
      counts.create += 1;
      let record = records.get(data.id);
      if (!record) {
        record = makeRecord({ id: data.id, name: data.name, body: data.body, folderId: data.folderId, courseId: data.courseId });
        records.set(data.id, record);
      }
      const context = { api, request, data, record, count: counts.create };
      return onCreate ? onCreate(context) : Response.json(responseFor(record));
    }
    if (method === "GET") {
      counts.read += 1;
      const record = records.get(url.searchParams.get("id"));
      if (!record) return Response.json({ error: "Document not found." }, { status: 404 });
      const context = { api, request, record, count: counts.read };
      return onRead ? onRead(context) : Response.json(responseFor(record));
    }
    if (method === "PUT") {
      counts.put += 1;
      const record = records.get(url.searchParams.get("id"));
      if (!record) return Response.json({ error: "Document not found." }, { status: 404 });
      const context = { api, request, data, record, count: counts.put };
      return onPut ? onPut(context) : api.applyPut(context);
    }
    return Response.json({ error: `Unexpected method ${method}` }, { status: 405 });
  };
  return api;
}

function editorProps({ file = null, create = null, currentProfile = profileId, canWrite = true, saved, closed, drafts } = {}) {
  return {
    profileId: currentProfile,
    ...(file ? { file } : {}),
    ...(create ? { create } : {}),
    canWrite,
    onSaved: (next) => saved?.push(next),
    onClose: () => closed?.push(true),
    onDraftChange: (draft) => drafts?.push(draft),
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function render(props) {
  await act(async () => root.render(createElement(NativeDocumentEditor, props)));
}

async function waitUntil(predicate, description, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await act(async () => tick(10));
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

function button(label) {
  const found = [...rootNode.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent.trim() === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

function field(label, selector) {
  const found = [...rootNode.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(label));
  assert.ok(found, `Missing ${label} field`);
  return found.querySelector(selector);
}

async function setValue(control, value) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label) {
  const control = button(label);
  await act(async () => control.click());
  return control;
}

async function unmount() {
  if (!root) return;
  await act(async () => root.unmount());
  root = undefined;
}

function reset() {
  rootNode.innerHTML = "";
  downloads = [];
  root = createRoot(rootNode);
  returnFocus.focus();
}

originalCreateObjectURL = URL.createObjectURL;
originalRevokeObjectURL = URL.revokeObjectURL;
originalAnchorClick = window.HTMLAnchorElement.prototype.click;
URL.createObjectURL = (blob) => {
  const item = { blob, anchor: null, url: `blob:native-document-${downloads.length + 1}` };
  downloads.push(item);
  return item.url;
};
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {
  const item = downloads.at(-1);
  if (item) item.anchor = { href: this.href, download: this.download };
};

after(async () => {
  await unmount();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  window.HTMLAnchorElement.prototype.click = originalAnchorClick;
  dom.window.close();
});
afterEach(async () => {
  await unmount();
  dom.window.confirm = () => true;
});

test("empty creation is durable before editing, and an uncertain retry keeps its stable document ID", async () => {
  reset();
  const api = makeApi({
    onCreate: async ({ count, record }) => {
      if (count === 1) return Response.json({ error: "The response was lost." }, { status: 503 });
      return Response.json(responseFor(record));
    },
  });
  const saved = [];
  const closed = [];
  const props = editorProps({ create: { id: creationId, name: "Untitled.txt", body: "", folderId: null, courseId: "" }, saved, closed });
  await render(props);
  await waitUntil(() => api.counts.create === 1, "the first durable create request");
  assert.equal(api.requests[0].method, "POST");
  assert.equal(api.requests[0].data.body, "");
  assert.equal(api.requests[0].data.id, creationId);
  await waitUntil(() => rootNode.textContent.includes("Could not create this document."), "the failed create state");
  assert.equal(rootNode.querySelector("fieldset").disabled, true);
  await click("Retry creation");
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the editor to become writable after the same-ID retry");
  assert.equal(api.counts.create, 2);
  assert.deepEqual(api.requests.filter((request) => request.method === "POST").map((request) => request.data.id), [creationId, creationId]);
  assert.equal(api.requests[1].data.body, "");
  assert.equal(api.records.get(creationId).body, "");
  await waitUntil(() => document.activeElement === field("File name", "input"), "initial focus on the name field");
  assert.ok(document.activeElement === field("File name", "input"), "ready creation focuses the name field");

  const dialog = rootNode.querySelector('[role="dialog"]');
  const first = button("Close text editor");
  const last = button("Close editor");
  first.focus();
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.ok(document.activeElement === last, "Shift+Tab from the first action wraps to the last editor action");
  last.focus();
  await act(async () => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.ok(document.activeElement === first, "Tab from the last action wraps to the close control");
  await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await act(async () => tick(0));
  assert.deepEqual(closed, [true]);
  assert.ok(document.activeElement === returnFocus, "closing restores focus to the launcher");
  assert.ok(saved.length >= 1);
});

test("Unicode and empty text save through Ctrl/Command+S and download as UTF-8 plain text", async () => {
  reset();
  const api = makeApi({ initialRecords: [makeRecord({ id: fileId, body: "initial" })] });
  const saved = [];
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 }, saved }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");

  const unicode = "日本語, résumé, 🙂\n";
  await setValue(field("File name", "input"), "Résumé.txt");
  await setValue(field("Text", "textarea"), unicode);
  const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => rootNode.querySelector('[role="dialog"]').dispatchEvent(event));
  assert.equal(event.defaultPrevented, true, "Ctrl/Command+S is handled by the editor");
  await waitUntil(() => api.counts.put === 1 && rootNode.textContent.includes("Saved"), "the Unicode save acknowledgement");
  assert.equal(api.requests.find((request) => request.method === "PUT").data.name, "Résumé.txt");
  assert.equal(api.records.get(fileId).body, unicode);
  assert.equal(api.records.get(fileId).contentRevision, 2);
  assert.equal(api.records.get(fileId).metadataRevision, 2);
  assert.equal(field("Text", "textarea").value, unicode);

  await click("Download saved text");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].anchor.download, "Résumé.txt");
  assert.equal(downloads[0].blob.type, "text/plain;charset=utf-8");
  assert.equal(await downloads[0].blob.text(), unicode);
  assert.ok(saved.some((item) => item.id === fileId && item.content_revision === 2));
});

test("a local rename made during an in-flight body save uses the acknowledged content and metadata revisions", async () => {
  reset();
  const firstPut = deferred();
  const firstPutStarted = deferred();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "initial" })],
    onPut: async (context) => {
      if (context.count === 1) {
        firstPutStarted.resolve(context);
        return firstPut.promise;
      }
      return api.applyPut(context);
    },
  });
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 } }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "first in-flight body");
  await act(async () => tick(800));
  const firstContext = await firstPutStarted.promise;
  assert.equal(firstContext.data.body, "first in-flight body");
  assert.equal(rootNode.querySelector("fieldset").disabled, false);

  await setValue(field("File name", "input"), "Renamed mid-save.txt");
  await setValue(field("Text", "textarea"), "newer body after rename");
  assert.equal(api.counts.put, 1);
  await act(async () => {
    firstPut.resolve(api.applyPut(firstContext));
    await tick();
  });
  await act(async () => tick(800));
  await waitUntil(() => api.counts.put === 2 && api.records.get(fileId).contentRevision === 3, "the queued rename and body write");

  const second = api.requests.filter((request) => request.method === "PUT")[1].data;
  assert.equal(second.name, "Renamed mid-save.txt");
  assert.equal(second.body, "newer body after rename");
  assert.equal(second.baseContentRevision, 2);
  assert.equal(second.baseMetadataRevision, 1);
  assert.equal(api.records.get(fileId).name, "Renamed mid-save.txt");
  assert.equal(api.records.get(fileId).body, "newer body after rename");
});

test("an acknowledged external rename stays canonical while queued and saved-vs-draft text is downloaded", async () => {
  reset();
  const firstPut = deferred();
  const firstPutStarted = deferred();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "initial" })],
    onPut: async (context) => {
      if (context.count === 1) {
        firstPutStarted.resolve(context);
        return firstPut.promise;
      }
      return Response.json({ error: "The latest queued save failed." }, { status: 503 });
    },
  });
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 } }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "body A acknowledged first");

  await act(async () => tick(800));
  const firstContext = await firstPutStarted.promise;
  assert.equal(firstContext.data.body, "body A acknowledged first");
  assert.equal(rootNode.querySelector("fieldset").disabled, false, "typing remains available while a PUT is in flight");
  assert.equal(api.counts.put, 1);
  await setValue(field("Text", "textarea"), "body B queued while saving");
  assert.equal(api.counts.put, 1, "new edits queue behind the active request");

  const externallyRenamed = {
    ...firstContext.record,
    name: "Other.txt",
    body: firstContext.data.body,
    contentRevision: 2,
    metadataRevision: 2,
  };
  api.records.set(fileId, externallyRenamed);
  await act(async () => {
    firstPut.resolve(Response.json(responseFor(externallyRenamed, firstContext.data.requestId)));
    await tick();
  });
  await waitUntil(() => field("File name", "input").value === "Other.txt", "the independently renamed canonical name");
  await setValue(field("Text", "textarea"), "body C continued after rename");
  await act(async () => tick(800));
  await waitUntil(() => api.counts.put === 2 && rootNode.textContent.includes("Failed to save"), "the queued latest revision and its simulated failure");
  const second = api.requests.filter((request) => request.method === "PUT")[1].data;
  assert.equal(Object.hasOwn(second, "name"), false, "the body-only update does not send the stale pre-rename name");
  assert.equal(second.body, "body C continued after rename");
  assert.equal(second.baseContentRevision, 2);
  assert.equal(second.baseMetadataRevision, undefined);
  assert.equal(api.records.get(fileId).name, "Other.txt");

  await click("Download saved text");
  await click("Download draft");
  assert.equal(await downloads[0].blob.text(), "body A acknowledged first", "saved text reflects the last server acknowledgement");
  assert.equal(await downloads[1].blob.text(), "body C continued after rename", "draft download retains the latest local edit");
});

test("failed writes retain the draft, pause automatic retries, and retry the same attempt on request", async () => {
  reset();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "initial" })],
    onPut: async (context) => context.count === 1
      ? Response.json({ error: "The response was lost." }, { status: 503 })
      : api.applyPut(context),
  });
  const closed = [];
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 }, closed }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "draft to keep ✓");
  await click("Save");
  await waitUntil(() => rootNode.textContent.includes("Failed to save"), "the failed save state");
  assert.equal(field("Text", "textarea").value, "draft to keep ✓");
  const firstRequest = api.requests.find((request) => request.method === "PUT");
  await tick(100);
  assert.equal(api.counts.put, 1, "a failed save is not retried automatically");

  const confirmations = [];
  dom.window.confirm = (message) => { confirmations.push(message); return false; };
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true, "unsaved text activates beforeunload protection");
  await click("Close editor");
  assert.match(confirmations[0], /unsaved text/i);
  assert.deepEqual(closed, [], "cancelling the close confirmation keeps the editor open");

  await click("Retry save");
  await waitUntil(() => api.counts.put === 2 && rootNode.textContent.includes("Saved"), "the explicit retry acknowledgement");
  const retryRequest = api.requests.filter((request) => request.method === "PUT")[1];
  assert.equal(retryRequest.data.requestId, firstRequest.data.requestId);
  assert.equal(retryRequest.data.body, "draft to keep ✓");
  assert.equal(retryRequest.data.baseContentRevision, firstRequest.data.baseContentRevision);
  assert.equal(api.records.get(fileId).body, "draft to keep ✓");

  await click("Close editor");
  await act(async () => tick(0));
  assert.deepEqual(closed, [true]);
  assert.ok(document.activeElement === returnFocus);
});

test("conflict copy retries the same ID after a lost response and carries the latest local draft forward", async () => {
  reset();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "server version" })],
    onPut: async (context) => context.count === 1
      ? Response.json({ error: "Another tab saved first." }, { status: 409 })
      : context.api.applyPut(context),
    onCreate: async ({ count, record }) => count === 1
      ? Response.json({ error: "The copy response was lost." }, { status: 503 })
      : Response.json(responseFor(record)),
  });
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 } }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "draft before conflict");
  await click("Save");
  await waitUntil(() => rootNode.querySelector('[aria-label="Resolve document conflict"]'), "the conflict actions");

  await click("Save local draft as new document");
  await waitUntil(() => rootNode.textContent.includes("Copy failed. Your local draft is still here."), "the lost copy response");
  const firstCopy = api.requests.find((request) => request.method === "POST");
  assert.ok(firstCopy);
  assert.notEqual(firstCopy.data.id, fileId);
  assert.equal(api.records.get(firstCopy.data.id).body, "draft before conflict", "the server committed the first copy before its response was lost");
  assert.equal(rootNode.querySelector("fieldset").disabled, false, "the recoverable draft remains editable after the failed copy");
  await setValue(field("Text", "textarea"), "newer local draft after lost response");

  await click("Retry saving this copy");
  await waitUntil(() => api.requests.filter((request) => request.method === "POST").length === 2, "the idempotent copy retry");
  const copyRequests = api.requests.filter((request) => request.method === "POST");
  assert.deepEqual(copyRequests.map((request) => request.data.id), [firstCopy.data.id, firstCopy.data.id]);
  assert.equal(copyRequests[1].data.body, firstCopy.data.body, "the retry replays the original create descriptor");
  await waitUntil(() => api.counts.put === 2 && api.records.get(firstCopy.data.id).body === "newer local draft after lost response", "the newer draft to save on the recovered copy");
  const copyUpdate = api.requests.filter((request) => request.method === "PUT").at(-1);
  assert.equal(new URL(`https://edu.example${copyUpdate.url}`).searchParams.get("id"), firstCopy.data.id);
  assert.equal(copyUpdate.data.body, "newer local draft after lost response");
  assert.equal(rootNode.textContent.includes("This document changed elsewhere"), false);
});

test("discarding a conflict asks first and reloads the latest saved version only after confirmation", async () => {
  reset();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "current server text" })],
    onPut: async () => Response.json({ error: "Another tab saved first." }, { status: 409 }),
  });
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 } }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "local text to discard");
  await click("Save");
  await waitUntil(() => rootNode.querySelector('[aria-label="Resolve document conflict"]'), "the conflict actions");

  const confirmations = [];
  dom.window.confirm = (message) => { confirmations.push(message); return false; };
  await click("Discard local draft and load saved version");
  assert.equal(field("Text", "textarea").value, "local text to discard");
  assert.equal(api.counts.read, 1, "cancelled discard does not fetch the latest version");
  assert.match(confirmations[0], /Discard your local text/);

  dom.window.confirm = () => true;
  api.records.set(fileId, { ...api.records.get(fileId), body: "latest from another tab", contentRevision: 2 });
  await click("Discard local draft and load saved version");
  await waitUntil(() => field("Text", "textarea").value === "latest from another tab", "the latest saved text");
  assert.equal(rootNode.querySelector('[aria-label="Resolve document conflict"]'), null);
  assert.equal(rootNode.textContent.includes("Saved"), true);
  assert.equal(api.counts.read, 2);
});

test("a late save response after an account switch cannot overwrite the visible local draft", async () => {
  reset();
  const putReply = deferred();
  const putStarted = deferred();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "account A saved text" })],
    onPut: async (context) => { putStarted.resolve(context); return putReply.promise; },
  });
  const saved = [];
  const file = { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 };
  await render(editorProps({ file, currentProfile: "profile-a", saved }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "account A editor");
  await setValue(field("Text", "textarea"), "local account A draft");
  await click("Save");
  const context = await putStarted.promise;
  assert.equal(context.request.profile, "profile-a");

  await render(editorProps({ file, currentProfile: "profile-b", saved }));
  await waitUntil(() => rootNode.querySelector('[role="alert"]')?.textContent.includes("account changed"), "the account-change guard");
  assert.equal(field("Text", "textarea").value, "local account A draft");
  const savedBeforeLateResponse = saved.length;
  await act(async () => {
    putReply.resolve(api.applyPut(context));
    await tick(30);
  });
  assert.equal(field("Text", "textarea").value, "local account A draft");
  assert.equal(saved.length, savedBeforeLateResponse, "a previous-account acknowledgement does not refresh the visible document");
  assert.equal(api.requests.some((request) => request.profile === "profile-b"), false, "no request is sent with the new account header");
});

test("unmount abandons an in-flight save acknowledgement", async () => {
  reset();
  const putReply = deferred();
  const putStarted = deferred();
  const api = makeApi({
    initialRecords: [makeRecord({ id: fileId, body: "saved" })],
    onPut: async (context) => { putStarted.resolve(context); return putReply.promise; },
  });
  const saved = [];
  await render(editorProps({ file: { id: fileId, name: "Notes.txt", content_backend: "native-text", state: "ready", metadata_revision: 1, content_revision: 1 }, saved }));
  await waitUntil(() => rootNode.querySelector("fieldset") && !rootNode.querySelector("fieldset").disabled, "the loaded editor");
  await setValue(field("Text", "textarea"), "save that outlives this editor");
  await click("Save");
  const context = await putStarted.promise;
  const notificationsBeforeUnmount = saved.length;
  await unmount();
  assert.equal(rootNode.querySelector('[role="dialog"]'), null);

  await act(async () => {
    putReply.resolve(api.applyPut(context));
    await tick(30);
  });
  assert.equal(rootNode.querySelector('[role="dialog"]'), null);
  assert.equal(saved.length, notificationsBeforeUnmount, "the late acknowledgement cannot resurrect editor state or notify the old parent");
});
