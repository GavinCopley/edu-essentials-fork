#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(projectRoot, ".vinext/verify-sidebar-navigation");
const serverBundle = resolve(outputDir, "nitro/server/index.mjs");
const resultPath = resolve(outputDir, "result.json");
const profile = {
  id: "navigation-fixture-profile",
  auth_user_id: "navigation-fixture-auth-user",
  email: "navigation-fixture@example.invalid",
  display_name: "Navigation Fixture",
  last_name: "",
  university: "Fixture University",
  major: "",
  academic_year: "",
  birthday: "",
  school_type: "college",
  graduation_year: "",
  program_length: "",
  study_goal: "",
  academic_structure: "",
  gpa_system: "4.0 scale",
  current_term: "",
  week_starts_on: "Sunday",
  timezone: "America/Los_Angeles",
  age: null,
  avatar_url: null,
  onboarding_completed_at: "2026-10-12T00:00:00.000Z",
  initialized: true,
  updated_at: "2026-10-12T00:00:00.000Z",
  preferences: {
    theme: "light",
    reducedMotion: false,
    highContrast: true,
    deadlineReminders: true,
    dailyStudyPlan: true,
    streakNudges: false,
  },
};
const workspace = {
  v: 2,
  a: "fixture-day",
  w: [["fixture-day", "Fixture Day", [[12, 1, "fixture-notes", 0]]]],
  t: [""],
  b: [],
  h: [],
  ts: [],
  rp: [],
  d: { assignments: [], manualEvents: [], dashboardView: "cards" },
};
const destinations = [
  ["Courses", "/dashboard", "main > .dashboard-page", "Your classes"],
  ["Calendar", "/calendar", "main > .calendar-page > .planner-heading h1", null],
  ["Tasks", "/tasks", "main > .page:not([hidden]) > .page-heading h1", "Tasks"],
  ["Files", "/files", "main > div:not([hidden]) > .files-page > .page-heading h1", "Your private files"],
  ["Ask Edu", "/assistant", "main > .assistant-page > .page-heading h1", "Ask Edu"],
  ["Settings", "/settings", "main > div:not([hidden]) > .settings-page > .page-heading h1", "Settings"],
  ["Home", "/home", "main .home-page", null],
];
const apiRequests = [];
const responses = [];
const documentRequests = [];
const consoleErrors = [];
const pageErrors = [];
const localRequestFailures = [];
const blockedExternalRequests = [];
const navigationResults = [];
const historyResults = [];
let initialTransientState = null;
let browser;
let context;
let page;
let server;
let baseUrl;
let initialDocumentRequestCount = 0;
let fatalError = null;
let screenshotPath = null;
let rootEntry = null;
let buildChild;
let buildDurationMs = null;
let buildOutputTail = "";

function fixtureWorkspaceResponse() {
  return {
    initialized: true,
    profile,
    courses: [],
    dashboard: workspace,
    revision: "2026-10-12T00:00:00.000Z",
  };
}

function sanitizedEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (/^(SUPABASE|NEXT_PUBLIC_SUPABASE|VITE_SUPABASE|DATABASE_URL|POSTGRES_URL)/i.test(key)) delete env[key];
  }
  return env;
}

async function buildFixture() {
  await fs.rm(outputDir, { recursive: true, force: true });
  const startedAt = Date.now();
  const viteCli = resolve(projectRoot, "node_modules/vite/bin/vite.js");
  buildChild = spawn(process.execPath, [viteCli, "build", "--config", "tests/fixtures/sidebar-navigation.vite.config.ts"], {
    cwd: projectRoot,
    env: sanitizedEnv({ EDU_NAVIGATION_TEST: "1", NITRO_PRESET: "node-server", NODE_ENV: "production", FILES_BROWSER_ENABLED: "false" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rememberOutput = (chunk) => { buildOutputTail = `${buildOutputTail}${chunk}`.slice(-6_000); };
  buildChild.stdout.setEncoding("utf8");
  buildChild.stderr.setEncoding("utf8");
  buildChild.stdout.on("data", rememberOutput);
  buildChild.stderr.on("data", rememberOutput);
  await new Promise((resolveBuild, rejectBuild) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      buildChild.kill("SIGTERM");
      setTimeout(() => buildChild?.kill("SIGKILL"), 5_000).unref();
    }, 100_000);
    buildChild.once("error", (error) => { clearTimeout(timeout); rejectBuild(error); });
    buildChild.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) rejectBuild(new Error(`Navigation fixture build exceeded 100 seconds.\n${buildOutputTail}`));
      else if (code !== 0) rejectBuild(new Error(`Navigation fixture build exited with ${code ?? signal}.\n${buildOutputTail}`));
      else resolveBuild();
    });
  });
  buildDurationMs = Date.now() - startedAt;
  buildChild = null;
}

