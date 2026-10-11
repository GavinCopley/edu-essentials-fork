import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientModule } from "../tests/helpers/client-modules.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const [{ SIDEBAR_COLLAPSED_BOOTSTRAP, SIDEBAR_COLLAPSED_STORAGE_KEY }, globalCss, referenceCss, widgetCss] = await Promise.all([
  import(await clientModule("lib/sidebar-preference.ts")),
  readFile(resolve(repoRoot, "app/globals.css"), "utf8"),
  readFile(resolve(repoRoot, "app/reference-ui.css"), "utf8"),
  readFile(resolve(repoRoot, "app/widget-block-layout.css"), "utf8"),
]);
const css = [globalCss, referenceCss, widgetCss].map((source) => source.replace(/^@import[^;]+;\s*/gm, "")).join("\n");
const html = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>:root { --font-geist-sans: Arial, sans-serif; }${css}</style>
    <script id="sidebar-preference-bootstrap">${SIDEBAR_COLLAPSED_BOOTSTRAP}</script>
  </head>
  <body>
    <div class="app-shell reference-ui">
      <aside class="sidebar" aria-label="Primary navigation">
        <div class="brand-row">
          <div class="brand-copy"><strong>EduEssentials</strong></div>
          <button class="icon-button sidebar-toggle" aria-label="Collapse sidebar"><svg aria-hidden="true" width="19" height="19"></svg></button>
          <button class="icon-button sidebar-close" aria-label="Close navigation">Close</button>
        </div>
        <nav class="main-nav">
          <a class="nav-item active" href="/home"><svg aria-hidden="true" width="20" height="20"></svg><span>Home</span></a>
          <div class="experimental-control"><button class="nav-item experimental-trigger"><svg aria-hidden="true" width="16" height="16"></svg><span>Experimental mode</span></button></div>
        </nav>
        <button class="nav-item syllabus-nav"><svg aria-hidden="true" width="22" height="22"></svg><span>Upload syllabus</span></button>
        <div class="sidebar-bottom"><a class="profile-card" href="/settings"><span class="avatar">A</span><span><strong>Alex</strong><small>Student workspace</small></span></a></div>
      </aside>
      <div class="mountain-backdrop" aria-hidden="true"></div>
      <header class="mobile-header"><button class="mobile-open" aria-label="Open navigation">Menu</button><strong>EduEssentials</strong></header>
      <header class="desktop-topbar" aria-label="Workspace toolbar">
        <div class="topbar-context"><span>STUDENT WORKSPACE</span><strong>Home</strong></div>
        <label class="topbar-search"><input aria-label="Search" placeholder="Search your workspace"></label>
        <div class="topbar-actions"><button class="topbar-date"><span><small>TODAY</small><strong>Wednesday, October 7</strong></span></button><button class="topbar-icon" aria-label="Notifications">N</button></div>
      </header>
      <main class="main-content"><div class="page">
        <section class="home-greeting"><h1>Good morning, Alex</h1><p>Wednesday, October 7 · A good day to make progress.</p></section>
        <section class="home-today-panel" aria-label="Today">
          <header class="today-panel-header"><h2>Today</h2><div class="today-panel-actions"><button class="today-panel-link">View schedule</button></div></header>
          <div class="today-panel-grid">
            <section class="today-panel-section"><div class="today-section-heading"><span class="today-heading-icon">S</span><h2>Study goal</h2></div><div class="today-task-list"><p class="today-empty">Keep building your streak.</p></div></section>
            <section class="today-panel-section"><div class="today-section-heading"><span class="today-heading-icon">T</span><h2>Tasks</h2></div><div class="today-task-list"><p class="today-empty">Two tasks are due today.</p></div></section>
            <section class="today-panel-section today-schedule"><div class="today-section-heading"><span class="today-heading-icon">C</span><h2>Schedule</h2></div><div class="today-schedule-list"><p class="today-empty">No events yet.</p></div></section>
          </div>
        </section>
        <section class="workspace-section">
          <div class="workspace-bar"><div class="workspace-tabs" role="tablist" aria-label="Workspaces"><button class="active">My workspace</button><button>Classes</button></div><div class="workspace-actions"><button class="widget-customization-trigger">Widget customization</button><button>Customize</button><button class="add-widget-control">Add widget</button></div></div>
          <div class="widget-grid" aria-label="Workspace widgets">
            <article class="widget-card" data-size="small" data-widget-id="goal"><div class="widget-frame"><div class="widget-header"><span class="widget-icon">G</span><h2>Daily Study Goal</h2></div><div class="widget-body">Study for 30 minutes</div></div></article>
            <article class="widget-card" data-size="large" data-widget-id="notes"><div class="widget-frame"><div class="widget-header"><span class="widget-icon">N</span><h2>Quick Notes</h2></div><div class="widget-body">Remember to review notes</div></div></article>
            <article class="widget-card" data-size="small" data-widget-id="timer"><div class="widget-frame"><div class="widget-header"><span class="widget-icon">T</span><h2>Pomodoro</h2></div><div class="widget-body">25:00</div></div></article>
          </div>
        </section>
      </div></main>
      <button class="sidebar-scrim" style="display:none" aria-label="Close navigation overlay"></button>
    </div>
    <script>
      const shell = document.querySelector('.app-shell');
      document.querySelector('.sidebar-toggle').addEventListener('click', () => {
        const collapsed = !shell.classList.contains('sidebar-collapsed');
        shell.classList.toggle('sidebar-collapsed', collapsed);
        document.documentElement.dataset.sidebarCollapsed = String(collapsed);
      });
      const sidebar = document.querySelector('.sidebar');
      const scrim = document.querySelector('.sidebar-scrim');
      document.querySelector('.mobile-open').addEventListener('click', () => { sidebar.classList.add('open'); scrim.style.display = ''; });
      const closeSidebar = () => { sidebar.classList.remove('open'); scrim.style.display = 'none'; };
      document.querySelector('.sidebar-close').addEventListener('click', closeSidebar);
      scrim.addEventListener('click', closeSidebar);
    </script>
  </body>
