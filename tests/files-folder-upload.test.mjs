import assert from "node:assert/strict";
import test from "node:test";
import { clientModule } from "./helpers/client-modules.mjs";

const { buildFolderUploadPlan, ensureFolderUploadHierarchy } = await import(await clientModule("lib/files-folder-upload.ts"));

const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROFILE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DESTINATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_ID = "10000000-0000-4000-8000-000000000001";
const ROOT_ID = "10000000-0000-4000-8000-000000000002";
const CHILD_ID = "10000000-0000-4000-8000-000000000003";
const GRANDCHILD_ID = "10000000-0000-4000-8000-000000000004";
const NOW = "2026-10-10T12:00:00.000Z";

function file(name, webkitRelativePath) {
  return { name, webkitRelativePath, marker: {} };
}

function idFactory(...ids) {
  let index = 0;
  return () => ids[index++];
}

function planFor(files, ids = [PLAN_ID, ROOT_ID, CHILD_ID, GRANDCHILD_ID]) {
  return buildFolderUploadPlan(files, {
    profileId: PROFILE,
    sessionGeneration: 7,
    folderId: DESTINATION,
    courseId: "biology",
  }, idFactory(...ids));
}

function createdFolder({ id, name, parentId }) {
  return {
    id, name, parent_id: parentId, kind: "custom", course_id: null,
    revision: 1, created_at: NOW, updated_at: NOW, archived_at: null, trashed_at: null,
    deleted_at: null, purge_pending_at: null,
  };
}

function currentFor(profileId = PROFILE, sessionGeneration = 7) {
  return (expectedProfile, expectedGeneration) => expectedProfile === profileId && expectedGeneration === sessionGeneration;
}

test("folder upload planning retains files and builds a parent-first hierarchy", async () => {
  const nested = file("notes.txt", "selected/root/sub/notes.txt");
  const rootFile = file("outline.txt", "selected/root/outline.txt");
  const plan = planFor([nested, rootFile]);

  assert.equal(plan.id, PLAN_ID);
  assert.equal(plan.profileId, PROFILE);
  assert.equal(plan.sessionGeneration, 7);
  assert.equal(plan.folderId, DESTINATION);
  assert.equal(plan.courseId, "biology");
  assert.equal(plan.files[0].file, nested);
  assert.equal(plan.files[0].relativePath, "selected/root/sub/notes.txt");
  assert.equal(plan.files[0].targetPath, "selected/root/sub");
  assert.equal(plan.files[1].file, rootFile);
  assert.equal(plan.files[1].targetPath, "selected/root");
  assert.deepEqual(plan.directories.map(({ id, path, name, parentPath, created }) => ({ id, path, name, parentPath, created })), [
    { id: ROOT_ID, path: "selected", name: "selected", parentPath: null, created: false },
    { id: CHILD_ID, path: "selected/root", name: "root", parentPath: "selected", created: false },
    { id: GRANDCHILD_ID, path: "selected/root/sub", name: "sub", parentPath: "selected/root", created: false },
  ]);

  const calls = [];
  const folders = await ensureFolderUploadHierarchy(PROFILE, plan, {
    isCurrent: currentFor(),
    onCreated: () => {},
    createFolder: async (profileId, input, options) => {
      calls.push({ profileId, input, options });
      return createdFolder(input);
    },
  });

  assert.deepEqual(calls.map(({ input }) => [input.name, input.parentId]), [
    ["selected", DESTINATION],
    ["root", ROOT_ID],
    ["sub", CHILD_ID],
  ]);
  assert.deepEqual([...folders], [
    ["selected", ROOT_ID],
    ["selected/root", CHILD_ID],
    ["selected/root/sub", GRANDCHILD_ID],
  ]);
  assert.ok(calls.every(({ profileId }) => profileId === PROFILE));
});

