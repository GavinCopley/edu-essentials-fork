import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-widget-drag-momentum");
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

async function loadPage({ reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion });
  await context.addInitScript(() => {
    const trace = { pointer: null };
    window.__widgetDragMomentumTrace = trace;
    window.__widgetDragDropAnimations = [];
    window.__pauseWidgetDragDrop = false;
    const nativeAnimate = Element.prototype.animate;
    if (typeof nativeAnimate === "function") {
      Element.prototype.animate = function (keyframes, options) {
        const animation = nativeAnimate.call(this, keyframes, options);
        const firstFrame = Array.isArray(keyframes) ? keyframes[0] : null;
        const isDropPosition = this.classList?.contains("widget-reorder-overlay")
          && firstFrame?.transform === "translate3d(0, 0, 0) scale(1, 1)";
        if (isDropPosition && window.__pauseWidgetDragDrop) {
          window.__widgetDragDropAnimations.push({ target: this, frames: keyframes, animation });
          animation.pause();
          animation.currentTime = 0;
        }
        return animation;
      };
    }
    document.addEventListener("pointermove", (event) => {
      trace.pointer = { x: event.clientX, y: event.clientY, time: performance.now() };
    }, true);
  });
  const page = await context.newPage();
  observeErrors(page);
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__widgetFixture && document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
  await page.waitForFunction(() => document.querySelector(".home-load-transition")?.getAttribute("data-phase") === "done", undefined, { timeout: 10_000 });
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await page.locator("[data-widget-reorder-handle]").first().waitFor({ state: "visible" });
  return { context, page };
}

async function beginDrag(page, widgetId = "notes-main") {
  const card = page.locator(`.widget-grid > [data-widget-id="${widgetId}"]`);
  const handle = card.locator("[data-widget-reorder-handle]");
  await handle.scrollIntoViewIfNeeded();
  const initialHandleBox = await handle.boundingBox();
  assert.ok(initialHandleBox, `Expected visible Customize handle for ${widgetId}`);
  await page.mouse.move(initialHandleBox.x + initialHandleBox.width / 2, initialHandleBox.y + initialHandleBox.height / 2);
  await page.waitForTimeout(220);
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox, `Expected hover-stable Customize handle for ${widgetId}`);
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.waitForTimeout(30);
  const cardBox = await card.boundingBox();
  assert.ok(cardBox, `Expected hover-stable widget bounds for ${widgetId}`);
  const grabX = startX - cardBox.x;
  const grabY = startY - cardBox.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 10, startY + 8, { steps: 1 });
  await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
  await page.evaluate(({ x, y }) => {
    window.__widgetDragMomentumTrace.grab = { x, y };
  }, { x: grabX, y: grabY });
  await page.waitForTimeout(120);
  return { startX, startY, grabX, grabY };
}

async function overlayState(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector(".widget-reorder-overlay");
    if (!(overlay instanceof HTMLElement)) return null;
    const rect = overlay.getBoundingClientRect();
    const trace = window.__widgetDragMomentumTrace;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      styleLeft: Number.parseFloat(overlay.style.left),
      styleTop: Number.parseFloat(overlay.style.top),
      pointer: trace.pointer,
      writes: window.__widgetFixture.writes,
      ids: [...document.querySelectorAll(".widget-grid > [data-widget-id]")].map((node) => node.getAttribute("data-widget-id")),
      removeOver: document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over"),
    };
  });
}

async function waitForSettled(page, { grabX, grabY }, label = "drag") {
  await page.waitForFunction(({ x, y }) => {
    const overlay = document.querySelector(".widget-reorder-overlay");
    const trace = window.__widgetDragMomentumTrace;
    if (!(overlay instanceof HTMLElement) || !trace.pointer) return false;
    const rect = overlay.getBoundingClientRect();
    return Math.hypot(rect.left - (trace.pointer.x - x), rect.top - (trace.pointer.y - y)) <= 1.5;
  }, { x: grabX, y: grabY }, { timeout: 2500 });
  const state = await overlayState(page);
  assert.ok(state, `${label}: active overlay remains present while held`);
  const dx = state.left - (state.pointer.x - grabX);
  const dy = state.top - (state.pointer.y - grabY);
  assert.ok(Math.hypot(dx, dy) <= 1.5, `${label}: follower settles at the live pointer (error ${Math.hypot(dx, dy).toFixed(2)}px)`);
  return state;
}

