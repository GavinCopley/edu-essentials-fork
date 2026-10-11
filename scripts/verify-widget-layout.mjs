import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-widget-layout");

// Optional browser QA. Set PLAYWRIGHT_MODULE to a bundled playwright/index.mjs
// if Playwright is not installed in this repository; set CHROME_EXECUTABLE if
// Chrome is installed outside Playwright's standard "chrome" channel lookup.
// Set DENSITY_ONLY=1 to run desktop scaling, phone geometry, and sidebar/menu
// checks independently of the legacy content-overflow scenarios.
// PowerShell example: $env:PLAYWRIGHT_MODULE = 'C:/path/to/playwright/index.mjs'; node scripts/verify-widget-layout.mjs
const [globalCss, referenceCss, widgetAppearanceCss, widgetBlockLayoutCss, mountainAsset, playwright] = await Promise.all([
  readFile(resolve(repoRoot, "app/globals.css"), "utf8"),
  readFile(resolve(repoRoot, "app/reference-ui.css"), "utf8"),
  readFile(resolve(repoRoot, "app/widget-appearance.css"), "utf8"),
  readFile(resolve(repoRoot, "app/widget-block-layout.css"), "utf8"),
  readFile(resolve(repoRoot, "public/mountain-header.png")),
  (async () => {
    try {
      return process.env.PLAYWRIGHT_MODULE
        ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
        : await import("playwright");
    } catch (error) {
      throw new Error("Playwright is unavailable. Install it outside this script or set PLAYWRIGHT_MODULE to a bundled playwright/index.mjs path.", { cause: error });
    }
  })(),
]);

assert.equal(mountainAsset.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "mountain banner fixture asset is a PNG");
const mountainSourceDimensions = {
  width: mountainAsset.readUInt32BE(16),
  height: mountainAsset.readUInt32BE(20),
};
assert.deepEqual(mountainSourceDimensions, { width: 2172, height: 724 }, "mountain banner source dimensions are 2172×724");
const mountainImageUrl = "url('/mountain-header.png')";
assert.equal(referenceCss.split(mountainImageUrl).length - 1, 1, "production CSS references the mountain banner exactly once");
const fixtureReferenceCss = referenceCss.replace(mountainImageUrl, `url("data:image/png;base64,${mountainAsset.toString("base64")}")`);

const longText = "An intentionally long fictional dashboard entry exercises content overflow without account data. ".repeat(70);
async function renderActualWidgetMarkup() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://layout.example.invalid/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const name of ["HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "MouseEvent"]) globalThis[name] = dom.window[name];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.confirm = () => true;

  const { clientModule } = await import("../tests/helpers/client-modules.mjs");
  const [{ createElement, act }, { createRoot }, { default: Workspace }, { validateProfile }, { default: AnimatedWidgetGrid, calculateWidgetUnit, calculateWidgetPlacements }, appearanceModule] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import(await clientModule("app/workspace-client.tsx")),
    import(await clientModule("lib/profile.ts")),
    import(await clientModule("app/animated-widget-grid.tsx")),
    import(await clientModule("lib/widget-appearance.ts")),
  ]);
  const sizeByType = new Map([[12, 0], [4, 0], [6, 0], [16, 0], [15, 2], [5, 0], [17, 0], [11, 1], [8, 1]]);
  const idByType = new Map([[12, "notes"], [4, "alerts"], [6, "timer"], [16, "quote"], [15, "overview"], [5, "calendar"], [17, "spacer"], [11, "links"], [8, "completion"], [2, "upcoming"]]);
  const typeOrder = [12, 4, 6, 16, 15, 5, 17, 11, 8, 0, 1, 2, 3, 7, 9, 10, 13, 14];
  const widgets = typeOrder.map((type) => [type, sizeByType.get(type) ?? 0, idByType.get(type) ?? `widget-${type}`, ...(type === 12 ? [0] : [])]);
  const courses = Array.from({ length: 4 }, (_, index) => ({
    id: `course-${index + 1}`,
    code: `HIST ${200 + index}`,
    name: `Advanced fictional archival methods and historical interpretation ${index + 1}`,
    credits: 3,
    instructor: "Example Instructor",
    room: "Example Hall",
    color: ["#6376ff", "#38b8d4", "#51b883", "#d9923c"][index],
    soft: "#6376ff20",
    initials: `H${index + 1}`,
  }));
  const assignments = Array.from({ length: 8 }, (_, index) => ({
    id: `assignment-${index + 1}`,
    title: `A carefully prepared fictional archive analysis and annotated primary source review ${index + 1} `.repeat(3),
    courseId: courses[index % courses.length].id,
    due: "2099-10-08",
    dateKey: `2099-10-${String(8 + index).padStart(2, "0")}`,
    status: "later",
    progress: 20 + index * 5,
    description: longText,
    weight: "",
    type: index % 2 ? "Assignment" : "Exam",
  }));
  const dashboard = { v: 2, a: "fixture", w: [["fixture", "Fictional", widgets]], t: [longText], d: { assignments, manualEvents: [], dashboardView: "cards", calendarView: "month" } };
  const updatedAt = "2026-10-01T00:00:00.000Z";
  const profile = { ...validateProfile({ display_name: "Alex" }), id: "fixture-profile", auth_user_id: "fixture-user", email: "alex@example.invalid", avatar_url: null, initialized: true, updated_at: updatedAt, onboarding_completed_at: updatedAt };
  globalThis.fetch = async (url) => String(url).startsWith("/api/files")
    ? Response.json({ files: [] })
    : Response.json({ initialized: true, courses, dashboard, revision: updatedAt, profile });
  const rootNode = document.getElementById("root");
  const root = createRoot(rootNode);
  await act(async () => {
    root.render(createElement(Workspace, { initialProfile: profile }));
    await new Promise((done) => setTimeout(done, 0));
  });
  const grid = rootNode.querySelector(".widget-grid");
  assert.ok(grid, "actual Workspace component should render the widget grid");
  assert.equal(grid.querySelectorAll(".widget-card").length, 18, "fixture should render every production widget type");
  const findGridOwner = (fiber) => {
    if (!fiber) return null;
    if (fiber.stateNode instanceof AnimatedWidgetGrid) return fiber.stateNode;
    return findGridOwner(fiber.child) ?? findGridOwner(fiber.sibling);
  };
  const gridOwner = findGridOwner(root._internalRoot.current);
  assert.equal(typeof gridOwner?.updateBoardUnit, "function", "actual AnimatedWidgetGrid exposes its production measurement callback for browser QA");
  assert.equal(typeof gridOwner?.updateCardPlacements, "function", "actual AnimatedWidgetGrid exposes its production card placement method for browser QA");
  const markup = grid.innerHTML;
  assert.equal(grid.style.maxWidth, "", "production board sizing does not write an inline max-width");
  grid.style.removeProperty("--widget-unit");
  const fixture = {
    cards: markup,
    gridStyle: grid.getAttribute("style") ?? "",
    desktopTopbar: document.querySelector(".desktop-topbar")?.outerHTML ?? "",
    sidebar: document.querySelector(".sidebar")?.outerHTML ?? "",
    mobileHeader: document.querySelector(".mobile-header")?.outerHTML ?? "",
    greeting: document.querySelector(".home-greeting")?.outerHTML ?? "",
    todayPanel: document.querySelector(".home-today-panel")?.outerHTML ?? "",
    workspaceBar: document.querySelector(".workspace-bar")?.outerHTML ?? "",
    mobileBottomNav: document.querySelector(".mobile-bottom-nav")?.outerHTML ?? "",
  };
  const densityAppearance = appearanceModule.widgetAppearanceStyle({
    ...appearanceModule.defaultWidgetAppearance,
    gap: 18,
    padding: 18,
    fontSize: 18,
    titleSize: 20,
    iconSize: 32,
  });
  const defaultDensityAppearance = appearanceModule.widgetAppearanceStyle(appearanceModule.defaultWidgetAppearance);
  assert.equal(typeof calculateWidgetUnit, "function", "actual AnimatedWidgetGrid exports the production board sizing calculation");
  await act(async () => root.unmount());
  dom.window.close();
  return {
    fixture,
    densityAppearance,
    defaultDensityAppearance,
    calculateWidgetUnitSource: calculateWidgetUnit.toString(),
    updateBoardUnitSource: gridOwner.updateBoardUnit.toString(),
    calculateWidgetPlacementsSource: calculateWidgetPlacements.toString(),
    updateCardPlacementsSource: gridOwner.updateCardPlacements.toString(),
  };
}

  const { fixture: actualMarkup, densityAppearance, defaultDensityAppearance, calculateWidgetUnitSource, updateBoardUnitSource, calculateWidgetPlacementsSource, updateCardPlacementsSource } = await renderActualWidgetMarkup();
const cardsMarkup = actualMarkup.cards;
const gridStyleAttribute = actualMarkup.gridStyle
  ? ` style="${actualMarkup.gridStyle.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`
  : "";

// This opt-in browser fixture combines actual Workspace markup with production CSS.
const documentHtml = `<!doctype html><html data-theme="dark" data-motion="reduced" style='--font-geist-sans:"Segoe UI";--font-geist-mono:Consolas,monospace'><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
.sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
${globalCss.replace(/^@import[^;]+;\s*/m, "")}
${fixtureReferenceCss}
${widgetAppearanceCss}
${widgetBlockLayoutCss}
</style></head><body><div class="app-shell reference-ui" id="app">
  ${actualMarkup.sidebar}
  <div class="mountain-backdrop"></div>${actualMarkup.desktopTopbar}
  <main class="main-content">${actualMarkup.mobileHeader}<div class="page home-page">${actualMarkup.greeting}${actualMarkup.todayPanel}<section class="workspace-section">${actualMarkup.workspaceBar}<div class="widget-grid" aria-label="My Day widgets"${gridStyleAttribute}>${cardsMarkup}</div></section><div class="fixture-footer" style="min-height:620px;padding:30px"><h2>Long page area</h2><p>Scroll content to verify the widget menu remains on top.</p></div></div></main>
  ${actualMarkup.mobileBottomNav}
</div><script>
document.querySelector(".sidebar-toggle").addEventListener("click", () => {
  const app = document.querySelector("#app");
  const collapsed = app.classList.toggle("sidebar-collapsed");
  document.querySelector(".sidebar-toggle").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
});
document.querySelectorAll(".widget-header .menu-wrap > button").forEach((trigger) => trigger.addEventListener("click", () => {
  const card = trigger.closest(".widget-card");
  const current = card.querySelector(".widget-menu");
  if (current) { current.remove(); return; }
  document.querySelectorAll(".widget-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "popover widget-menu";
  menu.innerHTML = '<p>Widget size</p><div class="size-options"><button data-size="mini" aria-label="Mini widget">Mini</button><button data-size="small" aria-label="Small widget">Small</button><button data-size="medium" aria-label="Medium horizontal widget">Medium horizontal</button><button data-size="medium-vertical" aria-label="Medium vertical widget">Medium vertical</button><button data-size="large" aria-label="Large widget">Large</button></div><button data-move="-1">Move earlier</button><button data-move="1">Move later</button>';
  const placeMenu = () => {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const width = menu.offsetWidth || Math.min(240, viewportWidth * .85);
    const anchorRect = trigger.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const left = Math.max(12, Math.min(anchorRect.right - width, viewportWidth - width - 12));
    menu.style.left = String(left - cardRect.left - card.clientLeft) + "px";
    menu.style.right = "auto";
    menu.style.top = String(anchorRect.bottom - cardRect.top - card.clientTop + 4) + "px";
  };
  const cleanup = () => {
    window.removeEventListener("resize", placeMenu);
    card.removeEventListener("scroll", placeMenu, true);
  };
  menu.querySelectorAll("[data-size]").forEach((button) => button.addEventListener("click", () => {
    card.dataset.size = button.dataset.size;
    cleanup();
    menu.remove();
  }));
  menu.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => {
    const sibling = Number(button.dataset.move) < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (sibling) sibling.insertAdjacentElement(Number(button.dataset.move) < 0 ? "beforebegin" : "afterend", card);
    cleanup();
    menu.remove();
  }));
  card.append(menu);
  placeMenu();
  window.addEventListener("resize", placeMenu);
  card.addEventListener("scroll", placeMenu, true);
}));
</script></body></html>`;

