import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-widget-reorder");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const [globalCss, referenceCss, appearanceCss, blockLayoutCss, reorderCss] = await Promise.all([
  "app/globals.css", "app/reference-ui.css", "app/widget-appearance.css", "app/widget-block-layout.css", "app/widget-reorder.css",
].map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await build({
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
});
const js = bundle.outputFiles[0].text;
const css = [globalCss, referenceCss, appearanceCss, blockLayoutCss, reorderCss]
  .map((source) => source.replace(/^@import[^;]+;\s*/gm, ""))
  .join("\n");
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
async function loadPage({ width = 1440, height = 1200, reducedMotion = "no-preference", touch = false, query = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  observeErrors(page);
  await page.goto(`${baseUrl}${query}`);
  await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
  await page.getByRole("button", { name: "Customize" }).click();
  await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
  assert.ok(await page.locator(".widget-grid > [data-widget-id]").evaluateAll((cards) =>
    cards.every((card) => getComputedStyle(card).animationName === "none" && getComputedStyle(card).rotate === "none"),
  ), "widgets remain still in customize mode");
  return { context, page };
}
async function liveIds(page) {
  return page.locator(".widget-grid > [data-widget-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id")));
}
async function beginMouseDrag(page, widgetId, destinationIndex, startSelector = ".widget-header h2") {
  const card = page.locator(`.widget-grid > [data-widget-id="${widgetId}"]`);
  const dragTarget = card.locator(startSelector);
  await dragTarget.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  const targetBox = await dragTarget.boundingBox();
  assert.ok(cardBox && targetBox, `Expected visible widget drag target for ${widgetId}`);
  const startX = targetBox.x + targetBox.width / 2;
  const startY = targetBox.y + targetBox.height / 2;
  const target = await page.evaluate(({ id, index, offsetX, offsetY }) => window.__widgetFixture.targetFor(id, index, offsetX, offsetY), {
    id: widgetId, index: destinationIndex, offsetX: startX - cardBox.x, offsetY: startY - cardBox.y,
  });
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 9, startY + 8, { steps: 2 });
  await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 }).catch(async (error) => {
    const diagnostics = await page.evaluate(({ x, y }) => ({
      pointerTypes: window.__widgetFixture.pointerTypes,
      pointerEvents: window.__widgetFixture.pointerEvents,
      sourceClasses: document.querySelector('.widget-grid [data-widget-id="notes-main"]')?.className,
      hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 240),
      handles: [...document.querySelectorAll("[data-widget-reorder-handle]")].map((node) => ({ rect: node.getBoundingClientRect().toJSON(), parent: node.parentElement?.outerHTML.slice(0, 240) })),
      customizeText: [...document.querySelectorAll("button")].find((node) => node.textContent?.includes("Customize"))?.textContent,
      bodyClasses: document.body.className,
    }), { x: startX, y: startY });
    throw new Error(`Mouse reorder did not activate: ${JSON.stringify(diagnostics)}; ${error.message}`);
  });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  return { candidate: target.candidate };
}
async function physicalTarget(page, draggedId, targetId) {
  const source = page.locator(`.widget-grid > [data-widget-id="${draggedId}"]`);
  const target = page.locator(`.widget-grid > [data-widget-id="${targetId}"]`);
  await source.locator("[data-widget-reorder-handle]").scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const handleBox = await source.locator("[data-widget-reorder-handle]").boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && handleBox && targetBox, `Expected visible source and physical target for ${draggedId} → ${targetId}`);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const offsetX = startX - sourceBox.x;
  const offsetY = startY - sourceBox.y;
  const x = targetBox.x + offsetX;
  const y = targetBox.y + offsetY;
  const hit = await page.evaluate(({ x: hitX, y: hitY }) => {
    const element = document.elementFromPoint(hitX, hitY)?.closest("[data-widget-id]");
    return element?.dataset.widgetId ?? null;
  }, { x, y });
  assert.equal(hit, targetId, `physical pointer target at (${x.toFixed(1)}, ${y.toFixed(1)}) is ${targetId}`);
  return { startX, startY, x, y, hit, draggedId, targetId };
}
async function physicalLowerMiniSlotTarget(page, draggedId, miniId) {
  const source = page.locator(`.widget-grid > [data-widget-id="${draggedId}"]`);
  const mini = page.locator(`.widget-grid > [data-widget-id="${miniId}"]`);
  await source.locator("[data-widget-reorder-handle]").scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const handleBox = await source.locator("[data-widget-reorder-handle]").boundingBox();
  const miniBox = await mini.boundingBox();
  const gap = await page.locator(".widget-grid").evaluate((grid) => Number.parseFloat(getComputedStyle(grid).rowGap) || 0);
  assert.ok(sourceBox && handleBox && miniBox, `Expected visible source and paired mini for ${draggedId} → below ${miniId}`);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const offsetX = startX - sourceBox.x;
  const offsetY = startY - sourceBox.y;
  const x = miniBox.x + offsetX;
  const y = miniBox.y + miniBox.height + gap + offsetY;
  return { startX, startY, x, y, draggedId, targetId: miniId, targetHalf: "below" };
}
async function startMouseDragAt(page, target) {
  await page.mouse.move(target.startX, target.startY);
  await page.mouse.down();
  await page.mouse.move(target.startX + 9, target.startY + 8, { steps: 2 });
  await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  return target;
}
async function beginMouseDragToPhysicalWidget(page, draggedId, targetId) {
  return startMouseDragAt(page, await physicalTarget(page, draggedId, targetId));
}

