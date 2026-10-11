import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-files-bulk");
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
  "app/file-organization-dialogs.css",
  "app/files-trash-dialog.css",
  "app/file-upload-dialog.css",
];
const cssSources = await Promise.all(cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/files-bulk-browser.tsx")],
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
const baseUrl = "https://files-bulk.test";
const widths = [1440, 1024, 820, 390];
await mkdir(screenshotDir, { recursive: true });

const launchOptions = {
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
};
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";

let browser;
const errors = [];
const pageContexts = new Set();

async function newPage(width = 1440, options = {}) {
  const isMobile = width <= 390;
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile,
    hasTouch: isMobile,
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  pageContexts.add(context);
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) { await route.fulfill({ status: 204, body: "" }); return; }
    if (url.pathname === "/fixture.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "cache-control": "no-store" }, body: js });
    } else if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204, body: "" });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: html });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(`pageerror at ${width}px: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console at ${width}px: ${message.text()}`); });
  if (options.captureDownloads) {
    const downloads = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    page.__capturedDownloads = downloads;
  }
  await page.goto(`${baseUrl}/files?view=my-files&layout=list`);
  await page.locator(".files-items .files-item").first().waitFor({ state: "visible" });
  assert.equal(await page.getByRole("group", { name: "Bulk file actions" }).count(), 0, "the zero-selected bulk toolbar stays hidden");
  return { context, page };
}

async function fixture(page, method, ...args) {
  return page.evaluate(({ methodName, methodArgs }) => {
    const api = window.__filesBulkFixture;
    return api[methodName](...methodArgs);
  }, { methodName: method, methodArgs: args });
}

async function requests(page) {
  return page.evaluate(() => structuredClone(window.__filesBulkFixture.requests));
}

async function uploads(page) {
  return fixture(page, "getUploads");
}

async function accountState(page, method, profileId) {
  return fixture(page, method, profileId);
}

async function rows(page) {
  return page.locator(".files-items .files-item").evaluateAll((items) => items.map((item) => item.querySelector(".files-item-title strong")?.textContent?.trim() ?? ""));
}

async function findCheckbox(page, name, viewLabel = "My files", occurrence = 0) {
  const checkboxes = page.getByRole("checkbox", { name: `Select ${name} in ${viewLabel}`, exact: true });
  assert.ok(await checkboxes.count() > occurrence, `checkbox for ${name} in ${viewLabel} exists (found ${await checkboxes.count()})`);
  return checkboxes.nth(occurrence);
}

async function selectItem(page, name, { viewLabel = "My files", occurrence = 0, input = "keyboard" } = {}) {
  const checkbox = await findCheckbox(page, name, viewLabel, occurrence);
  if (input === "touch") {
    await checkbox.locator("xpath=..").tap();
  } else {
    await checkbox.focus();
    await checkbox.press("Space");
  }
  await page.waitForFunction(({ name, viewLabel, occurrence }) => {
    const matches = [...document.querySelectorAll(".files-items input[type=checkbox]")]
      .filter((input) => input.getAttribute("aria-label") === `Select ${name} in ${viewLabel}`);
    return Boolean(matches[occurrence]?.checked);
  }, { name, viewLabel, occurrence });
}

async function selectionCount(page, count) {
  const expected = new RegExp(`^${count} ${count === 1 ? "item" : "items"} selected$`);
  const locator = page.locator(".files-selection-toolbar > span[aria-live]").getByText(expected);
  try { await locator.waitFor({ state: "visible" }); }
  catch {
    const actual = await page.locator(".files-selection-toolbar > span[aria-live]").textContent().catch(() => null);
    const checks = await page.locator(".files-items input[type=checkbox]").evaluateAll((items) => items.map((input) => ({ label: input.getAttribute("aria-label"), checked: input.checked, disabled: input.disabled })));
    throw new Error(`Expected selection count ${count}, found ${String(actual)}; checkboxes=${JSON.stringify(checks)}`);
  }
}

async function clearSelection(page) {
  const button = page.getByRole("button", { name: "Clear selection", exact: true });
  if (await button.isVisible() && await button.isEnabled()) await button.click();
  await page.getByRole("group", { name: "Bulk file actions" }).waitFor({ state: "detached" });
}

async function clickView(page, name) {
  const viewName = name === "My files" ? "Files" : name;
  await page.getByRole("navigation", { name: "File views" }).getByRole("button", { name: viewName, exact: true }).click();
}

