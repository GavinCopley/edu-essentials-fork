import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-files-discovery");
const ID = {
  biology: "11111111-1111-4111-8111-111111111111",
  projects: "22222222-2222-4222-8222-222222222222",
  design: "33333333-3333-4333-8333-333333333333",
  archive: "55555555-5555-4555-8555-555555555555",
  rootPlanning: "13131313-1313-4313-8313-131313131313",
  alpha: "88888888-8888-4888-8888-888888888888",
  biologyText: "99999999-9999-4999-8999-999999999999",
  broken: "10101010-1010-4010-8010-101010101010",
  native: "12121212-1212-4212-8212-121212121212",
};
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
  "app/file-archive-dialog.css",
  "app/course-syllabus.css",
  "app/native-document-editor.css",
];
const cssSources = await Promise.all(cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/files-discovery-browser.tsx")],
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
const baseUrl = "https://files-discovery.test";
await mkdir(screenshotDir, { recursive: true });

const launchOptions = {
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
};
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";

let browser;
const errors = [];

async function preparePage(viewport, query = "") {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) { await route.continue(); return; }
    if (url.pathname === "/fixture.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "cache-control": "no-store" }, body: js });
    } else if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204, body: "" });
    } else if (url.pathname === "/api/files" && url.searchParams.has("id")) {
      await route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", headers: { "content-disposition": 'attachment; filename="fixture-download.txt"' }, body: "Downloaded fixture bytes." });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: html });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(`pageerror at ${viewport.width}px: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console at ${viewport.width}px: ${message.text()}`); });
  await page.goto(`${baseUrl}/files?view=my-files&layout=list${query}`);
  await page.locator(".files-items .files-item").first().waitFor({ state: "visible" });
  return { context, page };
}

async function fixture(page, method, ...args) {
  return page.evaluate(({ methodName, methodArgs }) => {
    const api = window.__filesDiscoveryFixture;
    return api[methodName](...methodArgs);
  }, { methodName: method, methodArgs: args });
}

async function requestLog(page) {
  return page.evaluate(() => structuredClone(window.__filesDiscoveryFixture.requests));
}

async function mutations(page) {
  return (await requestLog(page)).filter((record) => record.method !== "GET");
}

async function resetRequests(page) {
  await fixture(page, "resetRequestLog");
}

async function itemNames(page, listSelector = ".files-items[role='list']") {
  return page.locator(`${listSelector} > .files-item`).evaluateAll((items) => items.map((item) => item.querySelector(".files-item-title strong")?.textContent?.trim() ?? ""));
}

async function itemTypes(page, listSelector = ".files-items[role='list']") {
  return page.locator(`${listSelector} > .files-item`).evaluateAll((items) => items.map((item) => item.classList.contains("is-folder") ? "folder" : "file"));
}