async function verifyMenuButtonGuard() {
  const { context, page } = await loadPage();
  try {
    const before = await liveIds(page);
    const writesBefore = await page.evaluate(() => window.__widgetFixture.writes);
    const options = page.locator('.widget-grid > [data-widget-id="timer-main"] .widget-header .menu-wrap > button');
    const box = await options.boundingBox();
    assert.ok(box, "widget options button is visible");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 18, { steps: 3 });
    await page.mouse.up();
    assert.equal(await page.locator(".widget-reorder-overlay").count(), 0, "dragging from the options button does not start a widget drag");
    assert.equal(await page.locator(".widget-menu").count(), 0, "dragging from the options button does not open its menu");
    assert.deepEqual(await liveIds(page), before);
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore);

    await options.click();
    await page.waitForSelector(".widget-menu", { state: "visible" });
    assert.equal(await page.locator(".widget-reorder-overlay").count(), 0, "opening the options menu does not start a widget drag");
  } finally { await context.close(); }
}

async function verifyTitleAndPlainHeaderDrag() {
  const { context, page } = await loadPage();
  try {
    const initial = await liveIds(page);
    const initialWrites = await page.evaluate(() => window.__widgetFixture.writes);
    const titleDrag = await beginMouseDrag(page, "notes-main", initial.length - 1);
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, initialWrites);
    assert.deepEqual(await liveIds(page), titleDrag.candidate, "dragging the widget title reorders the card");

    const headerWrites = await page.evaluate(() => window.__widgetFixture.writes);
    const headerDrag = await beginMouseDrag(page, "timer-main", 1, ".widget-header .widget-icon");
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, headerWrites);
    assert.deepEqual(await liveIds(page), headerDrag.candidate, "dragging an unmarked part of the header reorders the card");
    console.log("Widget title and plain-header drag checks passed.");
  } finally { await context.close(); }
}
async function startTouchDragAt(page, target) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: target.startX, y: target.startY, radiusX: 2, radiusY: 2, force: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: target.startX + 10, y: target.startY + 8, radiusX: 2, radiusY: 2, force: 1 }] });
  await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: target.x, y: target.y, radiusX: 2, radiusY: 2, force: 1 }] });
  return { ...target, session };
}
async function beginTouchDragToPhysicalWidget(page, draggedId, targetId) {
  return startTouchDragAt(page, await physicalTarget(page, draggedId, targetId));
}
async function widgetGridPositions(page) {
  return page.locator(".widget-grid > [data-widget-id]").evaluateAll((cards) => Object.fromEntries(cards.map((card) => {
    const style = getComputedStyle(card);
    return [card.getAttribute("data-widget-id"), {
      column: style.gridColumnStart,
      row: style.gridRowStart,
      size: card.getAttribute("data-size"),
      miniStart: card.getAttribute("data-mini-start") === "true",
    }];
  })));
}
async function assertWidgetOrder(page, expected, message) {
  const actual = await liveIds(page);
  assert.deepEqual(actual, expected, `${message}; actual order: ${JSON.stringify(actual)}`);
}
async function resizeBrowserWidget(page, widgetId, label) {
  const card = page.locator(`.widget-grid > [data-widget-id="${widgetId}"]`);
  await card.getByRole("button", { name: "Weekly study goal options", exact: true }).click();
  await page.getByRole("button", { name: `${label} widget`, exact: true }).click();
  const size = label.toLowerCase();
  await page.waitForFunction(({ id, expectedSize }) => document.querySelector(`.widget-grid > [data-widget-id="${id}"]`)?.getAttribute("data-size") === expectedSize, { id: widgetId, expectedSize: size });
}
async function assertNoBrowserErrors() {
  assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
}