async function selectVisible(page, currentLocation) {
  await page.getByRole("button", { name: `Actions for ${currentLocation}`, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Select visible", exact: true }).click();
}

async function noOverflow(page, width) {
  const metrics = await page.evaluate(() => {
    const browser = document.querySelector(".files-browser");
    const content = document.querySelector(".files-browser-content");
    const rect = browser?.getBoundingClientRect();
    const contentRect = content?.getBoundingClientRect();
    const action = document.querySelector(".files-selection-toolbar")?.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      browser: rect ? { left: rect.left, right: rect.right } : null,
      content: contentRect ? { left: contentRect.left, right: contentRect.right } : null,
      toolbar: action ? { left: action.left, right: action.right } : null,
    };
  });
  assert.ok(metrics.document <= width + 1, `document fits ${width}px: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.body <= width + 1, `body fits ${width}px: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.browser && metrics.browser.left >= -1 && metrics.browser.right <= width + 1, `Files browser fits ${width}px: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.content && metrics.content.left >= -1 && metrics.content.right <= width + 1, `Files content fits ${width}px: ${JSON.stringify(metrics)}`);
  if (metrics.toolbar) assert.ok(metrics.toolbar.left >= -1 && metrics.toolbar.right <= width + 1, `selection toolbar fits ${width}px: ${JSON.stringify(metrics)}`);
  return metrics;
}

async function menuEvidence(page, width) {
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const first = document.querySelector("[role='menu'] [role='menuitem']:not([aria-disabled='true'])");
    return first === document.activeElement;
  });
  const rect = await menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: window.innerHeight };
  });
  assert.ok(rect.left >= 0 && rect.right <= width, `menu fits horizontally at ${width}px: ${JSON.stringify(rect)}`);
  assert.ok(rect.top >= 0 && rect.bottom <= rect.height, `menu fits vertically at ${width}px: ${JSON.stringify(rect)}`);
  return rect;
}

async function dialogEvidence(page, dialog, width) {
  const evidence = await dialog.evaluate((element) => {
    for (const animation of element.closest(".files-dialog-backdrop, .files-upload-backdrop")?.getAnimations({ subtree: true }) ?? []) animation.finish();
    const backdrop = element.closest(".files-dialog-backdrop, .files-upload-backdrop");
    const close = element.querySelector(".files-details-heading button, .files-upload-close");
    const bounds = element.getBoundingClientRect();
    const backdropBounds = backdrop?.getBoundingClientRect();
    const closeBounds = close?.getBoundingClientRect();
    const hit = closeBounds ? document.elementFromPoint(closeBounds.left + closeBounds.width / 2, closeBounds.top + closeBounds.height / 2) : null;
    return {
      dialog: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, opacity: Number(getComputedStyle(element).opacity) },
      backdrop: backdropBounds ? { left: backdropBounds.left, top: backdropBounds.top, right: backdropBounds.right, bottom: backdropBounds.bottom, opacity: Number(getComputedStyle(backdrop).opacity) } : null,
      close: closeBounds ? { left: closeBounds.left, top: closeBounds.top, right: closeBounds.right, bottom: closeBounds.bottom, width: closeBounds.width, height: closeBounds.height } : null,
      closeIsTopmost: Boolean(close && hit && close.contains(hit)),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  assert.ok(evidence.dialog.opacity >= 0.99, `dialog is opaque: ${JSON.stringify(evidence)}`);
  assert.ok(evidence.backdrop && evidence.backdrop.opacity >= 0.99, `dialog backdrop is opaque: ${JSON.stringify(evidence)}`);
  assert.ok(evidence.backdrop && Math.abs(evidence.backdrop.left) <= 1 && Math.abs(evidence.backdrop.top) <= 1 && Math.abs(evidence.backdrop.right - width) <= 1 && Math.abs(evidence.backdrop.bottom - evidence.viewport.height) <= 1,
    `dialog backdrop covers ${width}px viewport: ${JSON.stringify(evidence)}`);
  assert.ok(evidence.dialog.left >= -1 && evidence.dialog.top >= -1 && evidence.dialog.right <= width + 1 && evidence.dialog.bottom <= evidence.viewport.height + 1,
    `dialog fits ${width}px viewport: ${JSON.stringify(evidence)}`);
  assert.ok(evidence.close?.width && evidence.close.height && evidence.closeIsTopmost, `dialog close control is visible and topmost: ${JSON.stringify(evidence)}`);
  return evidence;
}

async function screenshot(page, name, { fullPage = true } = {}) {
  const path = resolve(screenshotDir, name);
  await page.screenshot({ path, fullPage, animations: "disabled" });
  return path;
}

async function openNewUpload(page) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Upload files", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Upload files" });
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function setFileInput(dialog, files) {
  await dialog.locator('input[type="file"]').setInputFiles(files);
}

async function waitUploadRow(page, name, state) {
  const row = page.locator(".files-upload-row").filter({ hasText: name }).first();
  await row.waitFor({ state: "visible" });
  await row.evaluate((element, status) => new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      if (element.classList.contains(`is-${status}`)) return resolve();
      if (performance.now() - started > 15000) return reject(new Error(`Upload ${element.textContent?.trim()} did not reach ${status}`));
      requestAnimationFrame(tick);
    };
    tick();
  }), state);
  return row;
}

async function verifyResponsive(width) {
  const { context, page } = await newPage(width);
  const touch = width === 390;
  const evidence = { width, touch, screenshots: [] };
  try {
    evidence.metrics = await noOverflow(page, width);
    const input = touch ? "touch" : "keyboard";
    await selectItem(page, "Project Alpha", { input });
    await selectItem(page, "Move me.txt", { input });
    await selectionCount(page, 2);
    evidence.screenshots.push(await screenshot(page, `w${width}-selection.png`));

    await page.getByRole("button", { name: "New", exact: true }).click();
    evidence.menu = await menuEvidence(page, width);
    evidence.screenshots.push(await screenshot(page, `w${width}-new-menu.png`, { fullPage: false }));
    await page.getByRole("menuitem", { name: "Upload files", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upload files" });
    await dialog.waitFor({ state: "visible" });
    await dialogEvidence(page, dialog, width);
    const first = `held-${width}.txt`;
    const second = `retry-${width}.txt`;
    await fixture(page, "setUploadPlan", first, "hold");
    await fixture(page, "setUploadPlan", second, "fail-once");
    await setFileInput(dialog, [
      { name: first, mimeType: "text/plain", buffer: Buffer.from(`held upload ${width}`) },
      { name: second, mimeType: "text/plain", buffer: Buffer.from(`retry upload ${width}`) },
    ]);
    await page.getByRole("progressbar", { name: `${first} upload progress` }).waitFor({ state: "visible" });
    await page.waitForFunction((name) => {
      const progress = document.querySelector(`progress[aria-label="${name} upload progress"]`);
      return Boolean(progress && progress.value > 0 && progress.value < 100);
    }, first);
    evidence.progress = await dialogEvidence(page, dialog, width);
    evidence.screenshots.push(await screenshot(page, `w${width}-upload-progress.png`, { fullPage: false }));
    await fixture(page, "releaseUpload", first);
    await waitUploadRow(page, first, "complete");
    await waitUploadRow(page, second, "error");
    evidence.screenshots.push(await screenshot(page, `w${width}-upload-failure.png`, { fullPage: false }));
    const beforeRetry = await uploads(page);
    assert.equal(beforeRetry.filter((record) => record.name === second).length, 1, `one failed upload was attempted at ${width}px`);
    await dialog.getByRole("button", { name: "Retry upload", exact: true }).click();
    await waitUploadRow(page, second, "complete");
    const allUploadRecords = await uploads(page);
    const attempts = allUploadRecords.filter((record) => record.name === second);
    assert.equal(attempts.length, 2, `failed file retries exactly once at ${width}px`);
    assert.equal(attempts[0].id, attempts[1].id, `retry keeps the upload ID at ${width}px`);
    assert.equal(attempts[0].profileId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", `upload stays on captured profile at ${width}px`);
    assert.equal(attempts[0].contentType, "application/octet-stream", `upload uses the byte upload content type at ${width}px`);
    assert.ok(await fixture(page, "sameUploadFileReference", second), `retry sends the same File object at ${width}px`);
    evidence.uploadAttempts = attempts.map(({ id, attempt, profileId, metadata }) => ({ id, attempt, profileId, metadata }));
    await dialog.locator(".files-upload-footer").getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
    const trashDialog = page.locator(".files-trash-dialog");
    await trashDialog.waitFor({ state: "visible" });
    evidence.trashDialog = await dialogEvidence(page, trashDialog, width);
    evidence.screenshots.push(await screenshot(page, `w${width}-bulk-confirmation.png`, { fullPage: false }));
    assert.match(await trashDialog.innerText(), /2 items selected/);
    await trashDialog.getByRole("button", { name: "Close", exact: true }).click();
    await trashDialog.waitFor({ state: "hidden" });
    evidence.after = await noOverflow(page, width);
    return evidence;
  } finally {
    await context.close();
    pageContexts.delete(context);
  }
}

function localZipNames(bytes) {
  const buffer = Buffer.from(bytes);
  assert.ok(buffer.length >= 22, `ZIP is long enough to contain EOCD (${buffer.length} bytes)`);
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, "ZIP ends with an EOCD record");
  const names = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    names.push(buffer.toString("utf8", nameStart, nameStart + nameLength));
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  assert.ok(names.length > 0, "ZIP has at least one local entry");
  return names;
}

async function triggerDownload(page) {
  const download = page.waitForEvent("download", { timeout: 15000 });
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  return download;
}

async function verifyCourseDownload(page) {
  await selectItem(page, "BIO 201");
  await selectItem(page, "Loose read.txt");
  await selectionCount(page, 2);
  const group = page.getByRole("group", { name: "Bulk file actions" });
  assert.equal(await group.getByRole("button", { name: "Move to…", exact: true }).isDisabled(), true, "course root is not movable" );
  assert.equal(await group.getByRole("button", { name: "Move to Trash", exact: true }).isDisabled(), true, "course root cannot be trashed" );
  assert.equal(await group.getByRole("button", { name: "Download ZIP", exact: true }).isEnabled(), true, "managed course root remains downloadable" );
  const download = await triggerDownload(page);
  assert.equal(download.suggestedFilename(), "eduessentials-selected-files.zip");
  const mutation = (await requests(page)).filter((request) => request.path === "/api/files/download").at(-1);
  assert.ok(mutation, "selected ZIP download posts to the Files ZIP route");
  assert.equal(mutation.method, "POST");
  assert.equal(mutation.profileId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(mutation.headers["content-type"], "application/json");
  const submitted = mutation.body?.items;
  assert.ok(Array.isArray(submitted) && submitted.length === 2, `download submits the selected rows: ${JSON.stringify(submitted)}`);
  assert.deepEqual(new Set(submitted.map((item) => `${item.type}:${item.id}`)), new Set([
    "folder:11111111-1111-4111-8111-111111111111",
    "file:35353535-3535-4353-8353-353535353535",
  ]));
  const capture = await fixture(page, "getZipCapture");
  assert.equal(capture.type, "application/zip");
  const names = localZipNames(capture.bytes);
  assert.ok(names.includes("BIO 201/"), `course folder appears in ZIP: ${names.join(", ")}`);
  assert.ok(names.includes("BIO 201/Course plan.pdf"), `course file appears in ZIP: ${names.join(", ")}`);
  assert.ok(names.includes("Loose read.txt"), `loose file appears in ZIP: ${names.join(", ")}`);
  await clearSelection(page);
  return { filename: download.suggestedFilename(), names, zipBytes: capture.size, request: mutation };
}

async function verifyInterruptedZipRetry(page) {
  await selectItem(page, "Shared label", { occurrence: 0 });
  await selectItem(page, "Shared label", { occurrence: 1 });
  await selectionCount(page, 2);
  const zipCountBefore = await fixture(page, "getZipCaptureCount");
  const clicksBefore = (await fixture(page, "getAnchorClicks")).length;
  const requestCountBefore = (await requests(page)).filter((request) => request.path === "/api/files/download").length;
  await fixture(page, "setDownloadPlan", "interrupt");
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  await page.locator(".files-download-error").waitFor({ state: "visible" });
  assert.match(await page.locator(".files-download-error").innerText(), /interrupted|incomplete|footer/i);
  assert.equal(await fixture(page, "getZipCaptureCount"), zipCountBefore, "interrupted response never reaches object URL creation");
  assert.equal((await fixture(page, "getAnchorClicks")).length, clicksBefore, "interrupted response never clicks a download anchor");
  await selectionCount(page, 2);
  const beforeRetry = (await requests(page)).filter((request) => request.path === "/api/files/download");
  assert.equal(beforeRetry.length, requestCountBefore + 1, "interrupted ZIP attempt posts once");
  const retryDownload = page.waitForEvent("download", { timeout: 15000 });
  await page.getByRole("button", { name: "Retry download", exact: true }).click();
  const download = await retryDownload;
  assert.equal(download.suggestedFilename(), "eduessentials-selected-files.zip");
  const attempts = (await requests(page)).filter((request) => request.path === "/api/files/download");
  assert.equal(attempts.length, requestCountBefore + 2, "retry creates a second exact ZIP request");
  assert.deepEqual(attempts.at(-2).body, attempts.at(-1).body, "ZIP retry retains the same item IDs and revisions");
  const entries = await fixture(page, "getPlannedZipEntries");
  assert.ok(entries.includes("Shared label/"), `first duplicate folder gets a safe root name: ${entries.join(", ")}`);
  assert.ok(entries.includes("Shared label (2)/"), `second duplicate folder is disambiguated in the archive: ${entries.join(", ")}`);
  assert.ok(entries.includes("Shared label/notes.txt") && entries.includes("Shared label (2)/notes.txt"), `folder contents receive safe relative paths: ${entries.join(", ")}`);
  assert.equal(await fixture(page, "getZipCaptureCount"), zipCountBefore + 1, "only the complete retry creates a ZIP blob");
  assert.equal((await fixture(page, "getAnchorClicks")).length, clicksBefore + 1, "only the complete retry clicks a download anchor");
  const capture = await fixture(page, "getZipCapture");
  assert.deepEqual(localZipNames(capture.bytes), entries, "downloaded ZIP bytes contain every planned local entry");
  const storedFolders = await accountState(page, "getFolders");
  assert.equal(storedFolders.filter((folder) => folder.name === "Shared label").length, 2, "archive disambiguation does not rename stored folders");
  return { entries, attempts: attempts.slice(-2).map((request) => request.body), zipBytes: capture.size };
}

async function verifyOverlapAndManagedPins(page) {
  await page.getByRole("combobox", { name: "Search scope" }).selectOption("all");
  await page.getByRole("searchbox", { name: "Search files" }).fill("Project");
  await page.waitForFunction(() => document.querySelectorAll(".files-items .files-item").length >= 2);
  const visible = await rows(page);
  assert.ok(visible.includes("Project Alpha") && visible.includes("Project brief.txt"), `global search exposes overlapping parent and file rows: ${visible.join(", ")}`);
  await selectItem(page, "Project Alpha", { viewLabel: "My files" });
  await selectItem(page, "Project brief.txt", { viewLabel: "My files / Project Alpha" });
  await selectionCount(page, 2);
  const download = await triggerDownload(page);
  assert.equal(download.suggestedFilename(), "eduessentials-selected-files.zip");
  const entries = await fixture(page, "getPlannedZipEntries");
  assert.equal(entries.filter((name) => name.endsWith("Project brief.txt")).length, 1, `overlapping folder/file selection is deduplicated: ${entries.join(", ")}`);
  assert.ok(entries.includes("Project Alpha/Project brief.txt"), `folder selection keeps the relative folder path: ${entries.join(", ")}`);
  await clearSelection(page);
  await page.getByRole("searchbox", { name: "Search files" }).fill("");
  await page.getByRole("button", { name: "Open folder: BIO 201", exact: true }).click();
  await page.locator(".files-syllabus-pin").waitFor({ state: "visible" });
  assert.equal(await page.locator(".files-syllabus-pin input[type=checkbox]").count(), 0, "attached syllabus action is not a bulk-selectable file row");
  await selectVisible(page, "BIO 201");
  await selectionCount(page, 1);
  assert.equal(await page.getByRole("checkbox", { name: /Attached syllabus.pdf/ }).count(), 0, "attached syllabus virtual row never appears in bulk selection");
  await clearSelection(page);
  await clickView(page, "My files");
  await page.getByRole("button", { name: "Open folder: CHEM 102", exact: true }).click();
  await page.getByText("No syllabus attached", { exact: false }).waitFor({ state: "visible" });
  assert.equal(await page.locator(".files-syllabus-pin input[type=checkbox]").count(), 0, "empty pinned syllabus placeholder has no bulk checkbox");
  return { overlapEntries: entries, biologySelectableCount: 1, chemistryPinCheckboxes: 0 };
}

async function verifyCourseUpload(page) {
  await clickView(page, "My files");
  await page.getByRole("button", { name: "Open folder: BIO 201", exact: true }).click();
  const dialog = await openNewUpload(page);
  const name = "bio-course-upload.txt";
  await setFileInput(dialog, [{ name, mimeType: "text/plain", buffer: Buffer.from("course-linked bytes") }]);
  await waitUploadRow(page, name, "complete");
  const record = (await uploads(page)).find((item) => item.name === name);
  assert.ok(record, "course upload creates a canonical upload request");
  assert.equal(record.metadata.folderId, "11111111-1111-4111-8111-111111111111");
  assert.equal(record.metadata.courseId, "biology");
  assert.equal(record.profileId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await dialog.locator(".files-upload-footer").getByRole("button", { name: "Close", exact: true }).click();
  return record;
}

async function verifyBulkMoveAndDrop(page) {
  await clickView(page, "My files");
  await page.getByRole("button", { name: "Open folder: Project Alpha", exact: true }).click();
  const uploadBefore = (await uploads(page)).length;
  await fixture(page, "dispatchExternalDrop", "Nested", "child-row-drop.txt", "drop onto nested child row");
  const dropDialog = page.getByRole("dialog", { name: "Upload files" });
  await dropDialog.waitFor({ state: "visible" });
  await waitUploadRow(page, "child-row-drop.txt", "complete");
  const dropRecord = (await uploads(page)).at(-1);
  assert.equal((await uploads(page)).length, uploadBefore + 1, "one device-file drop becomes one upload");
  assert.equal(dropRecord.name, "child-row-drop.txt");
  assert.equal(dropRecord.metadata.folderId, "22222222-2222-4222-8222-222222222222", "dropping on a child row uses the current folder rather than the child destination");
  assert.equal(dropRecord.metadata.courseId, "", "custom-folder drop does not invent a managed course association");
  await dropDialog.locator(".files-upload-footer").getByRole("button", { name: "Close", exact: true }).click();
  await clickView(page, "My files");

  const source = page.locator(".files-items .files-item").filter({ hasText: "Move me.txt" }).first();
  const target = page.locator(".files-items .files-item").filter({ hasText: "Destination" }).first();
  await source.dragTo(target);
  await page.waitForFunction(() => window.__filesBulkFixture.requests.some((request) => request.method === "POST" && request.path === "/api/files/actions" && request.body?.action === "move" && request.body.items.some((item) => item.id === "36363636-3636-4363-8363-363636363636")));
  assert.equal(await page.getByRole("dialog", { name: "Upload files" }).count(), 0, "internal drag remains a move instead of opening the upload queue");
  const movedFile = (await accountState(page, "getFiles")).find((file) => file.id === "36363636-3636-4363-8363-363636363636");
  assert.equal(movedFile.folder_id, "24242424-2424-4424-8424-242424242424");
  assert.equal(movedFile.course_id, "biology", "moving a file preserves its course association");
  assert.equal(movedFile.assignment_id, "51515151-5151-4151-8151-515151515151", "moving a file preserves its assignment association");

  await selectItem(page, "Project Alpha");
  await selectItem(page, "Shared label", { occurrence: 0 });
  await selectionCount(page, 2);
  await page.getByRole("button", { name: "Move to…", exact: true }).click();
  const moveDialog = page.getByRole("dialog", { name: "Move to…" });
  await moveDialog.waitFor({ state: "visible" });
  await dialogEvidence(page, moveDialog, 1440);
  const destination = moveDialog.locator(".file-organization-destination").filter({ hasText: /^.*Destination/ });
  await destination.getByRole("button", { name: "Move here", exact: true }).click();
  await moveDialog.getByRole("button", { name: "Move items", exact: true }).click();
  await moveDialog.waitFor({ state: "hidden" });
  const mutations = (await requests(page)).filter((request) => request.method === "POST" && request.path === "/api/files/actions");
  const bulkMove = mutations.at(-1);
  assert.equal(bulkMove.body.action, "move");
  assert.equal(bulkMove.body.destinationId, "24242424-2424-4424-8424-242424242424");
  assert.deepEqual(new Set(bulkMove.body.items.map((item) => `${item.type}:${item.id}`)), new Set([
    "folder:22222222-2222-4222-8222-222222222222",
    "folder:26262626-2626-4626-8626-262626262626",
  ]));
  const folders = await accountState(page, "getFolders");
  assert.equal(folders.find((folder) => folder.id === "22222222-2222-4222-8222-222222222222").parent_id, "24242424-2424-4424-8424-242424242424");
  assert.equal(folders.find((folder) => folder.id === "26262626-2626-4626-8626-262626262626").parent_id, "24242424-2424-4424-8424-242424242424");
  assert.equal(folders.filter((folder) => folder.name === "Shared label").length, 2, "bulk move does not rename duplicate stored folders");
  await clearSelection(page);
  return { dropRecord, movedFile, bulkMove: bulkMove.body };
}

async function verifyBlockedDropsAndBulkTrashRestore(page) {
  const uploadCount = (await uploads(page)).length;
  await page.getByRole("button", { name: "Archives", exact: true }).click();
  await page.locator(".files-items .files-item").filter({ hasText: "Archived project" }).waitFor({ state: "visible" });
  await fixture(page, "dispatchExternalDrop", "Archived project", "archive-drop.txt", "not uploaded from archive");
  await page.getByRole("status").filter({ hasText: /active folder in My files/ }).waitFor({ state: "visible" });
  assert.equal((await uploads(page)).length, uploadCount, "archived-folder drop is rejected before upload");
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.locator(".files-items .files-item").filter({ hasText: "Deleted project" }).waitFor({ state: "visible" });
  await fixture(page, "dispatchExternalDrop", "Deleted project", "trash-drop.txt", "not uploaded from trash");
  await page.getByRole("status").filter({ hasText: /active folder in My files/ }).waitFor({ state: "visible" });
  assert.equal((await uploads(page)).length, uploadCount, "Trash drop is rejected before upload");

  await clickView(page, "My files");
  await clearSelection(page);
  await selectItem(page, "Protected project");
  await selectionCount(page, 1);
  const protectedTrash = page.getByRole("group", { name: "Bulk file actions" }).getByRole("button", { name: "Move to Trash", exact: true });
  assert.equal(await protectedTrash.isDisabled(), true, "protected syllabus blocks the bulk Trash action");
  const protectedReason = await protectedTrash.getAttribute("title");
  assert.match(protectedReason ?? "", /syllabus/i, `protected syllabus reason is exposed on the disabled Trash action (title=${String(protectedReason)})`);
  await clearSelection(page);

  await selectItem(page, "Shared label");
  await selectItem(page, "Loose read.txt");
  await selectionCount(page, 2);
  await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
  const trashDialog = page.locator(".files-trash-dialog");
  await trashDialog.waitFor({ state: "visible" });
  assert.match(await trashDialog.innerText(), /2 items selected/);
  const mutationCount = (await requests(page)).filter((request) => request.method === "POST" && request.path === "/api/files/actions").length;
  await screenshot(page, "w1440-bulk-trash-confirmation.png", { fullPage: false });
  await trashDialog.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await trashDialog.waitFor({ state: "hidden" });
  const afterTrash = (await requests(page)).filter((request) => request.method === "POST" && request.path === "/api/files/actions");
  assert.equal(afterTrash.length, mutationCount + 1, "bulk trash confirms with one batch action");
  assert.equal(afterTrash.at(-1).body.action, "trash");
  assert.equal(afterTrash.at(-1).body.items.length, 2, "both selected rows share the batch request");
  assert.equal((await fixture(page, "getTrashReceipts")).length, 1, "successful bulk trash returns an undo receipt");
  await clearSelection(page);

  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await selectItem(page, "Shared label", { viewLabel: "My files" });
  await selectItem(page, "Loose read.txt", { viewLabel: "My files" });
  await selectionCount(page, 2);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  const restoreDialog = page.locator(".files-trash-dialog");
  await restoreDialog.waitFor({ state: "visible" });
  assert.match(await restoreDialog.innerText(), /Restore 2/);
  await restoreDialog.getByRole("button", { name: "Restore", exact: true }).click();
  await restoreDialog.waitFor({ state: "hidden" });
  const restoreMutation = (await requests(page)).filter((request) => request.method === "POST" && request.path === "/api/files/actions").at(-1);
  assert.equal(restoreMutation.body.action, "restore");
  assert.equal(restoreMutation.body.items.length, 2, "bulk restore retains both selected roots");
  const restoredFiles = await accountState(page, "getFiles");
  const restoredFolders = await accountState(page, "getFolders");
  assert.equal(restoredFiles.find((file) => file.id === "35353535-3535-4353-8353-353535353535").trashed_at, null);
  assert.equal(restoredFolders.find((folder) => folder.id === "27272727-2727-4727-8727-272727272727").trashed_at, null);
  await clearSelection(page);

  await selectItem(page, "Deleted project", { viewLabel: "My files" });
  await selectItem(page, "Recovered handout.txt", { viewLabel: "My files / Missing folder" });
  await selectionCount(page, 2);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  const folderRestore = page.locator(".files-trash-dialog");
  await folderRestore.waitFor({ state: "visible" });
  assert.match(await folderRestore.innerText(), /4 items including folder contents/);
  await folderRestore.getByRole("button", { name: "Restore", exact: true }).click();
  await folderRestore.waitFor({ state: "hidden" });
  const recursive = await accountState(page, "getFiles");
  const nestedFolder = (await accountState(page, "getFolders")).find((folder) => folder.id === "29292929-2929-4929-8929-292929292929");
  assert.equal(nestedFolder.trashed_at, null, "folder restore includes nested folders");
  assert.equal(recursive.find((file) => file.id === "40404040-4040-4040-8040-404040404040").trashed_at, null, "folder restore includes descendant files");
  assert.equal(recursive.find((file) => file.id === "41414141-4141-4141-8141-414141414141").trashed_at, null, "the independent lost-location file is restored in the same atomic batch");
  await page.getByRole("status").filter({ hasText: /Restored to Restored files/ }).waitFor({ state: "visible" });
  const recovered = (await accountState(page, "getFiles")).find((file) => file.id === "41414141-4141-4141-8141-414141414141");
  assert.equal(recovered.folder_id, "30303030-3030-4030-8030-303030303030", "unavailable restore location uses the visible recovery folder");
  assert.ok((await accountState(page, "getFolders")).some((folder) => folder.id === "30303030-3030-4030-8030-303030303030" && folder.name === "Restored files"));
  return { afterTrash: afterTrash.at(-1).body, restore: restoreMutation.body, recoveryFolderId: recovered.folder_id };
}

async function verifyProfileABA() {
  const { context, page } = await newPage(1440);
  try {
    const uploadDialog = await openNewUpload(page);
    const heldName = "aba-held-upload.txt";
    await fixture(page, "setUploadPlan", heldName, "hold");
    await setFileInput(uploadDialog, [{ name: heldName, mimeType: "text/plain", buffer: Buffer.from("captured account upload") }]);
    await page.getByRole("progressbar", { name: `${heldName} upload progress` }).waitFor({ state: "visible" });
    await page.waitForFunction((name) => window.__filesBulkFixture.getUploads().some((record) => record.name === name), heldName);
    const uploadRecord = (await uploads(page))[0];
    await fixture(page, "switchProfile", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await page.waitForFunction(() => window.__filesBulkFixture.currentProfile() === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await fixture(page, "switchProfile", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await page.waitForFunction(() => window.__filesBulkFixture.currentProfile() === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && window.__filesBulkFixture.currentGeneration() === 2);
    await fixture(page, "releaseUpload", heldName);
    await waitUploadRow(page, heldName, "error");
    assert.equal((await accountState(page, "getFiles", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).some((file) => file.name === heldName), false, "late held A upload cannot create a canonical file after A-B-A");
    assert.equal((await accountState(page, "getFiles", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).some((file) => file.name === heldName), false, "held A upload never leaks into account B");
    await uploadDialog.getByRole("button", { name: "Retry upload", exact: true }).click();
    await waitUploadRow(page, heldName, "complete");
    const uploadAttempts = (await uploads(page)).filter((record) => record.name === heldName);
    assert.equal(uploadAttempts.length, 2);
    assert.equal(uploadAttempts[0].id, uploadRecord.id, "A-B-A retry preserves upload ID");
    assert.ok(await fixture(page, "sameUploadFileReference", heldName), "A-B-A retry retains the original File object");
    assert.equal((await accountState(page, "getFiles", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).filter((file) => file.name === heldName).length, 1);
    assert.equal((await accountState(page, "getFiles", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).some((file) => file.name === heldName), false);
    await uploadDialog.locator(".files-upload-footer").getByRole("button", { name: "Close", exact: true }).click();

    await selectItem(page, "Loose read.txt");
    const baselineAnchors = (await fixture(page, "getAnchorClicks")).length;
    const baselineZips = await fixture(page, "getZipCaptureCount");
    await fixture(page, "setDownloadPlan", "hold");
    await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
    await page.waitForFunction(() => window.__filesBulkFixture.requests.some((request) => request.path === "/api/files/download"));
    await fixture(page, "switchProfile", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await page.waitForFunction(() => window.__filesBulkFixture.currentProfile() === "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" && window.__filesBulkFixture.currentGeneration() === 3);
    await fixture(page, "switchProfile", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await page.waitForFunction(() => window.__filesBulkFixture.currentProfile() === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && window.__filesBulkFixture.currentGeneration() === 4);
    await page.locator(".files-download-error").waitFor({ state: "visible" });
    await fixture(page, "releaseDownload");
    await page.waitForTimeout(250);
    assert.equal((await fixture(page, "getAnchorClicks")).length, baselineAnchors, "stale held download creates no download anchor click");
    assert.equal(await fixture(page, "getZipCaptureCount"), baselineZips, "stale held download creates no object URL");
    const retry = page.getByRole("button", { name: "Retry download", exact: true });
    assert.equal(await retry.isDisabled(), true, "A-B-A makes the captured ZIP retry unavailable until reselection");
    return { uploadId: uploadRecord.id, uploadAttempts: uploadAttempts.map((attempt) => attempt.attempt), anchorClicks: await fixture(page, "getAnchorClicks"), zipCount: await fixture(page, "getZipCaptureCount") };
  } finally {
    await context.close();
    pageContexts.delete(context);
  }
}

async function verifyUploadLimits() {
  const { context, page } = await newPage(1440);
  try {
    const dialog = await openNewUpload(page);
    const longName = `${"x".repeat(256)}.txt`;
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 97);
    await setFileInput(dialog, [
      { name: longName, mimeType: "text/plain", buffer: Buffer.from("bad name") },
      { name: "too-large.txt", mimeType: "text/plain", buffer: oversized },
    ]);
    await page.locator(".files-upload-row.is-error").nth(1).waitFor({ state: "visible" });
    const rowText = await page.locator(".files-upload-row.is-error").allInnerTexts();
    assert.equal(rowText.length, 2, `both invalid selections remain visible for correction: ${rowText.join(" | ")}`);
    assert.match(rowText.join(" "), /255|name/i, "overlong filename is rejected");
    assert.match(rowText.join(" "), /25 MiB/, "oversized file is rejected at the 25 MiB limit");
    assert.equal((await uploads(page)).length, 0, "invalid selections never start network uploads");
    return { rejectedRows: rowText.length, requestCount: (await uploads(page)).length };
  } finally {
    await context.close();
    pageContexts.delete(context);
  }
}

async function verifyOperationsAndZip() {
  const { context, page } = await newPage(1440, { captureDownloads: true });
  try {
    const courseDownload = await verifyCourseDownload(page);
    await verifyInterruptedZipRetry(page);
    const overlap = await verifyOverlapAndManagedPins(page);
    const courseUpload = await verifyCourseUpload(page);
    const moves = await verifyBulkMoveAndDrop(page);
    const trash = await verifyBlockedDropsAndBulkTrashRestore(page);
    return { courseDownload, overlap, courseUpload: { id: courseUpload.id, metadata: courseUpload.metadata }, moves, trash, downloads: page.__capturedDownloads };
  } finally {
    await context.close();
    pageContexts.delete(context);
  }
}

const mode = process.env.VERIFY_ONLY ?? "all";
const summary = {};
try {
  browser = await playwright.chromium.launch(launchOptions);
  if (mode === "all" || mode === "responsive") {
    summary.responsive = [];
    const targetWidths = process.env.VERIFY_WIDTH ? [Number(process.env.VERIFY_WIDTH)] : widths;
    for (const width of targetWidths) summary.responsive.push(await verifyResponsive(width));
  }
  if (mode === "all" || mode === "operations") summary.operations = await verifyOperationsAndZip();
  if (mode === "all" || mode === "aba") summary.aba = await verifyProfileABA();
  if (mode === "all" || mode === "limits") summary.limits = await verifyUploadLimits();
  assert.deepEqual(errors, [], `browser console stays clean: ${errors.join(" | ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, mode, screenshots: screenshotDir, summary }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, mode, screenshots: screenshotDir, error: error instanceof Error ? error.stack : String(error), browserErrors: errors }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  for (const context of pageContexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}