async function inspectViewport(page, width) {
  const metrics = await page.evaluate(() => {
    const browser = document.querySelector(".files-browser");
    const content = document.querySelector(".files-browser-content");
    const { left, right } = browser?.getBoundingClientRect() ?? { left: 0, right: 0 };
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      browser: { left, right },
      content: content ? { left: content.getBoundingClientRect().left, right: content.getBoundingClientRect().right } : null,
      itemMainWidth: document.querySelector(".files-items .files-item-main")?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.ok(metrics.document <= width + 1, `document does not overflow at ${width}px (${metrics.document}px)`);
  assert.ok(metrics.body <= width + 1, `body does not overflow at ${width}px (${metrics.body}px)`);
  assert.ok(metrics.browser.left >= -1 && metrics.browser.right <= width + 1, `Files browser fits at ${width}px (${metrics.browser.left}–${metrics.browser.right})`);
  assert.ok(metrics.content && metrics.content.left >= -1 && metrics.content.right <= width + 1, `Files content fits at ${width}px (${JSON.stringify(metrics.content)})`);
  assert.ok(metrics.itemMainWidth >= 105, `name control remains usable at ${width}px (${metrics.itemMainWidth}px)`);
  return metrics;
}

async function assertMenuInViewport(page, width) {
  const rect = await page.getByRole("menu").evaluate((menu) => {
    const { left, right, top, bottom } = menu.getBoundingClientRect();
    return { left, right, top, bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(rect.left >= 0 && rect.right <= width, `menu fits horizontally at ${width}px (${rect.left}–${rect.right})`);
  assert.ok(rect.top >= 0 && rect.bottom <= rect.viewportHeight, `menu fits vertically at ${width}px (${rect.top}–${rect.bottom})`);
  return rect;
}

async function assertArchiveDialogTopmost(page, width) {
  const dialog = page.getByRole("dialog", { name: "Archive folder" });
  const evidence = await dialog.evaluate((element) => {
    for (const animation of element.closest(".files-dialog-backdrop")?.getAnimations({ subtree: true }) ?? []) animation.finish();
    const backdrop = element.closest(".files-dialog-backdrop");
    const close = element.querySelector(".files-details-heading button");
    const dialogRect = element.getBoundingClientRect();
    const backdropRect = backdrop?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    const hit = closeRect ? document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2) : null;
    return {
      dialog: { left: dialogRect.left, top: dialogRect.top, right: dialogRect.right, bottom: dialogRect.bottom, opacity: Number(getComputedStyle(element).opacity) },
      backdrop: backdropRect ? { left: backdropRect.left, top: backdropRect.top, right: backdropRect.right, bottom: backdropRect.bottom, opacity: Number(getComputedStyle(backdrop).opacity) } : null,
      close: closeRect ? { width: closeRect.width, height: closeRect.height, top: closeRect.top, bottom: closeRect.bottom } : null,
      closeIsTopmost: Boolean(close && hit && close.contains(hit)),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  const backdrop = evidence.backdrop;
  assert.ok(evidence.dialog.opacity >= 0.99, `archive dialog is opaque (${JSON.stringify(evidence)})`);
  assert.ok(backdrop && backdrop.opacity >= 0.99, `archive backdrop is opaque (${JSON.stringify(evidence)})`);
  assert.ok(backdrop && Math.abs(backdrop.left) <= 1 && Math.abs(backdrop.top) <= 1 && Math.abs(backdrop.right - width) <= 1 && Math.abs(backdrop.bottom - evidence.viewport.height) <= 1,
    `archive backdrop covers viewport at ${width}px (${JSON.stringify(evidence)})`);
  assert.ok(evidence.dialog.left >= -1 && evidence.dialog.top >= -1 && evidence.dialog.right <= width + 1 && evidence.dialog.bottom <= evidence.viewport.height + 1,
    `archive dialog fits viewport at ${width}px (${JSON.stringify(evidence)})`);
  assert.ok(evidence.close && evidence.close.width > 0 && evidence.close.height > 0 && evidence.close.top >= -1 && evidence.close.bottom <= evidence.viewport.height + 1 && evidence.closeIsTopmost,
    `archive close control is visible and topmost at ${width}px (${JSON.stringify(evidence)})`);
  return evidence;
}

async function assertArchiveDialogFocusTrap(page) {
  const dialog = page.getByRole("dialog", { name: "Archive folder" });
  const close = dialog.getByRole("button", { name: "Close Files dialog" });
  const submit = dialog.getByRole("button", { name: "Archive folder", exact: true });
  const closeHandle = await close.elementHandle();
  const submitHandle = await submit.elementHandle();
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate((element) => document.activeElement === element, submitHandle), true,
    "Shift+Tab wraps from the first archive control to the last enabled control");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate((element) => document.activeElement === element, closeHandle), true,
    "Tab wraps from the last archive control to the first");
}

async function openItemMenu(page, name) {
  await page.getByRole("button", { name: `More options for ${name}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `${name} actions` });
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function closePreview(page) {
  const preview = page.getByRole("dialog", { name: "Private file preview" });
  await preview.getByRole("button", { name: "Close file preview" }).click();
  await preview.waitFor({ state: "detached" });
}

async function verifyResponsiveScreenshots() {
  const viewports = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "compact-desktop", width: 1024, height: 900 },
    { name: "tablet", width: 820, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ];
  for (const viewport of viewports) {
    const { context, page } = await preparePage(viewport);
    try {
      const metrics = await inspectViewport(page, viewport.width);
      await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-root.png`), fullPage: true, animations: "disabled" });
      const menu = await openItemMenu(page, "Personal Projects");
      console.log(`${viewport.width}px item menu: ${JSON.stringify(await menu.innerText())}`);
      const menuBounds = await assertMenuInViewport(page, viewport.width);
      await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-menu.png`), animations: "disabled" });
      await menu.getByRole("menuitem", { name: "Archive folder…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Archive folder" });
      await dialog.waitFor({ state: "visible" });
      assert.equal(await dialog.getByRole("textbox", { name: "Semester label" }).inputValue(), "Fall 2026");
      assert.equal(await dialog.getByRole("textbox", { name: "Semester label" }).evaluate((input) => document.activeElement === input), true,
        `archive dialog focuses the label input at ${viewport.width}px`);
      const dialogEvidence = await assertArchiveDialogTopmost(page, viewport.width);
      await assertArchiveDialogFocusTrap(page);
      await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-archive-dialog.png`), animations: "disabled" });
      await inspectViewport(page, viewport.width);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await mutations(page), [], `responsive browse/menu/dialog checks do not write at ${viewport.width}px`);
      console.log(`${viewport.width}px: ${JSON.stringify({ metrics, menuBounds, dialogEvidence })}`);
    } finally {
      await context.close();
    }
  }

  const { context, page } = await preparePage({ width: 1024, height: 900 }, "&term=");
  try {
    const menu = await openItemMenu(page, "Design drafts");
    await menu.getByRole("menuitem", { name: "Archive folder…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archive folder" });
    await dialog.waitFor({ state: "visible" });
    assert.equal(await dialog.getByRole("textbox", { name: "Semester label" }).inputValue(), "Archived",
      "an empty account term defaults the archive label to Archived");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  } finally {
    await context.close();
  }
  console.log("Responsive screenshot, menu/dialog bounds, focus, overflow, and Archived fallback passed.");
}