async function moveAndMeasure(page, drag, dx, dy, label, screenshotName) {
  const before = await overlayState(page);
  assert.ok(before, `${label}: drag overlay is active`);
  await page.mouse.move(before.pointer.x + dx, before.pointer.y + dy, { steps: 1 });
  await page.waitForTimeout(35);
  const during = await overlayState(page);
  assert.ok(during, `${label}: overlay remains active during pointer movement`);
  assert.ok(during.writes === 0, `${label}: movement does not save dashboard state`);
  assert.ok(during.ids.includes("notes-main"), `${label}: dragged widget remains in the board while held`);
  const movementX = during.left - before.left;
  const movementY = during.top - before.top;
  if (dx) assert.ok(movementX * Math.sign(dx) > 0.5, `${label}: overlay moves in the horizontal pointer direction (${movementX.toFixed(2)}px)`);
  if (dy) assert.ok(movementY * Math.sign(dy) > 0.5, `${label}: overlay moves in the vertical pointer direction (${movementY.toFixed(2)}px)`);

  const gap = Math.hypot(
    during.left - (during.pointer.x - drag.grabX),
    during.top - (during.pointer.y - drag.grabY),
  );
  assert.ok(gap <= 28, `${label}: follower stays within the 24px cap with 4px of geometry tolerance (gap ${gap.toFixed(2)}px)`);
  assert.ok(gap >= 1, `${label}: movement shows a visible but bounded lag (gap ${gap.toFixed(2)}px)`);
  if (screenshotName) await page.screenshot({ path: resolve(screenshotDir, screenshotName), fullPage: false });
  const settled = await waitForSettled(page, drag, label);
  return { before, during, settled, gap };
}

async function verifyDirectionalMomentumAndCatchup() {
  const { context, page } = await loadPage();
  try {
    const drag = await beginDrag(page);
    const checks = [
      [180, 0, "horizontal", "horizontal-lag.png"],
      [0, 140, "vertical", null],
      [130, 120, "diagonal", "diagonal-lag.png"],
      [-220, 0, "reversal", null],
    ];
    const results = [];
    for (const [dx, dy, label, screenshot] of checks) {
      results.push(await moveAndMeasure(page, drag, dx, dy, label, screenshot));
    }
    await page.waitForTimeout(1100);
    const afterIdle = await moveAndMeasure(page, drag, 20, 0, "small movement after a long idle", null);
    const resumedMovement = afterIdle.during.left - afterIdle.before.left;
    assert.ok(resumedMovement > 0.5 && resumedMovement < 19.5, `small movement after a long idle still eases toward the pointer (moved ${resumedMovement.toFixed(2)}px of 20px)`);
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), 0, "held movement never saves dashboard state");
    assert.ok(results.every(({ settled }) => settled), "each direction settles at the current cursor after it stops");
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    assert.equal(await page.evaluate(() => window.__widgetFixture.writes), 0, "dropping without changing order does not save");
    assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
  } finally { await context.close(); }
}