async function findFreePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function waitForServer(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fixture server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/home`);
      if (response.ok) return;
    } catch {
      // The server may still be binding its loopback port; retry until the deadline.
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for the isolated fixture server.");
}

function contentSelectorFor(destination) {
  return destination[2];
}

async function assertContent(destination) {
  const content = page.locator(contentSelectorFor(destination));
  await content.waitFor({ state: "visible", timeout: 10_000 });
  const text = (await content.innerText()).trim();
  if (!text) throw new Error(`${destination[0]} rendered an empty content region.`);
  if (destination[3] && !text.includes(destination[3])) {
    throw new Error(`${destination[0]} content did not include ${JSON.stringify(destination[3])}.`);
  }
  return text.replace(/\s+/g, " ").slice(0, 120);
}

async function readTransientState() {
  const searchInput = page.locator('input[aria-label="Search assignments, classes, and files"]');
  const quickNotesInput = page.locator('textarea[aria-label="Quick notes"]');
  const [searchCount, notesCount] = await Promise.all([searchInput.count(), quickNotesInput.count()]);
  return {
    searchDraft: searchCount ? await searchInput.inputValue() : null,
    quickNotesDraft: notesCount ? await quickNotesInput.inputValue() : null,
  };
}

async function assertDocumentState() {
  const marker = await page.evaluate(() => window.__sidebarNavigationMarker ?? null);
  if (marker !== "fixture-document-marker") throw new Error("The page document was replaced during client navigation.");
  if (documentRequests.length !== initialDocumentRequestCount) throw new Error("A sidebar click caused a document reload.");
}

async function clickAndCapture([label, pathname, selector, expectedContent], mode) {
  const before = new URL(page.url()).pathname;
  let clickError = null;
  try {
    await page.locator(`#workspace-sidebar a[aria-label='${label}']`).click({ timeout: 5_000 });
  } catch (error) {
    clickError = error instanceof Error ? error.message : String(error);
  }

  let content = "";
  let assertionError = null;
  try {
    await page.waitForFunction((target) => location.pathname === target, pathname, { timeout: 8_000 });
    await page.waitForFunction((target) => document.querySelector("#workspace-sidebar a[aria-current='page']")?.getAttribute("href") === target, pathname, { timeout: 8_000 });
    content = await assertContent([label, pathname, selector, expectedContent]);
    await assertDocumentState();
  } catch (error) {
    assertionError = error instanceof Error ? error.message : String(error);
  }
  const result = {
    mode,
    label,
    from: before,
    to: new URL(page.url()).pathname,
    expected: pathname,
    activeLink: await page.locator("#workspace-sidebar a[aria-current='page']").getAttribute("href").catch(() => null),
    content,
    transientState: await readTransientState(),
    clickError,
    assertionError,
  };
  navigationResults.push(result);
  if (clickError || assertionError) throw new Error(`${mode} ${label} failed: ${clickError ?? assertionError}`);
}

async function fulfillJson(route, status, body) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

