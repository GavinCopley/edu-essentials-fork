import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const launchOptions = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";
const browser = await playwright.chromium.launch(launchOptions);
const consoleErrors = [];

function observeErrors(page) {
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`console: ${message.text()}`); });
}

async function loadPage({ width = 1440, height = 1100, touch = false, query = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  observeErrors(page);
  await page.goto(`${baseUrl}${query}`);
  await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
  return { context, page };
}

async function customize(page) {
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
  assert.equal(await customizeState(page), true, "Customize is active");
}

async function customizeState(page) {
  return (await page.locator(".workspace-actions button[aria-pressed]").getAttribute("aria-pressed")) === "true";
}

async function tapMouse(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "tap target is visible");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await tapMouseAt(page, x, y);
}

async function tapMouseAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

async function doubleTapMouse(page, locator) {
  await tapMouse(page, locator);
  await page.waitForTimeout(90);
  await tapMouse(page, locator);
}

async function assertState(page, expected, message) {
  await page.waitForFunction((value) => document.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed") === String(value), expected, { timeout: 2500 });
  assert.equal(await customizeState(page), expected, message);
}

async function tapTouch(session, x, y) {
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function verifyInactiveDoesNotEnter() {
  const { context, page } = await loadPage();
  try {
    const heading = page.locator('.widget-grid > [data-widget-id="notes-main"] .widget-header h2');
    await doubleTapMouse(page, heading);
    await assertState(page, false, "a double tap while Customize is inactive does not enter Customize");
    assert.ok(await page.evaluate(() => window.__widgetFixture.pointerTypes.includes("mouse")));
  } finally { await context.close(); }
}

async function verifyMouseDoubleTapAndSingleTap() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const heading = page.locator('.widget-grid > [data-widget-id="notes-main"] .widget-header h2');
    await tapMouse(page, heading);
    await page.waitForTimeout(400);
    await assertState(page, true, "one tap does not leave Customize after the double-tap window expires");

    const blankBody = page.locator('.widget-grid > [data-widget-id="spacer-main"] .widget-body');
    await blankBody.scrollIntoViewIfNeeded();
    const bodyBox = await blankBody.boundingBox();
    assert.ok(bodyBox);
    const point = { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + bodyBox.height - 16 };
    const pointInfo = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return {
        widgetId: target?.closest("[data-widget-id]")?.getAttribute("data-widget-id"),
        interactive: Boolean(target?.closest("button, a, input, textarea, select, [role='button'], [contenteditable]:not([contenteditable='false'])")),
      };
    }, point);
    assert.equal(pointInfo.widgetId, "spacer-main", "the blank target belongs to Spacer");
    assert.equal(pointInfo.interactive, false, "the blank target is not an interactive descendant");
    await tapMouseAt(page, point.x, point.y);
    await page.waitForTimeout(90);
    await tapMouseAt(page, point.x, point.y);
    await assertState(page, false, "two short taps on a blank widget body leave Customize");
  } finally { await context.close(); }
}

async function verifyReorderHandlePointerTaps() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const handle = page.locator('.widget-grid > [data-widget-id="timer-main"] [data-widget-reorder-handle]');
    await doubleTapMouse(page, handle);
    await assertState(page, false, "the reorder handle is eligible for mouse double-tap completion");
  } finally { await context.close(); }
}

async function verifyTouchDoubleTap() {
  const { context, page } = await loadPage({ width: 390, height: 844, touch: true });
  let session;
  try {
    await customize(page);
    const handle = page.locator('.widget-grid > [data-widget-id="timer-main"] [data-widget-reorder-handle]');
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    session = await page.context().newCDPSession(page);
    await tapTouch(session, x, y);
    await page.waitForTimeout(90);
    await tapTouch(session, x, y);
    await assertState(page, false, "two touch taps on the reorder handle leave Customize");
    assert.ok(await page.evaluate(() => window.__widgetFixture.pointerTypes.includes("touch")), "Chrome delivered touch PointerEvents");
  } finally {
    if (session) await session.detach();
    await context.close();
  }
}

async function verifyDragBreaksTapChain() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const card = page.locator('.widget-grid > [data-widget-id="timer-main"]');
    const heading = card.locator(".widget-header h2");
    const handle = card.locator("[data-widget-reorder-handle]");
    await tapMouse(page, heading);
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    assert.ok(box);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y + 8, { steps: 2 });
    await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    await page.mouse.up();
    await tapMouse(page, heading);
    await assertState(page, true, "a drag beyond the movement threshold breaks the prior tap chain");
  } finally { await context.close(); }
}