async function verifyMiniPairReorder({ width = 1440, height = 1200, touch = false } = {}) {
  const original = ["glance-mini", "alerts-small", "pomodoro-small", "weekly-mini", "daily-mini"];
  const beforeTargetOrder = ["glance-mini", "alerts-small", "daily-mini", "pomodoro-small", "weekly-mini"];
  const { context, page } = await loadPage({ width, height, touch, query: "?mini-pair=1" });
  try {
    await assertWidgetOrder(page, original, "mini-pair fixture starts in screenshot order");
    const initialPositions = await widgetGridPositions(page);
    assert.equal(initialPositions["weekly-mini"].size, "mini");
    assert.equal(initialPositions["daily-mini"].size, "mini");
    assert.equal(initialPositions["alerts-small"].size, "small");
    assert.equal(initialPositions["pomodoro-small"].size, "small");
    assert.equal(initialPositions["glance-mini"].column, initialPositions["weekly-mini"].column, "the screenshot pair shares the glance column before the drag");
    assert.equal(Number(initialPositions["weekly-mini"].row), Number(initialPositions["glance-mini"].row) + 1, "Weekly Study Goal is paired in the lower half below At a Glance");
    assert.equal(initialPositions["daily-mini"].miniStart, true, "Daily Study Goal starts a separate mini block in the saved screenshot layout");
    assert.equal(initialPositions["daily-mini"].column, touch ? "2" : "4", "the separate Daily Study Goal keeps its initial screenshot column");

    const writesBefore = await page.evaluate(() => window.__widgetFixture.writes);
    const canceledDrag = touch
      ? await beginTouchDragToPhysicalWidget(page, "daily-mini", "pomodoro-small")
      : await beginMouseDragToPhysicalWidget(page, "daily-mini", "pomodoro-small");
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, beforeTargetOrder, `dragging Daily Study Goal over Pomodoro's original physical slot previews insertion before it at ${canceledDrag.x.toFixed(1)},${canceledDrag.y.toFixed(1)}`);
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "hovering a projected mini-pair reorder does not save it");
    const splitPositions = await widgetGridPositions(page);
    assert.equal(splitPositions["daily-mini"].column, touch ? "1" : "3", "Daily Study Goal occupies the Pomodoro card's former column");
    assert.equal(splitPositions["pomodoro-small"].column, touch ? "2" : "4", "Pomodoro moves to the next physical column after the mini is inserted before it");
    assert.ok(
      splitPositions["glance-mini"].column !== splitPositions["weekly-mini"].column
        || Math.abs(Number(splitPositions["glance-mini"].row) - Number(splitPositions["weekly-mini"].row)) !== 1,
      "moving Daily Study Goal splits the original glance and weekly mini pair",
    );
    assert.equal(splitPositions["weekly-mini"].column, splitPositions["daily-mini"].column, "Weekly Study Goal joins the fresh Daily Study Goal mini block");
    assert.equal(Number(splitPositions["weekly-mini"].row), Number(splitPositions["daily-mini"].row) + 1, "the new pair stacks Weekly Study Goal below Daily Study Goal");

    await page.keyboard.press("Escape");
    await page.waitForFunction((order) => [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id")).join("|") === order.join("|"), original);
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "canceling the projected reorder does not save it");
    if (touch) await canceledDrag.session.detach();

    const committedDrag = touch
      ? await beginTouchDragToPhysicalWidget(page, "daily-mini", "pomodoro-small")
      : await beginMouseDragToPhysicalWidget(page, "daily-mini", "pomodoro-small");
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, beforeTargetOrder, "second physical drop target still previews the requested order");
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "the order remains unsaved while the pointer is held over Pomodoro");
    if (touch) await committedDrag.session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    else await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, writesBefore);
    assert.deepEqual((await page.evaluate(() => window.__widgetFixture.dashboard)).w[0][2].map((widget) => widget[2]), beforeTargetOrder, "release saves exactly the previewed order");
    if (touch) {
      assert.ok(await page.evaluate(() => window.__widgetFixture.pointerTypes.includes("touch")), "Chrome delivered a touch PointerEvent to the live Workspace");
      await committedDrag.session.detach();
    }

    const stored = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(stored.w[0][2].map((widget) => [widget[2], widget[1]]), [
      ["glance-mini", 3], ["alerts-small", 0], ["daily-mini", 3], ["pomodoro-small", 0], ["weekly-mini", 3],
    ], "the compact saved payload preserves every widget size after reorder");
    assert.deepEqual(stored.b, ["daily-mini"], "the compact saved payload preserves the separate mini-block choice");
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
    await page.getByRole("button", { name: "Customize" }).click();
    await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
    await assertWidgetOrder(page, beforeTargetOrder, "reload restores the persisted mini order");
    const reloadedPositions = await widgetGridPositions(page);
    assert.equal(reloadedPositions["daily-mini"].column, touch ? "1" : "3", "reload keeps Daily Study Goal in its committed footprint");
    assert.equal(reloadedPositions["pomodoro-small"].column, touch ? "2" : "4", "reload keeps Pomodoro in its committed footprint");
    assert.equal(reloadedPositions["daily-mini"].miniStart, true, "reload restores the separate mini-block choice");
    assert.equal(reloadedPositions["weekly-mini"].column, reloadedPositions["daily-mini"].column, "reload restores the joined daily and weekly pair");
    assert.equal(Number(reloadedPositions["weekly-mini"].row), Number(reloadedPositions["daily-mini"].row) + 1, "reload preserves the pair's upper and lower halves");
  } finally { await context.close(); }
}

