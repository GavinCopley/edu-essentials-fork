import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-files-browser");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const esbuild = process.env.ESBUILD_MODULE
  ? await import(pathToFileURL(resolve(process.env.ESBUILD_MODULE)).href)
  : await import("esbuild");
const [globalCss, referenceCss, browserCss, syllabusCss, authCss] = await Promise.all([
  "app/globals.css",
  "app/reference-ui.css",
  "app/files-browser.css",
  "app/files-browser-tools.css",
  "app/file-archive-dialog.css",
  "app/course-syllabus.css",
  "app/auth.css",
].map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/files-browser-browser.tsx")],
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
const css = [globalCss, referenceCss, browserCss, syllabusCss, authCss]
  .map((source) => source.replace(/^@import[^;]+;\s*/gm, ""))
  .join("\n");
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root { --font-geist-sans: Arial, sans-serif; }${css}</style></head><body><div class="app-shell reference-ui"><aside class="sidebar" aria-hidden="true"></aside><header class="desktop-topbar" aria-hidden="true"></header><main id="main-content" class="main-content"><div id="root"></div></main></div><script src="/fixture.js"></script></body></html>`;
const baseUrl = "http://files-browser.test";
await mkdir(screenshotDir, { recursive: true });

const launchOptions = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";
const errors = [];
let browser;

async function inspectViewport(page, width) {
  const metrics = await page.evaluate(() => {
    const browser = document.querySelector(".files-browser");
    const content = document.querySelector(".files-browser-content");
    const viewNav = document.querySelector(".files-view-nav");
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      browser: browser ? { left: browser.getBoundingClientRect().left, right: browser.getBoundingClientRect().right, width: browser.getBoundingClientRect().width } : null,
      content: content ? { left: content.getBoundingClientRect().left, right: content.getBoundingClientRect().right, width: content.getBoundingClientRect().width } : null,
      viewNav: viewNav ? { left: viewNav.getBoundingClientRect().left, right: viewNav.getBoundingClientRect().right, width: viewNav.getBoundingClientRect().width } : null,
      firstItemMainWidth: document.querySelector(".files-items .files-item-main")?.getBoundingClientRect().width ?? 0,
      fileItems: document.querySelectorAll(".files-item-main").length,
      itemListClasses: [...document.querySelectorAll(".files-items")].map((items) => items.className),
    };
  });
  assert.ok(metrics.browser, `Files Browser is rendered at ${width}px`);
  assert.ok(metrics.document <= width + 1, `document does not overflow at ${width}px (${metrics.document}px)`);
  assert.ok(metrics.body <= width + 1, `body does not overflow at ${width}px (${metrics.body}px)`);
  assert.ok(metrics.browser.left >= -1 && metrics.browser.right <= width + 1, `browser fits viewport at ${width}px (${metrics.browser.left}–${metrics.browser.right})`);
  assert.ok(metrics.content?.right <= width + 1, `content fits viewport at ${width}px`);
  assert.ok(metrics.firstItemMainWidth >= 125, `list item name column retains readable width at ${width}px (${metrics.firstItemMainWidth}px)`);
}

async function assertMenuInViewport(page, width) {
  const rect = await page.getByRole("menu").evaluate((menu) => {
    const { left, right, top, bottom } = menu.getBoundingClientRect();
    return { left, right, top, bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(rect.left >= 0 && rect.right <= width, `menu stays horizontally inside ${width}px (${rect.left}–${rect.right})`);
  assert.ok(rect.top >= 0 && rect.bottom <= rect.viewportHeight, `menu stays vertically inside viewport (${rect.top}–${rect.bottom})`);
  return rect;
}

async function assertDetailsBackdropCoversViewport(page, width) {
  const rect = await page.locator(".files-dialog-backdrop").evaluate((backdrop) => {
    const { left, top, right, bottom } = backdrop.getBoundingClientRect();
    return { left, top, right, bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  assert.ok(Math.abs(rect.left) <= 1, `details backdrop starts at viewport left (${rect.left}px)`);
  assert.ok(Math.abs(rect.top) <= 1, `details backdrop starts at viewport top (${rect.top}px)`);
  assert.ok(Math.abs(rect.right - width) <= 1, `details backdrop reaches viewport right (${rect.right}px vs ${width}px)`);
  assert.ok(Math.abs(rect.bottom - rect.viewportHeight) <= 1, `details backdrop reaches viewport bottom (${rect.bottom}px vs ${rect.viewportHeight}px)`);
  return rect;
}

async function assertDialogTopmost(page, selector) {
  const dialog = page.locator(selector);
  await dialog.evaluate((element) => {
    const overlay = element.closest(".modal-backdrop") ?? element;
    for (const animation of overlay.getAnimations({ subtree: true })) animation.finish();
  });
  const evidence = await dialog.evaluate((element) => {
    const backdrop = element.closest(".modal-backdrop");
    const close = [...element.querySelectorAll("button")].find((button) => /^Close\b/i.test(button.textContent?.trim() ?? ""))
      ?? element.querySelector("button");
    const backdropRect = backdrop?.getBoundingClientRect();
    const dialogRect = element.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    const hit = closeRect ? document.elementFromPoint(closeRect.x + closeRect.width / 2, closeRect.y + closeRect.height / 2) : null;
    return {
      dialogOpacity: Number(getComputedStyle(element).opacity),
      backdropOpacity: backdrop ? Number(getComputedStyle(backdrop).opacity) : 0,
      backdrop: backdropRect ? { left: backdropRect.left, top: backdropRect.top, right: backdropRect.right, bottom: backdropRect.bottom } : null,
      dialog: { left: dialogRect.left, top: dialogRect.top, right: dialogRect.right, bottom: dialogRect.bottom },
      closeVisible: Boolean(closeRect && closeRect.width && closeRect.height),
      closeIsTopmost: Boolean(close && hit && close.contains(hit)),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  assert.ok(evidence.dialogOpacity >= 0.99, `dialog is fully opaque (${JSON.stringify(evidence)})`);
  assert.ok(evidence.backdropOpacity >= 0.99, `modal backdrop is fully opaque (${JSON.stringify(evidence)})`);
  assert.ok(evidence.backdrop && Math.abs(evidence.backdrop.left) <= 1 && Math.abs(evidence.backdrop.top) <= 1
    && Math.abs(evidence.backdrop.right - evidence.viewport.width) <= 1
    && Math.abs(evidence.backdrop.bottom - evidence.viewport.height) <= 1, `modal backdrop covers the viewport (${JSON.stringify(evidence)})`);
  assert.ok(evidence.dialog.left >= -1 && evidence.dialog.top >= -1 && evidence.dialog.right <= evidence.viewport.width + 1
    && evidence.dialog.bottom <= evidence.viewport.height + 1, `dialog fits the viewport (${JSON.stringify(evidence)})`);
  assert.ok(evidence.closeVisible && evidence.closeIsTopmost, `the close control is visible and topmost (${JSON.stringify(evidence)})`);
  return evidence;
}

async function inspectSyllabusViews(page, viewportName) {
  const root = page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" });
  const openCourse = async (code) => {
    await page.getByRole("button", { name: `Open folder: ${code}` }).click();
    await page.locator(".files-syllabus-pin").waitFor({ state: "visible" });
  };
  const capture = async (name) => page.screenshot({ path: resolve(screenshotDir, `${viewportName}-course-${name}.png`), fullPage: true, animations: "disabled" });

  await openCourse("BIO 201");
  assert.equal(await page.locator(".files-syllabus-pin").count(), 1, "the uploaded syllabus is pinned once at its course root");
  assert.equal(await page.getByRole("button", { name: "View uploaded file" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "View text", exact: true }).count(), 1, "secondary text is available beside the uploaded source");
  await capture("uploaded-pin");

  await page.getByRole("button", { name: "Replace upload" }).click();
  await page.getByRole("dialog", { name: "Attach syllabus for BIO 201" }).waitFor({ state: "visible" });
  await assertDialogTopmost(page, '[aria-label="Attach syllabus for BIO 201"]');
  await capture("attachment-dialog");
  await page.getByRole("button", { name: "Close syllabus editor" }).click();

  await page.getByRole("button", { name: "View uploaded file" }).click();
  const uploadedPreview = page.locator('[aria-label="Private file preview"]');
  await uploadedPreview.waitFor({ state: "visible" });
  await uploadedPreview.locator(".syllabus-source").waitFor({ state: "visible" });
  assert.match(await uploadedPreview.locator(".syllabus-source").innerText(), /uploaded syllabus preview: résumé, 中文, ✓/);
  await assertDialogTopmost(page, '[aria-label="Private file preview"]');
  await capture("attachment-preview");
  await page.getByRole("button", { name: "Close file preview" }).click();
  await root.click();

  await openCourse("CHEM 102");
  assert.equal(await page.locator(".files-syllabus-pin").count(), 1, "the text-only syllabus is pinned once");
  await page.getByRole("button", { name: "View syllabus text" }).waitFor({ state: "visible" });
  await capture("text-only-pin");
  await page.getByRole("button", { name: "View syllabus text" }).click();
  const textPreview = page.locator(".syllabus-text-preview");
  await textPreview.waitFor({ state: "visible" });
  assert.equal(await textPreview.locator("input,textarea,select").count(), 0, "the saved text preview has no editable fields");
  assert.match(await textPreview.locator(".syllabus-text-preview-content").innerText(), /Chemistry text-only source/);
  await assertDialogTopmost(page, ".syllabus-text-preview");
  await capture("text-preview");
  await page.getByRole("button", { name: "Close preview" }).click();
  await root.click();

  await openCourse("PHYS 110");
  assert.equal(await page.locator(".files-syllabus-pin").count(), 1, "the empty course still has its managed root pin");
  await page.getByText("No syllabus attached", { exact: true }).waitFor({ state: "visible" });
  await capture("empty-pin");
  await root.click();
}

try {
  browser = await playwright.chromium.launch(launchOptions);
  const viewports = [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "compact-desktop", width: 1024, height: 900 },
    { name: "tablet", width: 820, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ];

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
    page.on("pageerror", (error) => errors.push(`pageerror at ${viewport.width}px: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console at ${viewport.width}px: ${message.text()}`); });
    await page.goto(`${baseUrl}/files?view=my-files&layout=list`);
    page.setDefaultTimeout(10000);
    await page.getByRole("button", { name: "Open folder: BIO 201" }).waitFor({ state: "visible" });
    await inspectViewport(page, viewport.width);

    const courseFolder = page.locator(".files-item").filter({ hasText: "BIO 201" }).first();
    assert.equal(await courseFolder.evaluate((row) => getComputedStyle(row).getPropertyValue("--file-item-accent").trim()), "#b23b53", "managed course folders use the current course color");
    await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-list.png`), fullPage: true });

    await inspectSyllabusViews(page, viewport.name);

    const rootListItems = await page.locator(".files-item").evaluateAll((items) => items.map((item) => ({ type: item.classList.contains("is-folder") ? "folder" : "file", name: item.querySelector(".files-item-title strong").textContent })));
    await page.getByRole("button", { name: "Grid view" }).click();
    await page.locator(".files-items.is-grid").waitFor({ state: "visible" });
    const rootGridItems = await page.locator(".files-item").evaluateAll((items) => items.map((item) => ({ type: item.classList.contains("is-folder") ? "folder" : "file", name: item.querySelector(".files-item-title strong").textContent })));
    assert.deepEqual(rootGridItems, rootListItems, `list and grid retain the same root item identities at ${viewport.width}px`);
    await page.getByRole("button", { name: "List view" }).click();
    await page.locator(".files-items.is-list").waitFor({ state: "visible" });

    await page.getByRole("button", { name: "Open folder: BIO 201" }).click();
    await page.getByRole("button", { name: "Open folder: Labs" }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Open folder: Labs" }).click();
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs");
    assert.match(await page.locator(".files-breadcrumbs").innerText(), /BIO 201[\s\S]*Labs/);
    await page.getByRole("button", { name: "Grid view" }).click();
    assert.equal(new URL(page.url()).searchParams.get("layout"), "grid");
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs");
    await page.locator(".files-items.is-grid").waitFor({ state: "visible" });
    await inspectViewport(page, viewport.width);
    await page.screenshot({ path: resolve(screenshotDir, `${viewport.name}-grid.png`), fullPage: true });

    await page.goBack();
    await page.locator(".files-items.is-list").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs");
    await page.goForward();
    await page.locator(".files-items.is-grid").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs");

    await page.evaluate(() => window.__filesBrowserFixture.renameFolder("course-labs", "Lab work renamed"));
    await page.getByRole("heading", { name: "Lab work renamed" }).waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs", "renaming leaves the URL anchored to the stable folder ID");
    await page.reload();
    await page.getByRole("heading", { name: "Labs" }).waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).searchParams.get("folder"), "course-labs", "reload restores the same folder ID");

    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files" }).click();
    const fileTrigger = page.getByRole("button", { name: "More options for Root notes.txt" });
    const triggerBeforeClick = await fileTrigger.evaluate((button) => {
      const { left, right, top, bottom } = button.getBoundingClientRect();
      return { left, right, top, bottom, scrollY: window.scrollY, viewportHeight: window.innerHeight };
    });
    const scrollBeforeMenu = await page.evaluate(() => ({ y: window.scrollY, active: document.activeElement?.tagName }));
    await fileTrigger.click();
    const menu = page.getByRole("menu", { name: "Root notes.txt actions" });
    await page.waitForTimeout(50);
    const afterClickEvidence = await page.evaluate(() => ({
      visibleMenus: document.querySelectorAll('[role="menu"]').length,
      expanded: document.querySelector('[aria-label="More options for Root notes.txt"]')?.getAttribute("aria-expanded"),
      scrollY: window.scrollY,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.outerHTML.slice(0, 120) : String(document.activeElement),
    }));
    try { await menu.waitFor({ state: "visible", timeout: 1500 }); }
    catch (error) {
      throw new Error(`File menu did not open at ${viewport.width}px (${JSON.stringify({ triggerBeforeClick, scrollBeforeMenu, afterClickEvidence, url: page.url() })}): ${error.message}`);
    }
    await page.waitForTimeout(400);
    const menuFocusEvidence = await page.evaluate(() => ({
      visibleMenus: document.querySelectorAll('[role="menu"]').length,
      scrollY: window.scrollY,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.outerHTML.slice(0, 120) : String(document.activeElement),
    }));
    assert.equal(menuFocusEvidence.visibleMenus, 1, `menu stays open after focus settles at ${viewport.width}px (${JSON.stringify(menuFocusEvidence)})`);
    const menuBounds = await assertMenuInViewport(page, viewport.width);
    if (viewport.width === 1440) console.log(`1440px menu bounds: ${JSON.stringify(menuBounds)}`);
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents().then((labels) => labels.map((label) => label.trim())), ["Add to Starred", "Preview", "Download", "Rename file", "Move to…", "Edit details", "Details"]);
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-menu.png"), fullPage: true });
    await menu.getByRole("menuitem", { name: "Details", exact: true }).click();
    await page.getByRole("dialog", { name: /Root notes\.txt/ }).waitFor({ state: "visible" });
    const detailsBounds = await assertDetailsBackdropCoversViewport(page, viewport.width);
    if (viewport.width === 1440) console.log(`1440px details backdrop bounds: ${JSON.stringify(detailsBounds)}`);
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-details.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await fileTrigger.focus();
    await fileTrigger.click();
    await page.getByRole("menu", { name: "Root notes.txt actions" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForFunction((button) => document.activeElement === button, await fileTrigger.elementHandle(), { timeout: 1000 });
    assert.equal(await fileTrigger.evaluate((button) => document.activeElement === button), true, "Escape restores focus to the menu trigger");

    const fileRow = page.locator(".files-item").filter({ hasText: "Root notes.txt" }).first();
    await fileRow.click({ button: "right" });
    await page.getByRole("menu", { name: "Root notes.txt actions" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await fileRow.locator(".files-item-main").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menu", { name: "Root notes.txt actions" }).waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More options for Root notes.txt" }).click();
    await page.getByRole("menuitem", { name: "Preview" }).click();
    await page.getByRole("button", { name: "Open folder: BIO 201" }).click();
    await page.getByRole("button", { name: "Open folder: Labs" }).click();
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("menu", { name: "New actions" }).getByRole("menuitem", { name: "Upload files", exact: true }).click();
    const uploads = await page.evaluate(() => window.__filesBrowserFixture.callbacks.uploads);
    assert.deepEqual(uploads, [{ folderId: "course-labs", courseId: "biology" }]);

    await page.getByRole("button", { name: "Archives", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: Fall 2025" }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "New" }).isDisabled(), true);
    await page.getByRole("button", { name: "Open folder: Fall 2025" }).click();
    await page.getByRole("button", { name: "Open folder: Old labs" }).click();
    await page.getByRole("button", { name: "More options for Archived reading.txt" }).click();
    assert.deepEqual(await page.getByRole("menuitem").allTextContents().then((labels) => labels.map((label) => label.trim())), ["View file", "Download", "Details"]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: Discarded" }).waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "New" }).isDisabled(), true);
    await page.getByRole("button", { name: "Open folder: Discarded" }).click();
    await page.getByRole("button", { name: "More options for Removed.txt" }).click();
    assert.deepEqual(await page.getByRole("menuitem").allTextContents().then((labels) => labels.map((label) => label.trim())), ["Restore", "Delete permanently", "Details"]);
    await page.keyboard.press("Escape");

    await context.close();
  }

  assert.deepEqual(errors, [], errors.join("\n"));
  console.log(`Files Browser browser verification passed at ${viewports.map(({ width }) => `${width}px`).join(", ")}. Screenshots: ${screenshotDir}`);
} finally {
  if (browser) await browser.close();
}
