import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-file-organization");
const FOLDER_ID = { organization: "16161616-1616-4161-8161-161616161616" };
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const esbuild = process.env.ESBUILD_MODULE
  ? await import(pathToFileURL(resolve(process.env.ESBUILD_MODULE)).href)
  : await import("esbuild");
const cssFiles = [
  "app/globals.css",
  "app/reference-ui.css",
  "app/files-browser.css",
  "app/files-browser-tools.css",
  "app/file-archive-dialog.css",
  "app/file-organization-dialogs.css",
  "app/course-syllabus.css",
  "app/auth.css",
];
const cssSources = await Promise.all(cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/file-organization-browser.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  jsx: "automatic",
  loader: { ".css": "empty" },
  alias: {
    "next/link": resolve(repoRoot, "tests/helpers/next-link.mjs"),
    "next/navigation": resolve(repoRoot, "tests/helpers/next-navigation.mjs"),
  },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
const js = bundle.outputFiles[0].text;
const css = cssSources.map((source) => source.replace(/^@import[^;]+;\s*/gm, "")).join("\n");
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root { --font-geist-sans: Arial, sans-serif; }${css}</style></head><body><div class="app-shell reference-ui"><aside class="sidebar" aria-hidden="true"></aside><header class="desktop-topbar" aria-hidden="true"></header><main id="main-content" class="main-content"><div id="root"></div></main></div><script src="/fixture.js"></script></body></html>`;
const baseUrl = "https://file-organization.test";
await mkdir(screenshotDir, { recursive: true });

const launchOptions = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"] };
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";
const errors = [];
let browser;

async function preparePage(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ignoreHTTPSErrors: true,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) { await route.continue(); return; }
    if (url.pathname === "/fixture.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "cache-control": "no-store" }, body: js });
    } else if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204, body: "" });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: html });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(`pageerror at ${viewport.width}px: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console at ${viewport.width}px: ${message.text()}`); });
  await page.goto(`${baseUrl}/files?view=my-files&layout=list`);
  await page.getByRole("button", { name: "Open folder: BIO 201" }).waitFor({ state: "visible" });
  return { context, page };
}

async function inspectViewport(page, width) {
  const metrics = await page.evaluate(() => {
    const browser = document.querySelector(".files-browser");
    const content = document.querySelector(".files-browser-content");
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      browser: browser ? { left: browser.getBoundingClientRect().left, right: browser.getBoundingClientRect().right } : null,
      content: content ? { left: content.getBoundingClientRect().left, right: content.getBoundingClientRect().right } : null,
      nameColumn: document.querySelector(".files-items .files-item-main")?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.ok(metrics.browser, `Files Browser renders at ${width}px`);
  assert.ok(metrics.document <= width + 1, `document does not overflow at ${width}px (${metrics.document}px)`);
  assert.ok(metrics.body <= width + 1, `body does not overflow at ${width}px (${metrics.body}px)`);
  assert.ok(metrics.browser.left >= -1 && metrics.browser.right <= width + 1, `browser fits at ${width}px (${metrics.browser.left}–${metrics.browser.right})`);
  assert.ok(metrics.content?.left >= -1 && metrics.content.right <= width + 1, `browser content fits at ${width}px`);
  assert.ok(metrics.nameColumn >= 110, `file name control remains usable at ${width}px (${metrics.nameColumn}px)`);
  return metrics;
}

async function assertMenuInViewport(page, width) {
  const rect = await page.getByRole("menu").evaluate((menu) => {
    const { left, right, top, bottom } = menu.getBoundingClientRect();
    return { left, right, top, bottom, viewportHeight: window.innerHeight };
  });
  assert.ok(rect.left >= 0 && rect.right <= width, `menu fits horizontally at ${width}px (${rect.left}–${rect.right})`);
  assert.ok(rect.top >= 0 && rect.bottom <= rect.viewportHeight, `menu fits vertically at ${width}px (${rect.top}–${rect.bottom})`);
  return rect;
}

async function assertDialogTopmost(page, dialog, width) {
  await dialog.evaluate((element) => {
    const backdrop = element.closest(".file-organization-backdrop");
    for (const animation of backdrop?.getAnimations({ subtree: true }) ?? []) animation.finish();
  });
  const close = dialog.getByRole("button", { name: "Close Files dialog" });
  await close.scrollIntoViewIfNeeded();
  const evidence = await dialog.evaluate((element) => {
    const backdrop = element.closest(".file-organization-backdrop");
    const closeButton = element.querySelector(".files-details-heading button");
    const dialogRect = element.getBoundingClientRect();
    const backdropRect = backdrop?.getBoundingClientRect();
    const closeRect = closeButton?.getBoundingClientRect();
    const hit = closeRect ? document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2) : null;
    return {
      dialogOpacity: Number(getComputedStyle(element).opacity),
      backdropOpacity: backdrop ? Number(getComputedStyle(backdrop).opacity) : 0,
      dialog: { left: dialogRect.left, top: dialogRect.top, right: dialogRect.right, bottom: dialogRect.bottom },
      backdrop: backdropRect ? { left: backdropRect.left, top: backdropRect.top, right: backdropRect.right, bottom: backdropRect.bottom } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      close: closeRect ? { left: closeRect.left, top: closeRect.top, right: closeRect.right, bottom: closeRect.bottom, width: closeRect.width, height: closeRect.height } : null,
      closeIsTopmost: Boolean(closeButton && hit && closeButton.contains(hit)),
    };
  });
  assert.ok(evidence.dialogOpacity >= 0.99, `organization dialog is opaque (${JSON.stringify(evidence)})`);
  assert.ok(evidence.backdropOpacity >= 0.99, `organization backdrop is opaque (${JSON.stringify(evidence)})`);
  assert.ok(evidence.backdrop && Math.abs(evidence.backdrop.left) <= 1 && Math.abs(evidence.backdrop.top) <= 1
    && Math.abs(evidence.backdrop.right - width) <= 1 && Math.abs(evidence.backdrop.bottom - evidence.viewport.height) <= 1,
  `organization backdrop covers the viewport (${JSON.stringify(evidence)})`);
  assert.ok(evidence.dialog.left >= -1 && evidence.dialog.right <= width + 1
    && evidence.dialog.top >= -1 && evidence.dialog.bottom <= evidence.viewport.height + 1,
  `organization dialog fits in the viewport (${JSON.stringify(evidence)})`);
  assert.ok(evidence.close && evidence.close.width > 0 && evidence.close.height > 0
    && evidence.close.top >= -1 && evidence.close.bottom <= evidence.viewport.height + 1 && evidence.closeIsTopmost,
  `the close control remains visible and topmost (${JSON.stringify(evidence)})`);
  return evidence;
}

async function assertDialogFocusTrap(page, dialog) {
  const close = dialog.getByRole("button", { name: "Close Files dialog" });
  const lastFocusable = dialog.getByRole("button", { name: "Cancel", exact: true });
  const closeHandle = await close.elementHandle();
  const lastFocusableHandle = await lastFocusable.elementHandle();
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate((element) => document.activeElement === element, lastFocusableHandle), true,
    "Shift+Tab wraps from the first organization dialog control to the last enabled control");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate((element) => document.activeElement === element, closeHandle), true,
    "Tab wraps from the last organization dialog control to the first");
}

async function openNewFolderDialog(page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  const menu = page.getByRole("menu", { name: "New actions" });
  await menu.waitFor({ state: "visible" });
  await menu.getByRole("menuitem", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create folder" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function createFolder(page, name) {
  const dialog = await openNewFolderDialog(page);
  await dialog.getByRole("textbox", { name: "Folder name" }).fill(name);
  await dialog.getByRole("button", { name: "Create folder", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction((folderName) => window.__fileOrganizationFixture.getFolders().some((folder) => folder.name === folderName), name);
  return await page.evaluate((folderName) => {
    const found = window.__fileOrganizationFixture.getFolders().filter((folder) => folder.name === folderName);
    return found.at(-1);
  }, name);
}

async function inspectManagedCourseMenu(page) {
  await page.getByRole("button", { name: "More options for BIO 201" }).click();
  const menu = page.getByRole("menu", { name: "BIO 201 actions" });
  await menu.waitFor({ state: "visible" });
  await assertMenuInViewport(page, page.viewportSize().width);
  const actions = await menu.getByRole("menuitem").allTextContents().then((labels) => labels.map((label) => label.trim()));
  assert.ok(!actions.some((label) => /rename|move|trash/i.test(label)), `managed course root has no rename, move, or trash actions (${actions.join(", ")})`);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
}

async function smokeViewport(viewport) {
  const { context, page } = await preparePage(viewport);
  try {
    const metrics = await inspectViewport(page, viewport.width);
    console.log(`${viewport.width}px layout: ${JSON.stringify(metrics)}`);
    await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-root.png`), fullPage: true, animations: "disabled" });
    await inspectManagedCourseMenu(page);
    const menuButton = page.getByRole("button", { name: "New", exact: true });
    await menuButton.click();
    const menu = page.getByRole("menu", { name: "New actions" });
    await menu.waitFor({ state: "visible" });
    const menuItems = await menu.getByRole("menuitem").allTextContents().then((labels) => labels.map((label) => label.trim()));
    assert.ok(menuItems.includes("Upload files"), `New menu includes Upload files at ${viewport.width}px (${menuItems.join(", ")})`);
    assert.ok(menuItems.includes("New folder"), `New menu includes New folder at ${viewport.width}px`);
    await assertMenuInViewport(page, viewport.width);
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-new-menu.png"), animations: "disabled" });
    await menu.getByRole("menuitem", { name: "New folder", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create folder" });
    await dialog.waitFor({ state: "visible" });
    await assertDialogTopmost(page, dialog, viewport.width);
    await assertDialogFocusTrap(page, dialog);
    await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-create-folder-dialog.png`), animations: "disabled" });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const closeBounds = await dialog.getByRole("button", { name: "Close Files dialog" }).boundingBox();
    assert.ok(closeBounds && closeBounds.y >= 0 && closeBounds.y + closeBounds.height <= viewport.height,
      `dialog close remains visible after scrolling at ${viewport.width}px (${JSON.stringify(closeBounds)})`);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction((button) => document.activeElement === button, await menuButton.elementHandle());
    await inspectViewport(page, viewport.width);
    if (viewport.width === 390) await verifyMobileMoveDialog(page, viewport);
  } finally {
    await context.close();
  }
}

async function verifyMobileMoveDialog(page, viewport) {
  const historyFile = "History reading.pdf";
  const selection = page.getByRole("checkbox", { name: `Select ${historyFile} in My files` });
  await selection.check();
  const moveTrigger = page.getByRole("button", { name: "Move to…", exact: true });
  await moveTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Move to…" });
  await dialog.waitFor({ state: "visible" });
  await assertDialogTopmost(page, dialog, viewport.width);
  await assertDialogFocusTrap(page, dialog);
  await inspectViewport(page, viewport.width);
  await page.screenshot({ path: resolve(screenshotDir, "mobile-move-dialog.png"), animations: "disabled" });

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const currentMoveTrigger = document.querySelector('[data-files-selection-action="move"]');
    return Boolean(currentMoveTrigger && !currentMoveTrigger.matches(":disabled") && document.activeElement === currentMoveTrigger);
  });
  assert.equal(await moveTrigger.evaluate((button) => document.activeElement === button), true,
    "Escape from the mobile move dialog restores focus to the current selection toolbar Move action");

  await moveTrigger.click();
  dialog = page.getByRole("dialog", { name: "Move to…" });
  await dialog.waitFor({ state: "visible" });
  const target = dialog.locator(".file-organization-destination").filter({ hasText: "Move target" });
  await target.getByRole("button", { name: "Move here", exact: true }).click();
  const actions = dialog.locator(".file-organization-actions");
  const actionsBounds = await actions.boundingBox();
  assert.ok(actionsBounds && actionsBounds.y >= 0 && actionsBounds.y + actionsBounds.height <= viewport.height,
    `mobile move dialog footer remains in the viewport after choosing a destination (${JSON.stringify(actionsBounds)})`);
  const submit = dialog.getByRole("button", { name: "Move items", exact: true });
  assert.equal(await submit.isEnabled(), true);
  await submit.click();
  await dialog.waitFor({ state: "detached" });
  const moved = await page.evaluate(() => window.__fileOrganizationFixture.getFiles().find((file) => file.id === "33333333-3333-4333-8333-333333333333"));
  assert.equal(moved.folder_id, "20202020-2020-4020-8020-202020202020");
  assert.equal(moved.course_id, "history");
  assert.equal(moved.assignment_id, "history-reading");
  await inspectViewport(page, viewport.width);
}

async function openItemMenu(page, itemName) {
  await page.getByRole("button", { name: `More options for ${itemName}` }).click();
  const menu = page.getByRole("menu", { name: `${itemName} actions` });
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function fullOrganizationFlow() {
  const viewport = { name: "desktop-flow", width: 1440, height: 1024 };
  const { context, page } = await preparePage(viewport);
  try {
    await inspectViewport(page, viewport.width);
    const rootFolder = await createFolder(page, "New personal folder");
    assert.match(rootFolder.id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i,
      "the browser creates a stable UUID for a root custom folder");
    assert.equal(rootFolder.parent_id, null);
    const duplicateA = await createFolder(page, "Repeated name");
    const duplicateB = await createFolder(page, "Repeated name");
    assert.equal(duplicateA.name, duplicateB.name);
    assert.notEqual(duplicateA.id, duplicateB.id, "duplicate folder names keep distinct UUID identities");
    assert.equal(duplicateA.parent_id, null);
    assert.equal(duplicateB.parent_id, null);

    await page.getByRole("button", { name: "Open folder: BIO 201" }).click();
    const courseFolder = await page.evaluate(() => window.__fileOrganizationFixture.getFolders().find((folder) => folder.course_id === "biology" && folder.kind === "course"));
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menu", { name: "New actions" }).getByRole("menuitem", { name: "Upload files", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__fileOrganizationFixture.getUploads()), [{ folderId: courseFolder.id, courseId: "biology" }],
      "the New menu's Upload files action preserves the active course folder and course");
    const courseNested = await createFolder(page, "BIO 201 notes");
    assert.equal(courseNested.parent_id, courseFolder.id, "a folder created inside a managed course root is nested under that stable course folder");
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" }).click();

    await page.getByRole("button", { name: "Open folder: Organization" }).click();
    const branch = await createFolder(page, "Added branch");
    assert.equal(branch.parent_id, FOLDER_ID.organization);
    await page.getByRole("button", { name: "Open folder: Added branch" }).click();
    const deep = await createFolder(page, "Added deep folder");
    assert.equal(deep.parent_id, branch.id);
    assert.equal((await page.evaluate(() => window.__fileOrganizationFixture.getFolders().find((folder) => folder.name === "Added branch"))).parent_id, FOLDER_ID.organization);
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" }).click();
    await inspectViewport(page, viewport.width);

    const renamedFolderMenu = await openItemMenu(page, "Folder before rename");
    assert.ok((await renamedFolderMenu.getByRole("menuitem").allTextContents()).some((label) => label.includes("Rename folder")));
    await renamedFolderMenu.getByRole("menuitem", { name: "Rename folder", exact: true }).click();
    const folderRename = page.getByRole("dialog", { name: "Rename folder" });
    await folderRename.waitFor({ state: "visible" });
    await assertDialogTopmost(page, folderRename, viewport.width);
    await page.screenshot({ path: resolve(screenshotDir, "desktop-rename-folder-dialog.png"), animations: "disabled" });
    await folderRename.getByRole("textbox", { name: "Name" }).fill("Folder after rename");
    await folderRename.getByRole("button", { name: "Rename", exact: true }).click();
    await folderRename.waitFor({ state: "detached" });
    const renamedFolder = await page.evaluate(() => window.__fileOrganizationFixture.getFolders().find((folder) => folder.id === "19191919-1919-4191-8191-191919191919"));
    assert.equal(renamedFolder.name, "Folder after rename");
    assert.equal(renamedFolder.revision, 2);
    const folderRenameRequest = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/file-folders" && request.method === "PUT").at(-1));
    assert.equal(folderRenameRequest.body.action, "rename");
    assert.equal(folderRenameRequest.body.id, renamedFolder.id);

    await page.getByRole("button", { name: "Open folder: Folder after rename" }).click();
    const oldNameRow = page.locator(".files-item.is-file").filter({ hasText: "Planning notes.txt" });
    await oldNameRow.waitFor({ state: "visible" });
    const fileMenu = await openItemMenu(page, "Planning notes.txt");
    await fileMenu.getByRole("menuitem", { name: "Rename file", exact: true }).click();
    const fileRename = page.getByRole("dialog", { name: "Rename file" });
    await fileRename.waitFor({ state: "visible" });
    await assertDialogTopmost(page, fileRename, viewport.width);
    await page.screenshot({ path: resolve(screenshotDir, "desktop-rename-file-dialog.png"), animations: "disabled" });
    await fileRename.getByRole("textbox", { name: "Name" }).fill("Planning notes renamed.txt");
    await fileRename.getByRole("button", { name: "Rename", exact: true }).click();
    await fileRename.waitFor({ state: "detached" });
    const fileAfterRename = await page.evaluate(() => window.__fileOrganizationFixture.getFiles().find((file) => file.id === "32323232-3232-4232-8232-323232323232"));
    const bodyAfterRename = await page.evaluate(() => window.__fileOrganizationFixture.getDocuments().find((document) => document.id === "32323232-3232-4232-8232-323232323232").body);
    assert.equal(fileAfterRename.name, "Planning notes renamed.txt");
    assert.equal(fileAfterRename.metadata_revision, 2);
    assert.equal(fileAfterRename.course_id, "history");
    assert.equal(fileAfterRename.assignment_id, "history-reading");
    assert.equal(bodyAfterRename, "Planning body survives a metadata-only rename.\nSecond line: π and résumé.");
    const numericRenameRequest = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path.startsWith("/api/files?id=") && request.method === "PUT").at(-1));
    assert.equal(numericRenameRequest.body.action, "rename");
    assert.equal(numericRenameRequest.body.baseMetadataRevision, 1, "the file rename route receives the numeric metadata revision");
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" }).click();

    await page.getByRole("checkbox", { name: "Select Organization in My files" }).check();
    await page.getByRole("checkbox", { name: "Select History reading.pdf in My files" }).check();
    assert.match(await page.locator(".files-selection-toolbar").innerText(), /2 items selected/);
    await page.getByRole("button", { name: "Move to…", exact: true }).click();
    let moveDialog = page.getByRole("dialog", { name: "Move to…" });
    await moveDialog.waitFor({ state: "visible" });
    await assertDialogTopmost(page, moveDialog, viewport.width);
    assert.match(await moveDialog.innerText(), /2 selected items/);
    assert.match(await moveDialog.locator(".file-organization-selection-note").innerText(), /2 items selected\. Items inside selected folders stay together/);
    assert.match(await moveDialog.innerText(), /Course and assignment links stay with each file/);
    await page.screenshot({ path: resolve(screenshotDir, "desktop-move-dialog.png"), animations: "disabled" });
    const moveTarget = moveDialog.locator(".file-organization-destination").filter({ hasText: "Move target" });
    await moveTarget.getByRole("button", { name: "Move here", exact: true }).click();
    const submitMove = moveDialog.getByRole("button", { name: "Move items", exact: true });
    assert.equal(await submitMove.isEnabled(), true);
    await submitMove.click();
    await moveDialog.waitFor({ state: "detached" });
    const moveRequest = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/files/actions" && request.method === "POST").at(-1));
    assert.equal(moveRequest.body.action, "move");
    assert.equal(moveRequest.body.destinationId, "20202020-2020-4020-8020-202020202020");
    assert.deepEqual(moveRequest.body.items.map((item) => item.type).sort(), ["file", "folder"]);
    const afterMove = await page.evaluate(() => ({
      folders: window.__fileOrganizationFixture.getFolders(),
      files: window.__fileOrganizationFixture.getFiles(),
      docs: window.__fileOrganizationFixture.getDocuments(),
    }));
    const movedOrganization = afterMove.folders.find((folder) => folder.id === "16161616-1616-4161-8161-161616161616");
    const movedHistoryFile = afterMove.files.find((file) => file.id === "33333333-3333-4333-8333-333333333333");
    const nestedBiologyFile = afterMove.files.find((file) => file.id === "31313131-3131-4131-8131-313131313131");
    assert.equal(movedOrganization.parent_id, "20202020-2020-4020-8020-202020202020");
    assert.equal(movedHistoryFile.folder_id, "20202020-2020-4020-8020-202020202020");
    assert.equal(movedHistoryFile.course_id, "history");
    assert.equal(movedHistoryFile.assignment_id, "history-reading");
    assert.equal(nestedBiologyFile.folder_id, movedOrganization.id, "a file under the selected folder stays in that folder as the tree moves");
    assert.equal(nestedBiologyFile.course_id, "biology");
    assert.equal(nestedBiologyFile.assignment_id, "biology-lab");
    assert.equal(afterMove.docs.find((document) => document.id === nestedBiologyFile.id).body,
      "Biology lab notes remain intact after folder moves and renames.\nAssignment: experiment 4 — café, 中文, ✓");
    assert.deepEqual(await page.evaluate(() => window.__fileOrganizationFixture.getUploadBytes("33333333-3333-4333-8333-333333333333")),
      [37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 127, 255, 13, 10]);
    await page.getByRole("button", { name: "Open folder: Move target" }).click();
    const historyRow = page.locator(".files-item.is-file").filter({ hasText: "History reading.pdf" });
    await historyRow.waitFor({ state: "visible" });
    const historyBadges = await historyRow.locator(".files-association-badges").innerText();
    assert.match(historyBadges, /HIST 104/);
    assert.match(historyBadges, /History Reading/);
    await page.getByRole("button", { name: "Open folder: Organization" }).click();
    const biologyRow = page.locator(".files-item.is-file").filter({ hasText: "Biology lab notes.txt" });
    await biologyRow.waitFor({ state: "visible" });
    const biologyBadges = await biologyRow.locator(".files-association-badges").innerText();
    assert.match(biologyBadges, /BIO 201/);
    assert.match(biologyBadges, /Biology Lab 4/);
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" }).click();

    const beforeDragActions = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/files/actions").length);
    const dragSource = page.locator(".files-item.is-folder").filter({ hasText: "Drag candidate" });
    const dragTarget = page.locator(".files-item.is-folder").filter({ hasText: "Move target" });
    await dragSource.dragTo(dragTarget);
    await page.waitForFunction(() => window.__fileOrganizationFixture.getFolders().find((folder) => folder.id === "21212121-2121-4121-8121-212121212121").parent_id === "20202020-2020-4020-8020-202020202020");
    await page.getByRole("button", { name: "Open folder: Move target" }).click();
    const nestedDrag = page.locator(".files-item.is-folder").filter({ hasText: "Drag candidate" });
    const rootBreadcrumb = page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" });
    await nestedDrag.dragTo(rootBreadcrumb);
    await page.waitForFunction(() => window.__fileOrganizationFixture.getFolders().find((folder) => folder.id === "21212121-2121-4121-8121-212121212121").parent_id === null);
    await rootBreadcrumb.click();
    const afterInternalDrags = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/files/actions").length);
    assert.equal(afterInternalDrags, beforeDragActions + 2, "dropping a folder on another folder and the My files root performs two internal moves");

    const targetHandle = await page.locator(".files-item.is-folder").filter({ hasText: "Move target" }).elementHandle();
    const beforeExternalDrop = await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/files/actions").length);
    await page.evaluate((target) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["external file data"], "external.txt", { type: "text/plain" }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    }, targetHandle);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__fileOrganizationFixture.requests.filter((request) => request.path === "/api/files/actions").length), beforeExternalDrop,
      "a dropped local file is ignored by the folder move handler");
    assert.equal(await page.evaluate(() => window.__fileOrganizationFixture.getFiles().some((file) => file.name === "external.txt")), false);
    await page.screenshot({ path: resolve(screenshotDir, "desktop-final-root.png"), fullPage: true, animations: "disabled" });
    assert.deepEqual(errors, [], errors.join("\n"));
  } finally {
    await context.close();
  }
}

try {
  browser = await playwright.chromium.launch(launchOptions);
  const viewports = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "compact-desktop", width: 1024, height: 900 },
    { name: "tablet", width: 820, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ];
  for (const viewport of viewports) await smokeViewport(viewport);
  await fullOrganizationFlow();
  assert.deepEqual(errors, [], errors.join("\n"));
  console.log(`File organization browser verification passed at ${viewports.map(({ width }) => `${width}px`).join(", ")}. Screenshots: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
}