async function verifyFreshMiniCellAndLowerHalfJoin() {
  const original = ["mini-a", "small-b", "mini-c"];
  const movedBeforeSmall = ["mini-a", "mini-c", "small-b"];
  const { context, page } = await loadPage({ query: "?fresh-mini=1" });
  try {
    await assertWidgetOrder(page, original, "fresh-mini fixture starts with a mini, a full small card, then another mini");
    const initial = await widgetGridPositions(page);
    assert.equal(initial["mini-a"].column, "1");
    assert.equal(initial["small-b"].column, "2");
    assert.equal(initial["mini-c"].column, "1", "the last mini initially pairs below the first across the small card");
    assert.equal(initial["mini-c"].miniStart, false);

    const writesBefore = await page.evaluate(() => window.__widgetFixture.writes);
    const canceled = await beginMouseDragToPhysicalWidget(page, "mini-c", "small-b");
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, movedBeforeSmall, `dragging mini-c to small-b's original physical cell previews insertion before it at ${canceled.x.toFixed(1)},${canceled.y.toFixed(1)}`);
    const freshPreview = await widgetGridPositions(page);
    assert.equal(freshPreview["mini-c"].column, "2", "the dragged mini can claim the previously unreachable second-column top half");
    assert.equal(freshPreview["mini-c"].row, "1");
    assert.equal(freshPreview["mini-c"].miniStart, true, "the fresh cell is represented in the live preview");
    assert.equal(freshPreview["small-b"].column, "3", "the original full card flows after the fresh mini");
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "fresh-cell hover does not save");
    await page.keyboard.press("Escape");
    await page.waitForFunction((order) => [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id")).join("|") === order.join("|"), original);
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "canceling fresh-cell selection does not save");

    await beginMouseDragToPhysicalWidget(page, "mini-c", "small-b");
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, movedBeforeSmall, "the repeated fresh-cell drag previews the same order");
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, writesBefore);
    let saved = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(saved.w[0][2].map((widget) => widget[2]), movedBeforeSmall, "the first release saves the new widget order");
    assert.deepEqual(saved.b, ["mini-c"], "the saved compact payload records mini-c as a fresh block");

    await page.reload();
    await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
    await page.getByRole("button", { name: "Customize" }).click();
    await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
    await assertWidgetOrder(page, movedBeforeSmall, "reload restores the fresh mini order");
    const reloadedFresh = await widgetGridPositions(page);
    assert.equal(reloadedFresh["mini-c"].column, "2");
    assert.equal(reloadedFresh["mini-c"].miniStart, true, "reload restores the fresh-cell placement bit");
    const writesAfterReload = await page.evaluate(() => window.__widgetFixture.writes);

    const lowerSlot = await physicalLowerMiniSlotTarget(page, "mini-c", "mini-a");
    await startMouseDragAt(page, lowerSlot);
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, original, "pairing below mini-a uses the readable order when the same physical slot has multiple candidates");
    const joinedPreview = await widgetGridPositions(page);
    assert.equal(joinedPreview["mini-c"].column, joinedPreview["mini-a"].column, "mini-c joins mini-a in its physical lower half");
    assert.equal(Number(joinedPreview["mini-c"].row), Number(joinedPreview["mini-a"].row) + 1);
    assert.equal(joinedPreview["mini-c"].miniStart, false, "the lower-half target clears the fresh-block flag");
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesAfterReload, "the lower-half pair change remains a preview until release");
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, writesAfterReload);
    saved = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(saved.w[0][2].map((widget) => widget[2]), original, "joining below mini-a saves the resolved order");
    assert.deepEqual(saved.b, [], "committing the lower-half join clears the fresh-block marker");

    await page.reload();
    await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
    await page.getByRole("button", { name: "Customize" }).click();
    await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
    await assertWidgetOrder(page, original, "reload restores the joined mini order");
    const reloadedJoin = await widgetGridPositions(page);
    assert.equal(reloadedJoin["mini-c"].column, reloadedJoin["mini-a"].column, "reload keeps the joined mini pair");
    assert.equal(Number(reloadedJoin["mini-c"].row), Number(reloadedJoin["mini-a"].row) + 1);
    assert.equal(reloadedJoin["mini-c"].miniStart, false);
  } finally { await context.close(); }
}