function near(actual, expected, message, tolerance = 1.5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected} ± ${tolerance}px, received ${actual}px`);
}

async function snapshotLayout(page) {
  // Container-query styles and their dependent tracks settle during rendering.
  await page.evaluate(() => {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__updateProductionBoardUnit?.();
      window.__updateProductionCardPlacements?.();
      requestAnimationFrame(() => {
        window.__updateProductionBoardUnit?.();
        window.__updateProductionCardPlacements?.();
        requestAnimationFrame(resolve);
      });
    })));
  });
  return page.evaluate(() => {
    const gridElement = document.querySelector(".widget-grid");
    const grid = gridElement.getBoundingClientRect();
    const workspaceSection = document.querySelector(".workspace-section").getBoundingClientRect();
    const todayPanel = document.querySelector(".home-today-panel").getBoundingClientRect();
    const scrollX = window.scrollX, scrollY = window.scrollY;
    const contentBox = (rect) => ({ x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, right: rect.right + scrollX, bottom: rect.bottom + scrollY });
    const cards = [...document.querySelectorAll(".widget-card")].map((card) => {
      const rect = card.getBoundingClientRect();
      return { id: card.dataset.widgetId, type: [...card.classList].find((name) => name.startsWith("widget-") && name !== "widget-card"), size: card.dataset.size, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, right: rect.right + scrollX, bottom: rect.bottom + scrollY };
    });
    const gridStyle = getComputedStyle(gridElement);
    return { grid: contentBox(grid), workspaceSection: contentBox(workspaceSection), todayPanel: contentBox(todayPanel), unit: Number.parseFloat(gridStyle.getPropertyValue("--widget-unit")), columns: gridStyle.gridTemplateColumns.trim().split(/\s+/).length, debug: window.__productionUnitInput, cards, workspaceWidth: document.querySelector(".main-content").clientWidth, viewportWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function assertGridLayout(layout, label) {
  assert.ok(layout.grid.width > 0, `${label}: widget grid has a measurable width`);
  assert.ok(layout.cards.length > 0, `${label}: widget grid contains cards`);
  for (const [targetName, target] of [["workspace section", layout.workspaceSection], ["Today panel", layout.todayPanel]]) {
    near(layout.grid.x, target.x, `${label}: widget grid aligns with the ${targetName}'s left edge`, 1.5);
    near(layout.grid.right, target.right, `${label}: widget grid aligns with the ${targetName}'s right edge`, 1.5);
    near(layout.grid.width, target.width, `${label}: widget grid fills the ${targetName} width`, 1.5);
  }
  for (const card of layout.cards) {
    assert.ok(card.x >= layout.grid.x - 1.5, `${label}: ${card.id} stays inside the grid's left edge`);
    assert.ok(card.right <= layout.grid.right + 1.5, `${label}: ${card.id} stays inside the grid's right edge`);
    assert.ok(card.y >= layout.grid.y - 1.5, `${label}: ${card.id} stays inside the grid's top edge`);
    assert.ok(card.bottom <= layout.grid.bottom + 1.5, `${label}: ${card.id} stays inside the grid's bottom edge`);
  }
  for (let i = 0; i < layout.cards.length; i++) {
    for (let j = i + 1; j < layout.cards.length; j++) {
      const left = layout.cards[i], right = layout.cards[j];
      const overlapWidth = Math.min(left.right, right.right) - Math.max(left.x, right.x);
      const overlapHeight = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y);
      assert.ok(overlapWidth <= 1 || overlapHeight <= 1, `${label}: ${left.id} and ${right.id} overlap by ${overlapWidth}×${overlapHeight}px`);
    }
  }
  return layout.cards;
}

function assertBlockRatios(layout, gaps, label, requireAllSizes = true) {
  const bySize = new Map();
  for (const size of ["mini", "small", "medium", "medium-vertical", "large"]) {
    const card = layout.cards.find((item) => item.size === size);
    if (!card) {
      assert.ok(!requireAllSizes, `${label}: mixed fixture includes a ${size} widget`);
      continue;
    }
    bySize.set(size, card);
  }
  const mini = bySize.get("mini"), small = bySize.get("small"), medium = bySize.get("medium");
  const vertical = bySize.get("medium-vertical"), large = bySize.get("large");
  near(small.width, small.height, `${label}: small widgets are square`, 2);
  near(mini.width, small.width, `${label}: mini spans one small-width column`, 2);
  assert.ok(mini.width > mini.height, `${label}: mini widgets are horizontal`);
  near(2 * mini.height + gaps.row, small.height, `${label}: two mini heights and their gap equal one small unit`, 2);
  near(medium.width, 2 * small.width + gaps.column, `${label}: medium spans two small columns and their gap`, 2);
  near(medium.height, small.height, `${label}: horizontal medium is one small unit high`, 2);
  if (vertical) {
    near(vertical.width, small.width, `${label}: vertical medium shares the small width`, 2);
    near(vertical.height, 2 * small.height + gaps.row, `${label}: medium vertical is two small blocks and their gap`, 2);
  }
  near(large.width, 2 * small.width + gaps.column, `${label}: large spans two small columns and their gap`, 2);
  near(large.height, 2 * small.height + gaps.row, `${label}: large spans two small rows and their gap`, 2);
  near(large.width, large.height, `${label}: large widgets are square`, 2);
  return { mini, small, medium, vertical, large };
}

function coordinateGroups(values, tolerance = 2) {
  const groups = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    if (!groups.length || Math.abs(value - groups.at(-1)) > tolerance) groups.push(value);
  }
  return groups;
}

function assertResponsiveSmallLayout(layout, expectedColumns, label) {
  const cards = layout.cards;
  const perRow = expectedColumns;
  assert.equal(cards.length, 8, `${label}: exactly eight representative production widgets are in the responsive board`);
  assert.ok(cards.every((card) => card.size === "small"), `${label}: every representative widget is small`);
  assert.equal(coordinateGroups(cards.map((card) => card.x)).length, perRow, `${label}: small widgets use ${perRow} distinct columns`);
  assert.equal(coordinateGroups(cards.map((card) => card.y)).length, 8 / perRow, `${label}: eight small widgets form ${8 / perRow} rows`);
  const xPositions = coordinateGroups(cards.map((card) => card.x));
  const yPositions = coordinateGroups(cards.map((card) => card.y));
  cards.forEach((card, index) => {
    const expectedColumn = index % perRow;
    const expectedRow = Math.floor(index / perRow);
    const actualColumn = xPositions.findIndex((value) => Math.abs(value - card.x) <= 2);
    const actualRow = yPositions.findIndex((value) => Math.abs(value - card.y) <= 2);
    assert.equal(actualColumn, expectedColumn, `${label}: ${card.id} stays in stable small column ${expectedColumn + 1}`);
    assert.equal(actualRow, expectedRow, `${label}: ${card.id} stays in stable small row ${expectedRow + 1}`);
    near(card.width, card.height, `${label}: ${card.id} remains square (grid ${JSON.stringify({ ...layout.grid, unit: layout.unit, columns: layout.columns, debug: layout.debug })}, card ${JSON.stringify(card)})`, 2);
  });
  const first = cards[0];
  for (const card of cards.slice(1)) {
    near(card.width, first.width, `${label}: ${card.id} has the same width as its peers`, 2);
    near(card.height, first.height, `${label}: ${card.id} has the same height as its peers`, 2);
  }
  return { perRow, rows: 8 / perRow, width: first.width, height: first.height };
}

async function readGridGaps(page) {
  return page.locator(".widget-grid").evaluate((grid) => {
    const style = getComputedStyle(grid);
    return {
      column: Number.parseFloat(style.columnGap),
      row: Number.parseFloat(style.rowGap),
      columns: style.gridTemplateColumns.trim().split(/\s+/).length,
    };
  });
}

async function readDesktopDensityMetrics(page) {
  await settleLayout(page);
  return page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    const number = (selector, property) => Number.parseFloat(getComputedStyle(document.querySelector(selector))[property]);
    const card = document.querySelector(".widget-card");
    const icon = card.querySelector(".widget-header .widget-icon");
    const iconRect = icon.getBoundingClientRect();
    const sidebarToggle = document.querySelector(".sidebar-toggle").getBoundingClientRect();
    const navIcon = document.querySelector(".main-nav .nav-item svg").getBoundingClientRect();
    const gridStyle = getComputedStyle(document.querySelector(".widget-grid"));
    const menu = document.querySelector(".today-section-menu");
    const menuRect = menu.getBoundingClientRect();
    const menuButton = menu.querySelector("[role=menuitem]");
    const menuButtonRect = menuButton.getBoundingClientRect();
    const cardsBySize = Object.fromEntries([...document.querySelectorAll(".widget-card")].map((element) => {
      const rect = element.getBoundingClientRect();
      return [element.dataset.size, { width: rect.width, height: rect.height }];
    }));
    return {
      sidebarWidth: box(".sidebar").width,
      brandTitleFontSize: number(".brand-row strong", "fontSize"),
      sidebarToggleWidth: sidebarToggle.width,
      sidebarToggleHeight: sidebarToggle.height,
      navIconWidth: navIcon.width,
      navIconHeight: navIcon.height,
      topbarHeight: box(".desktop-topbar").height,
      searchHeight: box(".topbar-search").height,
      searchFontSize: number(".topbar-search input", "fontSize"),
      greetingHeight: box(".home-greeting").height,
      greetingTitleFontSize: number(".home-greeting h1", "fontSize"),
      greetingSubtitleFontSize: number(".home-greeting p", "fontSize"),
      todayTitleFontSize: number(".today-panel-header h2", "fontSize"),
      todayPanelHeight: box(".home-today-panel").height,
      widgetGapColumn: Number.parseFloat(gridStyle.columnGap),
      widgetGapRow: Number.parseFloat(gridStyle.rowGap),
      cardFontSize: number(".widget-card", "fontSize"),
      cardPadding: number(".widget-card", "paddingTop"),
      widgetTitleFontSize: number(".widget-header h2", "fontSize"),
      widgetIconWidth: iconRect.width,
      widgetIconHeight: iconRect.height,
      cardFootprints: cardsBySize,
      todayMenuWidth: menuRect.width,
      todayMenuHeight: menuRect.height,
      todayMenuFontSize: Number.parseFloat(getComputedStyle(menu).fontSize),
      todayMenuItemHeight: menuButtonRect.height,
    };
  });
}

function expectedDesktopContentSpace(width) {
  return Math.max(0, (width - 1440) / 4);
}

function expectedDesktopDensityScale(width) {
  return Math.max(1, (width - expectedDesktopContentSpace(width)) / 1440);
}

function desktopFrameBaseline(frame) {
  return {
    clientWidth: frame.clientWidth,
    sidebarLeft: frame.sidebar.left,
    sidebarRight: frame.sidebar.right,
    sidebarWidth: frame.sidebar.width,
    mainLeft: frame.main.left,
    pageGutter: frame.mainPaddingRight,
    dashboardContentWidth: frame.main.width - frame.mainPaddingRight,
    topbarLeft: frame.topbar.left,
    topbarRightGutter: frame.clientWidth - frame.topbar.right,
    topbarHeight: frame.topbar.height,
    mountainLeft: frame.mountain.left,
    mountainHeight: frame.mountain.height,
  };
}

async function readDesktopFrameMetrics(page) {
  return page.evaluate(({ width: sourceWidth, height: sourceHeight }) => {
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, height: box.height };
    };
    const mountainElement = document.querySelector(".mountain-backdrop");
    const mountainStyle = getComputedStyle(mountainElement);
    const mountainBox = mountainElement.getBoundingClientRect();
    const backgroundPosition = mountainStyle.backgroundPosition.split(",").map((value) => value.trim()).filter(Boolean).at(-1);
    const backgroundSize = mountainStyle.backgroundSize.split(",").at(-1).trim();
    const verticalPositionTokens = backgroundPosition.match(/-?\d+(?:\.\d+)?%/g) ?? [];
    const verticalPositionPercent = Number.parseFloat(verticalPositionTokens.at(-1) ?? "NaN");
    const imageScale = Math.max(mountainBox.width / sourceWidth, mountainBox.height / sourceHeight);
    const renderedImageHeight = sourceHeight * imageScale;
    const verticalOverflow = Math.max(0, renderedImageHeight - mountainBox.height);
    const cropTop = verticalOverflow * verticalPositionPercent / 100;
    const app = document.querySelector(".reference-ui");
    const main = document.querySelector(".main-content");
    const mainStyle = getComputedStyle(main);
    const spaceProbe = document.createElement("span");
    Object.assign(spaceProbe.style, {
      position: "absolute",
      top: "0",
      width: "var(--desktop-content-space)",
      height: "0",
      visibility: "hidden",
      pointerEvents: "none",
    });
    app.append(spaceProbe);
    const contentSpace = spaceProbe.getBoundingClientRect().width;
    spaceProbe.remove();
    const densityProbe = document.createElement("span");
    Object.assign(densityProbe.style, {
      position: "absolute",
      top: "0",
      width: "0",
      height: "0",
      fontSize: "var(--desktop-density-unit)",
      visibility: "hidden",
      pointerEvents: "none",
    });
    main.append(densityProbe);
    const densityUnit = Number.parseFloat(getComputedStyle(densityProbe).fontSize);
    densityProbe.remove();
    const gutterProbe = document.createElement("span");
    Object.assign(gutterProbe.style, {
      position: "absolute",
      top: "0",
      width: "var(--desktop-content-gutter)",
      height: "0",
      visibility: "hidden",
      pointerEvents: "none",
    });
    app.append(gutterProbe);
    const contentGutter = gutterProbe.getBoundingClientRect().width;
    gutterProbe.remove();
    return {
      viewportWidth: innerWidth,
      clientWidth: document.documentElement.clientWidth,
      contentSpace,
      densityUnit,
      contentGutter,
      mainPaddingRight: Number.parseFloat(mainStyle.paddingRight),
      shell: rect(".reference-ui"),
      sidebar: rect(".sidebar"),
      main: rect(".main-content"),
      topbar: rect(".desktop-topbar"),
      mountain: {
        ...rect(".mountain-backdrop"),
        backgroundImageUsesEmbeddedAsset: mountainStyle.backgroundImage.includes("data:image/png;base64,"),
        backgroundPosition,
        backgroundSize,
        verticalPositionPercent,
        visibleSourceTop: cropTop / renderedImageHeight,
        visibleSourceBottom: (cropTop + mountainBox.height) / renderedImageHeight,
      },
      grid: rect(".widget-grid"),
    };
  }, mountainSourceDimensions);
}

