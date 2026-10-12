import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { clientModule } from "./helpers/client-modules.mjs";

const homeSkeleton = await import(await clientModule("lib/home-skeleton.ts"));
const { calculateWidgetPlacements } = await import(await clientModule("lib/widget-layout.ts"));
const { createElement, act } = await import("react");
const readCached = (accountId) => homeSkeleton.readHomeSkeletonLayout(accountId).layout;
const layoutShape = (layout) => ({
  version: layout.version,
  widgets: layout.widgets,
  todayHidden: layout.todayHidden,
  gap: layout.gap,
  todaySectionCount: layout.todaySectionCount ?? 3,
});

function assertNoOverlap(placements, columns, label) {
  const occupied = new Set();
  for (const placement of placements) {
    assert.ok(placement.column >= 1 && placement.column + placement.columnSpan - 1 <= columns, `${label}: placement stays within ${columns} columns`);
    assert.ok(placement.row >= 1 && placement.rowSpan >= 1, `${label}: placement has a positive row footprint`);
    for (let row = placement.row; row < placement.row + placement.rowSpan; row++) {
      for (let column = placement.column; column < placement.column + placement.columnSpan; column++) {
        const cell = `${column},${row}`;
        assert.ok(!occupied.has(cell), `${label}: no two cards occupy ${cell}`);
        occupied.add(cell);
      }
    }
  }
  return occupied;
}

function installDom(url = "https://edu.example.invalid/home") {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url, pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ["window", "document", "Element", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Node", "MouseEvent", "KeyboardEvent", "PopStateEvent", "MutationObserver", "localStorage", "requestAnimationFrame", "cancelAnimationFrame"]) {
    globalThis[name] = name === "localStorage" ? window.localStorage : window[name];
  }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = (query) => ({ matches: query.includes("prefers-reduced-motion") ? false : false, media: query, addEventListener() {}, removeEventListener() {} });
  window.confirm = () => true;
  window.alert = () => {};
  window.scrollTo = () => {};
  return dom;
}

const mixedLayout = () => ({
  version: 1,
  widgets: [
    { size: "small", startsNewMiniBlock: false },
    { size: "mini", startsNewMiniBlock: false },
    { size: "mini", startsNewMiniBlock: true },
    { size: "medium", startsNewMiniBlock: false },
  ],
  todayHidden: true,
  gap: 28,
});

function assertSkeletonLayout(root, layout, label) {
  const skeleton = root.querySelector(".home-skeleton");
  assert.ok(skeleton, `${label}: skeleton renders`);
  const cards = [...skeleton.querySelectorAll(".home-skeleton__card[data-size]")];
  assert.deepEqual(cards.map((card) => ({
    size: card.getAttribute("data-size"),
    startsNewMiniBlock: card.getAttribute("data-mini-start") === "true",
  })), layout.widgets.map((widget) => ({ size: widget.size, startsNewMiniBlock: widget.startsNewMiniBlock })), `${label}: cached card order, size, and mini grouping are shown`);
  assert.equal(Boolean(skeleton.querySelector(".home-skeleton__today")), !layout.todayHidden, `${label}: Today placeholder follows the cached visibility`);
  assert.equal(skeleton.querySelectorAll("[data-widget-id]").length, 0, `${label}: skeleton cards never impersonate live widgets`);
  return skeleton;
}

