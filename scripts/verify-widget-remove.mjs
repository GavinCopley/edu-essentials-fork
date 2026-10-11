import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-widget-remove");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const cssFiles = [
  "app/globals.css",
  "app/reference-ui.css",
  "app/widget-appearance.css",
  "app/widget-block-layout.css",
  "app/widget-reorder.css",
];
const [bundle, ...styles] = await Promise.all([
  build({
    entryPoints: [resolve(repoRoot, "tests/fixtures/widget-reorder-browser.tsx")],
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
  }),
  ...cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8")),
]);
const js = bundle.outputFiles[0].text;
const css = styles.map((source) => source.replace(/^@import[^;]+;\s*/gm, "")).join("\n");
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root { --font-geist-sans: Arial, sans-serif; }${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = createServer((request, response) => {
  if (request.url?.startsWith("/fixture.js")) {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(js);
    return;
  }
  if (request.url?.startsWith("/favicon.ico")) { response.writeHead(204); response.end(); return; }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
});
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/`;
await mkdir(screenshotDir, { recursive: true });

const launchOptions = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";
const browser = await playwright.chromium.launch(launchOptions);
const consoleErrors = [];

function observeErrors(page) {
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`); });
}

async function loadPage({ width = 1440, height = 1100, reducedMotion = "no-preference", touch = false, query = "" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion,
    hasTouch: touch,
    isMobile: touch,
  });
  const page = await context.newPage();
  observeErrors(page);
  await page.goto(`${baseUrl}${query}`);
  await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
  return { context, page };
}

async function customize(page) {
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("[data-remove-target-active]")?.getAttribute("data-remove-target-active") === "false");
}

async function liveIds(page) {
  return page.locator(".widget-grid > [data-widget-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id")));
}

async function savedIds(page, workspaceIndex = 0) {
  return page.evaluate((index) => window.__widgetFixture.dashboard.w[index][2].map((widget) => widget[2]), workspaceIndex);
}

async function writes(page) {
  return page.evaluate(() => window.__widgetFixture.writes);
}

async function startMouseDrag(page, widgetId) {
  const card = page.locator(`.widget-grid > [data-widget-id="${widgetId}"]`);
  const handle = card.locator("[data-widget-reorder-handle]");
  await handle.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  const handleBox = await handle.boundingBox();
  assert.ok(cardBox && handleBox, `Expected visible reorder handle for ${widgetId}`);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const offsetX = startX - cardBox.x;
  const offsetY = startY - cardBox.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + 8, { steps: 2 });
  await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
  return { startX, startY, offsetX, offsetY };
}

async function removeTargetBox(page) {
  const host = page.locator(".today-remove-target-host");
  const box = await host.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "Today remove target has a measurable drop area");
  return { host, box };
}

async function moveToRemoveTarget(page) {
  const { host, box } = await removeTargetBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over") === "true");
  await page.locator(".today-remove-target-overlay").waitFor({ state: "visible" });
  assert.equal((await page.locator(".today-remove-target-overlay").innerText()).trim(), "remove widget");
  return { host, box };
}

async function awaitWriteCount(page, expected) {
  await page.waitForFunction((count) => window.__widgetFixture.writes === count, expected, { timeout: 5000 });
}

async function finishMouseRemoval(page, priorWrites) {
  await page.mouse.up();
  await awaitWriteCount(page, priorWrites + 1);
  await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
}

async function cancelAndAssertNoWrite(page, beforeIds, priorWrites, cancelKind) {
  if (cancelKind === "escape") await page.keyboard.press("Escape");
  if (cancelKind === "pointercancel") {
    await page.evaluate(() => {
      const down = [...window.__widgetFixture.pointerEvents].reverse().find((event) => event.type === "pointerdown");
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: down?.id ?? 1, bubbles: true }));
    });
  }
  if (cancelKind === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  if (cancelKind === "outside") {
    await page.mouse.move(4, 4, { steps: 4 });
    await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over") === "false");
  }
  await page.mouse.up();
  await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
  assert.equal(await writes(page), priorWrites, `${cancelKind} while over the remove target does not save`);
  assert.deepEqual(await savedIds(page), beforeIds, `${cancelKind} does not remove the saved widget`);
  assert.deepEqual(await liveIds(page), beforeIds, `${cancelKind} restores the live widget order`);
}