async function verifyInteractiveTargetsAreExcluded() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const note = page.locator('.widget-grid > [data-widget-id="notes-main"] textarea');
    const originalNote = await note.inputValue();
    await doubleTapMouse(page, note);
    await assertState(page, true, "double-tapping the notes textarea does not leave Customize or edit its contents");
    assert.equal(await note.inputValue(), originalNote);

    const nextWeek = page.getByRole("button", { name: "Next week", exact: true });
    await doubleTapMouse(page, nextWeek);
    await assertState(page, true, "double-tapping an interactive widget button does not leave Customize");
    assert.equal(await page.locator(".widget-reorder-overlay").count(), 0, "interactive controls do not begin a drag");
  } finally { await context.close(); }
}

async function verifyPointerCancelResetsTapChain() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const heading = page.locator('.widget-grid > [data-widget-id="notes-main"] .widget-header h2');
    await tapMouse(page, heading);
    const box = await heading.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(() => {
      const down = [...window.__widgetFixture.pointerEvents].reverse().find((event) => event.type === "pointerdown");
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: down?.id ?? 1, bubbles: true }));
    });
    await page.mouse.up();
    await tapMouse(page, heading);
    await assertState(page, true, "pointer cancellation clears the pending tap chain");
  } finally { await context.close(); }
}

async function verifyWorkspaceContextReset() {
  const { context, page } = await loadPage({ query: "?remove-multi=1" });
  try {
    await customize(page);
    const timerHeading = page.locator('.widget-grid > [data-widget-id="timer-main"] .widget-header h2');
    await tapMouse(page, timerHeading);
    const switchStartedAt = await page.evaluate(() => performance.now());
    await page.evaluate(async () => {
      const tabs = [...document.querySelectorAll("[role='tab']")];
      tabs.find((tab) => tab.textContent?.trim() === "Other day")?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      tabs.find((tab) => tab.textContent?.trim() === "Fixture day")?.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const switchElapsed = await page.evaluate((startedAt) => performance.now() - startedAt, switchStartedAt);
    assert.ok(switchElapsed < 350, `the workspace round trip stays inside the tap interval (${switchElapsed.toFixed(1)}ms)`);
    await page.waitForFunction(() => document.querySelector(".widget-grid > [data-widget-id]")?.getAttribute("data-widget-id") === "notes-main");
    await tapMouse(page, timerHeading);
    const totalElapsed = await page.evaluate((startedAt) => performance.now() - startedAt, switchStartedAt);
    assert.ok(totalElapsed < 350, `the workspace context reset is tested within the tap interval (${totalElapsed.toFixed(1)}ms)`);
    await assertState(page, true, "switching workspaces resets a pending tap on the original widget");

    await doubleTapMouse(page, timerHeading);
    await assertState(page, false, "a fresh pair of taps still exits after the context reset");
  } finally { await context.close(); }
}

async function verifyDoubleTapAfterCompletedReorder() {
  const { context, page } = await loadPage();
  try {
    await customize(page);
    const card = page.locator('.widget-grid > [data-widget-id="timer-main"]');
    const handle = card.locator("[data-widget-reorder-handle]");
    const cardBox = await card.boundingBox();
    const handleBox = await handle.boundingBox();
    assert.ok(cardBox && handleBox);
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    const target = await page.evaluate(({ offsetX, offsetY }) => window.__widgetFixture.targetFor("timer-main", 0, offsetX, offsetY), {
      offsetX: startX - cardBox.x,
      offsetY: startY - cardBox.y,
    });
    const beforeWrites = await page.evaluate(() => window.__widgetFixture.writes);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 8, { steps: 2 });
    await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, beforeWrites, { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    assert.equal(await customizeState(page), true, "reordering keeps Customize active");

    const reorderedHeading = page.locator('.widget-grid > [data-widget-id="timer-main"] .widget-header h2');
    await doubleTapMouse(page, reorderedHeading);
    await assertState(page, false, "a completed reorder does not leave stale busy state that blocks double-tap exit");
  } finally { await context.close(); }
}

try {
  await verifyInactiveDoesNotEnter();
  await verifyMouseDoubleTapAndSingleTap();
  await verifyReorderHandlePointerTaps();
  await verifyTouchDoubleTap();
  await verifyDragBreaksTapChain();
  await verifyInteractiveTargetsAreExcluded();
  await verifyPointerCancelResetsTapChain();
  await verifyWorkspaceContextReset();
  await verifyDoubleTapAfterCompletedReorder();
  assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
  console.log("Widget double-tap browser QA passed.");
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