test("the no-cache fallback is a safe mixed responsive layout built with live widget placement rules", () => {
  const fallback = homeSkeleton.DEFAULT_HOME_SKELETON_LAYOUT;
  assert.equal(fallback.version, 1);
  assert.ok(fallback.widgets.some(({ size }) => size === "mini"), "fallback includes mini cards");
  assert.ok(fallback.widgets.some(({ size }) => size === "small"), "fallback includes small cards");
  assert.ok(fallback.widgets.some(({ size }) => size === "medium"), "fallback includes horizontal medium cards");
  assert.equal(fallback.todayHidden, false, "new accounts begin with Today visible");

  const placements = homeSkeleton.getHomeSkeletonPlacements(fallback);
  assert.equal(placements.desktop.length, fallback.widgets.length);
  assert.equal(placements.phone.length, fallback.widgets.length);
  assertNoOverlap(placements.desktop, 4, "default desktop fallback");
  assertNoOverlap(placements.phone, 2, "default phone fallback");
  assert.deepEqual(
    placements.desktop,
    calculateWidgetPlacements(fallback.widgets.map(({ size }) => size), 4, fallback.widgets.map(({ startsNewMiniBlock }) => startsNewMiniBlock)),
    "desktop skeleton placement uses the live row-major widget algorithm, including mini breaks",
  );
  assert.deepEqual(
    placements.phone,
    calculateWidgetPlacements(fallback.widgets.map(({ size }) => size), 2, fallback.widgets.map(({ startsNewMiniBlock }) => startsNewMiniBlock)),
    "phone skeleton placement uses the live row-major widget algorithm, including mini breaks",
  );
});

test("layout snapshots retain order, size, mini grouping, Today visibility, and custom gap", () => {
  const layout = mixedLayout();
  const workspace = {
    widgets: layout.widgets.map((widget, index) => ({ ...widget, instanceId: `live-${index}`, type: "notes" })),
    todayHidden: layout.todayHidden,
  };
  const created = homeSkeleton.createHomeSkeletonLayout(workspace, layout.gap);
  assert.deepEqual(created, layout);
  assert.equal(homeSkeleton.layoutsMatch(created, { ...layout, widgets: layout.widgets.map((widget) => ({ ...widget })) }), true, "equivalent snapshots match by value");
  assert.equal(homeSkeleton.layoutsMatch(layout, { ...layout, gap: 16 }), false, "a gap difference affects layout matching");
  assert.equal(homeSkeleton.layoutsMatch(layout, { ...layout, todayHidden: false }), false, "Today visibility affects layout matching");
  assert.equal(homeSkeleton.layoutsMatch(layout, { ...layout, widgets: [...layout.widgets].reverse() }), false, "widget order affects layout matching");
  assert.equal(homeSkeleton.layoutsMatch(layout, { ...layout, widgets: layout.widgets.map((widget, index) => index === 1 ? { ...widget, startsNewMiniBlock: true } : widget) }), false, "mini grouping affects layout matching");
  assert.equal(homeSkeleton.layoutsMatch(layout, { ...layout, version: 99 }), false, "unsupported snapshot versions do not match");
  const oneSection = homeSkeleton.createHomeSkeletonLayout({ ...workspace, todaySections: ["next-class"] }, layout.gap);
  assert.equal(oneSection.todaySectionCount, 1, "a customized Today panel records its section count");
  assert.equal(homeSkeleton.layoutsMatch(created, oneSection), false, "Today section count participates in coarse shape matching");
});