async function verifySuccessfulRemoval() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const before = await liveIds(page);
    const beforeWrites = await writes(page);
    await page.locator('.widget-grid > [data-widget-id="timer-main"] [data-widget-reorder-handle]').scrollIntoViewIfNeeded();
    const beforeGeometry = await page.locator(".home-today-panel").boundingBox();
    assert.ok(beforeGeometry);
    await startMouseDrag(page, "timer-main");
    await page.waitForTimeout(180);
    await page.screenshot({ path: resolve(screenshotDir, "remove-active-grid.png"), fullPage: false });
    const activeGeometry = await page.locator(".home-today-panel").boundingBox();
    assert.ok(activeGeometry);
    assert.deepEqual(
      { x: activeGeometry.x, y: activeGeometry.y, width: activeGeometry.width, height: activeGeometry.height },
      { x: beforeGeometry.x, y: beforeGeometry.y, width: beforeGeometry.width, height: beforeGeometry.height },
      "activating the remove affordance does not move or resize Today",
    );
    const { host } = await moveToRemoveTarget(page);
    const duringGeometry = await page.locator(".home-today-panel").boundingBox();
    assert.ok(duringGeometry);
    assert.deepEqual(
      { x: duringGeometry.x, y: duringGeometry.y, width: duringGeometry.width, height: duringGeometry.height },
      { x: beforeGeometry.x, y: beforeGeometry.y, width: beforeGeometry.width, height: beforeGeometry.height },
      "showing the remove target does not move or resize Today",
    );
    assert.equal(await host.getAttribute("data-remove-target-active"), "true");
    assert.equal(await host.getAttribute("data-remove-target-over"), "true");
    await page.waitForTimeout(180);
    const targetBox = await host.boundingBox();
    const iconBox = await page.locator(".today-remove-target-overlay svg").boundingBox();
    const labelBox = await page.locator(".today-remove-target-overlay span").boundingBox();
    assert.ok(targetBox && iconBox && labelBox);
    assert.ok(Math.abs(iconBox.x + iconBox.width / 2 - (targetBox.x + targetBox.width / 2)) < 2, "the trash icon is centered in the Today target");
    assert.ok(Math.abs(labelBox.x + labelBox.width / 2 - (targetBox.x + targetBox.width / 2)) < 2, "the remove label is centered below the icon");
    assert.ok(iconBox.y + iconBox.height < labelBox.y, "the remove label sits below the trash icon");
    const targetStyle = await page.locator(".today-remove-target-overlay").evaluate((node) => ({
      borderStyle: getComputedStyle(node).borderTopStyle,
      borderColor: getComputedStyle(node).borderTopColor,
    }));
    assert.equal(targetStyle.borderStyle, "dashed", "the active target uses a dashed outline");
    assert.match(targetStyle.borderColor, /rgb\(255, 119, 132\)/, "the active target outline uses the removal color");
    await page.screenshot({ path: resolve(screenshotDir, "remove-hover.png"), fullPage: false });
    assert.equal(await writes(page), beforeWrites, "hovering Today stays a preview until release");
    assert.ok((await savedIds(page)).includes("timer-main"), "the dragged widget remains saved while hovering");
    await page.mouse.up();
    await awaitWriteCount(page, beforeWrites + 1);
    await page.waitForFunction(() => !document.querySelector('.widget-grid > [data-widget-id="timer-main"]'));
    assert.deepEqual(await liveIds(page), before.filter((id) => id !== "timer-main"));
    assert.deepEqual(await savedIds(page), before.filter((id) => id !== "timer-main"), "the compact saved dashboard excludes the removed widget");
    await page.getByText("Workspace saved").waitFor({ timeout: 5000 });
    await page.screenshot({ path: resolve(screenshotDir, "remove-saved-board.png"), fullPage: true });
  } finally { await context.close(); }
}

async function verifyCancellations() {
  for (const cancelKind of ["escape", "pointercancel", "blur", "outside"]) {
    const { context, page } = await loadPage();
    try {
      await customize(page);
      const before = await liveIds(page);
      const beforeWrites = await writes(page);
      await startMouseDrag(page, "timer-main");
      await moveToRemoveTarget(page);
      await cancelAndAssertNoWrite(page, before, beforeWrites, cancelKind);
    } finally { await context.close(); }
  }
}