</html>`;

const server = createServer((request, response) => {
  if (request.url?.startsWith("/favicon.ico")) { response.writeHead(204); response.end(); return; }
  if (request.url?.startsWith("/mountain-header.png")) { response.writeHead(204); response.end(); return; }
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
let browser;
const errors = [];

async function openPage({ value = undefined, blocked = false, width = 1440, reducedMotion = "no-preference", accountMotion = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion });
  await context.addInitScript(({ key, value, blocked }) => {
    if (blocked) {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    } else if (value !== undefined) {
      window.localStorage.setItem(key, value);
    }
  }, { key: SIDEBAR_COLLAPSED_STORAGE_KEY, value, blocked });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(baseUrl, { waitUntil: "load" });
  if (accountMotion) await page.evaluate(() => { document.documentElement.dataset.motion = "reduced"; });
  return { context, page };
}

async function metrics(page) {
  return page.locator(".app-shell").evaluate((shell) => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    };
    const sidebar = shell.querySelector(".sidebar");
    const label = shell.querySelector(".nav-item > span");
    const widgetGrid = shell.querySelector(".widget-grid");
    const widgetCards = [...shell.querySelectorAll(".widget-card")];
    return {
      rootValue: document.documentElement.getAttribute("data-sidebar-collapsed"),
      sidebarWidth: sidebar.getBoundingClientRect().width,
      sidebarLeft: sidebar.getBoundingClientRect().left,
      brandCopy: rect(shell.querySelector(".brand-copy")),
      brandDisplay: getComputedStyle(shell.querySelector(".brand-copy")).display,
      brandRow: rect(shell.querySelector(".brand-row")),
      toggleLeft: shell.querySelector(".sidebar-toggle").getBoundingClientRect().left,
      navIconLeft: shell.querySelector(".nav-item svg").getBoundingClientRect().left,
      experimentalIconWidth: shell.querySelector(".experimental-trigger > svg").getBoundingClientRect().width,
      experimentalHeight: rect(shell.querySelector(".experimental-trigger")).height,
      experimentalLabelDisplay: getComputedStyle(shell.querySelector(".experimental-trigger > span")).display,
      syllabusIconLeft: shell.querySelector(".syllabus-nav > svg").getBoundingClientRect().left,
      labelDisplay: getComputedStyle(label).display,
      contentLeft: shell.querySelector(".main-content").getBoundingClientRect().left,
      contentWidth: shell.querySelector(".main-content").getBoundingClientRect().width,
      contentOffset: getComputedStyle(shell).getPropertyValue("--content-offset").trim(),
      topbar: rect(shell.querySelector(".desktop-topbar")),
      backdrop: rect(shell.querySelector(".mountain-backdrop")),
      greeting: rect(shell.querySelector(".home-greeting")),
      today: rect(shell.querySelector(".home-today-panel")),
      controls: rect(shell.querySelector(".workspace-bar")),
      grid: rect(widgetGrid),
      widgets: widgetCards.map(rect),
      dateVisible: getComputedStyle(shell.querySelector(".topbar-date")).display !== "none",
    };
  });
}

const shellTrackNames = ["sidebarWidth", "toggleLeft", "navIconLeft", "experimentalIconWidth", "experimentalHeight", "syllabusIconLeft", "contentLeft", "topbarLeft", "topbarWidth", "backdropLeft"];

function shellTrackValues(snapshot) {
  return {
    sidebarWidth: snapshot.sidebarWidth,
    toggleLeft: snapshot.toggleLeft,
    navIconLeft: snapshot.navIconLeft,
    experimentalIconWidth: snapshot.experimentalIconWidth,
    experimentalHeight: snapshot.experimentalHeight,
    syllabusIconLeft: snapshot.syllabusIconLeft,
    contentLeft: snapshot.contentLeft,
    topbarLeft: snapshot.topbar.left,
    topbarWidth: snapshot.topbar.width,
    backdropLeft: snapshot.backdrop.left,
  };
}

function assertSquareWidgets(snapshot, context) {
  assert.ok(snapshot.widgets.length >= 3, `${context}: fixture contains representative widgets`);
  for (const [index, widget] of snapshot.widgets.entries()) {
    assert.ok(widget.width > 0 && widget.height > 0, `${context}: widget ${index} has a rendered footprint`);
    assert.ok(Math.abs(widget.width - widget.height) <= 1.5, `${context}: widget ${index} remains square (${widget.width.toFixed(2)}×${widget.height.toFixed(2)})`);
  }
}

async function captureToggle(page, duration = 380) {
  return page.evaluate(async (duration) => {
    const shell = document.querySelector(".app-shell");
    const snapshot = () => {
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, width: rect.width, height: rect.height };
      };
      const sidebar = shell.querySelector(".sidebar");
      const main = shell.querySelector(".main-content");
      return {
        at: performance.now(),
        sidebarWidth: sidebar.getBoundingClientRect().width,
        toggleLeft: shell.querySelector(".sidebar-toggle").getBoundingClientRect().left,
        navIconLeft: shell.querySelector(".nav-item svg").getBoundingClientRect().left,
        experimentalIconWidth: shell.querySelector(".experimental-trigger > svg").getBoundingClientRect().width,
        experimentalHeight: box(shell.querySelector(".experimental-trigger")).height,
        syllabusIconLeft: shell.querySelector(".syllabus-nav > svg").getBoundingClientRect().left,
        brandRow: box(shell.querySelector(".brand-row")),
        contentLeft: main.getBoundingClientRect().left,
        topbar: box(shell.querySelector(".desktop-topbar")),
        backdrop: box(shell.querySelector(".mountain-backdrop")),
        widgets: [...shell.querySelectorAll(".widget-card")].map((card) => {
          const rect = card.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
        activeTransitions: [sidebar, shell.querySelector(".sidebar-toggle"), shell.querySelector(".nav-item"), shell.querySelector(".experimental-trigger"), shell.querySelector(".syllabus-nav"), main, shell.querySelector(".desktop-topbar"), shell.querySelector(".mountain-backdrop")]
          .flatMap((element) => element.getAnimations().filter((animation) => animation.playState === "running" || animation.playState === "pending")
            .map((animation) => ({ property: animation.transitionProperty, duration: animation.effect.getTiming().duration, easing: animation.effect.getTiming().easing }))),
      };
    };
    const before = snapshot();
    const startedAt = performance.now();
    document.querySelector(".sidebar-toggle").click();
    const frames = [];
    return await new Promise((resolve) => {
      const sample = () => {
        frames.push(snapshot());
        if (performance.now() - startedAt >= duration) resolve({ before, frames });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }, duration);
}

function assertSynchronizedMotion(before, after, frames, direction) {
  const from = shellTrackValues(before);
  const to = shellTrackValues(after);
  const movingNames = shellTrackNames.filter((name) => Math.abs(to[name] - from[name]) > 1);
  assert.deepEqual(movingNames, shellTrackNames, "sidebar, main, topbar, and backdrop all change geometry");
  const progressAt = (frame, name) => (shellTrackValues(frame)[name] - from[name]) / (to[name] - from[name]);
  const intermediate = frames.find((frame) => {
    const progresses = movingNames.map((name) => progressAt(frame, name));
    return progresses.every((progress) => progress > 0.08 && progress < 0.94);
  });
  assert.ok(intermediate, `${direction}: browser sampled an intermediate frame for every shell element (${movingNames.map((name) => `${name}=${frames.map((frame) => progressAt(frame, name).toFixed(2)).join("/")}`).join("; ")})`);

  const activeFrames = frames.filter((frame) => {
    const progresses = movingNames.map((name) => progressAt(frame, name));
    return progresses.every((progress) => progress > 0.03 && progress < 0.97);
  });
  assert.ok(activeFrames.length >= 3, `${direction}: multiple actual rendered frames overlap the active transition interval`);
  for (const frame of activeFrames) {
    const progresses = movingNames.map((name) => progressAt(frame, name));
    assert.ok(progresses.every((progress) => progress >= -0.02 && progress <= 1.02), `${direction}: frame remains between the start and destination geometry`);
    assert.ok(Math.max(...progresses) - Math.min(...progresses) < 0.025, `${direction}: shell geometry shares one eased progress (${progresses.map((progress) => progress.toFixed(3)).join(", ")})`);
  }
  for (const frame of frames) {
    const progresses = ["sidebarWidth", "contentLeft", "topbarLeft", "topbarWidth", "backdropLeft"].map((name) => progressAt(frame, name));
    assert.ok(progresses.every((progress) => progress >= -0.02 && progress <= 1.02), `${direction}: shell bounce stays within 2% of the destination`);
    assert.ok(Math.abs(frame.brandRow.height - before.brandRow.height) < 0.75, `${direction}: brand row keeps a stable height (${before.brandRow.height.toFixed(2)} → ${frame.brandRow.height.toFixed(2)})`);
  }
  assert.ok(frames.some((frame) => progressAt(frame, "sidebarWidth") > 1.003), `${direction}: sidebar gently overshoots before settling`);
  for (const frame of frames) assertSquareWidgets(frame, `${direction} at ${Math.round(frame.at - frames[0].at)}ms`);

  const transitionSamples = frames.flatMap((frame) => frame.activeTransitions);
  const properties = new Set(transitionSamples.map(({ property }) => property));
  for (const property of ["width", "margin-left", "left"]) {
    assert.ok(properties.has(property), `${direction}: browser reports a running ${property} transition`);
  }
  assert.ok(transitionSamples.every(({ duration, easing }) => duration === 320 && easing === "cubic-bezier(0.22, 1, 0.36, 1.06)"), `${direction}: all active CSS transitions use the shared 320ms bounce easing`);
}

async function shellAnimations(page) {
  return page.evaluate(() => [".sidebar", ".sidebar-toggle", ".nav-item", ".experimental-trigger", ".syllabus-nav", ".main-content", ".desktop-topbar", ".mountain-backdrop"]
    .flatMap((selector) => [...document.querySelector(selector).getAnimations()]
      .filter((animation) => animation.playState === "running" || animation.playState === "pending")
      .map((animation) => ({ selector, property: animation.transitionProperty }))));
}

async function assertStaticLanding(page, expectedCollapsed, description) {
  await page.waitForTimeout(35);
  const settled = await metrics(page);
  assert.equal(settled.sidebarWidth < 100, expectedCollapsed, `${description}: sidebar reaches the requested endpoint`);
  assert.deepEqual(await shellAnimations(page), [], `${description}: no shell transition remains active`);
  assertSquareWidgets(settled, description);
  return settled;
}

function assertReversalStartsSmoothly(before, firstFrame) {
  const start = shellTrackValues(before);
  const next = shellTrackValues(firstFrame);
  for (const name of shellTrackNames) {
    assert.ok(Math.abs(next[name] - start[name]) < 18, `rapid reversal keeps ${name} continuous (${start[name].toFixed(2)} → ${next[name].toFixed(2)})`);
  }
}

try {
  browser = await playwright.chromium.launch(launchOptions);
  let collapsedDesktop;
  const { context: collapsedContext, page: collapsedPage } = await openPage({ value: "true" });
  try {
    const initial = await metrics(collapsedPage);
    collapsedDesktop = initial;
    assert.equal(initial.rootValue, "true", "the before-hydration bootstrap sees the saved collapsed preference");
    assert.ok(initial.sidebarWidth < 100, `desktop sidebar is collapsed on first render (${initial.sidebarWidth}px)`);
    assert.equal(initial.labelDisplay, "none", "collapsed navigation labels are hidden before hydration");
    assertSquareWidgets(initial, "saved collapsed first paint");
    assert.deepEqual(await shellAnimations(collapsedPage), [], "saved collapsed preference does not animate the shell on first paint");
  } finally { await collapsedContext.close(); }

  const { context: expandedContext, page: expandedPage } = await openPage({ value: "false" });
  try {
    const initial = await metrics(expandedPage);
    assert.equal(initial.rootValue, "false", "false is represented explicitly by the early script");
    assert.ok(initial.sidebarWidth > 200, `desktop sidebar remains expanded (${initial.sidebarWidth}px)`);
    assert.notEqual(initial.labelDisplay, "none", "expanded navigation labels remain visible");
    assert.ok(collapsedDesktop.contentLeft < initial.contentLeft, "desktop content reflows to use the space released by the collapsed sidebar");
    assert.ok(initial.dateVisible, "the desktop date control is present");
    assert.notEqual(initial.brandDisplay, "none", "the brand text is visible in the expanded sidebar");
    assert.ok(Math.abs(initial.brandCopy.left - initial.navIconLeft) < 1, "header text aligns with the navigation icon inset without reserving logo space");
    assert.notEqual(initial.experimentalLabelDisplay, "none", "expanded experimental navigation label is visible");
    assert.ok(initial.greeting.width > 0 && initial.today.width > 0 && initial.controls.width > 0, "greeting, Today panel, and workspace controls render in the fixture");
    assertSquareWidgets(initial, "saved expanded first paint");
    assert.deepEqual(await shellAnimations(expandedPage), [], "saved expanded preference does not animate the shell on first paint");

    const collapsedTransition = await captureToggle(expandedPage);
    const collapsed = await metrics(expandedPage);
    assert.equal(collapsed.rootValue, "true", "collapse updates the same root preference used by production CSS");
    assert.equal(collapsed.labelDisplay, "none", "collapsed navigation labels keep their existing display behavior");
    assert.equal(collapsed.experimentalLabelDisplay, "none", "collapsed experimental label remains hidden");
    assert.equal(collapsed.brandDisplay, "none", "the brand text keeps its collapsed display behavior");
    assertSynchronizedMotion(collapsedTransition.before, collapsed, collapsedTransition.frames, "collapse");
    assert.ok(collapsed.greeting.width > initial.greeting.width && collapsed.today.width > initial.today.width, "page content expands into the space released by the sidebar");
    assert.ok(collapsed.controls.width > initial.controls.width, "workspace controls follow the wider main content");

    const expandedTransition = await captureToggle(expandedPage);
    const expandedAgain = await metrics(expandedPage);
    assert.equal(expandedAgain.rootValue, "false", "expansion restores the saved preference state");
    assert.notEqual(expandedAgain.labelDisplay, "none", "expanded navigation labels return");
    assert.notEqual(expandedAgain.brandDisplay, "none", "the brand text returns with the expanded sidebar");
    assert.notEqual(expandedAgain.experimentalLabelDisplay, "none", "the experimental label returns with the expanded sidebar");
    assertSynchronizedMotion(expandedTransition.before, expandedAgain, expandedTransition.frames, "expansion");

    const interruptedCollapse = await captureToggle(expandedPage, 75);
    const interruptedProgress = (interruptedCollapse.frames.at(-1).sidebarWidth - initial.sidebarWidth)
      / (collapsed.sidebarWidth - initial.sidebarWidth);
    assert.ok(interruptedProgress > 0.05 && interruptedProgress < 0.98, "rapid reversal starts while collapse is visibly in flight");
    const reversal = await captureToggle(expandedPage);
    assertReversalStartsSmoothly(reversal.before, reversal.frames[0]);
    const settledExpanded = await assertStaticLanding(expandedPage, false, "rapid reversal");
    for (const name of shellTrackNames) {
      assert.ok(Math.abs(shellTrackValues(settledExpanded)[name] - shellTrackValues(initial)[name]) < 0.5, `rapid reversal settles back to expanded ${name}`);
    }
  } finally { await expandedContext.close(); }

  for (const options of [{}, { value: "unexpected" }, { blocked: true }]) {
    const { context, page } = await openPage(options);
    try {
      const initial = await metrics(page);
      assert.equal(initial.rootValue, null, "missing, invalid, and blocked storage leave the default root state unset");
      assert.ok(initial.sidebarWidth > 200, `default desktop sidebar remains expanded (${initial.sidebarWidth}px)`);
    } finally { await context.close(); }
  }

  const { context: mobileContext, page: mobilePage } = await openPage({ value: "true", width: 390 });
  try {
    const initial = await metrics(mobilePage);
    assert.equal(initial.rootValue, "true", "the preference is still available on mobile");
    assert.ok(initial.sidebarWidth >= 219 && initial.sidebarWidth <= 221, `mobile drawer keeps its normal width (${initial.sidebarWidth}px)`);
    assert.notEqual(initial.labelDisplay, "none", "mobile navigation labels remain visible");
    assert.equal(initial.contentLeft, 0, "mobile main content begins at the viewport edge");
    assert.equal(initial.backdrop.left, 0, "mobile backdrop stays anchored to the viewport");
    const drawerFrames = await mobilePage.evaluate(async () => {
      document.querySelector(".mobile-open").click();
      const frames = [];
      const startedAt = performance.now();
      return await new Promise((resolve) => {
        const sample = () => {
          frames.push({
            contentLeft: document.querySelector(".main-content").getBoundingClientRect().left,
            backdropLeft: document.querySelector(".mountain-backdrop").getBoundingClientRect().left,
          });
          if (performance.now() - startedAt >= 380) resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
    });
    assert.ok(drawerFrames.length >= 8, "mobile drawer was sampled across its rendered opening frames");
    assert.ok(drawerFrames.every(({ contentLeft, backdropLeft }) => Math.abs(contentLeft) < 0.1 && Math.abs(backdropLeft) < 0.1), "mobile drawer overlays without shifting the main content or backdrop");
    await mobilePage.locator(".sidebar-close").click();
    await mobilePage.waitForTimeout(380);
    assert.ok(Math.abs((await metrics(mobilePage)).contentLeft) < 0.1, "closing the mobile drawer still does not shift content");
  } finally { await mobileContext.close(); }

  for (const options of [{ accountMotion: true }, { reducedMotion: "reduce" }]) {
    const { context, page } = await openPage({ value: "false", ...options });
    try {
      assert.deepEqual(await shellAnimations(page), [], "reduced-motion preference has no initial shell transition");
      const reducedTransition = await captureToggle(page, 45);
      assert.ok(reducedTransition.frames.length >= 1, "reduced-motion toggle was sampled in the browser");
      assert.ok(reducedTransition.frames.every((frame) => frame.activeTransitions.every(({ duration }) => duration <= 0.01)), `${options.accountMotion ? "account" : "OS"} reduced-motion reduces shell transitions to at most 0.01ms`);
      const settled = await assertStaticLanding(page, true, options.accountMotion ? "account reduced motion" : "OS reduced motion");
      assert.ok(reducedTransition.frames.every((frame) => Math.min(
        Math.abs(frame.sidebarWidth - reducedTransition.before.sidebarWidth),
        Math.abs(frame.sidebarWidth - settled.sidebarWidth),
      ) < 1.5), "reduced-motion frames stay at the starting or destination geometry without a visible in-between size");
      assert.equal(settled.labelDisplay, "none", "reduced motion still applies the collapsed layout and labels");
    } finally { await context.close(); }
  }

  assert.deepEqual(errors, [], "browser console and page errors are empty");
  console.log("Sidebar motion browser QA passed: synchronized collapse/expansion, reversal, saved first paint, reduced motion, mobile overlay, and square widgets.");
} finally {
  if (browser) await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}