async function verifySearchSortingAndArchives() {
  const { context, page } = await preparePage({ width: 1440, height: 1000 });
  try {
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    const initialNames = await itemNames(page);
    assert.deepEqual(initialNames.slice(0, 3), ["BIO 201", "Design drafts", "Personal Projects"], "name ascending keeps folders first and sorts their names");
    assert.deepEqual(await itemTypes(page), ["folder", "folder", "folder", "file", "file", "file", "file", "file"], "folders stay ahead of files in name ascending order");
    assert.ok(!initialNames.includes("Old Biology") && !initialNames.includes("Deleted notes.txt"), "normal browsing excludes archived and trashed records");

    await page.getByRole("button", { name: "Sort ascending" }).click();
    const nameDescending = await itemNames(page);
    assert.deepEqual(nameDescending.slice(0, 3), ["Personal Projects", "Design drafts", "BIO 201"], "name descending reverses folder order while keeping folders first");
    assert.deepEqual(nameDescending.slice(3), [...nameDescending.slice(3)].sort((a, b) => b.localeCompare(a)), "name descending sorts files by name");

    await page.getByLabel("Sort by").selectOption("modified");
    await page.getByRole("button", { name: "Sort descending" }).click();
    const modifiedAscending = await itemNames(page);
    assert.deepEqual(modifiedAscending.slice(0, 3), ["Design drafts", "BIO 201", "Personal Projects"], "modified ascending orders folders by saved modified time first");
    assert.deepEqual(modifiedAscending.slice(3), ["Zeta records.csv", "Broken preview.txt", "Alpha guide.pdf", "BIO 201 notes.txt", "Native plan.txt"],
      "modified ascending orders file rows by their saved modified time");
    await page.getByRole("button", { name: "Sort ascending" }).click();
    const modifiedDescending = await itemNames(page);
    assert.deepEqual(modifiedDescending.slice(0, 3), ["Personal Projects", "BIO 201", "Design drafts"], "modified descending reverses folder dates and keeps folders first");
    assert.deepEqual(modifiedDescending.slice(3), ["Native plan.txt", "BIO 201 notes.txt", "Alpha guide.pdf", "Broken preview.txt", "Zeta records.csv"],
      "modified descending orders file rows by their saved modified time");

    await page.getByLabel("Sort by").selectOption("name");
    await page.getByRole("button", { name: "Sort descending" }).click();
    await page.getByRole("searchbox", { name: "Search files" }).fill("biology");
    assert.deepEqual(await itemNames(page), [], "search matches names rather than course labels or document contents");

    await page.getByLabel("Course filter").selectOption("biology");
    await page.getByRole("searchbox", { name: "Search files" }).fill("");
    await page.getByLabel("File type").selectOption("pdf");
    assert.deepEqual(await itemNames(page), ["BIO 201", "Alpha guide.pdf"], "course and PDF filters compose while retaining course folders");
    await page.getByLabel("File type").selectOption("text");
    assert.deepEqual(await itemNames(page), ["BIO 201", "BIO 201 notes.txt"], "text filter selects text files and keeps the matching course root");
    await page.getByLabel("Course filter").selectOption("personal");
    await page.getByLabel("File type").selectOption("all");
    const personalRows = await itemNames(page);
    assert.ok(personalRows.includes("Personal Projects") && personalRows.includes("Broken preview.txt") && personalRows.includes("Native plan.txt"),
      `Personal course filter keeps personal folders and files (${personalRows.join(", ")})`);
    assert.ok(!personalRows.includes("BIO 201") && !personalRows.includes("Alpha guide.pdf"), "Personal filter excludes course-associated items");

    await page.getByLabel("Course filter").selectOption("all");
    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: BIO 201" }).click();
    await page.getByRole("searchbox", { name: "Search files" }).fill("Root planning");
    assert.deepEqual(await itemNames(page), [], "current-folder scope stays in the selected course folder");
    await page.getByLabel("Search scope").selectOption("all");
    assert.deepEqual(await itemNames(page), ["Root planning.txt"], "all-active scope finds a file outside the current folder");
    const resultLocation = await page.locator(".files-item").filter({ hasText: "Root planning.txt" }).locator(".files-item-title small").innerText();
    assert.match(resultLocation, /My files\s*\/\s*Personal Projects/, `search result exposes its containing path (${resultLocation})`);
    const resultMenu = await openItemMenu(page, "Root planning.txt");
    await resultMenu.getByRole("menuitem", { name: "Open containing folder", exact: true }).click();
    await page.getByRole("heading", { name: "Personal Projects" }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("searchbox", { name: "Search files" }).inputValue(), "", "Open containing folder clears the temporary query");
    assert.equal(new URL(page.url()).searchParams.get("folder"), ID.projects, "containing-folder navigation targets the canonical folder ID");
    assert.match(await page.locator(".files-breadcrumbs").innerText(), /My files[\s\S]*Personal Projects/);
    await page.getByRole("searchbox", { name: "Search files" }).fill("Project");
    await page.getByRole("button", { name: "Clear search" }).click();
    assert.equal(await page.getByRole("searchbox", { name: "Search files" }).inputValue(), "", "Clear search empties only the temporary query");

    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    await page.getByLabel("Search scope").selectOption("all");
    await page.getByRole("searchbox", { name: "Search files" }).fill("Archived specimen");
    assert.deepEqual(await itemNames(page), [], "global search excludes archived files by default");
    await page.getByLabel("Include archived").check();
    assert.deepEqual(await itemNames(page), ["Archived specimen.pdf"], "Include archived reveals archived roots and their files");
    await page.getByRole("searchbox", { name: "Search files" }).fill("Deleted notes");
    assert.deepEqual(await itemNames(page), [], "Include archived still excludes Trash from global search");
    await page.getByLabel("Include archived").uncheck();
    await page.getByRole("searchbox", { name: "Search files" }).fill("");
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "More options for Deleted notes.txt" }).waitFor({ state: "visible" });
    const trashNames = await itemNames(page);
    assert.deepEqual(trashNames, ["Deleted project", "Deleted notes.txt"], "Trash stays a distinct view with only trashed items");
    assert.equal(await page.getByLabel("Include archived").count(), 0, "Include archived is unavailable in Trash");
    assert.ok(!trashNames.includes("Old Biology") && !trashNames.includes("Archived specimen.pdf"), "Trash does not merge archive rows");
    assert.deepEqual(await mutations(page), [], "search, filters, sorting, and view navigation do not write");
    console.log("Search scope, paths, filters, sorting, archive inclusion, and Trash separation passed.");
  } finally {
    await context.close();
  }
}