async function verifyDisabledMode() {
  const { context, page } = await loadPage();
  try {
    const before = await liveIds(page);
    const beforeWrites = await writes(page);
    const card = page.locator('.widget-grid > [data-widget-id="timer-main"]');
    const handle = card.locator("[data-widget-reorder-handle]");
    await handle.scrollIntoViewIfNeeded();
    const handleBox = await handle.boundingBox();
    const target = await page.locator(".today-remove-target-host").boundingBox();
    assert.ok(handleBox && target);
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 14, handleBox.y + handleBox.height / 2 + 10, { steps: 2 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator(".widget-reorder-overlay").count(), 0, "a non-customizing drag never activates the reorder overlay");
    assert.equal(await page.locator(".today-remove-target-overlay").count(), 0, "a non-customizing drag does not expose the remove target");
    assert.equal(await writes(page), beforeWrites);
    assert.deepEqual(await savedIds(page), before);
    assert.deepEqual(await liveIds(page), before);
  } finally { await context.close(); }
}

async function verifyNotesConfirmation() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const before = await liveIds(page);
    const beforeWrites = await writes(page);

    await startMouseDrag(page, "notes-main");
    await moveToRemoveTarget(page);
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.message(), "Remove this notes widget and its text?");
      await dialog.dismiss();
    });
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    assert.equal(await writes(page), beforeWrites, "rejecting the notes confirmation does not save");
    assert.deepEqual(await liveIds(page), before, "rejecting the notes confirmation restores the widget");

    await startMouseDrag(page, "notes-main");
    await moveToRemoveTarget(page);
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.message(), "Remove this notes widget and its text?");
      await dialog.accept();
    });
    await page.mouse.up();
    await awaitWriteCount(page, beforeWrites + 1);
    await page.waitForFunction(() => !document.querySelector('.widget-grid > [data-widget-id="notes-main"]'));
    const expected = before.filter((id) => id !== "notes-main");
    assert.deepEqual(await liveIds(page), expected);
    assert.deepEqual(await savedIds(page), expected, "accepting the notes confirmation persists removal");
    const noteTexts = await page.evaluate(() => window.__widgetFixture.dashboard.t ?? []);
    assert.equal(noteTexts.length, 0, "the saved compact dashboard no longer retains removed notes text");
  } finally { await context.close(); }
}

async function verifyHiddenTodayTarget() {
  const { context, page } = await loadPage();
  try {
    const writesBeforeHide = await writes(page);
    await page.getByRole("button", { name: "Today section options" }).click();
    await page.getByRole("menuitem", { name: "Hide section" }).click();
    await awaitWriteCount(page, writesBeforeHide + 1);
    assert.deepEqual(await page.evaluate(() => window.__widgetFixture.dashboard.h), ["fixture-day"], "hiding Today is saved before the remove interaction");
    await customize(page);
    await page.getByRole("button", { name: "Restore Today section" }).waitFor({ state: "visible" });
    const before = await liveIds(page);
    const beforeWrites = await writes(page);
    await startMouseDrag(page, "timer-main");
    await moveToRemoveTarget(page);
    assert.equal(await page.locator(".today-remove-target-content").getAttribute("inert"), "");
    assert.equal(await page.locator(".today-section-restore").count(), 1, "the hidden Today ghost retains its restore control while dragging");
    await page.screenshot({ path: resolve(screenshotDir, "remove-hidden-today-hover.png"), fullPage: false });
    await finishMouseRemoval(page, beforeWrites);
    const expected = before.filter((id) => id !== "timer-main");
    assert.deepEqual(await savedIds(page), expected, "a hidden Today Customize ghost accepts removal");
    assert.deepEqual(await page.evaluate(() => window.__widgetFixture.dashboard.h), ["fixture-day"], "removing from the hidden ghost preserves Today’s hidden state");
    await page.getByRole("button", { name: "Restore Today section" }).waitFor({ state: "visible" });
  } finally { await context.close(); }
}

