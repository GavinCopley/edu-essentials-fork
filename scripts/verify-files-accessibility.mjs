import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-files-accessibility");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const esbuild = process.env.ESBUILD_MODULE
  ? await import(pathToFileURL(resolve(process.env.ESBUILD_MODULE)).href)
  : await import("esbuild");

const fixtures = {
  files: "tests/fixtures/files-browser-browser.tsx",
  organization: "tests/fixtures/file-organization-browser.tsx",
  trash: "tests/fixtures/files-trash-browser.tsx",
  native: "tests/fixtures/native-document-browser.tsx",
};
const cssFiles = [
  "app/globals.css",
  "app/reference-ui.css",
  "app/files-browser.css",
  "app/files-browser-tools.css",
  "app/file-upload-dialog.css",
  "app/file-archive-dialog.css",
  "app/file-organization-dialogs.css",
  "app/files-trash-dialog.css",
  "app/course-syllabus.css",
  "app/native-document-editor.css",
  "app/auth.css",
];
const [cssSources, bundles] = await Promise.all([
  Promise.all(cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8"))),
  Promise.all(Object.entries(fixtures).map(async ([name, path]) => {
    const bundle = await esbuild.build({
      entryPoints: [resolve(repoRoot, path)],
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
    return [name, bundle.outputFiles[0].text];
  })),
]);
const javascriptByFixture = Object.fromEntries(bundles);
const css = cssSources.map((source) => source.replace(/^@import[^;]+;\s*/gm, "")).join("\n");
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root { --font-geist-sans: Arial, sans-serif; }${css}</style></head><body><div class="app-shell reference-ui"><aside class="sidebar" aria-hidden="true"></aside><header class="desktop-topbar" aria-hidden="true"></header><main id="main-content" class="main-content"><div id="root"></div></main></div><script src="/fixture.js"></script></body></html>`;
const baseUrl = "https://files-accessibility.test";
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];
await mkdir(screenshotDir, { recursive: true });

const launchOptions = {
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"],
};
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";

const browserErrors = [];
const contrastReport = [];
let browser;

async function preparePage(fixture, viewport, query = "view=my-files&layout=list") {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) { await route.continue(); return; }
    if (url.pathname === "/fixture.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        headers: { "cache-control": "no-store" },
        body: javascriptByFixture[fixture],
      });
    } else if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204, body: "" });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: { "cache-control": "no-store" },
        body: html,
      });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => browserErrors.push(`pageerror ${fixture}/${viewport.width}px: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console ${fixture}/${viewport.width}px: ${message.text()}`);
  });
  await page.goto(`${baseUrl}/files?${query}`);
  await page.locator(".files-browser").waitFor({ state: "visible" });
  await page.locator(".files-browser-content .files-items").waitFor({ state: "visible" });
  return { context, page };
}

function parseColor(value) {
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].replace(/\//g, " ").trim().split(/[\s,]+/).filter(Boolean);
    const channel = (part) => part.endsWith("%") ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part);
    return [channel(parts[0]), channel(parts[1]), channel(parts[2]), parts[3] === undefined ? 1 : (parts[3].endsWith("%") ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]))];
  }
  const hex = value.match(/^#([\da-f]{3,8})$/i);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((part) => part + part).join("");
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
      digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
    ];
  }
  throw new Error(`Unsupported computed CSS color: ${value}`);
}

function composite(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];
  return [0, 1, 2].map((channel) => (
    (foreground[channel] * foreground[3] + background[channel] * background[3] * (1 - foreground[3])) / alpha
  )).concat(alpha);
}

function luminance([red, green, blue]) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(first, second) {
  const high = Math.max(luminance(first), luminance(second));
  const low = Math.min(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}

function summarizeContrast() {
  return viewports.map(({ width }) => {
    const byMode = Object.fromEntries(["normal", "high"].map((mode) => {
      const records = contrastReport.filter((item) => item.viewport === width && item.mode === mode);
      const lowest = records.reduce((current, item) => !current || item.contrast < current.contrast ? item : current, null);
      return [mode, {
        sampleCount: records.length,
        minimumRatio: lowest?.contrast ?? null,
        lowestSample: lowest ? {
          name: lowest.name,
          selector: lowest.selector,
          textColor: lowest.textColor,
          renderedBackgroundPixel: lowest.renderedBackgroundPixel,
        } : null,
      }];
    }));
    return { viewport: width, ...byMode };
  });
}

async function measureContrast(page, mode, samples) {
  const descriptors = await page.evaluate((requested) => {
    const saved = [];
    const measures = requested.map(({ name, selector }) => {
      const element = document.querySelector(selector);
      if (!element) return { name, selector, missing: true };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const color = style.color;
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const backgroundImage = style.backgroundImage;
      const opacity = (() => {
        let value = 1;
        for (let node = element; node; node = node.parentElement) value *= Number.parseFloat(getComputedStyle(node).opacity || "1");
        return value;
      })();
      const snapshotNodes = [element, ...element.querySelectorAll("*")];
      saved.push(snapshotNodes.map((node) => [node, node.getAttribute("style")]));
      element.style.setProperty("color", "transparent", "important");
      element.style.setProperty("-webkit-text-fill-color", "transparent", "important");
      element.style.setProperty("text-shadow", "none", "important");
      for (const child of snapshotNodes.slice(1)) child.style.setProperty("visibility", "hidden", "important");
      return {
        name,
        selector,
        color,
        fontSize,
        fontWeight,
        backgroundImage,
        opacity,
        x: Math.max(0, Math.min(window.innerWidth - 1, Math.floor(rect.left + rect.width / 2))),
        y: Math.max(0, Math.min(window.innerHeight - 1, Math.floor(rect.top + rect.height / 2))),
        visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      };
    });
    window.__filesA11yProbeRestore = saved;
    return measures;
  }, samples);
  assert.ok(descriptors.every((item) => !item.missing), `all contrast targets render in ${mode}: ${JSON.stringify(descriptors.filter((item) => item.missing))}`);
  assert.ok(descriptors.every((item) => item.visible), `all contrast targets are visible in ${mode}: ${JSON.stringify(descriptors.filter((item) => !item.visible))}`);

  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await page.screenshot({ animations: "disabled" });
  const pixels = await page.evaluate(async ({ encodedImage, points }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encodedImage}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return points.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data]);
  }, { encodedImage: image.toString("base64"), points: descriptors.map(({ x, y }) => ({ x, y })) });
  await page.evaluate(() => {
    for (const snapshot of window.__filesA11yProbeRestore ?? []) {
      for (const [element, style] of snapshot) {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }
    }
    delete window.__filesA11yProbeRestore;
  });

  const report = descriptors.map((descriptor, index) => {
    const color = parseColor(descriptor.color);
    const pixel = pixels[index].slice(0, 3).map(Number);
    const background = [...pixel, 1];
    const foreground = composite([color[0], color[1], color[2], color[3] * descriptor.opacity], background);
    return {
      viewport: page.viewportSize().width,
      mode,
      name: descriptor.name,
      selector: descriptor.selector,
      fontSizePx: descriptor.fontSize,
      fontWeight: descriptor.fontWeight,
      textColor: descriptor.color,
      renderedBackgroundPixel: `rgb(${pixel.join(", ")})`,
      contrast: Number(contrastRatio(foreground, background).toFixed(2)),
      backgroundImage: descriptor.backgroundImage === "none" ? undefined : descriptor.backgroundImage,
    };
  });
  for (const item of report) {
    assert.ok(item.contrast >= 4.5, `${item.name} contrast is at least 4.5:1 in ${mode} (${JSON.stringify(item)})`);
  }
  contrastReport.push(...report);
  return report;
}

async function assertContrastPreference(page) {
  const normal = await page.locator(".files-item.is-file .files-status.is-ready").evaluate((element) => ({
    color: getComputedStyle(element).color,
    fontWeight: Number.parseInt(getComputedStyle(element).fontWeight, 10),
    borderColor: getComputedStyle(element).borderTopColor,
  }));
  await page.evaluate(() => { document.documentElement.dataset.contrast = "high"; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const high = await page.locator(".files-item.is-file .files-status.is-ready").evaluate((element) => ({
    color: getComputedStyle(element).color,
    fontWeight: Number.parseInt(getComputedStyle(element).fontWeight, 10),
    borderColor: getComputedStyle(element).borderTopColor,
  }));
  assert.ok(high.fontWeight >= 700, `high-contrast preference strengthens Files status weight (${JSON.stringify({ normal, high })})`);
  assert.equal(high.borderColor, high.color, `high-contrast Files status label has a visible text-color border (${JSON.stringify({ normal, high })})`);
}

async function assertDialogSemantics(dialog, { description = true } = {}) {
  const semantics = await dialog.evaluate((element) => {
    const titleId = element.getAttribute("aria-labelledby");
    const descriptionIds = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return {
      role: element.getAttribute("role"),
      modal: element.getAttribute("aria-modal"),
      titleId,
      title: titleId ? document.getElementById(titleId)?.textContent?.trim() ?? "" : "",
      descriptionIds,
      description: descriptionIds.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" "),
    };
  });
  assert.equal(semantics.role, "dialog");
  assert.equal(semantics.modal, "true");
  assert.ok(semantics.titleId && semantics.title, `dialog has a nonempty accessible name (${JSON.stringify(semantics)})`);
  if (description) assert.ok(semantics.descriptionIds.length && semantics.description, `dialog has a nonempty accessible description (${JSON.stringify(semantics)})`);
  return semantics;
}

async function assertFocusTrap(page, dialogSelector) {
  const count = await page.locator(dialogSelector).evaluate((dialog) => {
    const candidates = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    if (candidates.length < 2) throw new Error(`Expected at least two focusable dialog controls, found ${candidates.length}`);
    candidates[0].focus();
    return candidates.length;
  });
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator(dialogSelector).evaluate((dialog) => {
    const candidates = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    return candidates.indexOf(document.activeElement);
  }), count - 1, `Shift+Tab wraps from the first to last dialog control in ${dialogSelector}`);
  await page.locator(dialogSelector).evaluate((dialog) => {
    const candidates = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    candidates.at(-1).focus();
  });
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(dialogSelector).evaluate((dialog) => {
    const candidates = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    return candidates.indexOf(document.activeElement);
  }), 0, `Tab wraps from the last to first dialog control in ${dialogSelector}`);
}

async function assertMenuFits(page, viewport) {
  const bounds = await page.getByRole("menu").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: window.innerWidth, height: window.innerHeight };
  });
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.width + 1 && bounds.top >= -1 && bounds.bottom <= bounds.height + 1,
    `keyboard-opened menu stays in the ${viewport.width}px viewport (${JSON.stringify(bounds)})`);
  return bounds;
}

async function verifyFilesKeyboardAndContrast(viewport) {
  const { context, page } = await preparePage("files", viewport);
  try {
    const namedRegion = page.getByRole("region", { name: "My files contents" });
    await namedRegion.waitFor({ state: "visible" });
    const trigger = page.getByRole("button", { name: "More options for Root notes.txt", exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Root notes.txt actions" });
    await menu.waitFor({ state: "visible" });
    const items = menu.getByRole("menuitem");
    const itemCount = await items.count();
    assert.ok(itemCount >= 3, "the file action menu exposes keyboard-operable actions");
    try {
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem", undefined, { timeout: 1500 });
    } catch {
      const focusDiagnostic = await page.evaluate(() => ({
        active: document.activeElement ? {
          tag: document.activeElement.tagName,
          role: document.activeElement.getAttribute("role"),
          label: document.activeElement.getAttribute("aria-label"),
          text: document.activeElement.textContent?.trim(),
          className: document.activeElement.className,
        } : null,
        menu: document.querySelector("[role='menu']")?.innerHTML,
      }));
      throw new Error(`keyboard menu did not focus an action: ${JSON.stringify(focusDiagnostic)}`);
    }
    assert.equal(await items.nth(0).evaluate((element) => document.activeElement === element), true,
      "Shift+F10 opens the named item menu on its first enabled action");
    await page.keyboard.press("ArrowDown");
    assert.equal(await items.nth(1).evaluate((element) => document.activeElement === element), true, "ArrowDown advances within the menu");
    await page.keyboard.press("ArrowUp");
    assert.equal(await items.nth(0).evaluate((element) => document.activeElement === element), true, "ArrowUp returns within the menu");
    await page.keyboard.press("ArrowUp");
    assert.equal(await items.nth(itemCount - 1).evaluate((element) => document.activeElement === element), true, "ArrowUp wraps from first to last");
    await page.keyboard.press("Home");
    assert.equal(await items.nth(0).evaluate((element) => document.activeElement === element), true, "Home focuses the first menu action");
    await page.keyboard.press("End");
    assert.equal(await items.nth(itemCount - 1).evaluate((element) => document.activeElement === element), true, "End focuses the last menu action");
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-files-keyboard-menu.png"), animations: "disabled" });
    await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Root notes.txt" });
    await details.waitFor({ state: "visible" });
    await assertDialogSemantics(details, { description: false });
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "detached" });
    await page.waitForFunction((button) => document.activeElement === button, await trigger.elementHandle());

    const checkbox = page.getByRole("checkbox", { name: "Select Root notes.txt in My files", exact: true });
    await checkbox.focus();
    await page.keyboard.press("Space");
    const bulkActions = page.getByRole("group", { name: "Bulk file actions" });
    const selectionStatus = bulkActions.locator('[aria-live="polite"]');
    assert.equal(await selectionStatus.getAttribute("aria-live"), "polite", "selection count is announced politely");
    assert.equal((await selectionStatus.innerText()).trim(), "1 item selected");
    const secondCheckbox = page.getByRole("checkbox", { name: "Select Class notes in My files", exact: true });
    await secondCheckbox.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector(".files-selection-toolbar > span")?.textContent?.trim() === "2 items selected");

    const newButton = page.getByRole("button", { name: "New", exact: true });
    await newButton.scrollIntoViewIfNeeded();
    await page.waitForTimeout(50);
    await newButton.focus();
    await page.keyboard.press("Enter");
    const newMenu = page.getByRole("menu", { name: "New actions" });
    await newMenu.waitFor({ state: "visible" });
    await assertMenuFits(page, viewport);
    const menuName = await newMenu.getAttribute("aria-label");
    assert.equal(menuName, "New actions");
    const menuItems = newMenu.getByRole("menuitem");
    assert.ok(await menuItems.count() > 0, "New menu has accessible menu items");
    const modeSamples = [
      { name: "small file detail", selector: ".files-item-title small" },
      { name: "file status label", selector: ".files-item.is-file .files-status.is-ready" },
      { name: "polite selection count", selector: ".files-selection-toolbar > span" },
      { name: "secondary file action", selector: ".files-selection-toolbar .files-secondary-button" },
      { name: "creation menu item", selector: ".files-context-menu [role='menuitem']" },
    ];
    await page.evaluate(() => { delete document.documentElement.dataset.contrast; });
    await measureContrast(page, "normal", modeSamples);
    await assertContrastPreference(page);
    if (!(await newMenu.isVisible().catch(() => false))) {
      await newButton.scrollIntoViewIfNeeded();
      await page.waitForTimeout(50);
      await newButton.focus();
      await page.keyboard.press("Enter");
      await newMenu.waitFor({ state: "visible" });
    }
    await measureContrast(page, "high", modeSamples);
    if (await newMenu.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await newMenu.waitFor({ state: "detached" });
      await page.waitForFunction((button) => document.activeElement === button, await newButton.elementHandle());
    }
  } finally {
    await context.close();
  }
}

async function verifyOrganizationDialog(viewport) {
  const { context, page } = await preparePage("organization", viewport);
  try {
    const trigger = page.getByRole("button", { name: "New", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "New actions" });
    await menu.waitFor({ state: "visible" });
    const newFolder = menu.getByRole("menuitem", { name: "New folder", exact: true });
    await newFolder.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create folder", exact: true });
    await dialog.waitFor({ state: "visible" });
    const semantics = await assertDialogSemantics(dialog);
    await assertFocusTrap(page, ".file-organization-dialog");
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-organization-dialog.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction((button) => document.activeElement === button, await trigger.elementHandle());
    return semantics;
  } finally {
    await context.close();
  }
}

async function openTrashDeleteDialog(page) {
  const trigger = page.getByRole("button", { name: "More options for Project Phoenix", exact: true });
  await trigger.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Project Phoenix actions" });
  await menu.waitFor({ state: "visible" });
  const deleteAction = menu.getByRole("menuitem", { name: "Delete permanently", exact: true });
  await deleteAction.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Delete folder permanently", exact: true });
  await dialog.waitFor({ state: "visible" });
  return { dialog, trigger };
}

async function verifyTrashDialogAndContrast(viewport) {
  const { context, page } = await preparePage("trash", viewport, "scenario=retry&view=trash&layout=list");
  try {
    await page.getByRole("button", { name: "More options for Project Phoenix", exact: true }).waitFor({ state: "visible" });
    const first = await openTrashDeleteDialog(page);
    const semantics = await assertDialogSemantics(first.dialog);
    await assertFocusTrap(page, ".files-trash-dialog");
    await page.keyboard.press("Escape");
    await first.dialog.waitFor({ state: "detached" });
    await page.waitForFunction((button) => document.activeElement === button, await first.trigger.elementHandle());

    const second = await openTrashDeleteDialog(page);
    await second.dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
    const error = page.locator(".files-trash-error[role='alert']");
    await error.waitFor({ state: "visible" });
    assert.match(await error.innerText(), /Mock physical object cleanup failed/);
    const samples = [
      { name: "Trash dialog description", selector: ".files-trash-intro" },
      { name: "Trash error alert", selector: ".files-trash-error[role='alert']" },
      { name: "Trash target detail", selector: ".files-trash-target span" },
      { name: "Trash secondary control", selector: ".files-trash-actions .files-secondary-button" },
      { name: "Trash submit control", selector: ".files-trash-submit" },
    ];
    await page.evaluate(() => { delete document.documentElement.dataset.contrast; });
    await measureContrast(page, "normal", samples);
    await page.evaluate(() => { document.documentElement.dataset.contrast = "high"; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await measureContrast(page, "high", samples);
    if (viewport.width === 390) await page.screenshot({ path: resolve(screenshotDir, "mobile-trash-error-dialog.png"), animations: "disabled" });

    await second.dialog.getByRole("button", { name: "Refresh Files", exact: true }).click();
    const pendingStatus = page.locator(".files-status.is-deleting").first();
    await pendingStatus.waitFor({ state: "visible" });
    assert.match((await pendingStatus.innerText()).trim(), /Cleanup pending|Permanent deletion pending/);
    await page.keyboard.press("Escape");
    await second.dialog.getByRole("button", { name: "Close anyway", exact: true }).click();
    await second.dialog.waitFor({ state: "detached" });
    const pendingSamples = [{ name: "Trash pending cleanup status", selector: ".files-status.is-deleting" }];
    await page.evaluate(() => { delete document.documentElement.dataset.contrast; });
    await measureContrast(page, "normal", pendingSamples);
    await page.evaluate(() => { document.documentElement.dataset.contrast = "high"; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await measureContrast(page, "high", pendingSamples);
    return semantics;
  } finally {
    await context.close();
  }
}

async function verifyNativeLiveRegionAndContrast(viewport) {
  const { context, page } = await preparePage("native", viewport);
  try {
    const newButton = page.getByRole("button", { name: "New", exact: true });
    await newButton.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "New actions" });
    await menu.waitFor({ state: "visible" });
    const createText = menu.getByRole("menuitem", { name: "Text document", exact: true });
    await createText.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Edit text file", exact: true });
    await dialog.waitFor({ state: "visible" });
    const semantics = await assertDialogSemantics(dialog);
    assert.deepEqual(semantics.descriptionIds, ["native-document-help"], "native editor help is linked as the dialog's accessible description");
    assert.match(semantics.description, /save automatically/i, "native editor description explains autosave");
    assert.match(semantics.description, /Ctrl\/⌘\+S/i, "native editor description explains the manual save shortcut");
    const status = page.locator(".native-document-status");
    await page.waitForFunction(() => document.querySelector(".native-document-status")?.textContent?.trim() === "Saved");
    assert.equal(await status.getAttribute("role"), "status");
    assert.equal(await status.getAttribute("aria-live"), "polite", "document save state is announced politely");
    assert.equal((await status.innerText()).trim(), "Saved");

    const textBox = dialog.getByRole("textbox", { name: "Text", exact: true });
    await textBox.fill("Accessibility verifier save state.");
    await page.waitForFunction(() => document.querySelector(".native-document-status")?.textContent?.trim() === "Saved");
    assert.equal(await status.getAttribute("role"), "status");
    assert.equal(await status.getAttribute("aria-live"), "polite", "save completion remains in the polite live region");
    const samples = [
      { name: "native save status", selector: ".native-document-status" },
      { name: "native editor help", selector: ".native-document-help" },
      { name: "native editor secondary control", selector: ".native-document-actions .files-secondary-button" },
    ];
    await page.evaluate(() => { delete document.documentElement.dataset.contrast; });
    await measureContrast(page, "normal", samples);
    await page.evaluate(() => { document.documentElement.dataset.contrast = "high"; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await measureContrast(page, "high", samples);
    if (viewport.width === 1440) await page.screenshot({ path: resolve(screenshotDir, "desktop-native-editor-saved.png"), animations: "disabled" });
    return semantics;
  } finally {
    await context.close();
  }
}

try {
  browser = await playwright.chromium.launch(launchOptions);
  const summary = [];
  for (const viewport of viewports) {
    await verifyFilesKeyboardAndContrast(viewport);
    const organization = await verifyOrganizationDialog(viewport);
    const trash = await verifyTrashDialogAndContrast(viewport);
    const native = await verifyNativeLiveRegionAndContrast(viewport);
    summary.push({ viewport: viewport.width, organization, trash, native });
  }
  assert.deepEqual(browserErrors, [], `browser console has no errors: ${browserErrors.join("; ")}`);
  const contrastReportPath = resolve(screenshotDir, "contrast-report.json");
  await writeFile(contrastReportPath, `${JSON.stringify({ threshold: "4.5:1", samples: contrastReport }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, browser: "Chrome", screenshots: screenshotDir, contrastReport: contrastReportPath, summary, contrast: summarizeContrast() }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, screenshots: screenshotDir, error: error instanceof Error ? error.stack : String(error), browserErrors, contrast: summarizeContrast() }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
