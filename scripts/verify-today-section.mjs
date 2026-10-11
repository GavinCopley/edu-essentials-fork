import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-today-section");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const esbuild = process.env.ESBUILD_MODULE
  ? await import(pathToFileURL(resolve(process.env.ESBUILD_MODULE)).href)
  : await import("esbuild");
const [globalCss, referenceCss, appearanceCss, blockLayoutCss, reorderCss] = await Promise.all([
  "app/globals.css", "app/reference-ui.css", "app/widget-appearance.css", "app/widget-block-layout.css", "app/widget-reorder.css",
].map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/today-section-browser.tsx")],
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
let browser;
const browserErrors = [];
try {
  browser = await playwright.chromium.launch(launchOptions);
  for (const scenario of [
    { width: 320, height: 900, touch: true, restore: "touch" },
    { width: 390, height: 900, touch: false, restore: "keyboard" },
    { width: 1000, height: 1000, touch: false, restore: "mouse" },
    { width: 1440, height: 1000, touch: false, restore: "mouse" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      hasTouch: scenario.touch,
      isMobile: scenario.touch,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(`console: ${message.text()}`); });
    await page.goto(baseUrl);
    const panel = page.locator(".home-today-panel");
    await panel.waitFor({ state: "visible" });
    await page.locator("[data-widget-id='browser-notes'] textarea").waitFor({ state: "visible" });
    const visibleGeometry = await panel.boundingBox();
    assert.ok(visibleGeometry, `Today panel has a layout box at ${scenario.width}px`);
    const urlBefore = page.url();
    const trigger = page.getByRole("button", { name: "Today section options" });
    const widgetOptions = page.locator("[data-widget-id='browser-notes'] .widget-header .menu-wrap > button");
    await widgetOptions.click();
    const standardMenu = page.locator(".widget-menu:not(.today-section-menu)");
    await standardMenu.waitFor({ state: "visible" });
    const standardStyle = await standardMenu.evaluate((element) => {
      const style = getComputedStyle(element);
      const item = element.querySelector(":scope > button:not(:disabled)");
      const itemStyle = getComputedStyle(item);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        color: style.color,
        family: style.fontFamily,
        itemFont: itemStyle.fontSize,
        itemColor: itemStyle.color,
      };
    });

    if (scenario.restore === "keyboard") {
      await trigger.focus();
      await page.evaluate(() => {
        if (window.__todayFocusTrace) return;
        const ids = new WeakMap();
        let nextId = 0;
        const events = [];
        const identify = (element) => {
          if (!element) return null;
          if (!ids.has(element)) ids.set(element, ++nextId);
          return ids.get(element);
        };
        const register = (node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(".today-section-menu, [role='menuitem']")) identify(node);
          for (const child of node.querySelectorAll(".today-section-menu, [role='menuitem']")) identify(child);
        };
        const observer = new MutationObserver((records) => {
          for (const record of records) for (const node of record.addedNodes) register(node);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener("focusin", (event) => {
          const target = event.target;
          if (target instanceof Element) events.push({
            id: identify(target), role: target.getAttribute("role"), label: target.getAttribute("aria-label") ?? target.textContent?.trim().slice(0, 60),
          });
        }, true);
        window.__todayFocusTrace = { identify, events };
      });
      await page.keyboard.press("ArrowDown");
    } else {
      await trigger.click();
    }
    const menu = page.locator('.today-section-menu[role="menu"]');
    await menu.waitFor({ state: "visible" });
    await standardMenu.waitFor({ state: "detached" });
    const todayStyle = await menu.evaluate((element) => {
      const style = getComputedStyle(element);
      const item = element.querySelector('[role="menuitem"]:not(:disabled)');
      const itemStyle = getComputedStyle(item);
      return {
        background: style.backgroundColor,
        border: style.borderTopColor,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        color: style.color,
        family: style.fontFamily,
        itemFont: itemStyle.fontSize,
        itemColor: itemStyle.color,
      };
    });
    assert.deepEqual(todayStyle, standardStyle, `Today menu uses the existing widget menu styling at ${scenario.width}px`);
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    const menuGeometry = await menu.boundingBox();
    assert.ok(menuGeometry, `Today options menu has a layout box at ${scenario.width}px`);
    assert.ok(menuGeometry.x >= 0 && menuGeometry.y >= 0, `menu begins within the viewport at ${scenario.width}px`);
    assert.ok(menuGeometry.x + menuGeometry.width <= scenario.width + 1, `menu fits the viewport width at ${scenario.width}px`);
    assert.ok(menuGeometry.y + menuGeometry.height <= scenario.height + 1, `menu fits the viewport height at ${scenario.width}px`);
    assert.equal(await menu.getByRole("menuitem", { name: /Edit section/ }).isDisabled(), false, "Edit section opens the content editor");
    assert.equal(page.url(), urlBefore, "opening Today options never navigates away");

    if (scenario.restore === "keyboard") {
      const assertKeyboardAutoFocus = async () => {
        const focusState = await page.evaluate(async () => {
          const menu = document.querySelector(".today-section-menu[role='menu']");
          const item = menu?.querySelector("[role='menuitem']:not(:disabled)");
          if (!menu || !item) return { missingMenu: !menu, missingMenuItem: !item };
          const initialMenu = menu;
          const initialItem = item;
          const read = () => {
            const currentMenu = document.querySelector(".today-section-menu[role='menu']");
            const currentItem = currentMenu?.querySelector("[role='menuitem']:not(:disabled)");
            const active = document.activeElement;
            return {
              active: active instanceof Element ? active.outerHTML.slice(0, 180) : null,
              activeId: window.__todayFocusTrace.identify(active),
              focused: active === currentItem,
              menuId: window.__todayFocusTrace.identify(currentMenu),
              itemId: window.__todayFocusTrace.identify(currentItem),
              sameMenu: currentMenu === initialMenu,
              sameItem: currentItem === initialItem,
            };
          };
          const immediate = read();
          await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
          const animationFrame = read();
          await new Promise((resolve) => setTimeout(resolve, 50));
          const delayed = read();
          const rect = initialItem.getBoundingClientRect();
          const style = getComputedStyle(initialItem);
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            immediate, animationFrame, delayed,
            itemDisabled: initialItem.matches(":disabled"), visibility: style.visibility, display: style.display,
            rect: rect.toJSON(), connected: initialItem.isConnected,
            menuInlineStyle: initialMenu.getAttribute("style"),
            portalHost: initialMenu.closest(".reference-ui")?.className ?? null,
            menuParent: initialMenu.parentElement?.outerHTML.slice(0, 180) ?? null,
            inertAncestor: initialItem.closest("[inert]")?.outerHTML.slice(0, 120) ?? null,
            ariaHiddenAncestor: initialItem.closest('[aria-hidden="true"]')?.outerHTML.slice(0, 120) ?? null,
            hitTarget: hit?.closest('[role="menuitem"]') === initialItem,
            focusEvents: window.__todayFocusTrace.events.slice(-8),
          };
        });
        assert.ok(
          focusState.immediate?.focused || focusState.animationFrame?.focused || focusState.delayed?.focused,
          `ArrowDown automatically focuses the first enabled menu item: ${JSON.stringify(focusState)}`,
        );
      };
      await assertKeyboardAutoFocus();
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate((element) => document.activeElement === element), true, "Escape returns focus to Today options");
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await menu.waitFor({ state: "visible" });
      await assertKeyboardAutoFocus();
      await page.keyboard.press("Tab");
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => !document.activeElement.closest(".home-today-panel")), true, "Tab closes the menu and moves focus outside the panel");
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await menu.waitFor({ state: "visible" });
      await assertKeyboardAutoFocus();
    } else {
      await page.locator(".home-greeting").click();
      await menu.waitFor({ state: "hidden" });
      await trigger.click();
    }
    const writesBeforeHide = await page.evaluate(() => window.__todayFixture.writes);
    if (scenario.restore === "keyboard") {
      await menu.getByRole("menuitem", { name: "Hide section" }).focus();
      await page.keyboard.press("Space");
    }
    else await menu.getByRole("menuitem", { name: "Hide section" }).click();
    await panel.waitFor({ state: "detached" });
    await page.waitForFunction((count) => window.__todayFixture.writes === count + 1, writesBeforeHide);
    assert.equal(await page.locator(".today-section-restore").count(), 0, "normal view hides the restore control");
    assert.equal(await page.locator("[data-widget-id='browser-notes'] textarea").inputValue(), "Browser fixture note", "hiding Today keeps the notes widget");
    assert.equal(await page.locator("[data-widget-id='browser-glance']").count(), 1, "hiding Today keeps the At a Glance widget");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Customize", "hiding Today moves focus outside the removed panel");

    await page.reload();
    await page.getByRole("tab", { name: "Browser day" }).waitFor({ state: "visible" });
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.__todayFixture.writes), writesBeforeHide + 1, "reload reads the saved visibility without an extra write");

    await page.getByRole("button", { name: "Customize" }).click();
    assert.equal(await panel.count(), 0, "Today remains collapsed in Customize");
    assert.equal(await page.getByRole("button", { name: "Restore Today section" }).count(), 0, "restore is tucked into Workspace options");
    await page.getByRole("button", { name: "Workspace options" }).click();
    const restore = page.getByRole("button", { name: "Restore Today section" });
    await restore.waitFor({ state: "visible" });
    assert.equal(await restore.evaluate((element) => Boolean(element.closest(".workspace-menu"))), true, "restore appears in the three-dot menu");
    if (scenario.restore === "keyboard") {
      await restore.focus();
      await page.keyboard.press("Enter");
    } else if (scenario.restore === "touch") {
      await restore.tap();
    } else {
      await restore.click();
    }
    await panel.waitFor({ state: "visible" });
    await page.waitForFunction((count) => window.__todayFixture.writes === count + 1, writesBeforeHide + 1);
    assert.equal(await page.evaluate(() => window.__todayFixture.writes), writesBeforeHide + 2, "hide and restore each save once");
    assert.equal(await page.locator(".today-section-restore").count(), 0, "restored Today replaces its placeholder");

    // Exercise real layout at each section count, including narrow viewports.
    const editToday = async () => {
      await trigger.click();
      await menu.getByRole("menuitem", { name: "Edit section" }).click();
      const dialog = page.getByRole("dialog", { name: "Edit Today sections" });
      await dialog.waitFor({ state: "visible" });
      const geometry = await dialog.boundingBox();
      assert.ok(geometry && geometry.x >= 0 && geometry.x + geometry.width <= scenario.width + 1, "editor fits the viewport");
      return dialog;
    };
    const assertSectionsFillGrid = async (count) => {
      const sections = panel.locator(".today-panel-grid > .today-panel-section");
      assert.equal(await sections.count(), count);
      const gridBox = await panel.locator(".today-panel-grid").boundingBox();
      const boxes = await sections.evaluateAll((elements) => elements.map((element) => {
        const { x, y, width } = element.getBoundingClientRect();
        return { x, y, width };
      }));
      for (const box of boxes) assert.ok(box.width > 0 && box.x >= gridBox.x && box.x + box.width <= gridBox.x + gridBox.width + 1, "section stays within the grid");
      for (const y of new Set(boxes.map((box) => box.y))) {
        const row = boxes.filter((box) => box.y === y);
        assert.ok(Math.abs(row.reduce((sum, box) => sum + box.width, 0) - (gridBox.width - 2)) < 3, `visible sections fill each row: ${JSON.stringify({ viewport: scenario.width, count, gridBox, boxes, row })}`);
        if (row.length > 1) assert.ok(Math.max(...row.map((box) => box.width)) - Math.min(...row.map((box) => box.width)) < 2, "sections in the same row share width equally");
      }
    };
    const applyChoices = async (dialog) => {
      const writes = await page.evaluate(() => window.__todayFixture.writes);
      await dialog.getByRole("button", { name: "Apply", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction((count) => window.__todayFixture.writes === count + 1, writes);
    };
    await assertSectionsFillGrid(3);
    let dialog = await editToday();
    await dialog.getByRole("checkbox", { name: "Today’s Schedule", exact: true }).uncheck();
    await applyChoices(dialog);
    await assertSectionsFillGrid(2);
    dialog = await editToday();
    await dialog.getByRole("checkbox", { name: "Due Today", exact: true }).uncheck();
    await applyChoices(dialog);
    await assertSectionsFillGrid(1);
    dialog = await editToday();
    await dialog.getByRole("checkbox", { name: "Study Goal", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Upcoming Deadlines", exact: true }).check();
    await dialog.getByRole("checkbox", { name: "Next Class", exact: true }).uncheck();
    await dialog.getByRole("checkbox", { name: "Study Streak", exact: true }).check();
    await applyChoices(dialog);
    await assertSectionsFillGrid(3);
    await page.reload();
    await panel.waitFor({ state: "visible" });
    await panel.getByRole("heading", { name: "Study Streak" }).waitFor({ state: "visible" });
    await assertSectionsFillGrid(3);

    await page.screenshot({ path: resolve(screenshotDir, `today-${scenario.width}.png`), fullPage: false });
    if (browserErrors.length) assert.deepEqual(browserErrors, [], "browser console stays clean");
    await context.close();
    console.log(`PASS ${scenario.width}px ${scenario.touch ? "touch" : scenario.restore} viewport: menu bounds, hide/restore, editor, 1–3 section layouts, saved choices`);
  }
} finally {
  if (browser) await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
assert.deepEqual(browserErrors, [], "browser console stays clean");
console.log(`Screenshots saved under ${screenshotDir} (ignored by Git).`);