test("a partial hierarchy retry revalidates acknowledged folders with the same IDs", async () => {
  const plan = planFor([file("report.pdf", "selected/root/sub/report.pdf")]);
  const requests = [];
  const savedFolders = new Map();
  let failNestedOnce = true;
  const options = {
    isCurrent: currentFor(),
    onCreated: (directory) => { directory.created = true; },
    createFolder: async (_profileId, input) => {
      requests.push(input);
      const existing = savedFolders.get(input.id);
      if (existing) {
        if (existing.name !== input.name || existing.parent_id !== input.parentId) throw new Error("Folder ID already used");
        return existing;
      }
      const folder = createdFolder(input);
      if (input.name === "sub" && failNestedOnce) {
        failNestedOnce = false;
        savedFolders.set(input.id, folder);
        throw new Error("request timed out after the server may have accepted it");
      }
      savedFolders.set(input.id, folder);
      return folder;
    },
  };

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, options), /timed out/);
  assert.equal(plan.directories[0].created, true);
  assert.equal(plan.directories[1].created, true);
  assert.equal(plan.directories[2].created, false);
  const retryMap = await ensureFolderUploadHierarchy(PROFILE, plan, options);

  assert.deepEqual(requests.map(({ id }) => id), [ROOT_ID, CHILD_ID, GRANDCHILD_ID, ROOT_ID, CHILD_ID, GRANDCHILD_ID]);
  assert.equal(savedFolders.size, 3, "replay confirms the saved rows instead of creating duplicate folders");
  assert.equal(plan.directories[2].created, true);
  assert.deepEqual([...retryMap], [["selected", ROOT_ID], ["selected/root", CHILD_ID], ["selected/root/sub", GRANDCHILD_ID]]);
});

test("a renamed or moved acknowledged parent stops retry before descendant requests", async () => {
  const selectedFile = file("report.pdf", "selected/root/sub/report.pdf");
  const plan = planFor([selectedFile]);
  const requests = [];
  const savedFolders = new Map();
  let failNestedOnce = true;
  const options = {
    isCurrent: currentFor(),
    onCreated: (directory) => { directory.created = true; },
    createFolder: async (_profileId, input) => {
      requests.push(input);
      const existing = savedFolders.get(input.id);
      if (existing) {
        if (existing.name !== input.name || existing.parent_id !== input.parentId) throw new Error("Folder ID already used");
        return existing;
      }
      if (input.name === "sub" && failNestedOnce) {
        failNestedOnce = false;
        throw new Error("leaf creation failed");
      }
      const folder = createdFolder(input);
      savedFolders.set(input.id, folder);
      return folder;
    },
  };

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, options), /leaf creation failed/);
  const root = savedFolders.get(ROOT_ID);
  savedFolders.set(ROOT_ID, { ...root, name: "renamed elsewhere", parent_id: null });

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, options), /Folder ID already used/);
  assert.deepEqual(requests.map(({ id }) => id), [ROOT_ID, CHILD_ID, GRANDCHILD_ID, ROOT_ID]);
  assert.equal(plan.directories[0].created, true);
  assert.equal(plan.directories[1].created, true);
  assert.equal(plan.files[0].file, selectedFile, "the selection remains available after a hierarchy conflict");
});

test("an archived acknowledged folder is rejected before any descendant is created", async () => {
  const plan = planFor([file("report.pdf", "selected/root/report.pdf")]);
  let archiveOnReplay = false;
  const requests = [];
  const options = {
    isCurrent: currentFor(),
    onCreated: (directory) => { directory.created = true; },
    createFolder: async (_profileId, input) => {
      requests.push(input);
      const folder = createdFolder(input);
      return archiveOnReplay && input.name === "selected"
        ? { ...folder, archived_at: NOW }
        : folder;
    },
  };

  await ensureFolderUploadHierarchy(PROFILE, plan, options);
  archiveOnReplay = true;
  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, options), /did not match the folder upload plan/i);
  assert.deepEqual(requests.map(({ id }) => id), [ROOT_ID, CHILD_ID, ROOT_ID]);
  assert.equal(plan.directories[0].created, true);
  assert.equal(plan.directories[1].created, true);
});

