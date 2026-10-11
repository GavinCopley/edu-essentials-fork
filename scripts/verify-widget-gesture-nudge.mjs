import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-widget-gesture-nudge");
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
    const nativeAnimate = Element.prototype.animate;
    window.__widgetNudgeAnimations = [];
    if (typeof nativeAnimate === "function") {
      Element.prototype.animate = function (keyframes, options) {
        const animation = nativeAnimate.call(this, keyframes, options);
        const frames = Array.isArray(keyframes) ? keyframes.map((frame) => ({ ...frame })) : keyframes;
        const handoffPosition = this.classList?.contains("widget-reorder-overlay")
          && frames?.[0]?.transform?.includes("translate3d")
          && !window.__widgetNudgeAnimations.some((record) => record.handoffPosition);
        const handoffScale = this.classList?.contains("widget-reorder-shake-lift");
        const record = {
          target: this,
          targetClass: typeof this.className === "string" ? this.className : "",
          frames,
          duration: typeof options === "number" ? options : options?.duration ?? 0,
          animation,
          handoffPosition,
          handoffScale,
        };
        window.__widgetNudgeAnimations.push(record);
        if (handoffPosition || handoffScale) animation.pause();
        return animation;
      };
    }
  });
  const page = await context.newPage();
  observeErrors(page);
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__widgetFixture && document.querySelector(".widget-grid")?.style.getPropertyValue("--widget-unit"));
  await page.waitForFunction(() => document.querySelector(".home-load-transition")?.getAttribute("data-phase") === "done", undefined, { timeout: 10_000 });
  return { context, page };
}

async function fixtureState(page, widgetId = "notes-main") {
  return page.evaluate((id) => {
    const card = document.querySelector(`.widget-grid > [data-widget-id="${id}"]`);
    const grid = card?.closest(".widget-grid");
    const neighbor = card?.nextElementSibling;
    if (!(card instanceof HTMLElement) || !(grid instanceof HTMLElement)) throw new Error(`Missing widget ${id}`);
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, left: value.left, top: value.top };
    };
    return {
      card: rect(card), grid: rect(grid), neighbor: neighbor instanceof HTMLElement ? rect(neighbor) : null,
      offset: { left: card.offsetLeft, top: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight },
      preview: card.getAttribute("data-widget-shake-preview"),
      x: card.style.getPropertyValue("--widget-shake-x"),
      y: card.style.getPropertyValue("--widget-shake-y"),
      translate: card.style.getPropertyValue("translate"),
      writes: window.__widgetFixture.writes,
      customize: document.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed"),
    };
  }, widgetId);
}

async function setBaselineTranslate(page) {
  await page.evaluate(() => {
    const card = document.querySelector('.widget-grid > [data-widget-id="notes-main"]');
    if (!(card instanceof HTMLElement)) throw new Error("Missing notes widget");
    card.style.translate = "10px 20px";
  });
  await page.waitForTimeout(260);
}