test("local cache is account-scoped, validates corrupt values, and tolerates unavailable storage", () => {
  const dom = installDom();
  try {
    const layout = mixedLayout();
    assert.deepEqual(homeSkeleton.readHomeSkeletonLayout("account-a"), { layout: null, readable: true }, "a missing cache is safe to initialize later");
    assert.equal(homeSkeleton.writeHomeSkeletonLayout("account-a", layout), true);
    assert.deepEqual(readCached("account-a"), layout);
    assert.ok(readCached("account-b") == null, "one account never reads another account's layout");
    assert.equal(window.localStorage.getItem("edu-essentials:home-skeleton:v1:account-a"), JSON.stringify(layout));

    const malformed = [
      { ...layout, version: 7 },
      { ...layout, gap: 1000 },
      { ...layout, todayHidden: "yes" },
      { ...layout, widgets: [{ size: "giant", startsNewMiniBlock: false }] },
      { ...layout, widgets: [{ size: "small", startsNewMiniBlock: "yes" }] },
      { ...layout, widgets: Array(1000).fill({ size: "small", startsNewMiniBlock: false }) },
    ];
    for (const value of malformed) {
      window.localStorage.setItem("edu-essentials:home-skeleton:v1:account-a", JSON.stringify(value));
      const result = homeSkeleton.readHomeSkeletonLayout("account-a");
      assert.equal(result.readable, true, "valid storage remains writable after a malformed value");
      assert.ok(result.layout == null, "malformed cache data is ignored");
    }

    const measured = {
      ...layout,
      todaySectionCount: 1,
      geometry: { viewportWidth: 1280, contentWidth: 980, todayHeight: 177, toolbarHeight: 38 },
    };
    assert.equal(homeSkeleton.writeHomeSkeletonLayout("account-a", measured), true, "optional same-viewport geometry is a valid cache extension");
    assert.deepEqual(readCached("account-a"), measured, "the cache preserves measured Today and toolbar hints");
    assert.equal(homeSkeleton.layoutsMatch(measured, { ...measured, geometry: { ...measured.geometry, todayHeight: 182 } }), true, "the server shape comparison ignores optional measured hints");
    assert.equal(homeSkeleton.cacheLayoutsMatch(measured, { ...measured, geometry: { ...measured.geometry, todayHeight: 178 } }), true, "one-pixel measured drift remains the same stored hint");
    assert.equal(homeSkeleton.cacheLayoutsMatch(measured, { ...measured, geometry: { ...measured.geometry, todayHeight: 180 } }), false, "materially changed measured geometry refreshes the local hint");
    assert.equal(homeSkeleton.layoutsMatch(measured, { ...measured, todaySectionCount: 2 }), false, "Today section count changes the skeleton geometry");
    assert.equal(homeSkeleton.cacheLayoutsMatch(measured, { ...measured, geometry: { ...measured.geometry, viewportWidth: 1282 } }), false, "a different measured viewport refreshes the local hint");
    const invalidMetrics = [
      { ...measured, todaySectionCount: 0 },
      { ...measured, geometry: { ...measured.geometry, contentWidth: -1 } },
    ];
    for (const value of invalidMetrics) {
      window.localStorage.setItem("edu-essentials:home-skeleton:v1:account-a", JSON.stringify(value));
      assert.equal(homeSkeleton.readHomeSkeletonLayout("account-a").layout, null, "invalid optional metrics safely fall back to the mixed default");
    }
    window.localStorage.setItem("edu-essentials:home-skeleton:v1:account-a", "{not-json");
    const malformedJson = homeSkeleton.readHomeSkeletonLayout("account-a");
    assert.equal(malformedJson.readable, true, "accessible storage with malformed JSON can be repaired after a server read");
    assert.ok(malformedJson.layout == null, "malformed JSON falls back to the default layout");

    const originalWindowStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
    const originalGlobalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
      assert.deepEqual(homeSkeleton.readHomeSkeletonLayout("account-a"), { layout: null, readable: false });
    assert.equal(homeSkeleton.writeHomeSkeletonLayout("account-a", layout), false, "blocked storage cannot be overwritten");
    } finally {
      if (originalWindowStorage) Object.defineProperty(window, "localStorage", originalWindowStorage);
      if (originalGlobalStorage) Object.defineProperty(globalThis, "localStorage", originalGlobalStorage);
    }
  } finally {
    dom.window.close();
  }
});

function makeProfile(validateProfile, id = "home-skeleton-test-profile") {
  return {
    ...validateProfile({ display_name: "Alex", major: "History" }),
    id,
    auth_user_id: `auth-${id}`,
    email: "alex@example.invalid",
    avatar_url: null,
    initialized: true,
    updated_at: "2026-10-08T12:00:00.000Z",
    onboarding_completed_at: "2026-10-07T00:00:00.000Z",
  };
}

function defaultServerWidgets() {
  return [
    { instanceId: "saved-small", type: "notes", size: "small", note: "Saved note" },
    { instanceId: "saved-mini-a", type: "daily-goal", size: "mini" },
    { instanceId: "saved-mini-b", type: "upcoming", size: "mini", startsNewMiniBlock: true },
    { instanceId: "saved-medium", type: "task-completion", size: "medium" },
  ];
}