async function verifyImmediateMotionModes() {
  const modes = [
    { name: "system reduced motion", reducedMotion: "reduce" },
    { name: "account reduced motion", configure: (page) => page.evaluate(() => { document.documentElement.dataset.motion = "reduced"; }) },
    { name: "zero widget duration", configure: (page) => page.locator('.widget-grid > [data-widget-id="notes-main"]').evaluate((card) => card.style.setProperty("--wa-transition-ms", "0ms")) },
    { name: "missing Web Animations API", configure: (page) => page.evaluate(() => { Element.prototype.animate = undefined; }) },
  ];
  for (const mode of modes) {
    const { context, page } = await loadPage({ reducedMotion: mode.reducedMotion ?? "no-preference" });
    try {
      if (mode.configure) await mode.configure(page);
      const drag = await beginDrag(page);
      const before = await overlayState(page);
      await page.mouse.move(before.pointer.x + 150, before.pointer.y + 90, { steps: 1 });
      await page.waitForTimeout(60);
      const after = await overlayState(page);
      assert.ok(after, `${mode.name}: overlay stays active`);
      const error = Math.hypot(after.left - (after.pointer.x - drag.grabX), after.top - (after.pointer.y - drag.grabY));
      assert.ok(error <= 1.5, `${mode.name}: reduced motion moves directly with the pointer (error ${error.toFixed(2)}px)`);
      assert.equal(after.writes, 0, `${mode.name}: immediate movement remains an unsaved preview`);
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    } finally { await context.close(); }
  }
}

async function verifyEarlyDropAndEscapeCleanup() {
  const earlyDrop = await loadPage();
  try {
    const drag = await beginDrag(earlyDrop.page);
    const state = await overlayState(earlyDrop.page);
    await earlyDrop.page.mouse.move(state.pointer.x + 220, state.pointer.y + 80, { steps: 1 });
    await earlyDrop.page.mouse.up();
    await earlyDrop.page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"), undefined, { timeout: 3000 });
    assert.equal(await earlyDrop.page.evaluate(() => window.__widgetFixture.writes), 0, "early drop cleans up without saving an unchanged order");
    assert.ok(drag.grabX > 0, "test began with a valid pointer grab offset");
  } finally { await earlyDrop.context.close(); }

  const earlyEscape = await loadPage();
  try {
    await beginDrag(earlyEscape.page);
    const state = await overlayState(earlyEscape.page);
    await earlyEscape.page.mouse.move(state.pointer.x - 170, state.pointer.y + 100, { steps: 1 });
    await earlyEscape.page.keyboard.press("Escape");
    await earlyEscape.page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"), undefined, { timeout: 3000 });
    assert.equal(await earlyEscape.page.evaluate(() => window.__widgetFixture.writes), 0, "Escape cancels without saving");
    assert.ok(await earlyEscape.page.locator('.widget-grid > [data-widget-id="notes-main"]').count(), "Escape leaves the source widget in the board");
  } finally { await earlyEscape.context.close(); }

  const earlyCancel = await loadPage();
  try {
    await beginDrag(earlyCancel.page);
    const state = await overlayState(earlyCancel.page);
    await earlyCancel.page.mouse.move(state.pointer.x + 190, state.pointer.y - 90, { steps: 1 });
    await earlyCancel.page.evaluate(() => {
      const down = [...window.__widgetFixture.pointerEvents].reverse().find((event) => event.type === "pointerdown");
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: down?.id ?? 1, bubbles: true }));
    });
    await earlyCancel.page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"), undefined, { timeout: 3000 });
    assert.equal(await earlyCancel.page.evaluate(() => window.__widgetFixture.writes), 0, "pointercancel cleans up without saving");
    assert.ok(await earlyCancel.page.locator('.widget-grid > [data-widget-id="notes-main"]').count(), "pointercancel leaves the source widget in the board");
  } finally { await earlyCancel.context.close(); }
}