async function headingPoint(page, widgetId = "notes-main") {
  const heading = page.locator(`.widget-grid > [data-widget-id="${widgetId}"] .widget-header h2`);
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "widget heading is visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function verifyEightDirectionGeometryAndCleanup() {
  const { context, page } = await loadPage();
  try {
    const directions = [
      ["right", 1, 0], ["down-right", 1, 1], ["down", 0, 1], ["down-left", -1, 1],
      ["left", -1, 0], ["up-left", -1, -1], ["up", 0, -1], ["up-right", 1, -1],
    ];
    for (const [name, dx, dy] of directions) {
      await setBaselineTranslate(page);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(180);
      const resting = await fixtureState(page);
      const point = await headingPoint(page);
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(180);
      const origin = await fixtureState(page);
      await page.mouse.down();
      await page.mouse.move(point.x + dx * 80, point.y + dy * 80, { steps: 1 });
      try {
        await page.waitForFunction(() => document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.getAttribute("data-widget-shake-preview") === "true", undefined, { timeout: 2500 });
      } catch {
        const state = await page.evaluate(() => ({
          card: document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.outerHTML.slice(0, 500),
          customize: document.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed"),
          pointerTypes: window.__widgetFixture.pointerTypes.slice(-4),
          pointerEvents: window.__widgetFixture.pointerEvents.slice(-4),
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        }));
        throw new Error(`Directional preview did not start for ${name}: ${JSON.stringify(state)}`);
      }
      await page.waitForTimeout(180);
      const preview = await fixtureState(page);
      const actualX = preview.card.x - origin.card.x;
      const actualY = preview.card.y - origin.card.y;
      const magnitude = Math.hypot(actualX, actualY);
      assert.ok(magnitude >= 5 && magnitude <= 11, `${name}: rendered nudge is near 8px (received ${magnitude.toFixed(2)}px)`);
      assert.ok((actualX * dx + actualY * dy) / (magnitude * Math.hypot(dx, dy)) > 0.85, `${name}: rendered nudge follows pointer direction`);
      assert.deepEqual(preview.offset, origin.offset, `${name}: nudge does not change grid item footprint`);
      assert.deepEqual(preview.grid, origin.grid, `${name}: grid bounds stay fixed during preview`);
      assert.deepEqual(preview.neighbor, origin.neighbor, `${name}: neighboring widget bounds stay fixed`);
      assert.equal(preview.writes, 0, `${name}: preview does not save dashboard state`);
      assert.equal(preview.customize, "false", `${name}: preview does not activate Customize`);
      if (name === "right") await page.screenshot({ path: resolve(screenshotDir, "nudge-active.png") });

      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.getAttribute("data-widget-shake-preview") !== "true");
      await page.mouse.move(5, 5);
      await page.waitForTimeout(180);
      const restored = await fixtureState(page);
      assert.ok(Math.abs(restored.card.x - resting.card.x) < 1 && Math.abs(restored.card.y - resting.card.y) < 1, `${name}: release restores no-hover visual bounds (delta ${restored.card.x - resting.card.x}, ${restored.card.y - resting.card.y}; translate ${restored.translate})`);
      assert.equal(restored.translate, "10px 20px", `${name}: release restores the preexisting translate`);
      assert.equal(restored.x, "", `${name}: release clears horizontal offset`);
      assert.equal(restored.y, "", `${name}: release clears vertical offset`);
      assert.equal(restored.writes, 0, `${name}: release does not save dashboard state`);
    }
  } finally { await context.close(); }
}

async function beginHandoff(page, { baseline = true, distance = 80 } = {}) {
  if (baseline) await setBaselineTranslate(page);
  const point = await headingPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(180);
  const origin = await fixtureState(page);
  await page.mouse.down();
  await page.mouse.move(point.x + distance, point.y, { steps: 1 });
  await page.waitForFunction(() => document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.getAttribute("data-widget-shake-preview") === "true");
  await page.waitForTimeout(160);
  await page.mouse.move(point.x + Math.max(0, distance - 40), point.y, { steps: 1 });
  await page.waitForTimeout(45);
  await page.mouse.move(point.x + distance, point.y, { steps: 1 });
  await page.waitForFunction(() => document.querySelector(".widget-reorder-overlay") !== null, { timeout: 3000 });
  await page.waitForFunction(() => document.querySelector(".workspace-actions button[aria-pressed]")?.getAttribute("aria-pressed") === "true");
  return { origin, point, distance, desiredX: point.x + distance - (point.x - origin.card.left), desiredY: point.y - (point.y - origin.card.top) };
}

async function setHandoffTime(page, milliseconds) {
  await page.evaluate((time) => {
    for (const record of window.__widgetNudgeAnimations) {
      if (record.handoffPosition || record.handoffScale) record.animation.currentTime = time;
    }
  }, milliseconds);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
}

async function playHandoff(page) {
  await page.evaluate(() => {
    for (const record of window.__widgetNudgeAnimations) {
      if (record.handoffPosition || record.handoffScale) record.animation.play();
    }
  });
}