function installWorkspaceFetch({ failReads = 0, holdReads = true, widgets = defaultServerWidgets(), todayHidden = true, gap = 28, workspaces, activeWorkspaceId = "saved-home" } = {}) {
  let getCalls = 0;
  let writes = 0;
  let failuresRemaining = failReads;
  const pending = [];
  const { encodeWorkspaceState } = globalThis.__homeSkeletonTestModules;
  const profile = globalThis.__homeSkeletonTestProfile;
  const dashboard = encodeWorkspaceState(workspaces ?? [
    { id: "saved-home", name: "Saved Home", widgets, todayHidden },
  ], activeWorkspaceId, "", {
    assignments: [], manualEvents: [], dashboardView: "cards",
    widgetAppearance: { defaults: { ...globalThis.__homeSkeletonTestAppearance.defaultWidgetAppearance, gap }, overrides: {} },
  });
  const successPayload = () => ({ initialized: true, courses: [], dashboard, revision: profile.updated_at, profile });
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("/api/files")) return Response.json({ files: [] });
    assert.ok(url.startsWith("/api/workspace"), `Unexpected test fetch ${url}`);
    if (init.method === "PUT") { writes++; return Response.json({ ok: true, revision: "2026-10-08T12:01:00.000Z" }); }
    if (init.method === "POST") return Response.json({ initialized: true, revision: profile.updated_at });
    getCalls++;
    if (failuresRemaining > 0) { failuresRemaining--; return Response.json({ error: "Workspace is temporarily offline." }, { status: 503 }); }
    if (holdReads) return await new Promise((resolve) => pending.push(resolve));
    return Response.json(successPayload());
  };
  globalThis.fetch = fetcher;
  window.fetch = fetcher;
  return {
    get getCalls() { return getCalls; },
    get writes() { return writes; },
    releaseNext() { pending.shift()?.(Response.json(successPayload())); },
  };
}

async function loadWorkspace() {
  const { validateProfile } = await import(await clientModule("lib/profile.ts"));
  const profile = makeProfile(validateProfile);
  globalThis.__homeSkeletonTestProfile = profile;
  globalThis.__homeSkeletonTestModules = await import(await clientModule("lib/workspace-codec.ts"));
  globalThis.__homeSkeletonTestAppearance = await import(await clientModule("lib/widget-appearance.ts"));
  const { default: Workspace } = await import(await clientModule("app/workspace-client.tsx"));
  return { profile, Workspace };
}

async function waitFor(predicate, description, timeoutMs = 2200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(predicate(), `Timed out waiting for ${description}`);
}

async function renderWorkspace(Workspace, profile, path = "/home") {
  window.history.replaceState({}, "", path);
  const { createRoot } = await import("react-dom/client");
  const rootNode = document.getElementById("root");
  const root = createRoot(rootNode);
  await act(async () => root.render(createElement(Workspace, { initialProfile: profile })));
  return { root, rootNode };
}

function clearHomeGlobals() {
  delete globalThis.__homeSkeletonTestProfile;
  delete globalThis.__homeSkeletonTestModules;
  delete globalThis.__homeSkeletonTestAppearance;
}