async function verifyStarActivity() {
  const { context, page } = await preparePage({ width: 1440, height: 1000 });
  try {
    const beforeFile = (await fixture(page, "getFiles")).find((file) => file.id === ID.alpha);
    const beforeFolder = (await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects);
    await resetRequests(page);
    await fixture(page, "failNextGet", "/api/file-folders?view=active");

    const folderMenu = await openItemMenu(page, "Personal Projects");
    await folderMenu.getByRole("menuitem", { name: "Add to Starred", exact: true }).click();
    const starRefreshAlert = page.locator(".files-browser .files-activity-inline-error");
    await starRefreshAlert.filter({ hasText: "Fixture Files refresh failed." }).waitFor({ state: "visible" });
    const failedStarRequests = await requestLog(page);
    const firstStar = failedStarRequests.filter((record) => record.method === "POST");
    assert.equal(firstStar.length, 1, "a committed folder star is sent once before the failed refresh");
    assert.equal(firstStar[0].body.action, "star");
    assert.deepEqual(firstStar[0].body.items, [{ type: "folder", id: ID.projects, revision: beforeFolder.revision }]);
    assert.ok((await fixture(page, "getFolderActivity")).find((activity) => activity.id === ID.projects)?.starred_at,
      "the canonical server activity records the successful folder star");
    await starRefreshAlert.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await starRefreshAlert.waitFor({ state: "detached" });
    const afterFolderRetry = await requestLog(page);
    assert.equal(afterFolderRetry.filter((record) => record.method === "POST").length, 1, "retry refresh does not repeat the committed star action");
    assert.ok(afterFolderRetry.some((record) => record.method === "GET" && record.path === "/api/file-folders?view=active"), "folder star retry performs GET refreshes only");
    assert.deepEqual((await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects), beforeFolder,
      "folder star and refresh leave its saved metadata, revision, and modified time unchanged");

    await page.getByRole("button", { name: "Starred", exact: true }).click();
    await page.getByRole("button", { name: "More options for Personal Projects" }).waitFor({ state: "visible" });
    const starredFolderMenu = await openItemMenu(page, "Personal Projects");
    await starredFolderMenu.getByRole("menuitem", { name: "Remove from Starred", exact: true }).click();
    await page.getByRole("heading", { name: "No starred files" }).waitFor({ state: "visible" });
    assert.equal((await fixture(page, "getFolderActivity")).find((activity) => activity.id === ID.projects)?.starred_at, null,
      "one unstar action removes the folder from Starred");
    assert.deepEqual((await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects), beforeFolder,
      "folder unstar does not alter folder metadata or timestamps");

    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    const fileMenu = await openItemMenu(page, "Alpha guide.pdf");
    await fileMenu.getByRole("menuitem", { name: "Add to Starred", exact: true }).click();
    await page.getByRole("button", { name: "Starred", exact: true }).click();
    await page.getByRole("button", { name: "More options for Alpha guide.pdf" }).waitFor({ state: "visible" });
    const starredFileMenu = await openItemMenu(page, "Alpha guide.pdf");
    await starredFileMenu.getByRole("menuitem", { name: "Remove from Starred", exact: true }).click();
    await page.getByRole("heading", { name: "No starred files" }).waitFor({ state: "visible" });
    assert.equal((await fixture(page, "getFileActivity")).find((activity) => activity.id === ID.alpha)?.starred_at, null,
      "one unstar action removes the file from Starred");
    assert.deepEqual((await fixture(page, "getFiles")).find((file) => file.id === ID.alpha), beforeFile,
      "file star and unstar leave metadata, content revision, modified time, and bytes untouched");
    const actionRequests = (await mutations(page)).filter((record) => record.path === "/api/files/actions");
    assert.deepEqual(actionRequests.map((record) => record.body.action), ["star", "unstar", "star", "unstar"],
      "file and folder Starred controls each issue exactly one action per click");
    assert.ok(actionRequests.every((record) => Array.isArray(record.body.items) && record.body.items.length === 1), "each Starred request contains one canonical item");
    console.log(`Star/unstar captured ${actionRequests.length} single-item actions; metadata stayed unchanged.`);
  } finally {
    await context.close();
  }
}