async function verifyMetadataOnlyFreshMiniCommit() {
  const order = ["mini-a", "mini-c", "small-b"];
  const { context, page } = await loadPage({ query: "?mini-adjacent=1" });
  try {
    await assertWidgetOrder(page, order, "adjacent-mini fixture starts with a paired pair before a small card");
    const initial = await widgetGridPositions(page);
    assert.equal(initial["mini-c"].column, "1");
    assert.equal(initial["mini-c"].row, "2", "mini-c starts in the lower half below mini-a");
    assert.equal(initial["mini-c"].miniStart, false);
    assert.equal(initial["small-b"].column, "2");

    const writesBefore = await page.evaluate(() => window.__widgetFixture.writes);
    const target = await beginMouseDragToPhysicalWidget(page, "mini-c", "small-b");
    await page.waitForTimeout(140);
    await assertWidgetOrder(page, order, `dragging mini-c to small-b's physical cell keeps the same ID order at ${target.x.toFixed(1)},${target.y.toFixed(1)}`);
    const freshPreview = await widgetGridPositions(page);
    assert.equal(freshPreview["mini-c"].column, "2", "the unchanged order can project mini-c into a fresh second-column cell");
    assert.equal(freshPreview["mini-c"].row, "1");
    assert.equal(freshPreview["mini-c"].miniStart, true, "projection changes only the mini-block choice");
    assert.equal(freshPreview["small-b"].column, "3");
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "the metadata-only change is not saved during hover");
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, writesBefore);
    const saved = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(saved.w[0][2].map((widget) => widget[2]), order, "the metadata-only commit leaves widget IDs in the same order");
    assert.deepEqual(saved.b, ["mini-c"], "the metadata-only commit persists the fresh mini block");
    assert.deepEqual(saved.w[0][2].map((widget) => [widget[2], widget[1]]), [
      ["mini-a", 3], ["mini-c", 3], ["small-b", 0],
    ], "the metadata-only save preserves all widget sizes");

    await page.reload();
    await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
    await page.getByRole("button", { name: "Customize" }).click();
    await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
    await assertWidgetOrder(page, order, "reload restores the same widget order after a metadata-only save");
    const reloaded = await widgetGridPositions(page);
    assert.equal(reloaded["mini-c"].column, "2");
    assert.equal(reloaded["mini-c"].row, "1");
    assert.equal(reloaded["mini-c"].miniStart, true, "reload restores the fresh block from compact state");
    assert.equal(reloaded["small-b"].column, "3");
  } finally { await context.close(); }
}