async function verifyRemovalUsesLivePointer() {
  const { context, page } = await loadPage();
  try {
    const before = await page.evaluate(() => window.__widgetFixture.dashboard.w[0][2].map((widget) => widget[2]));
    const priorWrites = await page.evaluate(() => window.__widgetFixture.writes);
    const drag = await beginDrag(page, "timer-main");
    const target = await page.locator(".today-remove-target-host").boundingBox();
    assert.ok(target && target.width > 0 && target.height > 0, "Today remove target is measurable");
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 1 });
    await page.waitForFunction(() => document.querySelector(".today-remove-target-host")?.getAttribute("data-remove-target-over") === "true", undefined, { timeout: 2000 });
    const lagging = await overlayState(page);
    assert.ok(lagging, "overlay remains active over the remove target");
    const pointerToOverlay = Math.hypot(
      lagging.left + drag.grabX - lagging.pointer.x,
      lagging.top + drag.grabY - lagging.pointer.y,
    );
    assert.ok(pointerToOverlay > 1, `overlay is still lagging when the pointer reaches Today (${pointerToOverlay.toFixed(2)}px)`);
    assert.equal(lagging.writes, priorWrites, "removal remains a preview while the pointer is held over Today");
    await page.screenshot({ path: resolve(screenshotDir, "remove-target-lag.png"), fullPage: false });
    await page.mouse.up();
    await page.waitForFunction((count) => window.__widgetFixture.writes === count + 1, priorWrites, { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.widget-grid > [data-widget-id="timer-main"]'));
    assert.deepEqual(
      await page.evaluate(() => window.__widgetFixture.dashboard.w[0][2].map((widget) => widget[2])),
      before.filter((id) => id !== "timer-main"),
      "drop over Today removes according to the live pointer despite overlay lag",
    );
  } finally { await context.close(); }
}

async function verifyFastReleaseKeepsDisplayedPosition() {
  const { context, page } = await loadPage();
  try {
    const drag = await beginDrag(page);
    const displayed = await overlayState(page);
    assert.ok(displayed, "overlay is active before the release race");
    const pointerId = await page.evaluate(() => {
      const down = [...window.__widgetFixture.pointerEvents].reverse().find((event) => event.type === "pointerdown");
      window.__pauseWidgetDragDrop = true;
      return down?.id ?? 1;
    });
    const targetX = drag.startX - 210;
    const targetY = drag.startY;
    await page.evaluate(({ id, x, y }) => {
      document.dispatchEvent(new PointerEvent("pointermove", {
        pointerId: id, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
        button: 0, buttons: 1, bubbles: true, cancelable: true,
      }));
      document.dispatchEvent(new PointerEvent("pointerup", {
        pointerId: id, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y,
        button: 0, buttons: 0, bubbles: true, cancelable: true,
      }));
    }, { id: pointerId, x: targetX, y: targetY });
    await page.waitForFunction(() => window.__widgetDragDropAnimations.length > 0, undefined, { timeout: 3000 });
    const drop = await page.evaluate(() => {
      const record = window.__widgetDragDropAnimations[0];
      const rect = record.target.getBoundingClientRect();
      return {
        firstFrame: record.frames[0],
        left: rect.left,
        top: rect.top,
        styleLeft: Number.parseFloat(record.target.style.left),
        styleTop: Number.parseFloat(record.target.style.top),
      };
    });
    assert.equal(drop.firstFrame.transform, "translate3d(0, 0, 0) scale(1, 1)", "drop animation starts from the currently displayed overlay position");
    assert.ok(Math.abs(drop.left - displayed.left) < 1, `rapid final pointer movement does not snap the overlay horizontally at release (before ${displayed.left}, first frame ${drop.left})`);
    assert.ok(Math.abs(drop.top - displayed.top) < 1, `rapid final pointer movement does not snap the overlay vertically at release (before ${displayed.top}, first frame ${drop.top})`);
    assert.ok(Math.abs(drop.styleLeft - displayed.styleLeft) < 1 && Math.abs(drop.styleTop - displayed.styleTop) < 1, "drop retains the displayed inline position while resolving the live-pointer projection");
    await page.evaluate(() => window.__widgetDragDropAnimations[0].animation.play());
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"), undefined, { timeout: 3000 });
    await page.mouse.up();
  } finally { await context.close(); }
}

try {
  await verifyDirectionalMomentumAndCatchup();
  await verifyImmediateMotionModes();
  await verifyEarlyDropAndEscapeCleanup();
  await verifyRemovalUsesLivePointer();
  await verifyFastReleaseKeepsDisplayedPosition();
  assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
  console.log(`Widget drag momentum browser QA passed. Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