async function handoffDetails(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector(".widget-reorder-overlay");
    if (!(overlay instanceof HTMLElement)) throw new Error("Missing reorder overlay");
    const rect = overlay.getBoundingClientRect();
    const records = window.__widgetNudgeAnimations.filter((record) => record.targetClass.includes("widget-reorder-overlay"));
    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      style: { left: Number.parseFloat(overlay.style.left), top: Number.parseFloat(overlay.style.top), width: Number.parseFloat(overlay.style.width) },
      records: records.map((record) => ({ frames: record.frames, duration: record.duration, playState: record.animation.playState, handoffPosition: record.handoffPosition, handoffScale: record.handoffScale })),
      writes: window.__widgetFixture.writes,
      sourcePreview: document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.getAttribute("data-widget-shake-preview"),
      sourceTranslate: document.querySelector('.widget-grid > [data-widget-id="notes-main"]')?.style.getPropertyValue("translate"),
    };
  });
}

function parseTranslate(value) {
  const match = value.match(/translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px,\s*0\)/);
  assert.ok(match, `Expected a translate3d handoff frame, received: ${value}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function verifyHandoffGeometryAndEscape() {
  const { context, page } = await loadPage();
  try {
    await page.evaluate(() => { window.__widgetNudgeAnimations.length = 0; });
    const { origin, point, desiredX, desiredY } = await beginHandoff(page);
    let details = await handoffDetails(page);
    const position = details.records.find((record) => record.frames?.[0]?.transform?.includes("translate3d"));
    assert.ok(position, "the position handoff is animated with WAAPI");
    assert.ok(position.duration > 0 && position.duration <= 180, `handoff duration is bounded to 180ms (received ${position.duration})`);
    const initialOffset = parseTranslate(position.frames[0].transform);
    const visualStartX = details.style.left + initialOffset.x;
    const visualStartY = details.style.top + initialOffset.y;
    assert.ok(Math.abs(visualStartX - origin.card.left - 8) < 4, `overlay first frame begins at the translated nudge bounds (${visualStartX}, expected near ${origin.card.left + 8})`);
    assert.ok(Math.abs(visualStartY - origin.card.top) < 2, "overlay first frame preserves the baseline vertical translate without duplicating it");
    assert.equal(details.sourcePreview, null, "the source preview styling is restored before lift");
    assert.equal(details.sourceTranslate, "10px 20px", "the source keeps its original inline translate");
    assert.equal(details.writes, 0, "activating the shake and lifting does not save the dashboard");
    assert.ok(Math.abs(details.style.left - desiredX) < 1 && Math.abs(details.style.top - desiredY) < 1, "the overlay layout target is anchored to the live pointer grab point");
    await page.screenshot({ path: resolve(screenshotDir, "handoff-start.png") });

    await setHandoffTime(page, 60);
    const midBefore = await handoffDetails(page);
    assert.ok(midBefore.rect.left > visualStartX + 1 && midBefore.rect.left < desiredX - 1, "the handoff moves smoothly between the nudge and pointer positions");
    await page.mouse.move(point.x + 100, point.y, { steps: 1 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    const midAfter = await handoffDetails(page);
    const pointerDelta = midAfter.rect.left - midBefore.rect.left;
    assert.ok(pointerDelta > 18 && pointerDelta < 22, `the lifted widget follows later pointer movement smoothly while the handoff is paused (moved ${pointerDelta.toFixed(2)}px)`);
    await page.screenshot({ path: resolve(screenshotDir, "handoff-mid-move.png") });
    await setHandoffTime(page, 120);
    const later = await handoffDetails(page);
    assert.ok(later.rect.left > midAfter.rect.left && later.rect.left < desiredX + 20, "the handoff continues toward the pointer after the held movement");
    await playHandoff(page);
    await page.waitForTimeout(100);
    details = await handoffDetails(page);
    assert.ok(Math.abs(details.rect.left - (desiredX + 20)) < 2, "handoff ends with the widget under the pointer at the original grab offset");
    assert.equal(details.writes, 0, "the handoff remains unsaved while the pointer is held");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    const restored = await fixtureState(page);
    assert.equal(restored.preview, null, "Escape clears preview marker state");
    assert.equal(restored.translate, "10px 20px", "Escape preserves the original translate");
    assert.equal(restored.writes, 0, "Escape cancels without a dashboard write");
    await page.mouse.up();
  } finally { await context.close(); }
}

async function verifyEarlyHandoffCancellation() {
  const earlyEscape = await loadPage();
  try {
    await beginHandoff(earlyEscape.page);
    await setHandoffTime(earlyEscape.page, 60);
    await earlyEscape.page.keyboard.press("Escape");
    await earlyEscape.page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    const source = await fixtureState(earlyEscape.page);
    assert.equal(source.preview, null, "Escape during the paused handoff clears preview state");
    assert.equal(source.translate, "10px 20px", "Escape during handoff preserves the source translate");
    assert.equal(source.writes, 0, "Escape during handoff makes no dashboard write");
    await earlyEscape.page.mouse.up();
  } finally { await earlyEscape.context.close(); }

  const earlyDrop = await loadPage();
  try {
    await beginHandoff(earlyDrop.page, { distance: 24 });
    await setHandoffTime(earlyDrop.page, 60);
    await earlyDrop.page.mouse.up();
    await earlyDrop.page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"), undefined, { timeout: 3000 });
    const source = await fixtureState(earlyDrop.page);
    assert.equal(source.preview, null, "early pointer release clears preview state");
    assert.equal(source.translate, "10px 20px", "early release preserves the source translate");
    assert.equal(source.writes, 0, "dropping without a destination change does not save");
  } finally { await earlyDrop.context.close(); }
}

async function verifyImmediateFallbacks() {
  const { context, page } = await loadPage({ reducedMotion: "reduce" });
  try {
    await page.evaluate(() => { window.__widgetNudgeAnimations.length = 0; });
    const point = await headingPoint(page);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 80, point.y, { steps: 1 });
    await page.waitForTimeout(150);
    const reduced = await fixtureState(page);
    assert.equal(reduced.preview, null, "reduced motion skips the directional visual nudge");
    await page.mouse.move(point.x + 40, point.y, { steps: 1 });
    await page.mouse.move(point.x + 80, point.y, { steps: 1 });
    await page.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__widgetNudgeAnimations.filter((record) => record.targetClass.includes("widget-reorder-overlay")).length), 0, "reduced motion skips handoff animations");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
    await page.mouse.up();
  } finally { await context.close(); }

  for (const mode of ["zero-duration", "missing-animate"]) {
    const result = await loadPage();
    try {
      const fallbackPage = result.page;
      await fallbackPage.evaluate((selectedMode) => {
        window.__widgetNudgeAnimations.length = 0;
        const card = document.querySelector('.widget-grid > [data-widget-id="notes-main"]');
        if (selectedMode === "zero-duration" && card instanceof HTMLElement) card.style.setProperty("--wa-transition-ms", "0ms");
        if (selectedMode === "missing-animate") Element.prototype.animate = undefined;
      }, mode);
      const point = await headingPoint(fallbackPage);
      await fallbackPage.mouse.move(point.x, point.y);
      await fallbackPage.mouse.down();
      await fallbackPage.mouse.move(point.x + 80, point.y, { steps: 1 });
      await fallbackPage.mouse.move(point.x + 40, point.y, { steps: 1 });
      await fallbackPage.mouse.move(point.x + 80, point.y, { steps: 1 });
      await fallbackPage.waitForSelector(".widget-reorder-overlay", { state: "attached", timeout: 3000 });
      const animationCount = await fallbackPage.evaluate(() => window.__widgetNudgeAnimations.filter((record) => record.targetClass.includes("widget-reorder-overlay")).length);
      assert.equal(animationCount, 0, `${mode} uses an immediate handoff without WAAPI animations`);
      assert.equal(await fallbackPage.evaluate(() => window.__widgetFixture.writes), 0, `${mode} does not save while held`);
      await fallbackPage.keyboard.press("Escape");
      await fallbackPage.waitForFunction(() => !document.querySelector(".widget-reorder-overlay"));
      await fallbackPage.mouse.up();
    } finally { await result.context.close(); }
  }
}

try {
  await verifyEightDirectionGeometryAndCleanup();
  await verifyHandoffGeometryAndEscape();
  await verifyEarlyHandoffCancellation();
  await verifyImmediateFallbacks();
  assert.deepEqual(consoleErrors, [], "browser console and page errors are empty");
  console.log(`Widget gesture nudge browser QA passed. Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