async function verifyMiniResizeClearsPlacement({ reloadWhileSmall }) {
  const order = ["mini-a", "mini-c", "small-b"];
  const { context, page } = await loadPage({ query: "?mini-adjacent=1" });
  try {
    await assertWidgetOrder(page, order, "resize fixture starts with an adjacent mini pair");
    const initialWrites = await page.evaluate(() => window.__widgetFixture.writes);
    await beginMouseDragToPhysicalWidget(page, "mini-c", "small-b");
    await page.waitForTimeout(140);
    const freshPreview = await widgetGridPositions(page);
    assert.equal(freshPreview["mini-c"].miniStart, true, "physical second-column drop creates a fresh mini block before resizing");
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, initialWrites);

    let currentWrites = await page.evaluate(() => window.__widgetFixture.writes);
    await resizeBrowserWidget(page, "mini-c", "Small");
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, currentWrites);
    currentWrites = await page.evaluate(() => window.__widgetFixture.writes);
    let afterSmall = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(afterSmall.b, [], "resizing to Small clears the mini-block marker in the saved payload");
    assert.equal(afterSmall.w[0][2].find((widget) => widget[2] === "mini-c")[1], 0, "resizing to Small persists the small footprint");
    assert.equal((await widgetGridPositions(page))["mini-c"].miniStart, false, "the live Small card has no mini-block marker");

    if (reloadWhileSmall) {
      await page.reload();
      await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
      await page.getByRole("button", { name: "Customize" }).click();
      await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
      const reloadedSmall = await widgetGridPositions(page);
      assert.equal(reloadedSmall["mini-c"].size, "small", "reload while Small keeps the resized footprint");
      assert.equal(reloadedSmall["mini-c"].miniStart, false, "reload while Small does not resurrect the old mini-block marker");
      afterSmall = await page.evaluate(() => window.__widgetFixture.dashboard);
      assert.deepEqual(afterSmall.b, [], "reload while Small keeps the empty block list");
      currentWrites = await page.evaluate(() => window.__widgetFixture.writes);
    }

    await resizeBrowserWidget(page, "mini-c", "Mini");
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, currentWrites);
    const afterMini = await widgetGridPositions(page);
    assert.equal(afterMini["mini-c"].size, "mini");
    assert.equal(afterMini["mini-c"].miniStart, false, "returning to Mini stays in legacy pairing mode");
    assert.equal(afterMini["mini-c"].column, afterMini["mini-a"].column, "returning to Mini pairs below mini-a");
    assert.equal(Number(afterMini["mini-c"].row), Number(afterMini["mini-a"].row) + 1);
    const savedMini = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(savedMini.b, [], "resizing back to Mini does not restore the old marker");

    await page.reload();
    await page.waitForFunction(() => document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
    await page.getByRole("button", { name: "Customize" }).click();
    await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
    const finalPositions = await widgetGridPositions(page);
    assert.equal(finalPositions["mini-c"].size, "mini", "final reload restores the Mini size");
    assert.equal(finalPositions["mini-c"].miniStart, false, "final reload keeps the cleared mini-block marker");
    assert.equal(finalPositions["mini-c"].column, finalPositions["mini-a"].column, "final reload keeps the legacy lower-half pair");
    assert.equal(Number(finalPositions["mini-c"].row), Number(finalPositions["mini-a"].row) + 1);
  } finally { await context.close(); }
}