async function verifyLeavingTargetReorders() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const before = await liveIds(page);
    const beforeWrites = await writes(page);
    const drag = await startMouseDrag(page, "timer-main");
    await moveToRemoveTarget(page);
    const targetForOrder = await page.evaluate(({ offsetX, offsetY }) => window.__widgetFixture.targetFor("timer-main", 0, offsetX, offsetY), drag);
    await page.mouse.move(targetForOrder.x, targetForOrder.y, { steps: 8 });
    await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over") === "false");
    await page.waitForFunction((order) => [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id")).join("|") === order.join("|"), targetForOrder.candidate);
    assert.equal(await writes(page), beforeWrites, "leaving the remove target and previewing a reorder does not save yet");
    assert.ok(await page.locator(".today-remove-target-overlay").count(), "the active drag continues to advertise the remove affordance while it is available");
    await page.mouse.up();
    await awaitWriteCount(page, beforeWrites + 1);
    assert.deepEqual(await savedIds(page), targetForOrder.candidate, "dropping back on the grid reorders instead of removing");
    assert.equal((await savedIds(page)).length, before.length);
  } finally { await context.close(); }
}

async function verifyStaleWorkspaceGuard() {
  const { context, page } = await loadPage({ query: "?remove-multi=1" });
  try {
    await customize(page);
    await page.getByRole("tab", { name: "Fixture day" }).waitFor({ state: "visible" });
    const before = await savedIds(page);
    const beforeWrites = await writes(page);
    await startMouseDrag(page, "timer-main");
    await moveToRemoveTarget(page);
    await page.evaluate(() => [...document.querySelectorAll("[role='tab']")].find((tab) => tab.textContent?.trim() === "Other day")?.click());
    await page.waitForFunction(() => document.querySelector(".widget-grid > [data-widget-id]")?.getAttribute("data-widget-id") === "other-timer");
    await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-active") === "false");
    await page.mouse.up();
    assert.equal(await writes(page), beforeWrites, "switching workspaces during a drag makes the old removal stale");
    assert.deepEqual(await savedIds(page), before, "the source workspace keeps its widget after the switch");
    assert.deepEqual(await savedIds(page, 1), ["other-timer"], "the destination workspace is untouched");
  } finally { await context.close(); }
}

async function verifyReducedMotion() {
  const { context, page } = await loadPage({ reducedMotion: "reduce" });
  try {
    assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
    await customize(page);
    const beforeWrites = await writes(page);
    await startMouseDrag(page, "timer-main");
    await moveToRemoveTarget(page);
    await page.mouse.up();
    await awaitWriteCount(page, beforeWrites + 1);
    assert.ok(!(await savedIds(page)).includes("timer-main"), "removal remains usable with reduced motion enabled");
  } finally { await context.close(); }
}

async function verifyMobileTouchRemoval() {
  const { context, page } = await loadPage({ width: 390, height: 1100, touch: true, reducedMotion: "reduce" });
  let session;
  try {
    await customize(page);
    const before = await liveIds(page);
    const beforeWrites = await writes(page);
    const card = page.locator('.widget-grid > [data-widget-id="notes-main"]');
    const handle = card.locator("[data-widget-reorder-handle]");
    await handle.scrollIntoViewIfNeeded();
    const cardBox = await card.boundingBox();
    const handleBox = await handle.boundingBox();
    const target = await removeTargetBox(page);
    assert.ok(cardBox && handleBox);
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: startX, y: startY, radiusX: 2, radiusY: 2, force: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: startX + 10, y: startY + 8, radiusX: 2, radiusY: 2, force: 1 }] });
    await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: target.box.x + target.box.width / 2, y: target.box.y + target.box.height / 2, radiusX: 2, radiusY: 2, force: 1 }] });
    await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over") === "true");
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.message(), "Remove this notes widget and its text?");
      await dialog.accept();
    });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await awaitWriteCount(page, beforeWrites + 1);
    assert.ok(await page.evaluate(() => window.__widgetFixture.pointerTypes.includes("touch")), "Chrome dispatched touch PointerEvents to the workspace");
    assert.deepEqual(await savedIds(page), before.filter((id) => id !== "notes-main"), "touch release on Today removes and saves the dragged widget");
    await page.screenshot({ path: resolve(screenshotDir, "remove-touch-saved-board.png"), fullPage: true });
  } finally {
    if (session) await session.detach();
    await context.close();
  }
}

try {
  await verifySuccessfulRemoval();
  await verifyCancellations();
  await verifyDisabledMode();
  await verifyNotesConfirmation();
  await verifyHiddenTodayTarget();
  await verifyLeavingTargetReorders();
  await verifyStaleWorkspaceGuard();
  await verifyReducedMotion();
  await verifyMobileTouchRemoval();
  assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
  console.log(`Widget remove browser QA passed. Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