try {
  await buildFixture();
  const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
  const playwrightSpecifier = isAbsolute(playwrightModule) || playwrightModule.startsWith(".")
    ? pathToFileURL(resolve(projectRoot, playwrightModule)).href
    : playwrightModule;
  const { chromium } = await import(playwrightSpecifier);
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [serverBundle], {
    cwd: projectRoot,
    env: sanitizedEnv({ PORT: String(port), HOST: "127.0.0.1", FILES_BROWSER_ENABLED: "false" }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverStderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { serverStderr = `${serverStderr}${chunk}`.slice(-4_000); });
  await waitForServer(server).catch((error) => {
    if (serverStderr) throw new Error(`${error.message}\n${serverStderr}`);
    throw error;
  });

  const launchOptions = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
  else launchOptions.channel = "chrome";
  browser = await chromium.launch(launchOptions);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  const origin = new URL(baseUrl).origin;
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;
    if (request.resourceType() === "document") documentRequests.push({ method: request.method(), path: url.pathname });
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin) responses.push({ method: response.request().method(), path: url.pathname, status: response.status(), contentType: response.headers()["content-type"] ?? null });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) localRequestFailures.push({ method: request.method(), path: url.pathname, error: request.failure()?.errorText });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      blockedExternalRequests.push({ method: request.method(), origin: url.origin, path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    apiRequests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/workspace" && request.method() === "GET") return fulfillJson(route, 200, fixtureWorkspaceResponse());
    if (url.pathname === "/api/workspace" && ["PUT", "POST"].includes(request.method())) return fulfillJson(route, 200, { ok: true, revision: "fixture-revision" });
    if (url.pathname === "/api/files" && request.method() === "GET") return fulfillJson(route, 200, { files: [] });
    if (url.pathname === "/api/profile" && request.method() === "GET") return fulfillJson(route, 200, { profile });
    if (url.pathname === "/api/ai/access" && request.method() === "GET") return fulfillJson(route, 200, { eligible: false, enabled: false, mode: "disabled" });
    if (url.pathname.startsWith("/api/ai/")) return fulfillJson(route, 200, { enabled: false, mode: "disabled", result: null });
    return fulfillJson(route, 404, { error: "No isolated API fixture for this endpoint." });
  });

  const workspaceResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === "/api/workspace" && response.request().method() === "GET" && response.status() === 200;
  }, { timeout: 20_000 });
  const initialNavigationPromise = page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await Promise.all([workspaceResponsePromise, initialNavigationPromise]);
  await page.waitForFunction(() => document.querySelector("#workspace-sidebar a[aria-current='page']")?.getAttribute("href") === "/home", null, { timeout: 20_000 });
  const notesInput = page.locator('textarea[aria-label="Quick notes"]');
  await notesInput.waitFor({ state: "visible", timeout: 20_000 });
  rootEntry = { requestedPath: "/", finalPath: new URL(page.url()).pathname };
  if (rootEntry.finalPath !== "/home") throw new Error("The fixture root route did not redirect to Home.");
  initialDocumentRequestCount = documentRequests.length;
  await page.evaluate(() => { window.__sidebarNavigationMarker = "fixture-document-marker"; });

  // Wait for a React event to take effect before filling controlled inputs.
  await page.locator("#workspace-sidebar .sidebar-toggle").click();
  await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed"), null, { timeout: 5_000 });
  await page.locator("#workspace-sidebar .sidebar-toggle").click();
  await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("sidebar-collapsed"), null, { timeout: 5_000 });

  await page.getByLabel("Search assignments, classes, and files").fill("navigation draft");
  await page.waitForFunction(() => document.querySelector('input[aria-label="Search assignments, classes, and files"]')?.value === "navigation draft", null, { timeout: 5_000 });
  await notesInput.fill("in-memory navigation draft");
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Quick notes"]')?.value === "in-memory navigation draft", null, { timeout: 5_000 });
  initialTransientState = await readTransientState();

  for (const destination of destinations) await clickAndCapture(destination, "desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const destination of destinations) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    const link = page.locator(`#workspace-sidebar a[aria-label='${destination[0]}']`);
    if (!(await link.isVisible())) throw new Error(`Mobile sidebar did not show ${destination[0]}.`);
    await clickAndCapture(destination, "mobile-sidebar");
  }

  await page.evaluate(() => history.back());
  await page.waitForFunction(() => location.pathname === "/settings", null, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector("#workspace-sidebar a[aria-current='page']")?.getAttribute("href") === "/settings", null, { timeout: 10_000 });
  historyResults.push({ direction: "back", pathname: new URL(page.url()).pathname, activeLink: await page.locator("#workspace-sidebar a[aria-current='page']").getAttribute("href"), transientState: await readTransientState() });
  await assertContent(destinations.find((item) => item[1] === "/settings"));
  await assertDocumentState();
  await page.evaluate(() => history.forward());
  await page.waitForFunction(() => location.pathname === "/home", null, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector("#workspace-sidebar a[aria-current='page']")?.getAttribute("href") === "/home", null, { timeout: 10_000 });
  historyResults.push({ direction: "forward", pathname: new URL(page.url()).pathname, activeLink: await page.locator("#workspace-sidebar a[aria-current='page']").getAttribute("href"), transientState: await readTransientState() });
  await assertContent(destinations.find((item) => item[1] === "/home"));
  await assertDocumentState();
  if (consoleErrors.length) throw new Error(`Browser reported ${consoleErrors.length} console errors.`);
  if (pageErrors.length) throw new Error(`Browser reported ${pageErrors.length} page errors.`);
  if (localRequestFailures.length) throw new Error(`Fixture had ${localRequestFailures.length} failed same-origin requests.`);
  if (blockedExternalRequests.length) throw new Error(`Fixture attempted ${blockedExternalRequests.length} off-origin requests.`);
  if (consoleErrors.some((message) => message.includes("RSC prefetch setup error"))) {
    throw new Error("Vinext reported an RSC prefetch setup error.");
  }
} catch (error) {
  fatalError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (page) {
    screenshotPath = resolve(outputDir, "failure.png");
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => { screenshotPath = null; });
  }
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolveExit) => server.once("exit", resolveExit)), delay(3_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (buildChild && buildChild.exitCode === null) buildChild.kill("SIGTERM");
  const result = {
    baseUrl,
    buildDurationMs,
    buildOutputTail: fatalError ? buildOutputTail : undefined,
    rootEntry,
    initialTransientState,
    fatalError,
    screenshotPath,
    initialDocumentRequestCount,
    documentRequests,
    navigationResults,
    historyResults,
    apiRequests,
    responses,
    consoleErrors,
    prefetchSetupErrorCount: consoleErrors.filter((message) => message.includes("RSC prefetch setup error")).length,
    pageErrors,
    localRequestFailures,
    blockedExternalRequests,
  };
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    status: fatalError ? "failed" : "passed",
    desktopClicks: navigationResults.filter((item) => item.mode === "desktop").length,
    mobileClicks: navigationResults.filter((item) => item.mode === "mobile-sidebar").length,
    historyResults,
    rootEntry: result.rootEntry,
    consoleErrors: consoleErrors.length,
    prefetchSetupErrorCount: result.prefetchSetupErrorCount,
    pageErrors: pageErrors.length,
    localRequestFailures: localRequestFailures.length,
    blockedExternalRequests: blockedExternalRequests.length,
    resultPath,
  }, null, 2));
}

if (fatalError) process.exitCode = 1;