try {
  await verifyMenuButtonGuard();
  await verifyTitleAndPlainHeaderDrag();
  await verifyMetadataOnlyFreshMiniCommit();
  await verifyFreshMiniCellAndLowerHalfJoin();
  await verifyMiniResizeClearsPlacement({ reloadWhileSmall: false });
  await verifyMiniResizeClearsPlacement({ reloadWhileSmall: true });
  await verifyMiniPairReorder();
  await verifyMiniPairReorder({ width: 390, height: 844, touch: true });

  const { context, page } = await loadPage();
  try {
    const before = await liveIds(page);
    const writesBefore = await page.evaluate(() => window.__widgetFixture.writes);
    const scrollState = await page.evaluate(() => window.__widgetFixture.setTextareaScrollToEnd());
    assert.ok(scrollState.scrollHeight > scrollState.clientHeight, "fixture note content overflows its textarea");
    assert.ok(scrollState.before > 0, "source note textarea scrolls before it is lifted");

    const drag = await beginMouseDrag(page, "notes-main", before.length - 1);
    await page.waitForFunction((candidate) => {
      const current = [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id"));
      return current.every((id, index) => id === candidate[index]);
    }, drag.candidate);
    const preview = await page.evaluate(() => {
      const overlay = document.querySelector(".widget-reorder-overlay");
      const clone = overlay?.querySelector(".widget-card");
      const textarea = clone?.querySelector("textarea");
      const source = document.querySelector('.widget-grid [data-widget-id="notes-main"] textarea');
      const rect = overlay?.getBoundingClientRect();
      return {
        placeholder: document.querySelector('.widget-grid [data-widget-id="notes-main"]')?.classList.contains("widget-reorder-placeholder"),
        inert: overlay?.hasAttribute("inert"), hidden: overlay?.getAttribute("aria-hidden"),
        duplicateIdentityCount: overlay?.querySelectorAll("[id], [data-widget-id], [data-widget-reorder-handle]").length,
        sourceScrollTop: source?.scrollTop, cloneScrollTop: textarea?.scrollTop,
        cloneNoteLength: textarea?.value.length, rect: rect && { x: rect.x, y: rect.y },
      };
    });
    assert.equal(preview.placeholder, true);
    assert.equal(preview.inert, true);
    assert.equal(preview.hidden, "true");
    assert.equal(preview.duplicateIdentityCount, 0);
    assert.ok(Math.abs(preview.cloneScrollTop - scrollState.before) <= 4, "Chrome clone preserves the note textarea scroll offset captured before lift");
    assert.ok(preview.cloneNoteLength > 1000, "full widget notes content remains in the floating preview");
    await page.waitForTimeout(450);
    assert.deepEqual(await liveIds(page), drag.candidate, "the projected order remains while the pointer is stationary");
    await page.screenshot({ path: resolve(screenshotDir, "mouse-hover-preview.png"), fullPage: false });
    assert.equal(await page.locator(".widget-reorder-overlay").count(), 1, "taking the viewport screenshot leaves the active preview mounted");
    assert.deepEqual(await liveIds(page), drag.candidate, "the screenshot captures the projected order before release");
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), writesBefore, "hover preview remains ephemeral beyond the autosave delay");
    assert.deepEqual((await page.evaluate(() => window.__widgetFixture.dashboard)).w[0][2].map((widget) => widget[2]), before);

    await page.keyboard.press("Escape");
    await page.waitForFunction((order) => [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id")).join("|") === order.join("|"), before);
    await page.waitForFunction((top) => document.querySelector('.widget-grid [data-widget-id="notes-main"] textarea')?.scrollTop === top, scrollState.before);
    // Start a different widget immediately while the prior inert preview fades.
    const redrag = await beginMouseDrag(page, "timer-main", 0, ".widget-header .widget-icon");
    await page.mouse.up();
    await page.waitForFunction(() => window.__widgetFixture.writes === 1);
    await page.getByText("Workspace saved").waitFor();
    const committedScroll = await page.evaluate(() => {
      const textarea = document.querySelector('.widget-grid [data-widget-id="notes-main"] textarea');
      return { top: textarea?.scrollTop, scrollHeight: textarea?.scrollHeight, clientHeight: textarea?.clientHeight };
    });
    assert.equal(committedScroll.top, scrollState.before, `committed note scroll position restores: ${JSON.stringify({ expected: scrollState.before, ...committedScroll })}`);
    const saved = await page.evaluate(() => window.__widgetFixture.dashboard);
    assert.deepEqual(saved.w[0][2].map((widget) => widget[2]), redrag.candidate);
    const savedWidgets = saved.w[0][2];
    const note = savedWidgets.find((widget) => widget[0] === 12);
    assert.equal(note[1], 1, "notes widget size is preserved after reorder");
    const noteLength = await page.evaluate(() => window.__widgetFixture.noteLength);
    assert.equal(saved.t[note[3]].length, noteLength, "the saved note payload is unchanged");
    await page.screenshot({ path: resolve(screenshotDir, "mouse-committed-board.png"), fullPage: true });
  } finally { await context.close(); }

  const { context: touchContext, page: touchPage } = await loadPage({ width: 390, height: 844, touch: true });
  try {
    const drag = await beginTouchDrag(touchPage, "timer-main", 0);
    await touchPage.waitForFunction((candidate) => [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((card) => card.getAttribute("data-widget-id")).join("|") === candidate.join("|"), drag.candidate);
    await drag.session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await touchPage.waitForFunction(() => window.__widgetFixture.writes === 1);
    assert.ok(await touchPage.evaluate(() => window.__widgetFixture.pointerTypes.includes("touch")), "the browser delivered a touch PointerEvent to the live Workspace");
    assert.deepEqual((await touchPage.evaluate(() => window.__widgetFixture.dashboard)).w[0][2].map((widget) => widget[2]), drag.candidate);
    await touchPage.screenshot({ path: resolve(screenshotDir, "touch-committed-board.png"), fullPage: true });
    await drag.session.detach();
  } finally { await touchContext.close(); }

  const { context: reducedContext, page: reducedPage } = await loadPage({ reducedMotion: "reduce" });
  try {
    const startAnimation = await reducedPage.locator(".widget-grid > [data-widget-id]").first().evaluate((card) => getComputedStyle(card).animationName);
    assert.equal(startAnimation, "none", "widgets also remain still with reduced motion");
    const before = await liveIds(reducedPage);
    const drag = await beginMouseDrag(reducedPage, "timer-main", before.length - 1);
    const liftTransform = await reducedPage.locator(".widget-reorder-overlay .widget-card").evaluate((card) => getComputedStyle(card).transform);
    assert.equal(liftTransform, "none", "reduced motion keeps the pointer preview without lift scaling");
    await reducedPage.mouse.up();
    await reducedPage.waitForFunction(() => window.__widgetFixture.writes === 1);
    assert.deepEqual((await reducedPage.evaluate(() => window.__widgetFixture.dashboard)).w[0][2].map((widget) => widget[2]), drag.candidate);
  } finally { await reducedContext.close(); }

  const { context: edgeContext, page: edgePage } = await loadPage({ width: 1280, height: 760, query: "?long=1" });
  try {
    await edgePage.evaluate(() => window.scrollTo(0, 0));
    const source = edgePage.locator('.widget-grid > [data-widget-id="notes-main-0"]');
    const handle = source.locator("[data-widget-reorder-handle]");
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    assert.ok(box);
    const startScroll = await edgePage.evaluate(() => window.scrollY);
    await edgePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await edgePage.mouse.down();
    await edgePage.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 8, { steps: 2 });
    await edgePage.waitForSelector(".widget-reorder-overlay");
    await edgePage.mouse.move(900, 752, { steps: 2 });
    await edgePage.waitForFunction((initial) => window.scrollY > initial + 60, startScroll, { timeout: 3000 });
    const scrolled = await edgePage.evaluate(() => window.scrollY);
    assert.ok(scrolled > startScroll + 60, "a stationary pointer held at the viewport edge scrolls the live board");
    await edgePage.screenshot({ path: resolve(screenshotDir, "edge-scroll-preview.png"), fullPage: false });
    assert.ok(await edgePage.locator(".widget-reorder-overlay").count(), "viewport screenshot does not cancel edge-scroll preview");
    await edgePage.keyboard.press("Escape");
    await edgePage.waitForFunction(() => !document.querySelector(".widget-reorder-placeholder"));
    assert.equal(await edgePage.evaluate(() => window.__widgetFixture.writes), 0, "edge scrolling and cancel do not save a reorder");
  } finally { await edgeContext.close(); }

  await assertNoBrowserErrors();
  console.log(`Widget reorder browser QA passed. Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function beginTouchDrag(page, widgetId, destinationIndex) {
  const source = page.locator(`.widget-grid > [data-widget-id="${widgetId}"]`);
  await source.locator("[data-widget-reorder-handle]").scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const handleBox = await source.locator("[data-widget-reorder-handle]").boundingBox();
  assert.ok(sourceBox && handleBox);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const target = await page.evaluate(({ id, index, offsetX, offsetY }) => window.__widgetFixture.targetFor(id, index, offsetX, offsetY), {
    id: widgetId, index: destinationIndex, offsetX: startX - sourceBox.x, offsetY: startY - sourceBox.y,
  });
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: startX, y: startY, radiusX: 2, radiusY: 2, force: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: startX + 10, y: startY + 8, radiusX: 2, radiusY: 2, force: 1 }] });
  await page.waitForSelector(".widget-reorder-overlay");
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: target.x, y: target.y, radiusX: 2, radiusY: 2, force: 1 }] });
  return { candidate: target.candidate, session };
}