test("a plan for another profile is rejected before any folder request", async () => {
  const plan = planFor([file("report.pdf", "selected/report.pdf")]);
  let requests = 0;

  await assert.rejects(ensureFolderUploadHierarchy(OTHER_PROFILE, plan, {
    isCurrent: currentFor(),
    onCreated: () => {},
    createFolder: async () => { requests += 1; throw new Error("must not run"); },
  }), /different signed-in account/i);
  assert.equal(requests, 0);
});

test("an unverified folder response never marks a directory as created", async () => {
  const plan = planFor([file("report.pdf", "selected/report.pdf")]);
  let createdCallbacks = 0;

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, {
    isCurrent: currentFor(),
    onCreated: () => { createdCallbacks += 1; },
    createFolder: async (_profileId, input) => ({ ...createdFolder(input), id: CHILD_ID }),
  }), /did not match the folder upload plan/i);

  assert.equal(plan.directories[0].created, false);
  assert.equal(createdCallbacks, 0);
});

test("a profile switch away and back is fenced by the captured session generation", async () => {
  const plan = planFor([file("report.pdf", "selected/root/report.pdf")]);
  let currentProfile = PROFILE;
  let currentGeneration = 7;
  let requests = 0;
  let createdCallbacks = 0;

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, {
    isCurrent: (expectedProfile, expectedGeneration) => expectedProfile === currentProfile && expectedGeneration === currentGeneration,
    onCreated: () => { createdCallbacks += 1; },
    createFolder: async (_profileId, input) => {
      requests += 1;
      currentProfile = OTHER_PROFILE;
      currentGeneration = 8;
      currentProfile = PROFILE;
      currentGeneration = 9;
      return createdFolder(input);
    },
  }), /earlier Files session/i);

  assert.equal(requests, 1);
  assert.equal(createdCallbacks, 0);
});

test("an abort during folder creation stops the hierarchy before mapping is returned", async () => {
  const plan = planFor([file("report.pdf", "selected/root/report.pdf")]);
  const controller = new AbortController();
  let requests = 0;
  let createdCallbacks = 0;

  await assert.rejects(ensureFolderUploadHierarchy(PROFILE, plan, {
    signal: controller.signal,
    isCurrent: currentFor(),
    onCreated: () => { createdCallbacks += 1; },
    createFolder: async (_profileId, input) => {
      requests += 1;
      controller.abort();
      return createdFolder(input);
    },
  }), /interrupted/i);

  assert.equal(requests, 1);
  assert.equal(createdCallbacks, 0);
});

test("missing, unsafe, or colliding webkitRelativePath values are rejected before folder creation", async () => {
  let requests = 0;
  const createHierarchy = async (pickedFile) => ensureFolderUploadHierarchy(PROFILE, planFor([pickedFile]), {
    isCurrent: currentFor(),
    onCreated: () => {},
    createFolder: async () => { requests += 1; throw new Error("must not run"); },
  });

  await assert.rejects(createHierarchy(file("report.pdf", "")), /missing a safe folder path/i);
  await assert.rejects(createHierarchy(file("report.pdf", "report.pdf")), /missing its folder path/i);
  await assert.rejects(createHierarchy(file("report.pdf", "selected/../report.pdf")), /unsafe folder path/i);
  await assert.rejects(createHierarchy(file("report.pdf", "selected\\report.pdf")), /missing a safe folder path/i);
  await assert.rejects(async () => createHierarchyPair(
    file("A", "selected/A"), file("report.pdf", "selected/A/report.pdf"),
  ), /same path for a file and a folder/i);
  assert.equal(requests, 0, "invalid selections are rejected before hierarchy creation begins");

  function createHierarchyPair(...pickedFiles) {
    return ensureFolderUploadHierarchy(PROFILE, planFor(pickedFiles), {
      isCurrent: currentFor(),
      onCreated: () => {},
      createFolder: async () => { requests += 1; throw new Error("must not run"); },
    });
  }
});