test("Workspace restores the account cache before showing its pending skeleton and hydrates without mismatch", async () => {
  const dom = installDom();
  const cached = mixedLayout();
  let root;
  const errors = [];
  const originalConsoleError = console.error;
  try {
    const { profile, Workspace } = await loadWorkspace();
    homeSkeleton.writeHomeSkeletonLayout(profile.id, cached);
    const api = installWorkspaceFetch({ holdReads: true, widgets: defaultServerWidgets(), todayHidden: true, gap: cached.gap });
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const container = document.getElementById("root");
    container.innerHTML = renderToString(createElement(Workspace, { initialProfile: profile }));
    const serverSkeleton = container.querySelector(".home-skeleton");
    if (serverSkeleton) {
      const boundary = serverSkeleton.closest(".home-load-transition");
      assert.ok(serverSkeleton.hidden || serverSkeleton.closest("[hidden]") || serverSkeleton.closest('[aria-hidden="true"]') || boundary?.getAttribute("data-layout-restored") === "false", "SSR does not expose an un-restored fallback as the visible first skeleton");
    }
    console.error = (...args) => { errors.push(args.map(String).join(" ")); originalConsoleError(...args); };
    await act(async () => { root = hydrateRoot(container, createElement(Workspace, { initialProfile: profile })); });
    await waitFor(() => api.getCalls === 1, "the held account workspace read");
    assertSkeletonLayout(container, cached, "restored cache while the server read is held");
    const transition = container.querySelector(".home-load-transition");
    assert.equal(transition?.getAttribute("data-layout-match"), "false", "pending read cannot claim a match before the server responds");
    assert.equal(container.querySelectorAll("[data-widget-id]").length, 0, "pending cache is only a skeleton and does not mutate live workspace state");
    assert.equal(api.writes, 0, "restoring a cache does not save a workspace");
    assert.deepEqual(errors.filter((message) => /hydration|server html|did not match/i.test(message)), [], "the cached client layout hydrates without a markup mismatch");
    assert.deepEqual(readCached(profile.id), cached, "a held read leaves the cached layout intact");

    await act(async () => { api.releaseNext(); await Promise.resolve(); });
    await waitFor(() => container.querySelector('[data-widget-id="saved-small"]'), "saved Home widgets after hydration");
    assert.equal(container.querySelector(".home-skeleton"), null, "a matching server snapshot exits the skeleton state");
    assert.equal(container.querySelector(".home-load-transition")?.getAttribute("data-layout-match"), "true", "the server layout matches the cached sizes, grouping, Today visibility, and gap");
    assert.equal(container.querySelector(".home-today-panel"), null, "saved hidden Today remains hidden");
    assert.deepEqual(readCached(profile.id), cached, "successful hydration retains the matching cache value");
    assert.equal(api.writes, 0, "loading and revealing never write the workspace snapshot");
  } finally {
    console.error = originalConsoleError;
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});

test("a new account with no cache sees the mixed default while its first workspace read is pending", async () => {
  const dom = installDom();
  let root;
  try {
    const { profile, Workspace } = await loadWorkspace();
    assert.deepEqual(homeSkeleton.readHomeSkeletonLayout(profile.id), { layout: null, readable: true });
    const api = installWorkspaceFetch({ holdReads: true });
    const app = await renderWorkspace(Workspace, profile);
    root = app.root;
    await waitFor(() => api.getCalls === 1, "the new account's first workspace read");
    const skeleton = app.rootNode.querySelector(".home-skeleton");
    assert.ok(skeleton, "first account receives a default skeleton instead of a random preset");
    assert.deepEqual([...skeleton.querySelectorAll(".home-skeleton__card")].map((card) => card.getAttribute("data-size")), homeSkeleton.DEFAULT_HOME_SKELETON_LAYOUT.widgets.map(({ size }) => size));
    assert.ok(skeleton.querySelector(".home-skeleton__today"), "the first-account default reserves visible Today");
    assert.equal(app.rootNode.querySelectorAll("[data-widget-id]").length, 0, "unresolved default state does not render live widgets");
    assert.equal(api.writes, 0, "an empty cache does not cause a write before the server read");

    await act(async () => { api.releaseNext(); await Promise.resolve(); });
    await waitFor(() => app.rootNode.querySelector('[data-widget-id="saved-small"]'), "first account's saved widgets");
    assert.deepEqual(layoutShape(readCached(profile.id)), layoutShape(homeSkeleton.createHomeSkeletonLayout({ widgets: defaultServerWidgets(), todayHidden: true }, 28)), "the successful first read initializes the account cache shape");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});

test("malformed JSON falls back safely, survives a failed read, and is repaired after a successful retry", async () => {
  const dom = installDom();
  let root;
  try {
    const { profile, Workspace } = await loadWorkspace();
    const key = "edu-essentials:home-skeleton:v1:" + encodeURIComponent(profile.id);
    window.localStorage.setItem(key, "{malformed");
    assert.deepEqual(homeSkeleton.readHomeSkeletonLayout(profile.id), { layout: null, readable: true });
    const api = installWorkspaceFetch({ failReads: 1, holdReads: true });
    const app = await renderWorkspace(Workspace, profile);
    root = app.root;
    await waitFor(() => app.rootNode.textContent.includes("could not be loaded"), "the failed initial read");
    assert.equal(window.localStorage.getItem(key), "{malformed", "a failed read does not overwrite malformed cache data");
    const retry = [...app.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "Retry loading");
    assert.ok(retry);
    await act(async () => retry.click());
    await waitFor(() => api.getCalls === 2, "the successful retry's held read");
    assert.deepEqual([...app.rootNode.querySelectorAll(".home-skeleton__card")].map((card) => card.getAttribute("data-size")), homeSkeleton.DEFAULT_HOME_SKELETON_LAYOUT.widgets.map(({ size }) => size), "invalid JSON uses the account fallback while retry is pending");
    assert.equal(window.localStorage.getItem(key), "{malformed", "a pending retry does not overwrite malformed data");

    await act(async () => { api.releaseNext(); await Promise.resolve(); });
    await waitFor(() => app.rootNode.querySelector('[data-widget-id="saved-small"]'), "Home after successful retry");
    assert.deepEqual(layoutShape(readCached(profile.id)), layoutShape(homeSkeleton.createHomeSkeletonLayout({ widgets: defaultServerWidgets(), todayHidden: true }, 28)), "successful hydration repairs malformed storage from server state");
    assert.equal(api.writes, 0, "repairing the local cache does not send a workspace write");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});

test("a stale cache stays visible during the read, then fades to the server layout without geometric overlays", async () => {
  const dom = installDom();
  const stale = { ...mixedLayout(), todayHidden: false, gap: 16 };
  let root;
  try {
    const { profile, Workspace } = await loadWorkspace();
    homeSkeleton.writeHomeSkeletonLayout(profile.id, stale);
    const serverWidgets = [
      { instanceId: "server-large", type: "notes", size: "large", note: "Server note" },
      { instanceId: "server-small", type: "pomodoro", size: "small" },
    ];
    const api = installWorkspaceFetch({ holdReads: true, widgets: serverWidgets, todayHidden: false, gap: 24 });
    const app = await renderWorkspace(Workspace, profile);
    root = app.root;
    await waitFor(() => api.getCalls === 1, "the held mismatched workspace read");
    assertSkeletonLayout(app.rootNode, stale, "stale cache before read completion");
    assert.deepEqual(readCached(profile.id), stale, "the server has not overwritten the cache before succeeding");
    assert.equal(api.writes, 0);

    await act(async () => { api.releaseNext(); await Promise.resolve(); });
    await waitFor(() => app.rootNode.querySelector('[data-widget-id="server-large"]'), "server widgets after the mismatched read");
    const transition = app.rootNode.querySelector(".home-load-transition");
    assert.equal(transition?.getAttribute("data-layout-match"), "false", "mismatched layouts take the opacity handoff path");
    assert.deepEqual(readCached(profile.id), {
      version: 1,
      widgets: [
        { size: "large", startsNewMiniBlock: false },
        { size: "small", startsNewMiniBlock: false },
      ],
      todayHidden: false,
      gap: 24,
    }, "the successful server layout refreshes local storage");
    assert.equal(app.rootNode.querySelectorAll(".home-load-transition__surface, .home-load-transition__today-outline").length, 0, "layout mismatches do not create geometry-morph overlays");
    assert.equal(app.rootNode.querySelectorAll('[data-widget-id="saved-small"]').length, 0, "stale cached widgets never enter the live workspace");
    assert.equal(api.writes, 0, "the handoff does not post or put the workspace");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});

test("failed reads preserve the cached layout, and retry keeps using it until the next read succeeds", async () => {
  const dom = installDom();
  const cached = mixedLayout();
  let root;
  try {
    const { profile, Workspace } = await loadWorkspace();
    homeSkeleton.writeHomeSkeletonLayout(profile.id, cached);
    const api = installWorkspaceFetch({ failReads: 1, holdReads: true, todayHidden: true, gap: 28 });
    const app = await renderWorkspace(Workspace, profile);
    root = app.root;
    await waitFor(() => app.rootNode.textContent.includes("could not be loaded"), "first read error");
    assert.equal(app.rootNode.querySelector(".home-skeleton"), null, "an error shows the retry view instead of a stale loading screen");
    assert.deepEqual(readCached(profile.id), cached, "a failed read does not replace the cache");
    assert.equal(api.writes, 0);

    const retry = [...app.rootNode.querySelectorAll("button")].find((button) => button.textContent.trim() === "Retry loading");
    assert.ok(retry);
    await act(async () => retry.click());
    await waitFor(() => api.getCalls === 2, "retry workspace read");
    assertSkeletonLayout(app.rootNode, cached, "cached layout on retry");
    assert.deepEqual(readCached(profile.id), cached, "retry does not clear or replace the cache while pending");
    await act(async () => { api.releaseNext(); await Promise.resolve(); });
    await waitFor(() => app.rootNode.querySelector('[data-widget-id="saved-small"]'), "Home after successful retry");
    assert.deepEqual(readCached(profile.id), cached, "matching retry keeps the cache");
    assert.equal(api.writes, 0, "retry and hydration do not write an unchanged workspace");
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});

test("switching workspaces and changing size or Today visibility refresh the account cache", async () => {
  const dom = installDom();
  let root;
  try {
    const { profile, Workspace } = await loadWorkspace();
    const primary = { id: "saved-home", name: "Saved Home", widgets: defaultServerWidgets(), todayHidden: false };
    const secondary = { id: "secondary-home", name: "Secondary", widgets: [{ instanceId: "secondary-note", type: "notes", size: "large", note: "Secondary note" }], todayHidden: true };
    installWorkspaceFetch({ holdReads: false, workspaces: [primary, secondary], activeWorkspaceId: primary.id });
    const app = await renderWorkspace(Workspace, profile);
    root = app.root;
    await waitFor(() => app.rootNode.querySelector('[data-widget-id="saved-small"]'), "the initial active workspace");
    await waitFor(() => readCached(profile.id)?.widgets.length === primary.widgets.length, "initial workspace cache");
    assert.equal(readCached(profile.id).todayHidden, false);

    const secondaryTab = [...app.rootNode.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === "Secondary");
    assert.ok(secondaryTab, "server workspace switcher includes the secondary layout");
    await act(async () => secondaryTab.click());
    await waitFor(() => readCached(profile.id)?.widgets[0]?.size === "large", "cache after switching workspaces");
    assert.equal(readCached(profile.id).todayHidden, true, "switching workspaces also refreshes cached Today visibility");

    const secondaryCard = app.rootNode.querySelector('[data-widget-id="secondary-note"]');
    const options = secondaryCard?.querySelector('button[aria-label$="options"]');
    assert.ok(options);
    await act(async () => options.click());
    const mediumChoice = [...app.rootNode.querySelectorAll('.widget-menu button[aria-label="Medium horizontal widget"]')][0];
    assert.ok(mediumChoice);
    await act(async () => mediumChoice.click());
    await waitFor(() => readCached(profile.id)?.widgets[0]?.size === "medium", "cache after resizing a widget");

    const customizeButton = app.rootNode.querySelector('.workspace-actions button[aria-pressed]');
    assert.ok(customizeButton, "workspace has a customization toggle");
    if (customizeButton.getAttribute("aria-pressed") !== "true") await act(async () => customizeButton.click());
    const workspaceOptions = app.rootNode.querySelector('button[aria-label="Workspace options"]');
    assert.ok(workspaceOptions, "customization exposes workspace options");
    await act(async () => workspaceOptions.click());
    const restoreToday = app.rootNode.querySelector('button[aria-label="Restore Today section"]');
    assert.ok(restoreToday, "the hidden Today section has a restore action");
    await act(async () => restoreToday.click());
    await waitFor(() => readCached(profile.id)?.todayHidden === false, "cache after restoring Today");

    const primaryTab = [...app.rootNode.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.trim() === "Saved Home");
    assert.ok(primaryTab);
    await act(async () => primaryTab.click());
    await waitFor(() => readCached(profile.id)?.widgets[0]?.size === "small", "cache after switching back");
    assert.equal(readCached(profile.id).todayHidden, false);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    clearHomeGlobals();
  }
});