async function verifyRecentActivity() {
  const { context, page } = await preparePage({ width: 1440, height: 1000 });
  try {
    await resetRequests(page);
    await page.getByRole("button", { name: "Preview file: Broken preview.txt" }).click();
    const failedPreview = page.getByRole("dialog", { name: "Private file preview" });
    await failedPreview.getByRole("alert").filter({ hasText: "Fixture blob read failed." }).waitFor({ state: "visible" });
    assert.equal((await mutations(page)).filter((record) => record.path === "/api/files/actions").length, 0,
      "a failed object read does not write Recent activity");
    await closePreview(page);

    const downloadMenu = await openItemMenu(page, "Alpha guide.pdf");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadMenu.getByRole("menuitem", { name: "Download", exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "Alpha guide.pdf", "download keeps the production filename");
    assert.equal((await mutations(page)).filter((record) => record.path === "/api/files/actions").length, 0,
      "downloading the original does not count as a successful preview or Recent open");

    await fixture(page, "failNextRecentRefresh");
    await page.getByRole("button", { name: "Preview file: BIO 201 notes.txt" }).click();
    const preview = page.getByRole("dialog", { name: "Private file preview" });
    await preview.locator(".syllabus-source").filter({ hasText: "course label" }).waitFor({ state: "visible" });
    await page.getByRole("alert").filter({ hasText: "Recent was saved, but Files could not refresh." }).waitFor({ state: "visible" });
    const firstSuccessfulOpenLog = await requestLog(page);
    const openAction = firstSuccessfulOpenLog.find((record) => record.method === "POST" && record.path === "/api/files/actions");
    assert.equal(openAction.body.action, "open", "Recent is recorded only after FilePreview successfully reads the uploaded bytes");
    assert.deepEqual(openAction.body.items, [{ type: "file", id: ID.biologyText, revision: 1 }], "open action sends the captured file metadata revision");
    const openedFileBeforeRetry = (await fixture(page, "getFiles")).find((file) => file.id === ID.biologyText);
    assert.equal((await fixture(page, "getFileActivity")).find((activity) => activity.id === ID.biologyText)?.last_opened_at !== null, true,
      "the server acknowledged the open before the refresh failed");
    const recentRefresh = firstSuccessfulOpenLog.find((record) => record.activityRefresh);
    assert.equal(recentRefresh.method, "GET", "Recent activity refresh uses a read request");

    await closePreview(page);
    await page.getByRole("button", { name: "Retry Recent refresh", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Recent was saved, but Files could not refresh." }).waitFor({ state: "detached" });
    const afterRetry = await requestLog(page);
    assert.equal(afterRetry.filter((record) => record.method === "POST" && record.path === "/api/files/actions").length, 1,
      "retrying a saved Recent refresh does not send a second open action");
    assert.ok(afterRetry.filter((record) => record.activityRefresh).every((record) => record.method === "GET"), "Recent retry sends only a GET refresh");
    assert.deepEqual((await fixture(page, "getFiles")).find((file) => file.id === ID.biologyText), openedFileBeforeRetry,
      "Recent activity leaves file content revision, metadata revision, and modified time unchanged");
    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.getByRole("button", { name: "Preview file: BIO 201 notes.txt" }).waitFor({ state: "visible" });

    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Edit text: Native plan.txt" }).click();
    const editor = page.locator(".native-document-dialog");
    const textField = editor.locator(".native-document-fields textarea");
    await textField.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const field = document.querySelector(".native-document-fields textarea");
      return field && !field.disabled;
    });
    await page.waitForFunction((fileId) => window.__filesDiscoveryFixture.requests.some((record) => record.method === "GET" && record.path === `/api/file-documents?id=${fileId}`), ID.native);
    await page.waitForFunction((fileId) => window.__filesDiscoveryFixture.requests.some((record) => record.method === "POST" && record.path === "/api/files/actions" && record.body?.action === "open" && record.body.items?.[0]?.id === fileId), ID.native);
    const requestsBeforeSave = await requestLog(page);
    const nativeReadOpen = requestsBeforeSave.find((record) => record.method === "POST" && record.path === "/api/files/actions" && record.body?.items?.[0]?.id === ID.native);
    assert.equal(nativeReadOpen.body.action, "open", "a successfully loaded native document records Recent after its read resolves");
    const nativeBeforeSave = (await fixture(page, "getFiles")).find((file) => file.id === ID.native);
    await textField.fill("Updated native content saved by the production editor.");
    await page.waitForFunction((fileId) => window.__filesDiscoveryFixture.requests.some((record) => record.method === "PUT" && record.path === `/api/file-documents?id=${fileId}`), ID.native, { timeout: 15000 });
    const nativeOpenCountBeforeSave = requestsBeforeSave.filter((record) => record.method === "POST" && record.path === "/api/files/actions" && record.body?.items?.[0]?.id === ID.native).length;
    await page.waitForFunction(({ fileId, count }) => window.__filesDiscoveryFixture.requests.filter((record) => record.method === "POST" && record.path === "/api/files/actions" && record.body?.action === "open" && record.body.items?.[0]?.id === fileId).length > count,
      { fileId: ID.native, count: nativeOpenCountBeforeSave }, { timeout: 15000 });
    const nativeAfterSave = (await fixture(page, "getFiles")).find((file) => file.id === ID.native);
    const nativeDocument = await fixture(page, "getNativeDocument", ID.native);
    assert.equal(nativeAfterSave.content_revision, nativeBeforeSave.content_revision + 1, "native save increments the canonical content revision once");
    assert.equal(nativeAfterSave.metadata_revision, nativeBeforeSave.metadata_revision, "native content save leaves metadata revision unchanged");
    assert.ok(nativeAfterSave.updated_at > nativeBeforeSave.updated_at, "native save advances the canonical modified timestamp");
    assert.equal(nativeDocument.body, "Updated native content saved by the production editor.", "native editor saves the canonical document body");
    await editor.getByRole("button", { name: "Close text editor" }).click();
    await editor.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Recent", exact: true }).click();
    await page.getByRole("button", { name: "Edit text: Native plan.txt" }).waitFor({ state: "visible" });
    assert.ok((await fixture(page, "getFileActivity")).find((activity) => activity.id === ID.native)?.last_opened_at,
      "the canonical Recent list includes the successful native read/save");
    console.log("Recent tracks a successful uploaded preview and native document read/save; failed preview, download, and refresh retry do not create duplicate opens.");
  } finally {
    await context.close();
  }
}

async function verifyArchiveLifecycle() {
  const { context, page } = await preparePage({ width: 1440, height: 1000 });
  try {
    const academicBefore = await fixture(page, "getAcademicRecords");
    await resetRequests(page);
    const archiveMenu = await openItemMenu(page, "Personal Projects");
    await archiveMenu.getByRole("menuitem", { name: "Archive folder…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archive folder" });
    await dialog.waitFor({ state: "visible" });
    const label = dialog.getByRole("textbox", { name: "Semester label" });
    assert.equal(await label.inputValue(), "Fall 2026", "the dialog defaults to the account's current term");
    await fixture(page, "setCurrentTerm", "Spring 2027");
    await page.waitForFunction(() => window.__filesDiscoveryFixture.getCurrentTerm() === "Spring 2027");
    assert.equal(await fixture(page, "getCurrentTerm"), "Spring 2027");
    assert.equal(await label.inputValue(), "Fall 2026", "an open archive draft retains its captured account term");
    await label.fill("Fieldwork Fall 2026");
    await fixture(page, "failNextGet", "/api/file-folders?view=active");
    await dialog.getByRole("button", { name: "Archive folder", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Fixture Files refresh failed." }).waitFor({ state: "visible" });
    assert.match(await dialog.innerText(), /The folder change was saved\. Refresh Files to confirm the latest view\./);
    assert.equal(await dialog.getByRole("button", { name: "Retry refresh", exact: true }).count(), 1,
      "the committed archive exposes a refresh-only retry");
    let writes = (await mutations(page)).filter((record) => record.path === "/api/file-folders");
    assert.equal(writes.length, 1, "archive commits once before its refresh fails");
    assert.deepEqual(writes[0].body, { action: "archive", id: ID.projects, revision: 1, semesterLabel: "Fieldwork Fall 2026" },
      "archive submits the edited captured term label and folder revision");
    const archivedFolder = (await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects);
    assert.equal(archivedFolder.semester_label, "Fieldwork Fall 2026");
    assert.ok(archivedFolder.archived_at);
    await dialog.getByRole("button", { name: "Retry refresh", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    writes = (await mutations(page)).filter((record) => record.path === "/api/file-folders");
    assert.equal(writes.length, 1, "archive retry performs GET refreshes without a duplicate PUT");
    const afterArchiveRetry = await requestLog(page);
    assert.ok(afterArchiveRetry.some((record) => record.method === "GET" && record.path === "/api/file-folders?view=active"), "archive refresh retry performs GET");
    assert.deepEqual(await fixture(page, "getAcademicRecords"), academicBefore,
      "archiving a folder leaves course schedules, assignments, and course links untouched");

    await page.getByRole("button", { name: "Archives", exact: true }).click();
    await page.getByRole("heading", { name: "Fall 2025" }).waitFor({ state: "visible" });
    await page.getByRole("heading", { name: "Fieldwork Fall 2026" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Open folder: Personal Projects" }).waitFor({ state: "visible" });
    assert.equal(await fixture(page, "getCurrentTerm"), "Spring 2027", "the account term changed after archiving");
    assert.equal((await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects).semester_label, "Fieldwork Fall 2026",
      "the saved archive label remains stable after the account term changes");
    await page.getByRole("button", { name: "Open folder: Personal Projects" }).click();
    await page.getByRole("button", { name: "View file: Root planning.txt" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "View file: Root planning.txt" }).click();
    const archivedPreview = page.getByRole("dialog", { name: "Private file preview" });
    await archivedPreview.locator(".syllabus-source").waitFor({ state: "visible" });
    assert.equal(await fixture(page, "getLastOpenReadOnly"), true, "archived file previews use the read-only host mode");
    await closePreview(page);
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "Archives", exact: true }).click();
    const unarchiveMenu = await openItemMenu(page, "Personal Projects");
    await unarchiveMenu.getByRole("menuitem", { name: "Unarchive folder…", exact: true }).click();
    const unarchiveDialog = page.getByRole("dialog", { name: "Unarchive folder" });
    await unarchiveDialog.waitFor({ state: "visible" });
    assert.match(await unarchiveDialog.innerText(), /Return “Personal Projects” to My files/);
    await unarchiveDialog.getByRole("button", { name: "Unarchive folder", exact: true }).click();
    await unarchiveDialog.waitFor({ state: "detached" });
    assert.equal((await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects).archived_at, null,
      "unarchive clears archived state");
    assert.equal((await fixture(page, "getFolders")).find((folder) => folder.id === ID.projects).semester_label, null,
      "unarchive clears the stored semester label");
    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: Personal Projects" }).waitFor({ state: "visible" });

    const courseMenu = await openItemMenu(page, "BIO 201");
    await courseMenu.getByRole("menuitem", { name: "Archive folder…", exact: true }).click();
    const courseArchiveDialog = page.getByRole("dialog", { name: "Archive folder" });
    await courseArchiveDialog.waitFor({ state: "visible" });
    assert.equal(await courseArchiveDialog.getByRole("textbox", { name: "Semester label" }).inputValue(), "Spring 2027",
      "a new managed course archive defaults to the updated current term");
    await courseArchiveDialog.getByRole("button", { name: "Archive folder", exact: true }).click();
    await courseArchiveDialog.waitFor({ state: "detached" });
    const courseArchive = (await fixture(page, "getFolders")).find((folder) => folder.id === ID.biology);
    assert.equal(courseArchive.semester_label, "Spring 2027");
    assert.equal(courseArchive.course_name_snapshot, "Biology", "course archive preserves its course display snapshot");
    assert.equal(courseArchive.course_color_snapshot, "#b23b53", "course archive preserves its course color snapshot");
    assert.deepEqual(await fixture(page, "getAcademicRecords"), academicBefore,
      "archiving a managed course folder also leaves academic records unchanged");
    await page.getByRole("button", { name: "Archives", exact: true }).click();
    await page.getByRole("heading", { name: "Spring 2027" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Open folder: BIO 201" }).click();
    await page.getByRole("button", { name: "Open folder: Lab notes" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Open folder: Lab notes" }).click();
    await page.getByRole("button", { name: "View file: Lab results.txt" }).waitFor({ state: "visible" });
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "Archives", exact: true }).click();
    const courseUnarchiveMenu = await openItemMenu(page, "BIO 201");
    await courseUnarchiveMenu.getByRole("menuitem", { name: "Unarchive folder…", exact: true }).click();
    const courseUnarchiveDialog = page.getByRole("dialog", { name: "Unarchive folder" });
    await courseUnarchiveDialog.waitFor({ state: "visible" });
    await courseUnarchiveDialog.getByRole("button", { name: "Unarchive folder", exact: true }).click();
    await courseUnarchiveDialog.waitFor({ state: "detached" });
    await page.locator(".files-view-nav").getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: BIO 201" }).waitFor({ state: "visible" });
    assert.equal((await fixture(page, "getFolders")).find((folder) => folder.id === ID.biology).archived_at, null,
      "managed course root returns to My files after unarchive");
    assert.deepEqual(await fixture(page, "getAcademicRecords"), academicBefore, "archive/unarchive lifecycle preserves academic records");
    console.log("Custom and managed-course archives preserve stored labels, contents, snapshots, and academic records; saved archive refresh retries only GET.");
  } finally {
    await context.close();
  }
}

try {
  if (!process.env.CHROME_EXECUTABLE) throw new Error("Set CHROME_EXECUTABLE to the installed Chrome executable for actual Chrome verification.");
  browser = await playwright.chromium.launch(launchOptions);
  const only = process.env.VERIFY_ONLY;
  if (only && !["responsive", "search", "star", "recent", "archive"].includes(only)) throw new Error(`Unknown VERIFY_ONLY scenario: ${only}`);
  if (!only || only === "responsive") await verifyResponsiveScreenshots();
  if (!only || only === "search") await verifySearchSortingAndArchives();
  if (!only || only === "star") await verifyStarActivity();
  if (!only || only === "recent") await verifyRecentActivity();
  if (!only || only === "archive") await verifyArchiveLifecycle();
  assert.deepEqual(errors, [], errors.join("\n"));
  console.log(`Files discovery actual Chrome verification passed at 1440px, 1024px, 820px, and 390px. Screenshots: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
}