function assertDesktopFrameAlignment(frame, densityScale, baseline, label) {
  const contentSpace = expectedDesktopContentSpace(frame.clientWidth);
  near(frame.contentSpace, contentSpace, `${label}: reserved space follows the 75% desktop growth model`, 1);
  near(frame.densityUnit, densityScale, `${label}: content density token is scoped to the dashboard`, 0.01);
  near(frame.shell.left, 0, `${label}: full-width shell starts at the viewport edge`, 1);
  near(frame.shell.right, frame.clientWidth, `${label}: full-width shell reaches the viewport edge`, 1);
  near(frame.sidebar.left, baseline.sidebarLeft, `${label}: fixed sidebar keeps its laptop-baseline inset`, 1.5);
  near(frame.sidebar.width, baseline.sidebarWidth, `${label}: fixed sidebar keeps its laptop-baseline width`, 1.5);
  const baselineGutterIncrease = baseline.pageGutter * (1 - 1 / 1.05);
  const originalReservedWidthAtBaseline = baseline.clientWidth - baseline.dashboardContentWidth - 2 * baselineGutterIncrease;
  const expectedGutter = (contentSpace + originalReservedWidthAtBaseline * densityScale - frame.sidebar.right) / 2 * 1.05;
  near(frame.contentGutter, expectedGutter, `${label}: CSS gutter follows the centered dashboard width`, 2);
  near(frame.mainPaddingRight, expectedGutter, `${label}: dashboard reserves the computed right gutter`, 2);
  near(frame.main.left, frame.sidebar.right + expectedGutter, `${label}: dashboard starts after the matching left gutter`, 2);
  near(frame.main.right, frame.clientWidth, `${label}: main shell reaches the viewport edge`, 2);
  near(frame.topbar.left, baseline.topbarLeft, `${label}: top bar keeps its original shell left edge`, 1.5);
  near(frame.topbar.right, frame.clientWidth - baseline.topbarRightGutter, `${label}: top bar keeps its original shell right gutter`, 1.5);
  near(frame.topbar.height, baseline.topbarHeight, `${label}: top bar height remains fixed with viewport growth`, 1.5);
  near(frame.mountain.left, baseline.mountainLeft, `${label}: mountain backdrop keeps its original shell left edge`, 1.5);
  near(frame.mountain.right, frame.clientWidth, `${label}: mountain backdrop remains full width to the viewport edge`, 2);
  near(frame.mountain.height, (70 + 80 * densityScale) * 1.125, `${label}: mountain backdrop grows with desktop content density`, 1.5);
  assert.ok(frame.mountain.backgroundImageUsesEmbeddedAsset, `${label}: browser fixture uses the real embedded mountain artwork`);
  assert.equal(frame.mountain.backgroundSize, "cover", `${label}: mountain artwork keeps its cover sizing`);
  assert.equal(frame.mountain.backgroundPosition, "100% 52%", `${label}: mountain artwork uses the approved right-aligned 52% vertical position`);
  assert.ok(Number.isFinite(frame.mountain.verticalPositionPercent), `${label}: mountain vertical position is measurable (${frame.mountain.backgroundPosition})`);
  assert.ok(frame.mountain.visibleSourceTop <= 0.43, `${label}: banner crop keeps the highest peak visible (source y=${frame.mountain.visibleSourceTop.toFixed(3)})`);
  assert.ok(frame.mountain.visibleSourceBottom >= 0.62, `${label}: banner crop keeps the moon fully visible (source bottom y=${frame.mountain.visibleSourceBottom.toFixed(3)})`);
  near(frame.grid.left, frame.main.left, `${label}: widget grid starts at the dashboard content edge`, 2);
  near(frame.grid.right, frame.main.right - frame.mainPaddingRight, `${label}: widget grid ends at the inset content edge`, 2);
  near(frame.grid.left - frame.sidebar.right, frame.clientWidth - frame.grid.right, `${label}: widget grid has equal gaps from the fixed sidebar and viewport edge`, 2);
}

function assertDesktopDensityMetrics(metrics, baseline, scale, label, fixedShellKeys, contentDensityKeys, footprintSizes = []) {
  for (const key of fixedShellKeys) {
    near(metrics[key], baseline[key], `${label}: ${key} stays at the fixed shell baseline`, 2);
  }
  for (const key of contentDensityKeys) {
    const tolerance = ["greetingHeight", "todayPanelHeight"].includes(key)
      ? Math.max(5, baseline[key] * scale * 0.015)
      : key === "todayMenuHeight" ? 5 : 3;
    near(metrics[key], baseline[key] * scale, `${label}: ${key} scales with the 1440px content baseline`, tolerance);
  }
  for (const size of footprintSizes) {
    const expected = baseline.cardFootprints[size];
    assert.ok(expected, `${label}: 1440px baseline includes the ${size} widget footprint`);
    near(metrics.cardFootprints[size].width, expected.width * scale, `${label}: ${size} width scales with the 1440px content baseline`, Math.max(3, expected.width * scale * 0.015));
    near(metrics.cardFootprints[size].height, expected.height * scale, `${label}: ${size} height scales with the 1440px content baseline`, Math.max(3, expected.height * scale * 0.015));
  }
}

async function assertSidebarReachability(page, width, height, label) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(320);
  const reachability = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar");
    const settings = [...sidebar.querySelectorAll(".nav-item")].find((item) => item.textContent.includes("Settings"));
    const profile = sidebar.querySelector(".profile-card");
    if (!settings || !profile) throw new Error("The actual sidebar must include Settings and the profile link");
    const makeVisible = (target) => {
      target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const rect = target.getBoundingClientRect();
      const container = sidebar.getBoundingClientRect();
      return {
        visible: rect.width > 0 && rect.height > 0 && rect.top >= container.top - 1 && rect.bottom <= container.bottom + 1,
        top: rect.top,
        bottom: rect.bottom,
        sidebarTop: container.top,
        sidebarBottom: container.bottom,
        scrollTop: sidebar.scrollTop,
      };
    };
    const settingsResult = makeVisible(settings);
    const profileResult = makeVisible(profile);
    const report = { settings: settingsResult, profile: profileResult, scrollHeight: sidebar.scrollHeight, clientHeight: sidebar.clientHeight };
    sidebar.scrollTop = 0;
    return report;
  });
  assert.ok(reachability.settings.visible, `${label}: Settings remains reachable inside the real sidebar: ${JSON.stringify(reachability)}`);
  assert.ok(reachability.profile.visible, `${label}: profile remains reachable inside the real sidebar: ${JSON.stringify(reachability)}`);
  return reachability;
}

async function assertExperimentalMenuFitsShortViewport(page, collapsed) {
  const state = collapsed ? "collapsed sidebar" : "expanded sidebar";
  await page.setViewportSize({ width: 1920, height: 300 });
  const before = await page.evaluate((isCollapsed) => {
    const app = document.querySelector("#app");
    app.classList.toggle("sidebar-collapsed", isCollapsed);
    const sidebar = document.querySelector(".sidebar");
    const trigger = sidebar.querySelector(".experimental-trigger");
    trigger.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
    const menu = document.createElement("div");
    menu.className = "experimental-menu";
    menu.id = "experimental-options-browser-check";
    menu.innerHTML = '<p>Fake preview data</p><button type="button"><span><strong>Clear</strong><small>0 classes · 0 tasks</small></span></button><button type="button"><span><strong>Light</strong><small>2 classes · 6 tasks</small></span></button><button type="button"><span><strong>Medium</strong><small>4 classes · 14 tasks</small></span></button><button type="button"><span><strong>Packed</strong><small>6 classes · 28 tasks</small></span></button><button type="button"><strong>Onboard test</strong></button><small>Your saved workspace stays untouched.</small>';
    trigger.closest(".experimental-control").append(menu);
    return {
      trigger: (() => { const rect = trigger.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; })(),
      sidebar: (() => { const rect = sidebar.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, scrollTop: sidebar.scrollTop }; })(),
      supportsAnchor: CSS.supports("anchor-name", "--experimental-trigger-anchor"),
      supportsPositionTry: CSS.supports("position-try-fallbacks", "flip-block, --experimental-viewport"),
    };
  }, collapsed);
  await settleLayout(page);
  const report = await page.evaluate(() => {
    const menu = document.querySelector("#experimental-options-browser-check");
    const rect = menu.getBoundingClientRect();
    const first = menu.querySelector("button");
    const last = [...menu.querySelectorAll("button")].at(-1);
    const firstRect = first.getBoundingClientRect();
    const styles = getComputedStyle(menu);
    const beforeScroll = {
      firstVisible: firstRect.top >= rect.top - 1 && firstRect.bottom <= rect.bottom + 1,
      firstHit: document.elementFromPoint(firstRect.left + firstRect.width / 2, firstRect.top + firstRect.height / 2)?.closest("button") === first,
    };
    menu.scrollTop = menu.scrollHeight;
    const lastRect = last.getBoundingClientRect();
    const afterScroll = {
      lastVisible: lastRect.top >= rect.top - 1 && lastRect.bottom <= rect.bottom + 1,
      lastHit: document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2)?.closest("button") === last,
      scrollTop: menu.scrollTop,
    };
    return {
      bounds: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      overflowY: styles.overflowY,
      beforeScroll,
      afterScroll,
    };
  });
  assert.ok(report.bounds.left >= 0 && report.bounds.right <= report.viewport.width, `1920×300 ${state} Experimental menu stays horizontally in the viewport: ${JSON.stringify({ before, ...report })}`);
  assert.ok(report.bounds.top >= 0 && report.bounds.bottom <= report.viewport.height, `1920×300 ${state} Experimental menu stays vertically in the viewport: ${JSON.stringify({ before, ...report })}`);
  assert.ok(report.bounds.height <= report.viewport.height, `1920×300 ${state} Experimental menu does not exceed viewport height: ${JSON.stringify({ before, ...report })}`);
  assert.ok(report.scrollHeight > report.clientHeight && ["auto", "scroll"].includes(report.overflowY), `1920×300 ${state} Experimental menu scrolls when its full content exceeds the viewport: ${JSON.stringify({ before, ...report })}`);
  assert.ok(report.beforeScroll.firstVisible && report.beforeScroll.firstHit, `1920×300 ${state} Experimental menu first option is visible and hit-testable: ${JSON.stringify({ before, ...report })}`);
  assert.ok(report.afterScroll.lastVisible && report.afterScroll.lastHit, `1920×300 ${state} Experimental menu final action remains reachable by scrolling: ${JSON.stringify({ before, ...report })}`);
  await page.evaluate((isCollapsed) => {
    document.querySelector("#experimental-options-browser-check")?.remove();
    document.querySelector("#app").classList.toggle("sidebar-collapsed", isCollapsed);
    document.querySelector(".sidebar").scrollTop = 0;
  }, false);
  return { state, ...before, ...report };
}

await mkdir(screenshotDir, { recursive: true });
const launchOptions = {
  headless: true,
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: ["--no-sandbox", "--disable-features=OverlayScrollbar"],
};
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = process.env.BROWSER_CHANNEL ?? "chrome";
const browser = await playwright.chromium.launch(launchOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  await page.setContent(documentHtml, { waitUntil: "load" });
  await page.evaluate(({ calculateWidgetUnitSource, updateBoardUnitSource, calculateWidgetPlacementsSource, updateCardPlacementsSource }) => {
    const calculateWidgetUnit = new Function(`return (${calculateWidgetUnitSource})`)();
    // Extract the production arrow callback body and execute it as a bound
    // function so its real `this.grid.current` reads this browser fixture.
    const instrumentedUpdaterSource = updateBoardUnitSource.replace("const unit = calculateWidgetUnit({", "window.__productionUnitInput = { gridWidth, gap, columns, computedWidth, rectWidth }; const unit = calculateWidgetUnit({");
    const updaterBody = instrumentedUpdaterSource.slice(instrumentedUpdaterSource.indexOf("{") + 1, instrumentedUpdaterSource.lastIndexOf("}"));
    const updateBoardUnit = new Function("calculateWidgetUnit", `return function () {${updaterBody}}`)(calculateWidgetUnit);
    const calculateWidgetPlacements = new Function(`return (${calculateWidgetPlacementsSource})`)();
    const placementBody = updateCardPlacementsSource.slice(updateCardPlacementsSource.indexOf("{") + 1, updateCardPlacementsSource.lastIndexOf("}"));
    const updateCardPlacements = new Function("calculateWidgetPlacements", `return function () {${placementBody}}`)(calculateWidgetPlacements);
    const context = { grid: { current: null } };
    window.__updateProductionBoardUnit = () => {
      const grid = document.querySelector(".widget-grid");
      context.grid.current = grid;
      updateBoardUnit.call(context);
      const style = getComputedStyle(grid);
      window.__lastBoardUnitMeasurement = {
        ...window.__productionUnitInput,
        unit: Number.parseFloat(style.getPropertyValue("--widget-unit")),
      };
      return window.__lastBoardUnitMeasurement;
    };
    window.__updateProductionCardPlacements = () => {
      context.grid.current = document.querySelector(".widget-grid");
      updateCardPlacements.call(context);
    };
  }, { calculateWidgetUnitSource, updateBoardUnitSource, calculateWidgetPlacementsSource, updateCardPlacementsSource });
  await page.evaluate(() => document.fonts.ready);
  const sizeSequence = ["mini", "small", "medium", "medium-vertical", "large"];
  const sizeLabel = { mini: "Mini", small: "Small", medium: "Medium horizontal", "medium-vertical": "Medium vertical", large: "Large" };
  let layout = await snapshotLayout(page);
  assert.ok(layout.workspaceWidth > 960, "wide fixture should exceed 60rem, got " + layout.workspaceWidth + "px");
  assertGridLayout(layout, "wide workspace");
  assert.equal(layout.cards.length, 18, "the browser fixture uses all 18 actual production widgets");
  assert.equal(new Set(layout.cards.map((card) => card.type)).size, 18, "each production widget type is represented");
  const gridDisplay = await page.locator(".widget-grid").evaluate((grid) => getComputedStyle(grid).display);
  assert.equal(gridDisplay, "grid", "production widget layout uses CSS grid");
  assert.equal((await readGridGaps(page)).columns, 4, "wide workspace has four small-widget columns");

  // Isolate eight actual widgets so the small-card desktop and phone grids can
  // be counted without other spans backfilling holes.
  const representativeTypes = [
    "widget-daily-goal", "widget-today", "widget-pomodoro", "widget-task-completion",
    "widget-red-alerts", "widget-mini-calendar", "widget-notes", "widget-exams",
  ];
  await page.locator(".widget-grid").evaluate((grid, types) => {
    const originalNodes = [...grid.children];
    const cards = types.map((type) => grid.querySelector(`.widget-card.${type}`));
    if (cards.some((card) => !card)) throw new Error("The actual Workspace fixture is missing a requested representative widget type");
    window.__responsiveOriginalNodes = originalNodes;
    window.__responsiveOriginalSizes = new Map(originalNodes.filter((node) => node.matches?.(".widget-card")).map((node) => [node, node.dataset.size]));
    grid.replaceChildren(...cards);
    for (const card of cards) card.dataset.size = "small";
    return cards.map((card) => card.dataset.widgetId);
  }, representativeTypes);
  const responsiveReports = [];
  for (const width of [320, 390, 600, 601, 768, 821, 1024, 1160, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => {
      document.querySelector("#app").classList.remove("sidebar-collapsed");
      window.scrollTo(0, 0);
    });
    layout = await snapshotLayout(page);
    const expectedColumns = width <= 600 ? 2 : 4;
    const label = `${width}px ${width <= 600 ? "phone" : width <= 820 ? "tablet" : "desktop"}`;
    const metrics = assertResponsiveSmallLayout(layout, expectedColumns, label);
    assertGridLayout(layout, label);
    const gridMetrics = await readGridGaps(page);
    assert.equal(gridMetrics.columns, expectedColumns, `${label}: production CSS exposes ${expectedColumns} small-widget columns`);
    const unitMeasurement = await page.evaluate(() => window.__lastBoardUnitMeasurement);
    assert.equal(unitMeasurement.columns, expectedColumns, `${label}: the production sizing helper receives the CSS column metadata`);
    near(metrics.width, unitMeasurement.unit, `${label}: square widget width matches the production unit`, 2);
    assert.ok(layout.scrollWidth <= width, `${label}: document has no horizontal overflow (${layout.scrollWidth}px > ${width}px)`);
    assert.ok(layout.grid.x >= -1 && layout.grid.right <= width + 1, `${label}: responsive grid remains inside the viewport`);
    responsiveReports.push({ viewportWidth: width, expectedColumns, ...metrics, unit: unitMeasurement.unit, scrollWidth: layout.scrollWidth });

    if (width >= 821) {
      const expandedIds = layout.cards.map((card) => card.id);
      if (width === 1440) await page.locator(".widget-grid").screenshot({ path: resolve(screenshotDir, "desktop-small-4x2-expanded.png") });
      await page.locator(".sidebar-toggle").click();
      await page.waitForTimeout(300);
      const collapsed = await snapshotLayout(page);
      const collapsedMetrics = assertResponsiveSmallLayout(collapsed, 4, `${width}px collapsed sidebar`);
      assertGridLayout(collapsed, `${width}px collapsed sidebar`);
      assert.deepEqual(collapsed.cards.map((card) => card.id), expandedIds, `${width}px sidebar toggle preserves widget order`);
      assert.ok(collapsed.workspaceWidth > layout.workspaceWidth, `${width}px collapsed sidebar releases workspace width`);
      assert.ok(collapsed.grid.width > layout.grid.width, `${width}px collapsed sidebar expands the widget grid to use released content width`);
      assert.ok(collapsedMetrics.width > metrics.width, `${width}px collapsed sidebar increases the width-driven square unit`);
      assert.equal((await readGridGaps(page)).columns, 4, `${width}px collapsed sidebar preserves four small-widget columns`);
      assert.ok(collapsed.scrollWidth <= width, `${width}px collapsed sidebar keeps the document inside the viewport`);
      responsiveReports.push({ viewportWidth: width, sidebar: "collapsed", columns: 4, ...collapsedMetrics, scrollWidth: collapsed.scrollWidth });
      if (width === 1440) await page.locator(".widget-grid").screenshot({ path: resolve(screenshotDir, "desktop-small-4x2-collapsed.png") });
      await page.locator(".sidebar-toggle").click();
      await page.waitForTimeout(300);
      const restored = await snapshotLayout(page);
      assertResponsiveSmallLayout(restored, 4, `${width}px restored sidebar`);
      assert.deepEqual(restored.cards.map((card) => card.id), expandedIds, `${width}px restoring sidebar preserves widget order`);
    }
    if (width === 390) await page.locator(".widget-grid").screenshot({ path: resolve(screenshotDir, "phone-small-2x4.png") });
  }

  // Board width and square units stay fixed as viewport height or earlier page
  // content changes; the resulting grid can extend below the viewport.
  await page.setViewportSize({ width: 1920, height: 640 });
  await page.evaluate(() => { document.querySelector("#app").classList.remove("sidebar-collapsed"); window.scrollTo(0, 0); });
  const shortLayout = await snapshotLayout(page);
  const shortMeasure = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  const shortMetrics = assertResponsiveSmallLayout(shortLayout, 4, "1920px short viewport");
  near(shortMetrics.width, shortMeasure.unit, "short viewport square width matches the production sizing helper", 2);
  assertGridLayout(shortLayout, "1920px short viewport");
  await page.locator(".home-today-panel").evaluate((panel) => { panel.style.minHeight = "600px"; });
  const tallHeaderLayout = await snapshotLayout(page);
  const tallHeaderMeasure = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  const tallHeaderMetrics = assertResponsiveSmallLayout(tallHeaderLayout, 4, "taller Today panel");
  near(tallHeaderMetrics.width, shortMetrics.width, "a taller Today panel does not resize square cards", 2);
  near(tallHeaderMeasure.unit, shortMeasure.unit, "a taller Today panel leaves the width-based unit unchanged", 2);
  near(tallHeaderLayout.grid.width, shortLayout.grid.width, "a taller Today panel leaves the grid width unchanged", 1.5);
  assert.ok(tallHeaderLayout.grid.y > shortLayout.grid.y, "a taller Today panel moves the grid down the page");
  assertGridLayout(tallHeaderLayout, "taller Today panel");
  await page.locator(".home-today-panel").evaluate((panel) => { panel.style.minHeight = ""; });
  await page.setViewportSize({ width: 1920, height: 1400 });
  const tallLayout = await snapshotLayout(page);
  const tallMeasure = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  const tallMetrics = assertResponsiveSmallLayout(tallLayout, 4, "1920px tall viewport");
  near(tallMetrics.width, shortMetrics.width, "a taller viewport keeps square cards at the same width", 2);
  near(tallMeasure.unit, shortMeasure.unit, "a taller viewport leaves the width-based unit unchanged", 2);
  near(tallLayout.grid.width, shortLayout.grid.width, "a taller viewport leaves the grid width unchanged", 1.5);
  assertGridLayout(tallLayout, "1920px tall viewport");

  await page.setViewportSize({ width: 1920, height: 300 });
  const veryShortLayout = await snapshotLayout(page);
  const veryShortMeasure = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  const veryShortMetrics = assertResponsiveSmallLayout(veryShortLayout, 4, "1920px very short viewport");
  near(veryShortMetrics.width, shortMetrics.width, "a very short viewport keeps square cards at the same width", 2);
  near(veryShortMeasure.unit, shortMeasure.unit, "a very short viewport leaves the width-based unit unchanged", 2);
  near(veryShortLayout.grid.width, shortLayout.grid.width, "a very short viewport leaves the grid width unchanged", 1.5);
  assert.ok(veryShortLayout.grid.bottom > 300, "the full-width widget grid can extend below a short viewport");
  assertGridLayout(veryShortLayout, "1920px very short viewport");
  const shortSidebarReports = [
    await assertSidebarReachability(page, 1920, 640, "1920×640 short desktop"),
    await assertSidebarReachability(page, 1920, 300, "1920×300 very short desktop"),
  ];
  const experimentalMenuReports = [
    await assertExperimentalMenuFitsShortViewport(page, false),
    await assertExperimentalMenuFitsShortViewport(page, true),
  ];

  // Restore the complete 18-widget production fixture before the existing size,
  // content overflow, appearance override, reorder, and menu stress checks.
  await page.locator(".widget-grid").evaluate((grid) => {
    const sizes = window.__responsiveOriginalSizes;
    const nodes = window.__responsiveOriginalNodes;
    for (const [node, size] of sizes) node.dataset.size = size;
    grid.replaceChildren(...nodes);
    delete window.__responsiveOriginalSizes;
    delete window.__responsiveOriginalNodes;
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.evaluate(() => { document.querySelector("#app").classList.remove("sidebar-collapsed"); window.scrollTo(0, 0); });
  layout = await snapshotLayout(page);
  assert.equal(layout.cards.length, 18, "restoring responsive probe returns all 18 production widget types");

  // Compare desktop density at a common viewport aspect ratio. The screenshots
  // use the requested laptop, monitor, and 4K viewport sizes; the metric reads
  // use a consistent 16:10 ratio so height does not affect the comparison.
  await page.evaluate((appearance) => {
    const menu = document.createElement("div");
    menu.className = "popover widget-menu today-section-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = '<button type="button" role="menuitem"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"></svg>Edit section</button><button type="button" role="menuitem"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"></svg>Hide section</button>';
    for (const [name, value] of Object.entries(appearance)) menu.style.setProperty(name, value);
    Object.assign(menu.style, { position: "fixed", left: "0", top: "0", visibility: "hidden", pointerEvents: "none" });
    document.querySelector("#app").append(menu);
    window.__densityMenu = menu;
  }, defaultDensityAppearance);
  const densityWidths = [1440, 1901, 2555, 3840];
  const screenshotNames = {
    1440: "desktop-density-laptop-1440x900.png",
    1901: "desktop-density-monitor-1901x867.png",
    2555: "desktop-density-wide-monitor-2555x1266.png",
    3840: "desktop-density-4k-3840x2160.png",
  };
  const screenshotHeights = { 1440: 900, 1901: 867, 2555: 1266, 3840: 2160 };
  const densitySnapshots = [];
  const collapsedDensitySnapshots = [];
  let densityBaseline = null;
  let collapsedDensityBaseline = null;
  let expandedDesktopFrameBaseline = null;
  let collapsedDesktopFrameBaseline = null;
  const desktopFrameReports = [];
  const fixedShellKeys = [
    "sidebarWidth", "brandTitleFontSize", "sidebarToggleWidth", "sidebarToggleHeight", "navIconWidth", "navIconHeight", "topbarHeight", "searchHeight", "searchFontSize",
  ];
  const contentDensityKeys = [
    "greetingHeight", "greetingTitleFontSize", "greetingSubtitleFontSize", "todayTitleFontSize", "todayPanelHeight",
    "widgetGapColumn", "widgetGapRow", "cardFontSize", "cardPadding", "widgetTitleFontSize", "widgetIconWidth", "widgetIconHeight",
    "todayMenuWidth", "todayMenuHeight", "todayMenuFontSize", "todayMenuItemHeight",
  ];
  for (const width of densityWidths) {
    const height = Math.round(width * 900 / 1440);
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.querySelector("#app").classList.remove("sidebar-collapsed"); window.scrollTo(0, 0); });
    await page.waitForTimeout(320);
    const densityLayout = await snapshotLayout(page);
    assertGridLayout(densityLayout, `${width}px desktop density`);
    assert.equal(densityLayout.cards.length, 18, `${width}px desktop density uses every production widget`);
    assert.ok(densityLayout.scrollWidth <= width, `${width}px desktop density has no horizontal overflow`);
    const metrics = await readDesktopDensityMetrics(page);
    assert.ok(metrics.todayMenuWidth > 0 && metrics.todayMenuHeight > 0, `${width}px Today menu has measurable desktop dimensions`);
    const frame = await readDesktopFrameMetrics(page);
    const scale = expectedDesktopDensityScale(frame.clientWidth);
    if (!expandedDesktopFrameBaseline) expandedDesktopFrameBaseline = desktopFrameBaseline(frame);
    assertDesktopFrameAlignment(frame, scale, expandedDesktopFrameBaseline, `${width}px expanded sidebar`);
    desktopFrameReports.push({ viewportWidth: width, sidebar: "expanded", ...frame });
    if (!densityBaseline) densityBaseline = metrics;
    else assertDesktopDensityMetrics(metrics, densityBaseline, scale, `${width}px expanded sidebar`, fixedShellKeys, contentDensityKeys, Object.keys(densityBaseline.cardFootprints));
    densitySnapshots.push({ viewportWidth: width, scale, ...metrics });
    await page.locator(".sidebar-toggle").click();
    await page.waitForTimeout(320);
    const collapsedMetrics = await readDesktopDensityMetrics(page);
    if (!collapsedDensityBaseline) collapsedDensityBaseline = collapsedMetrics;
    else assertDesktopDensityMetrics(collapsedMetrics, collapsedDensityBaseline, scale, `${width}px collapsed sidebar`, fixedShellKeys, contentDensityKeys, Object.keys(collapsedDensityBaseline.cardFootprints));
    collapsedDensitySnapshots.push({ viewportWidth: width, scale, ...collapsedMetrics });
    const collapsedFrame = await readDesktopFrameMetrics(page);
    if (!collapsedDesktopFrameBaseline) collapsedDesktopFrameBaseline = desktopFrameBaseline(collapsedFrame);
    assertDesktopFrameAlignment(collapsedFrame, scale, collapsedDesktopFrameBaseline, `${width}px collapsed sidebar`);
    desktopFrameReports.push({ viewportWidth: width, sidebar: "collapsed", ...collapsedFrame });
    await page.locator(".sidebar-toggle").click();
    await page.waitForTimeout(320);
    await page.setViewportSize({ width, height: screenshotHeights[width] });
    await page.waitForTimeout(320);
    await page.screenshot({ path: resolve(screenshotDir, screenshotNames[width]) });
  }

  // Apply non-default values through the real typed appearance serializer and
  // check every widget footprint plus the Today menu at each desktop density.
  const densitySizes = ["mini", "small", "medium", "medium-vertical", "large"];
  await page.evaluate(({ appearance, sizes }) => {
    const grid = document.querySelector(".widget-grid");
    const nodes = [...grid.children];
    const cards = nodes.filter((node) => node.matches?.(".widget-card"));
    const menu = window.__densityMenu;
    window.__densityOriginalState = {
      nodes,
      gridStyle: grid.getAttribute("style"),
      menuStyle: menu.getAttribute("style"),
      cards: cards.map((node) => ({ node, size: node.dataset.size, style: node.getAttribute("style") })),
    };
    const probes = cards.slice(0, sizes.length);
    if (probes.length !== sizes.length) throw new Error("The actual Workspace fixture needs one card for each widget footprint");
    grid.replaceChildren(...probes);
    for (const [index, card] of probes.entries()) {
      card.dataset.size = sizes[index];
      for (const [name, value] of Object.entries(appearance)) card.style.setProperty(name, value);
    }
    for (const [name, value] of Object.entries(appearance)) grid.style.setProperty(name, value);
    for (const [name, value] of Object.entries(appearance)) menu.style.setProperty(name, value);
  }, { appearance: densityAppearance, sizes: densitySizes });
  let customDensityBaseline = null;
  let customDensityCollapsedBaseline = null;
  const customDensitySnapshots = [];
  const customDensityCollapsedSnapshots = [];
  for (const width of densityWidths) {
    const height = Math.round(width * 900 / 1440);
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.querySelector("#app").classList.remove("sidebar-collapsed"); window.scrollTo(0, 0); });
    await page.waitForTimeout(320);
    const customLayout = await snapshotLayout(page);
    assertGridLayout(customLayout, `${width}px custom appearance density`);
    assert.equal(customLayout.cards.length, densitySizes.length, `${width}px custom appearance fixture has all five widget footprints`);
    const metrics = await readDesktopDensityMetrics(page);
    assert.deepEqual(Object.keys(metrics.cardFootprints).sort(), [...densitySizes].sort(), `${width}px custom appearance fixture exposes all five footprints`);
    const frame = await readDesktopFrameMetrics(page);
    const scale = expectedDesktopDensityScale(frame.clientWidth);
    if (!customDensityBaseline) customDensityBaseline = metrics;
    else assertDesktopDensityMetrics(metrics, customDensityBaseline, scale, `${width}px expanded sidebar custom appearance`, fixedShellKeys, contentDensityKeys, densitySizes);
    customDensitySnapshots.push({ viewportWidth: width, scale, ...metrics });

    await page.locator(".sidebar-toggle").click();
    await page.waitForTimeout(320);
    const collapsedMetrics = await readDesktopDensityMetrics(page);
    if (!customDensityCollapsedBaseline) customDensityCollapsedBaseline = collapsedMetrics;
    else assertDesktopDensityMetrics(collapsedMetrics, customDensityCollapsedBaseline, scale, `${width}px collapsed sidebar custom appearance`, fixedShellKeys, contentDensityKeys, densitySizes);
    customDensityCollapsedSnapshots.push({ viewportWidth: width, scale, ...collapsedMetrics });
    const collapsedFrame = await readDesktopFrameMetrics(page);
    assertDesktopFrameAlignment(collapsedFrame, scale, collapsedDesktopFrameBaseline, `${width}px collapsed sidebar custom appearance`);
    desktopFrameReports.push({ viewportWidth: width, sidebar: "collapsed custom appearance", ...collapsedFrame });
    await page.locator(".sidebar-toggle").click();
    await page.waitForTimeout(320);
  }
  await page.evaluate(() => {
    const grid = document.querySelector(".widget-grid");
    const state = window.__densityOriginalState;
    for (const { node, size, style } of state.cards) {
      node.dataset.size = size;
      if (style === null) node.removeAttribute("style"); else node.setAttribute("style", style);
    }
    grid.replaceChildren(...state.nodes);
    if (state.gridStyle === null) grid.removeAttribute("style"); else grid.setAttribute("style", state.gridStyle);
    const menu = window.__densityMenu;
    if (state.menuStyle === null) menu.removeAttribute("style"); else menu.setAttribute("style", state.menuStyle);
    menu.remove();
    delete window.__densityOriginalState;
    delete window.__densityMenu;
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.evaluate(() => { document.querySelector("#app").classList.remove("sidebar-collapsed"); window.scrollTo(0, 0); });
  layout = await snapshotLayout(page);
  assert.equal(layout.cards.length, 18, "restoring density probes leaves all production widgets in their original order");

  if (process.env.DENSITY_ONLY === "1") {
    console.log(JSON.stringify({
      result: "PASS",
      fixture: "actual Workspace markup and production CSS with all 18 widget types",
      screenshots: densityWidths.map((width) => `.vinext/verify-widget-layout/${screenshotNames[width]}`),
      desktopDensity: {
        commonAspectRatio: "16:10",
        normalizedWidths: densityWidths,
        defaultAppearance: densitySnapshots,
        defaultAppearanceCollapsed: collapsedDensitySnapshots,
        customAppearance: customDensitySnapshots,
        customAppearanceCollapsed: customDensityCollapsedSnapshots,
        customValues: { gap: 18, padding: 18, fontSize: 18, titleSize: 20, iconSize: 32 },
      },
      desktopFrameAlignment: desktopFrameReports,
      responsive: responsiveReports.map(({ viewportWidth, expectedColumns, sidebar, columns, rows, perRow, width, height, unit, scrollWidth }) => ({ viewportWidth, expectedColumns, sidebar, columns, rows, perRow, width, height, unit, scrollWidth })),
      shortDesktopSidebar: shortSidebarReports,
      shortDesktopExperimentalMenu: experimentalMenuReports,
    }, null, 2));
  } else {

  // Capture the requested edge-sharing composition: a large square at left,
  // a horizontal medium at upper right, then a small with two minis below.
  await page.locator(".widget-grid").evaluate((grid) => {
    const originals = [...grid.children];
    const cards = originals.filter((node) => node.matches?.(".widget-card")).slice(0, 5);
    window.__compositionOriginalNodes = originals;
    window.__compositionOriginalSizes = new Map(cards.map((node) => [node, node.dataset.size]));
    grid.replaceChildren(...cards);
    ["large", "medium", "small", "mini", "mini"].forEach((size, index) => { cards[index].dataset.size = size; });
  });
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "requested mixed-size composition");
  const bySize = new Map(layout.cards.map((card) => [card.size, card]));
  const large = bySize.get("large"), medium = bySize.get("medium"), small = bySize.get("small");
  const minis = layout.cards.filter((card) => card.size === "mini").sort((a, b) => a.y - b.y);
  const compositionGaps = await readGridGaps(page);
  near(large.x, layout.grid.x, "composition large widget starts at the grid's left edge", 2);
  near(medium.x, large.right + compositionGaps.column, "composition medium widget sits immediately right of large", 2);
  near(medium.y, large.y, "composition medium aligns to the large widget's top edge", 2);
  near(medium.right, layout.grid.right, "composition medium reaches the grid's right edge", 2);
  near(small.x, medium.x, "composition small widget shares the medium's right column", 2);
  near(small.y, medium.bottom + compositionGaps.row, "composition small widget sits directly below medium", 2);
  near(minis[0].x, small.right + compositionGaps.column, "first mini sits directly right of the lower small", 2);
  near(minis[0].y, small.y, "first mini aligns to the lower small's top edge", 2);
  near(minis[1].x, minis[0].x, "second mini stays in the same rightmost column", 2);
  near(minis[1].y, minis[0].bottom + compositionGaps.row, "second mini sits directly below first mini", 2);
  const compositionFootprints = assertBlockRatios(layout, compositionGaps, "requested mixed-size composition", false);
  await page.locator(".widget-grid").screenshot({ path: resolve(screenshotDir, "composition-large-medium-small-minis.png") });
  await page.locator(".widget-grid").evaluate((grid) => {
    const originals = window.__compositionOriginalNodes;
    for (const [node, size] of window.__compositionOriginalSizes) node.dataset.size = size;
    grid.replaceChildren(...originals);
    delete window.__compositionOriginalNodes;
    delete window.__compositionOriginalSizes;
  });

  // Regression for the half-row offset that appeared after two small cards,
  // a vertical mini pair, and two wide cards. Non-mini cards must begin on
  // full small-row boundaries even when earlier mini cards leave half rows.
  const rowAlignmentSizes = ["small", "small", "mini", "mini", "medium", "medium"];
  await page.locator(".widget-grid").evaluate((grid, sizes) => {
    const originals = [...grid.children];
    const cards = originals.filter((node) => node.matches?.(".widget-card")).slice(0, sizes.length);
    window.__rowAlignmentOriginalNodes = originals;
    window.__rowAlignmentOriginalSizes = new Map(cards.map((node) => [node, node.dataset.size]));
    grid.replaceChildren(...cards);
    cards.forEach((card, index) => { card.dataset.size = sizes[index]; });
  }, rowAlignmentSizes);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "small-small-mini-pair-medium-medium row alignment regression");
  const rowAlignmentGaps = await readGridGaps(page);
  const rowAlignmentCards = Object.fromEntries(rowAlignmentSizes.map((size) => [size, layout.cards.filter((card) => card.size === size)]));
  assert.equal(rowAlignmentCards.small.length, 2, "row alignment fixture contains two small cards");
  assert.equal(rowAlignmentCards.mini.length, 2, "row alignment fixture contains a vertical mini pair");
  assert.equal(rowAlignmentCards.medium.length, 2, "row alignment fixture contains two medium cards");
  const rowAlignmentSmall = rowAlignmentCards.small[0];
  const rowAlignmentMediums = rowAlignmentCards.medium;
  const rowAlignmentMinis = rowAlignmentCards.mini.sort((left, right) => left.y - right.y);
  const fullSmallRowPitch = rowAlignmentSmall.height + rowAlignmentGaps.row;
  const rowAlignmentSmallRows = rowAlignmentCards.small.map((card) => Math.round((card.y - layout.grid.y) / fullSmallRowPitch));
  for (const card of [...rowAlignmentCards.small, ...rowAlignmentMediums]) {
    const rowOffset = (card.y - layout.grid.y) / fullSmallRowPitch;
    near(rowOffset, Math.round(rowOffset), `${card.size} ${card.id} starts on a full small-row boundary`);
  }
  near(rowAlignmentCards.small[1].y, rowAlignmentSmall.y, "the small cards share one full row");
  near(rowAlignmentMinis[0].x, rowAlignmentMinis[1].x, "paired minis stay in the same small-cell column");
  near(rowAlignmentMinis[0].y, rowAlignmentSmall.y, "the mini pair starts within the first small row");
  near(rowAlignmentMinis[1].y, rowAlignmentMinis[0].bottom + rowAlignmentGaps.row, "the mini pair stacks vertically with one grid gap");
  near(rowAlignmentMediums[0].y, rowAlignmentMediums[1].y, "the medium cards share one full small row");
  await page.locator(".widget-grid").screenshot({ path: resolve(screenshotDir, "composition-small-small-mini-pair-mediums.png") });
  await page.locator(".widget-grid").evaluate((grid) => {
    for (const [node, size] of window.__rowAlignmentOriginalSizes) node.dataset.size = size;
    grid.replaceChildren(...window.__rowAlignmentOriginalNodes);
    delete window.__rowAlignmentOriginalNodes;
    delete window.__rowAlignmentOriginalSizes;
  });
  await page.setViewportSize({ width: 1440, height: 980 });
  layout = await snapshotLayout(page);

  // Give every production type each canonical size in turn.
  const sizeGeometry = {};
  const originalOrder = layout.cards.map((card) => card.id);
  for (const size of sizeSequence) {
    await page.locator(".widget-grid").evaluate((grid, size) => grid.querySelectorAll(".widget-card").forEach((card) => { card.dataset.size = size; }), size);
    await settleLayout(page);
    layout = await snapshotLayout(page);
    assertGridLayout(layout, "all widget types at " + size);
    assert.deepEqual(layout.cards.map((card) => card.id), originalOrder, "testing " + size + " keeps every widget in the fixture");
    const reference = layout.cards[0];
    for (const card of layout.cards) {
      near(card.width, reference.width, card.type + " " + size + " width matches the shared footprint", 2);
      near(card.height, reference.height, card.type + " " + size + " height matches the shared footprint", 2);
    }
    sizeGeometry[size] = { width: reference.width, height: reference.height };
  }

  // A mixed set proves the five footprints coexist and pack without collision.
  await page.locator(".widget-grid").evaluate((grid, sizes) => grid.querySelectorAll(".widget-card").forEach((card, index) => { card.dataset.size = sizes[index % sizes.length]; }), sizeSequence);
  await settleLayout(page);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "mixed widget sizes");
  const initialMixedLayout = layout;
  const gaps = await readGridGaps(page);
  assertBlockRatios(layout, gaps, "mixed widget sizes");
  for (const card of layout.cards) {
    near(card.width, sizeGeometry[card.size].width, card.type + " " + card.size + " preserves its measured width", 2);
    near(card.height, sizeGeometry[card.size].height, card.type + " " + card.size + " preserves its measured height", 2);
  }

  // Long content stays inside fixed card blocks and remains reachable by scrolling.
  await page.evaluate((copy) => {
    for (const card of document.querySelectorAll(".widget-card")) {
      const paragraph = document.createElement("p");
      paragraph.className = "fixture-overflow-copy";
      paragraph.textContent = copy;
      card.querySelector(".widget-body").append(paragraph);
    }
  }, longText);
  await settleLayout(page);
  let contentLayout = await snapshotLayout(page);
  assertGridLayout(contentLayout, "long content in fixed blocks");
  for (const card of contentLayout.cards) {
    near(card.height, sizeGeometry[card.size].height, card.id + " height stays fixed when content grows", 2);
    near(card.width, sizeGeometry[card.size].width, card.id + " width stays fixed when content grows", 2);
  }
  const overflowReport = await page.evaluate(() => [...document.querySelectorAll(".widget-card")].map((card) => {
    const frame = card.querySelector(".widget-frame");
    const body = card.querySelector(".widget-body");
    const copy = body.querySelector(".fixture-overflow-copy");
    const bounds = frame.getBoundingClientRect();
    frame.scrollTop = 0;
    const first = body.firstElementChild && body.firstElementChild.getBoundingClientRect();
    const header = card.querySelector(".widget-header").getBoundingClientRect();
    frame.scrollTop = frame.scrollHeight;
    const bottomBounds = frame.getBoundingClientRect();
    const trailing = copy.getBoundingClientRect();
    return {
      id: card.dataset.widgetId,
      frameOverflowY: getComputedStyle(frame).overflowY,
      frameScrollHeight: frame.scrollHeight,
      frameClientHeight: frame.clientHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyFlexGrow: getComputedStyle(body).flexGrow,
      bodyFlexShrink: getComputedStyle(body).flexShrink,
      headerReachable: header.top >= bounds.top - 2 && header.bottom <= bounds.bottom + 2,
      firstReachable: Boolean(first && first.bottom > bounds.top && first.top < bounds.bottom),
      lastReachable: trailing.bottom <= bottomBounds.bottom + 2 && trailing.bottom > bottomBounds.top,
    };
  }));
  for (const result of overflowReport) {
    assert.equal(result.frameOverflowY, "auto", result.id + " uses the shared widget frame as its scroll viewport");
    assert.ok(result.frameScrollHeight > result.frameClientHeight, result.id + " frame has real overflow in the long-content fixture");
    assert.equal(result.bodyOverflowY, "visible", result.id + " body does not create a nested scroll trap");
    assert.equal(result.bodyFlexGrow, "1", result.id + " body grows naturally inside the frame");
    assert.equal(result.bodyFlexShrink, "0", result.id + " body keeps its natural content height");
    assert.ok(result.headerReachable, result.id + " header remains reachable at the start of the frame");
    assert.ok(result.firstReachable, result.id + " leading content remains reachable");
    assert.ok(result.lastReachable, result.id + " trailing content remains reachable at the end of the shared frame");
  }

  // Board controls set the shared gap. Card appearance overrides must not
  // alter the grid-derived square footprint.
  await page.locator(".widget-grid").evaluate((grid) => {
    grid.style.setProperty("--wa-gap", "22px");
  });
  await settleLayout(page);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "board appearance controls");
  const boardGaps = await readGridGaps(page);
  near(boardGaps.column, 22, "board horizontal gap setting applies to the grid");
  near(boardGaps.row, 22, "board vertical gap setting applies to the grid");
  const boardFootprints = assertBlockRatios(layout, boardGaps, "board appearance controls");
  const boardUnitMeasurement = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  near(boardFootprints.small.height, boardUnitMeasurement.unit, "board unit follows the measured grid width and selected columns", 2);
  near(boardFootprints.small.width, boardFootprints.small.height, "changing the board gap preserves square small cards", 2);

  // Stress the smallest blocks with the largest supported appearance values.
  await page.locator(".widget-grid").evaluate((grid) => {
    grid.style.setProperty("--wa-gap", "32px");
    for (const card of grid.querySelectorAll(".widget-card")) {
      card.style.setProperty("--wa-padding", "28px");
      card.style.setProperty("--wa-icon-size", "40px");
      card.style.setProperty("--wa-title-size", "20px");
      card.style.setProperty("--wa-line-height", "1.8");
    }
  });
  await settleLayout(page);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "maximum gap and padding settings");
  const compactGaps = await readGridGaps(page);
  const compactFootprints = assertBlockRatios(layout, compactGaps, "maximum content styling");
  near(compactGaps.row, 32, "maximum gap setting applies to the row grid");
  const compactUnitMeasurement = await page.evaluate(() => window.__lastBoardUnitMeasurement);
  near(compactFootprints.small.height, compactUnitMeasurement.unit, "maximum gap and padding preserve the grid-derived square unit", 2);
  const compactBodies = await page.evaluate(() => [...document.querySelectorAll(".widget-card")].map((card) => ({
    id: card.dataset.widgetId,
    size: card.dataset.size,
    height: card.querySelector(".widget-body").getBoundingClientRect().height,
  })));
  for (const body of compactBodies) {
    assert.ok(body.height > 0, body.id + " " + body.size + " keeps a visible body under maximum appearance styling");
  }
  const compactReachability = await page.evaluate(() => [...document.querySelectorAll(".widget-card")].map((card) => {
    const frame = card.querySelector(".widget-frame");
    const body = card.querySelector(".widget-body");
    const header = card.querySelector(".widget-header h2");
    frame.scrollTop = 0;
    const frameBounds = frame.getBoundingClientRect();
    const headerBounds = header.getBoundingClientRect();
    const menuButton = card.querySelector(".widget-header .menu-wrap > button");
    const menuButtonBounds = menuButton.getBoundingClientRect();
    const firstAtFrameStart = body.firstElementChild?.getBoundingClientRect();
    frame.scrollTop = Math.max(0, menuButtonBounds.top + menuButtonBounds.height / 2 - frameBounds.top - frame.clientHeight / 2);
    const alignedMenuButton = menuButton.getBoundingClientRect();
    const triggerCenter = alignedMenuButton.top + alignedMenuButton.height / 2;
    frame.scrollTop = Math.max(0, firstAtFrameStart.top - frameBounds.top - Math.max(0, (frame.clientHeight - Math.min(frame.clientHeight, firstAtFrameStart.height)) / 2));
    const alignedFirst = body.firstElementChild?.getBoundingClientRect();
    const firstReachable = Boolean(alignedFirst && alignedFirst.bottom > frameBounds.top && alignedFirst.top < frameBounds.bottom);
    frame.scrollTop = frame.scrollHeight;
    const endBounds = frame.getBoundingClientRect();
    const trailing = body.querySelector(".fixture-overflow-copy").getBoundingClientRect();
    const result = {
      id: card.dataset.widgetId,
      size: card.dataset.size,
      frameOverflowY: getComputedStyle(frame).overflowY,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyFlexGrow: getComputedStyle(body).flexGrow,
      bodyFlexShrink: getComputedStyle(body).flexShrink,
      titleWhiteSpace: getComputedStyle(header).whiteSpace,
      frameBounds: { top: frameBounds.top, bottom: frameBounds.bottom },
      titleBounds: { top: headerBounds.top, bottom: headerBounds.bottom },
      titleVisibleAtFrameStart: headerBounds.bottom > frameBounds.top && headerBounds.top < frameBounds.bottom,
      triggerCenterReachable: triggerCenter >= frameBounds.top && triggerCenter <= frameBounds.bottom,
      firstReachable,
      lastReachable: trailing.bottom <= endBounds.bottom + 2 && trailing.bottom > endBounds.top,
      frameScrollHeight: frame.scrollHeight,
      frameClientHeight: frame.clientHeight,
    };
    frame.scrollTop = 0;
    return result;
  }));
  for (const result of compactReachability) {
    assert.equal(result.frameOverflowY, "auto", result.id + " uses one shared frame viewport under maximum content styling");
    assert.equal(result.bodyOverflowY, "visible", result.id + " body does not become a nested scroll container");
    assert.equal(result.bodyFlexGrow, "1", result.id + " body grows naturally under maximum content styling");
    assert.equal(result.bodyFlexShrink, "0", result.id + " body retains its content height under maximum content styling");
    assert.equal(result.titleWhiteSpace, "nowrap", result.id + " title remains a single-line header");
    assert.ok(result.frameScrollHeight > result.frameClientHeight, result.id + " frame remains scrollable at maximum content styling");
    assert.ok(result.titleVisibleAtFrameStart, result.id + " title begins in the shared frame at maximum content styling: " + JSON.stringify(result));
    assert.ok(result.triggerCenterReachable, result.id + " menu trigger can be exposed by scrolling the shared frame");
    assert.ok(result.firstReachable, result.id + " leading content remains reachable under maximum content styling");
    assert.ok(result.lastReachable, result.id + " trailing content remains reachable under maximum content styling");
  }

  const timerBeforeOverride = layout.cards.find((card) => card.id === "timer");
  await page.locator('[data-widget-id="timer"]').evaluate((card) => {
    card.style.setProperty("--wa-padding", "28px");
    card.style.setProperty("--wa-title-size", "20px");
    card.style.setProperty("--wa-line-height", "1.8");
  });
  await settleLayout(page);
  const perWidgetOverrideLayout = await snapshotLayout(page);
  assertGridLayout(perWidgetOverrideLayout, "per-widget appearance overrides");
  const timerAfterOverride = perWidgetOverrideLayout.cards.find((card) => card.id === "timer");
  near(timerAfterOverride.width, timerBeforeOverride.width, "per-widget padding and typography cannot change its grid footprint", 2);
  near(timerAfterOverride.height, timerBeforeOverride.height, "per-widget appearance overrides preserve its grid footprint", 2);
  const overrideGaps = await readGridGaps(page);
  near(overrideGaps.column, 32, "per-widget gap cannot change the board column gap");
  near(overrideGaps.row, 32, "per-widget gap cannot change the board row gap");
  await page.locator(".widget-grid").evaluate((grid) => {
    for (const card of grid.querySelectorAll(".widget-card")) {
      for (const property of ["--wa-padding", "--wa-icon-size", "--wa-title-size", "--wa-line-height"]) card.style.removeProperty(property);
    }
    grid.style.removeProperty("--wa-gap");
  });

  // Reordering and repeated menu resizes keep mixed blocks in bounds and clear.
  const orderBeforeMove = (await snapshotLayout(page)).cards.map((card) => card.id);
  await page.locator('[data-widget-id="timer"] .widget-header .menu-wrap > button').click();
  await page.getByRole("button", { name: "Move later" }).click();
  await page.mouse.move(2, 2);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "after reorder");
  const reorderedIds = layout.cards.map((card) => card.id);
  assert.equal(reorderedIds.indexOf("timer"), orderBeforeMove.indexOf("timer") + 1, "Move later advances the selected widget in DOM order");
  const orderAfterMove = [...reorderedIds];
  const originalTimerSize = initialMixedLayout.cards.find((card) => card.id === "timer").size;
  for (const size of sizeSequence) {
    await page.locator('[data-widget-id="timer"] .widget-header .menu-wrap > button').click();
    await page.getByRole("button", { name: sizeLabel[size] + " widget" }).click();
    await page.mouse.move(2, 2);
    layout = await snapshotLayout(page);
    assertGridLayout(layout, "timer resized to " + size);
    assert.deepEqual(layout.cards.map((card) => card.id), orderAfterMove, "resizing to " + size + " preserves reordered DOM order");
  }
  await page.locator('[data-widget-id="timer"] .widget-header .menu-wrap > button').click();
  await page.getByRole("button", { name: sizeLabel[originalTimerSize] + " widget" }).click();
  await page.mouse.move(2, 2);
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "restored timer size");

  // Sidebar collapse releases width and the block grid reflows without overlap.
  await page.setViewportSize({ width: 1160, height: 980 });
  layout = await snapshotLayout(page);
  assertGridLayout(layout, "expanded-sidebar workspace");
  const expandedSidebarColumns = (await readGridGaps(page)).columns;
  await page.locator(".sidebar-toggle").click();
  const collapsedLayout = await snapshotLayout(page);
  assert.ok(collapsedLayout.workspaceWidth > layout.workspaceWidth, "sidebar collapse releases content width");
  assertGridLayout(collapsedLayout, "sidebar-collapsed workspace");
  assert.equal((await readGridGaps(page)).columns, expandedSidebarColumns, "sidebar collapse preserves four small-widget columns");
  await page.locator("#app").evaluate((app) => app.classList.remove("sidebar-collapsed"));

  // Phone widths retain two fluid columns and all five footprints.
  const phoneMenus = [];
  const phoneBodyHeights = [];
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    layout = await snapshotLayout(page);
    assertGridLayout(layout, width + "px phone workspace");
    const phoneGaps = await readGridGaps(page);
    assert.equal(phoneGaps.columns, 2, width + "px phone keeps two square small-widget columns");
    assert.ok(layout.grid.width <= layout.viewportWidth, width + "px phone board exceeds the viewport width: " + layout.grid.width + "px > " + layout.viewportWidth + "px");
    assert.ok(layout.scrollWidth <= layout.viewportWidth, width + "px phone page overflows horizontally: " + layout.scrollWidth + "px > " + layout.viewportWidth + "px");
    assertBlockRatios(layout, phoneGaps, width + "px phone footprints");
    const bodyReports = await page.evaluate(() => [...document.querySelectorAll(".widget-card")].map((card) => ({
      id: card.dataset.widgetId,
      size: card.dataset.size,
      height: card.querySelector(".widget-body").getBoundingClientRect().height,
      frameOverflowY: getComputedStyle(card.querySelector(".widget-frame")).overflowY,
      bodyOverflowY: getComputedStyle(card.querySelector(".widget-body")).overflowY,
    })));
    for (const body of bodyReports) {
      assert.ok(body.height > 0, body.id + " " + body.size + " body remains visible at " + width + "px");
      assert.equal(body.frameOverflowY, "auto", body.id + " has one usable scroll viewport at " + width + "px");
      assert.equal(body.bodyOverflowY, "visible", body.id + " has no nested scroll viewport at " + width + "px");
    }
    phoneBodyHeights.push({ width, bodies: bodyReports });

    const firstColumnId = await page.evaluate(() => {
      const grid = document.querySelector(".widget-grid").getBoundingClientRect();
      const card = [...document.querySelectorAll(".widget-card")].find((item) => Math.abs(item.getBoundingClientRect().left - grid.left) < 2);
      return card?.dataset.widgetId;
    });
    assert.ok(firstColumnId, width + "px phone fixture has a card at the first column edge");
    const trigger = page.locator('[data-widget-id="' + firstColumnId + '"] .widget-header .menu-wrap > button');
    await page.locator('[data-widget-id="' + firstColumnId + '"]').evaluate((card) => {
      const documentTop = card.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: Math.max(0, documentTop - 100), behavior: "instant" });
    });
    await settleLayout(page);
    const triggerHit = await trigger.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button");
      return { expected: button.getAttribute("aria-label"), hit: hit?.getAttribute("aria-label"), y: rect.y, scrollY };
    });
    assert.equal(triggerHit.hit, triggerHit.expected, width + "px narrow-card menu trigger is pointer reachable before Playwright clicks it: " + JSON.stringify(triggerHit));
    await trigger.click();
    const phoneMenu = await page.locator('[data-widget-id="' + firstColumnId + '"] .widget-menu').evaluate((menu) => {
      const rect = menu.getBoundingClientRect();
      const options = [...menu.querySelectorAll("[data-size]")].map((button) => {
        const buttonRect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest("button");
        return { value: button.dataset.size, hitValue: hit?.dataset.size };
      });
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY, options };
    });
    if (width === 320) await page.screenshot({ path: resolve(screenshotDir, "phone-menu-hit-test.png") });
    assert.ok(phoneMenu.left >= 0 && phoneMenu.right <= phoneMenu.viewportWidth, "first-column menu stays inside the " + width + "px phone viewport: " + JSON.stringify(phoneMenu));
    assert.deepEqual(phoneMenu.options.map((option) => option.hitValue), sizeSequence, width + "px first-column popup exposes five hit-testable size options: " + JSON.stringify(phoneMenu));
    phoneMenus.push({ width, ...phoneMenu });
    await trigger.click();

    if (width === 320) {
      const card = page.locator('[data-widget-id="' + firstColumnId + '"]');
      const originalPhoneSize = await card.getAttribute("data-size");
      await card.evaluate((node) => {
        node.dataset.size = "mini";
        node.style.setProperty("--wa-padding", "28px");
        const grid = node.closest(".widget-grid");
        grid.style.setProperty("--wa-gap", "32px");
        document.querySelector("#app").classList.add("is-customizing");
      });
      await settleLayout(page);
      let maximumPhone = await snapshotLayout(page);
      assertGridLayout(maximumPhone, "320px phone with maximum appearance settings");
      assert.ok(maximumPhone.scrollWidth <= 320, "320px maximum phone appearance keeps document width inside viewport");
      const maximumTriggerHit = await trigger.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button");
        return { expected: button.getAttribute("aria-label"), hit: hit?.getAttribute("aria-label"), y: rect.y };
      });
      assert.equal(maximumTriggerHit.hit, maximumTriggerHit.expected, "320px mini card menu trigger remains hit-testable with 32px gap and 28px padding");
      await trigger.click();
      const maximumMenuHits = await page.locator('[data-widget-id="' + firstColumnId + '"] .widget-menu').evaluate((menu) => ({
        menu: (() => { const rect = menu.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }; })(),
        viewport: { width: innerWidth, height: innerHeight, scrollY },
        options: [...menu.querySelectorAll("[data-size]")].map((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button");
          return { value: button.dataset.size, hitValue: hit?.dataset.size, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
        }),
      }));
      if (width === 320) await page.screenshot({ path: resolve(screenshotDir, "phone-menu-hit-test-max.png") });
      assert.deepEqual(maximumMenuHits.options.map((item) => item.hitValue), sizeSequence, "320px mini card menu stays pointer reachable with maximum gap and padding: " + JSON.stringify(maximumMenuHits));
      await trigger.click();
      assert.equal(await card.locator(".widget-header .drag-handle").count(), 0, "320px customization has no visible separate drag handle");
      await card.evaluate((node, originalSize) => {
        node.dataset.size = originalSize;
        node.style.removeProperty("--wa-padding");
        node.closest(".widget-grid").style.removeProperty("--wa-gap");
        document.querySelector("#app").classList.remove("is-customizing");
      }, originalPhoneSize);
      await settleLayout(page);
    }

    await page.evaluate(() => {
      document.querySelectorAll(".widget-frame").forEach((frame) => { frame.scrollTop = 0; });
      window.scrollTo(0, 0);
    });
    if (width === 320) await page.screenshot({ path: resolve(screenshotDir, "phone.png"), fullPage: true });
  }
  // Desktop menu stays in the viewport and receives pointer hit-testing.
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopMenuWidgetId = await page.evaluate(() => {
    const grid = document.querySelector(".widget-grid").getBoundingClientRect();
    return [...document.querySelectorAll(".widget-card")].find((card) => Math.abs(card.getBoundingClientRect().left - grid.left) < 2)?.dataset.widgetId;
  });
  assert.ok(desktopMenuWidgetId, "desktop fixture has a first-column widget for popup testing");
  const desktopTrigger = page.locator('[data-widget-id="' + desktopMenuWidgetId + '"] .widget-header .menu-wrap > button');
  const desktopMenu = page.locator('[data-widget-id="' + desktopMenuWidgetId + '"] .widget-menu');
  await desktopTrigger.scrollIntoViewIfNeeded();
  await desktopTrigger.click();
  await desktopMenu.waitFor({ state: "visible" });
  await settleLayout(page);
  const desktopPopup = await desktopMenu.evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const options = [...menu.querySelectorAll("[data-size]")].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest("button");
      return { value: button.dataset.size, hitValue: hit?.dataset.size };
    });
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, options };
  });
  assert.ok(desktopPopup.left >= 0 && desktopPopup.right <= desktopPopup.viewportWidth, "first-column popup stays inside the desktop viewport horizontally: " + JSON.stringify(desktopPopup));
  assert.ok(desktopPopup.top >= 0 && desktopPopup.bottom <= desktopPopup.viewportHeight, "first-column popup stays inside the desktop viewport vertically: " + JSON.stringify(desktopPopup));
  assert.deepEqual(desktopPopup.options.map((option) => option.value), sizeSequence, "first-column popup presents all five sizes in canonical order");
  assert.deepEqual(desktopPopup.options.map((option) => option.hitValue), sizeSequence, "all five size options receive pointer hit-testing above sibling cards");

  const sizeButtonHitTests = [];
  for (const size of sizeSequence) {
    if (!(await desktopMenu.count())) {
      await desktopTrigger.click();
      await desktopMenu.waitFor({ state: "visible" });
    }
    await desktopMenu.locator('[data-size="' + size + '"]').click();
    assert.equal(await page.locator('[data-widget-id="' + desktopMenuWidgetId + '"]').getAttribute("data-size"), size, "real size option click applies " + size);
    sizeButtonHitTests.push(size);
    await page.mouse.move(2, 2);
  }
  const originalDesktopSize = initialMixedLayout.cards.find((card) => card.id === desktopMenuWidgetId).size;
  await desktopTrigger.click();
  await desktopMenu.waitFor({ state: "visible" });
  await desktopMenu.locator('[data-size="' + originalDesktopSize + '"]').click();
  assert.equal(await page.locator('[data-widget-id="' + desktopMenuWidgetId + '"]').getAttribute("data-size"), originalDesktopSize, "restore the first-column widget's initial size after menu hit tests");
  await desktopTrigger.click();
  await desktopMenu.waitFor({ state: "visible" });
  await settleLayout(page);
  const readMenu = () => page.locator('[data-widget-id="' + desktopMenuWidgetId + '"] .widget-menu').evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const button = menu.querySelector('[data-size="large"]');
    const buttonRect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest("button");
    return { menuLeft: rect.left, menuRight: rect.right, menuTop: rect.top, menuBottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, hitLabel: hit?.getAttribute("aria-label"), hitText: hit?.textContent };
  });
  const menuBeforeScroll = await readMenu();
  await page.evaluate(() => window.scrollBy({ top: 40, behavior: "instant" }));
  const menuAfterScroll = await readMenu();
  const menuState = { ...menuAfterScroll, before: menuBeforeScroll };
  assert.ok(menuState.menuLeft >= 0 && menuState.menuRight <= menuState.viewportWidth, "widget menu remains horizontally in viewport: " + JSON.stringify(menuState));
  assert.ok(menuState.menuTop >= 0 && menuState.menuBottom <= menuState.viewportHeight, "widget menu remains vertically in viewport after body scroll: " + JSON.stringify(menuState));
  assert.ok(menuState.hitLabel === "Large widget" || menuState.hitText.includes("Large"), "widget menu receives pointer hit-testing above sibling cards: " + JSON.stringify(menuState));
  near(menuState.menuTop, menuBeforeScroll.menuTop - 40, "open menu remains anchored while the page scrolls", 2);
  await desktopTrigger.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.querySelectorAll(".widget-frame").forEach((frame) => { frame.scrollTop = 0; }));
  await page.screenshot({ path: resolve(screenshotDir, "desktop.png"), fullPage: true });

  // Repeated measurement around a three-row overflow stays stable with a
  // classic scrollbar and writes the square unit only when its inputs change.
  const thresholdPage = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 });
  const thresholdHtml = `<!doctype html><html data-theme="dark" data-motion="reduced"><head><meta charset="utf-8"><style>
${globalCss.replace(/^@import[^;]+;\s*/m, "")}
${referenceCss}
${widgetAppearanceCss}
${widgetBlockLayoutCss}
</style></head><body style="margin:0"><div class="reference-ui" style="--content-offset:0px;--page-gutter:0px"><main class="main-content" style="margin:0;padding:0 0 20px;min-height:0;width:100%"><div style="height:100px"></div><div class="widget-grid"${gridStyleAttribute}>${cardsMarkup}</div></main></div></body></html>`;
  let thresholdResult;
  try {
    await thresholdPage.setContent(thresholdHtml, { waitUntil: "load" });
    const thresholdStart = await thresholdPage.evaluate(({ calculateWidgetUnitSource, updateBoardUnitSource, calculateWidgetPlacementsSource, updateCardPlacementsSource }) => {
      const calculateWidgetUnit = new Function(`return (${calculateWidgetUnitSource})`)();
      const updaterBody = updateBoardUnitSource.slice(updateBoardUnitSource.indexOf("{") + 1, updateBoardUnitSource.lastIndexOf("}"));
      const updateBoardUnit = new Function("calculateWidgetUnit", `return function () {${updaterBody}}`)(calculateWidgetUnit);
      const calculateWidgetPlacements = new Function(`return (${calculateWidgetPlacementsSource})`)();
      const placementBody = updateCardPlacementsSource.slice(updateCardPlacementsSource.indexOf("{") + 1, updateCardPlacementsSource.lastIndexOf("}"));
      const updateCardPlacements = new Function("calculateWidgetPlacements", `return function () {${placementBody}}`)(calculateWidgetPlacements);
      const grid = document.querySelector(".widget-grid");
      const cards = [...grid.querySelectorAll(".widget-card")];
      cards.slice(12).forEach((card) => card.remove());
      cards.slice(0, 12).forEach((card) => { card.dataset.size = "small"; });
      const context = { grid: { current: grid } };
      const writes = [];
      const observerWidths = [];
      let observerCallbacks = 0;
      let frame = null;
      const originalSetProperty = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        if (this === grid.style && name === "--widget-unit") writes.push(String(value));
        return originalSetProperty.call(this, name, value, priority);
      };
      const measure = () => {
        updateBoardUnit.call(context);
        updateCardPlacements.call(context);
        const style = getComputedStyle(grid);
        let bottomInset = 0;
        for (let ancestor = grid.parentElement; ancestor; ancestor = ancestor.parentElement) {
          bottomInset += Number.parseFloat(getComputedStyle(ancestor).paddingBottom) || 0;
        }
        const input = {
          gridWidth: grid.getBoundingClientRect().width || grid.clientWidth,
          gap: Number.parseFloat(style.columnGap) || 16,
          columns: Number.parseFloat(style.getPropertyValue("--widget-columns")) || 4,
          gridDocumentTop: grid.getBoundingClientRect().top + scrollY,
          bottomInset,
        };
        const unit = Number.parseFloat(style.getPropertyValue("--widget-unit"));
        return { ...input, unit, gridHeight: grid.getBoundingClientRect().height, scrollHeight: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth };
      };
      const before = { scrollHeight: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, viewportWidth: innerWidth };
      const initial = measure();
      const observer = new ResizeObserver(() => {
        observerCallbacks += 1;
        observerWidths.push(grid.clientWidth);
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          measure();
        });
      });
      observer.observe(grid);
      grid.style.setProperty("--wa-gap", "17px");
      window.__thresholdCleanup = () => {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        CSSStyleDeclaration.prototype.setProperty = originalSetProperty;
      };
      window.__thresholdState = () => ({
        writes: [...writes],
        observerWidths: [...observerWidths],
        observerCallbacks,
        final: measure(),
        scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter,
        cardCount: grid.querySelectorAll(".widget-card[data-size=small]").length,
      });
      return { before, initial };
    }, { calculateWidgetUnitSource, updateBoardUnitSource, calculateWidgetPlacementsSource, updateCardPlacementsSource });
    await thresholdPage.waitForTimeout(400);
    thresholdResult = await thresholdPage.evaluate(() => window.__thresholdState());
    thresholdResult.start = thresholdStart;
    assert.equal(thresholdResult.cardCount, 12, "classic-scrollbar regression fixture has exactly twelve small cards in three rows");
    near(thresholdStart.initial.gridDocumentTop, 100, "scrollbar threshold fixture starts the grid at document y=100", 1);
    near(thresholdStart.initial.bottomInset, 20, "scrollbar threshold fixture reserves its 20px bottom inset", 1);
    assert.ok(thresholdStart.before.scrollHeight > 750, "three square small-widget rows extend beyond the 750px viewport");
    assert.ok(thresholdResult.final.scrollHeight > 750, "measurement does not deform square cards to force the page below the viewport threshold");
    assert.ok(thresholdResult.scrollbarGutter.includes("stable"), "production board CSS reserves a stable classic-scrollbar gutter");
    assert.ok(thresholdStart.before.clientWidth < thresholdStart.before.viewportWidth, "the overflowing document reserves a classic-scrollbar gutter: " + JSON.stringify(thresholdResult));
    assert.equal(thresholdResult.final.gridWidth, thresholdStart.initial.gridWidth, "the grid width remains fixed through gap-triggered measurements: " + JSON.stringify(thresholdResult));
    assert.ok(thresholdResult.observerCallbacks > 0, "ResizeObserver observes the grid's gap-driven size change");
    assert.equal(new Set(thresholdResult.observerWidths).size, 1, "grid width stays stable across observer deliveries: " + JSON.stringify(thresholdResult));
    assert.ok(thresholdResult.writes.length <= 2, "production unit measurement writes only for the initial size and changed gap: " + JSON.stringify(thresholdResult));
    await thresholdPage.evaluate(() => window.__thresholdCleanup());
  } finally {
    await thresholdPage.close();
  }

  console.log(JSON.stringify({
    result: "PASS",
    fixture: "actual app/globals.css, app/reference-ui.css, app/widget-appearance.css, app/widget-block-layout.css, and all 18 production widget types",
    screenshots: [
      ".vinext/verify-widget-layout/desktop-small-4x2-expanded.png",
      ".vinext/verify-widget-layout/desktop-small-4x2-collapsed.png",
      ".vinext/verify-widget-layout/phone-small-2x4.png",
      ".vinext/verify-widget-layout/composition-large-medium-small-minis.png",
      ".vinext/verify-widget-layout/composition-small-small-mini-pair-mediums.png",
      ".vinext/verify-widget-layout/phone-menu-hit-test-max.png",
      ...densityWidths.map((width) => `.vinext/verify-widget-layout/${screenshotNames[width]}`),
      ".vinext/verify-widget-layout/desktop.png",
      ".vinext/verify-widget-layout/phone.png",
    ],
    desktopDensity: {
      commonAspectRatio: "16:10",
      normalizedWidths: densityWidths,
      defaultAppearance: densitySnapshots,
      customAppearance: customDensitySnapshots,
      customValues: { gap: 18, padding: 18, fontSize: 18, titleSize: 20, iconSize: 32 },
    },
    desktopFrameAlignment: desktopFrameReports,
    shortDesktopSidebar: shortSidebarReports,
    shortDesktopExperimentalMenu: experimentalMenuReports,
    sizeGeometry: Object.fromEntries(Object.entries(sizeGeometry).map(([size, box]) => [size, { width: box.width, height: box.height }])),
    responsive: responsiveReports.map(({ viewportWidth, expectedColumns, sidebar, columns, rows, perRow, width, height, unit, scrollWidth }) => ({ viewportWidth, expectedColumns, sidebar, columns, rows, perRow, width, height, unit, scrollWidth })),
    composition: {
      large: { width: compositionFootprints.large.width, height: compositionFootprints.large.height },
      medium: { width: compositionFootprints.medium.width, height: compositionFootprints.medium.height },
      small: { width: compositionFootprints.small.width, height: compositionFootprints.small.height },
      mini: { width: compositionFootprints.mini.width, height: compositionFootprints.mini.height },
      edgeAlignment: "PASS",
    },
    rowAlignmentRegression: {
      sizes: rowAlignmentSizes,
      smallRows: rowAlignmentSmallRows,
      minisStacked: true,
      nonMiniStartsOnFullRows: true,
    },
    contentOverflow: { cardsChecked: overflowReport.length, allReachable: overflowReport.every((item) => item.headerReachable && item.firstReachable && item.lastReachable) },
    maximumAppearance: { gap: compactGaps.row, smallWidth: compactFootprints.small.width, smallHeight: compactFootprints.small.height, contentReachable: compactReachability.every((item) => item.triggerCenterReachable && item.firstReachable && item.lastReachable) },
    menuHitTesting: { phoneWidths: phoneMenus.map(({ width }) => width), desktopSizeOptions: sizeButtonHitTests.length, desktopPopupHit: desktopPopup.options.every((option) => option.hitValue === option.value) },
    scrollbarStability: { writes: thresholdResult.writes.length, observerCallbacks: thresholdResult.observerCallbacks, fixedGridWidth: thresholdResult.final.gridWidth, scrollHeight: thresholdResult.final.scrollHeight },
  }, null, 2));
  }
} finally {
  await browser.close();
}
