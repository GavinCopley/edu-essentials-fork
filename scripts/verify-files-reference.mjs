import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = resolve(repoRoot, ".vinext/verify-files-reference");
const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import("playwright");
const esbuild = process.env.ESBUILD_MODULE
  ? await import(pathToFileURL(resolve(process.env.ESBUILD_MODULE)).href)
  : await import("esbuild");

const cssFiles = [
  "app/globals.css",
  "app/reference-ui.css",
  "app/auth.css",
  "app/home-skeleton.css",
  "app/widget-appearance.css",
  "app/widget-block-layout.css",
  "app/widget-reorder.css",
  "app/files-browser.css",
  "app/files-browser-tools.css",
  "app/files-card-preview.css",
  "app/file-organization-dialogs.css",
  "app/files-trash-dialog.css",
  "app/file-archive-dialog.css",
  "app/file-upload-dialog.css",
  "app/native-document-editor.css",
  "app/course-syllabus.css",
];
const cssSources = await Promise.all(cssFiles.map((file) => readFile(resolve(repoRoot, file), "utf8")));
const bundle = await esbuild.build({
  entryPoints: [resolve(repoRoot, "tests/fixtures/files-reference-browser.tsx")],
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
const css = cssSources.map((source) => source.replace(/^@import[^;]+;\s*/gm, "")).join("\n");
assert.doesNotMatch(css, /files-reference-art\.png/i, "the Files stylesheet bundle does not use the screenshot sprite");
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root { --font-geist-sans: Arial, sans-serif; } .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; }${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const baseUrl = "https://files-reference.test";
const filesLandscape = await readFile(resolve(repoRoot, "public/files-landscape.png"));
const filesEmptyIllustration = await readFile(resolve(repoRoot, "public/files-empty-illustration.png"));
await mkdir(screenshotDir, { recursive: true });

const launchOptions = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors"] };
if (process.env.CHROME_EXECUTABLE) launchOptions.executablePath = process.env.CHROME_EXECUTABLE;
else launchOptions.channel = "chrome";

const errors = [];
const layoutFailures = [];
const servedAssets = [];
let browser;

async function createPage(viewport, scenario, extraQuery = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) {
      // Keep this harness offline. Third-party requests are satisfied locally and
      // the fixture API owns every workspace and file response.
      await route.fulfill({ status: 204, body: "" });
    } else if (url.pathname === "/fixture.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", headers: { "cache-control": "no-store" }, body: js });
    } else if (url.pathname === "/files-landscape.png") {
      servedAssets.push(url.pathname);
      await route.fulfill({ status: 200, contentType: "image/png", body: filesLandscape });
    } else if (url.pathname === "/files-empty-illustration.png") {
      servedAssets.push(url.pathname);
      await route.fulfill({ status: 200, contentType: "image/png", body: filesEmptyIllustration });
    } else if (url.pathname === "/favicon.ico") {
      await route.fulfill({ status: 204, body: "" });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: html });
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(`pageerror at ${viewport.width}px (${scenario}): ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("net::ERR_ABORTED")) {
      errors.push(`console at ${viewport.width}px (${scenario}): ${message.text()}`);
    }
  });
  const search = new URLSearchParams({ scenario, ...extraQuery });
  await page.goto(`${baseUrl}/home?${search}`);
  await enterFilesView(page);
  return { context, page };
}

async function enterFilesView(page) {
  const primaryFilesLink = page.getByRole("link", { name: "Files", exact: true });
  if (await isInViewport(primaryFilesLink, page)) await primaryFilesLink.click();
  else {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await primaryFilesLink.click();
  }
  await page.locator(".files-browser").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor({ state: "visible" });
}

async function isInViewport(locator, page) {
  if (!(await locator.count())) return false;
  const box = await locator.boundingBox();
  if (!box) return false;
  const viewport = page.viewportSize();
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
}

async function fixture(page, expression) {
  return page.evaluate((source) => Function(`return window.__filesReferenceFixture.${source}`)(), expression);
}

async function takeScreenshot(page, name) {
  const viewport = page.viewportSize();
  await page.mouse.move(Math.max(1, viewport.width - 24), Math.max(1, viewport.height - 100));
  await page.screenshot({ path: resolve(screenshotDir, `${name}.png`), animations: "disabled" });
}

async function inspectViewport(page, viewport) {
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const primary = document.querySelector("#workspace-sidebar");
    const secondary = document.querySelector(".files-sidebar");
    const files = document.querySelector(".files-browser");
    const rect = (element) => {
      if (!element) return null;
      const { left, right, width } = element.getBoundingClientRect();
      return { left, right, width };
    };
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      shell: rect(shell),
      primary: rect(primary),
      secondary: rect(secondary),
      files: rect(files),
    };
  });
  const check = (condition, message) => { if (!condition) layoutFailures.push(message); };
  check(Boolean(metrics.files), `the Files workspace renders at ${viewport.width}px`);
  check(metrics.document <= viewport.width + 1, `document has no horizontal overflow at ${viewport.width}px (${metrics.document}px)`);
  check(metrics.body <= viewport.width + 1, `body has no horizontal overflow at ${viewport.width}px (${metrics.body}px)`);
  check(metrics.files.left >= -1 && metrics.files.right <= viewport.width + 1, `Files content fits at ${viewport.width}px (${metrics.files.left}–${metrics.files.right})`);
  check(Boolean(metrics.primary), `the actual Workspace sidebar renders at ${viewport.width}px`);
  check(Boolean(metrics.secondary), `the Files view navigation renders at ${viewport.width}px`);
  if (viewport.width > 700) {
    check(metrics.primary.width >= 160 && metrics.primary.width <= 250, `primary sidebar has a usable desktop width (${metrics.primary.width}px)`);
    check(metrics.secondary.width >= 220 && metrics.secondary.width <= 300, `secondary Files navigation has a usable desktop width (${metrics.secondary.width}px)`);
  }
  return metrics;
}

async function inspectFilesAppearance(page, viewport, { expectEmptyArt = false } = {}) {
  const styles = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const backdrop = document.querySelector(".mountain-backdrop");
    const search = document.querySelector(".files-browser-search-control");
    const emptyArt = document.querySelector(".files-empty-art");
    const rgbaAlpha = (value) => [...value.matchAll(/rgba?\(([^)]+)\)/g)].map((match) => {
      const parts = match[1].split(/\s*,\s*/);
      return parts.length === 4 ? Number(parts[3]) : 1;
    });
    const oldSpriteUses = [...document.querySelectorAll("*")].flatMap((element) => {
      const computed = getComputedStyle(element);
      return [computed.backgroundImage, computed.maskImage, computed.webkitMaskImage]
        .filter((value) => value.includes("files-reference-art.png"));
    });
    return {
      viewport: window.innerWidth,
      shellBackground: shell ? getComputedStyle(shell).backgroundColor : "",
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
      shellBackgroundImage: shell ? getComputedStyle(shell).backgroundImage : "",
      backdropImage: backdrop ? getComputedStyle(backdrop).backgroundImage : "",
      backdropPosition: backdrop ? getComputedStyle(backdrop).backgroundPosition : "",
      searchBackgroundImage: search ? getComputedStyle(search).backgroundImage : "",
      searchBackgroundColor: search ? getComputedStyle(search).backgroundColor : "",
      searchBackdropFilter: search ? getComputedStyle(search).backdropFilter : "",
      searchAlphaStops: search ? rgbaAlpha(getComputedStyle(search).backgroundImage) : [],
      emptyArtBackgroundImage: emptyArt ? getComputedStyle(emptyArt).backgroundImage : "",
      oldSpriteUses,
    };
  });
  const check = (condition, message) => { if (!condition) layoutFailures.push(message); };
  check(styles.oldSpriteUses.length === 0, `computed CSS contains no files-reference-art source at ${viewport.width}px (${styles.oldSpriteUses.join(", ")})`);
  check(styles.backdropImage.includes("files-landscape.png"), `Files uses the clean landscape banner at ${viewport.width}px (${styles.backdropImage})`);
  if (viewport.width >= 821) check(styles.backdropPosition.includes("-20px"), `the desktop Files landscape is shifted to keep the moon above the search glass at ${viewport.width}px (${styles.backdropPosition})`);
  check(styles.shellBackground !== "rgba(0, 0, 0, 0)" && styles.shellBackground !== "transparent", `Files has a painted workspace background at ${viewport.width}px (${styles.shellBackground})`);
  check(styles.bodyBackground !== "rgba(0, 0, 0, 0)" && styles.bodyBackground !== "transparent", `the document body background is painted at ${viewport.width}px (${styles.bodyBackground})`);
  check(styles.searchBackgroundImage.includes("gradient") && styles.searchAlphaStops.some((alpha) => alpha > 0 && alpha < 1), `Files search has a translucent glass background at ${viewport.width}px (${styles.searchBackgroundImage})`);
  if (expectEmptyArt) check(styles.emptyArtBackgroundImage.includes("files-empty-illustration.png"), `the empty state uses its standalone illustration at ${viewport.width}px (${styles.emptyArtBackgroundImage})`);
  console.log(`Files appearance at ${viewport.width}px: ${JSON.stringify(styles)}`);
  return styles;
}

async function clickFilesMenuItem(page, label) {
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
}

async function openNewMenu(page) {
  const trigger = page.getByRole("button", { name: "New", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function closeDialog(page, name) {
  const dialog = page.getByRole("dialog", { name });
  await dialog.getByRole("button", { name: /close/i }).first().click();
  await dialog.waitFor({ state: "detached" });
}

async function assertSidebarIdentity(page) {
  const sidebar = page.locator("#workspace-sidebar");
  if (!(await isInViewport(sidebar.getByText("Johan", { exact: true }), page))) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await sidebar.getByText("Johan", { exact: true }).waitFor({ state: "visible" });
  await sidebar.getByText("comp eng", { exact: true }).waitFor({ state: "visible" });
  const closeNavigation = page.getByRole("button", { name: "Close navigation" });
  const sidebarOpen = await sidebar.evaluate((element) => element.classList.contains("open"));
  if (page.viewportSize().width <= 820) {
    if (sidebarOpen) {
      await page.getByRole("button", { name: "Close navigation overlay" }).evaluate((button) => button.click());
      await page.waitForFunction(() => !document.querySelector("#workspace-sidebar")?.classList.contains("open"));
    }
  } else if (await isInViewport(closeNavigation, page)) {
    await closeNavigation.click();
  }
  const filesNavigation = page.locator(".files-view-nav");
  await filesNavigation.getByRole("button", { name: "Files", exact: true }).waitFor({ state: "visible" });
  await filesNavigation.getByRole("button", { name: "Recent", exact: true }).waitFor({ state: "visible" });
}

async function assertDirectoryInput(page) {
  const inputEvidence = await page.locator('input[type="file"]').evaluateAll((inputs) => inputs.map((input) => ({
    label: input.getAttribute("aria-label") ?? input.closest("label")?.textContent?.trim() ?? "",
    webkitdirectory: input.hasAttribute("webkitdirectory"),
    directory: input.hasAttribute("directory"),
    multiple: input.multiple,
  })));
  assert.ok(inputEvidence.some((input) => input.webkitdirectory || input.directory), `Upload folder exposes a directory chooser input (${JSON.stringify(inputEvidence)})`);
  return inputEvidence;
}

async function exerciseEmptyWorkspace() {
  const viewport = { width: 1672, height: 941 };
  const { context, page } = await createPage(viewport, "empty");
  try {
    await assertSidebarIdentity(page);
    assert.equal(await fixture(page, "scenario"), "empty");
    assert.equal((await fixture(page, "files")).length, 0, "the empty fixture has no files");
    assert.equal((await fixture(page, "folders")).length, 0, "the empty fixture has no folders");
    await inspectViewport(page, viewport);
    await inspectFilesAppearance(page, viewport, { expectEmptyArt: true });
    await takeScreenshot(page, "desktop-empty");

    const menu = await openNewMenu(page);
    const menuLabels = await menu.getByRole("menuitem").allTextContents();
    assert.ok(menuLabels.some((label) => label.trim() === "Upload files"), `New menu includes Upload files (${menuLabels})`);
    assert.ok(menuLabels.some((label) => label.trim() === "Upload folder"), `New menu includes Upload folder (${menuLabels})`);
    assert.ok(menuLabels.some((label) => label.trim() === "New folder"), `New menu includes New folder (${menuLabels})`);
    assert.ok(menuLabels.some((label) => label.trim() === "Text document"), `New menu includes Text document (${menuLabels})`);
    await takeScreenshot(page, "desktop-new-menu");

    await clickFilesMenuItem(page, "Upload files");
    const uploadDialog = page.getByRole("dialog", { name: "Upload files" });
    await uploadDialog.waitFor({ state: "visible" });
    const uploadInput = uploadDialog.locator('input[type="file"]');
    await uploadInput.waitFor({ state: "attached" });
    const multipleFiles = await uploadInput.evaluate((input) => input.multiple);
    assert.equal(multipleFiles, true, "the Upload files sheet accepts more than one file");
    await takeScreenshot(page, "desktop-upload-files");
    await closeDialog(page, "Upload files");

    await openNewMenu(page);
    await clickFilesMenuItem(page, "Upload folder");
    const folderSheet = page.getByRole("dialog", { name: "Upload folder" });
    await folderSheet.waitFor({ state: "visible" });
    const directoryInputs = await assertDirectoryInput(page);
    await takeScreenshot(page, "desktop-upload-folder");
    console.log(`Upload folder input: ${JSON.stringify(directoryInputs)}`);
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      folderSheet.getByRole("button", { name: "Choose folder", exact: true }).click(),
    ]);
    const chooserElement = await chooser.element();
    const directoryMode = await chooserElement.evaluate((input) => input.hasAttribute("webkitdirectory") || input.hasAttribute("directory"));
    assert.equal(directoryMode, true, "the native folder chooser is configured for directories");
    assert.equal(await chooser.isMultiple(), false, "the native folder chooser is configured for one folder selection");
    await closeDialog(page, "Upload folder");

    await openNewMenu(page);
    await clickFilesMenuItem(page, "New folder");
    const folderDialog = page.getByRole("dialog", { name: "Create folder" });
    await folderDialog.waitFor({ state: "visible" });
    await folderDialog.getByLabel("Folder name").fill("Lab notebook");
    await takeScreenshot(page, "desktop-new-folder");
    await folderDialog.getByRole("button", { name: "Create folder", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: Lab notebook" }).waitFor({ state: "visible" });
    assert.ok((await fixture(page, "folders")).some((folder) => folder.name === "Lab notebook"), "folder creation reaches only the local fixture backend");
    await takeScreenshot(page, "desktop-folder-created");

    await openNewMenu(page);
    await clickFilesMenuItem(page, "Text document");
    const editor = page.getByRole("dialog").filter({ has: page.getByLabel("Text") });
    await editor.waitFor({ state: "visible" });
    const editorTitle = await editor.getByRole("heading").innerText();
    assert.match(editorTitle, /text|document/i, `the text sheet title follows the text creation action (${editorTitle})`);
    await editor.getByLabel("File name").waitFor({ state: "visible" });
    await takeScreenshot(page, "desktop-text-document");
    assert.ok((await fixture(page, "files")).some((file) => file.content_backend === "native-text"), "text document creation uses the local API fixture");
    await editor.getByRole("button", { name: "Close text editor" }).click();
    await editor.waitFor({ state: "detached" });

    const finalMetrics = await inspectViewport(page, viewport);
    const requests = await fixture(page, "requests");
    const profileId = await fixture(page, "profile").then((item) => item.id);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.profileId === "" || request.profileId === profileId), "all authenticated mock requests stay scoped to Johan's profile");
    console.log(`Desktop empty flow: ${JSON.stringify(finalMetrics)}`);
  } finally {
    await context.close();
  }
}

async function captureWideEmptyAndUpload(viewport, screenshotPrefix) {
  const { context, page } = await createPage(viewport, "empty");
  try {
    await assertSidebarIdentity(page);
    assert.equal((await fixture(page, "files")).length, 0, "the wide empty fixture has no files");
    await inspectViewport(page, viewport);
    await inspectFilesAppearance(page, viewport, { expectEmptyArt: true });
    await takeScreenshot(page, `${screenshotPrefix}-empty`);
    await openNewMenu(page);
    await clickFilesMenuItem(page, "Upload files");
    const uploadDialog = page.getByRole("dialog", { name: "Upload files" });
    await uploadDialog.waitFor({ state: "visible" });
    assert.equal(await uploadDialog.locator('input[type="file"]').evaluate((input) => input.multiple), true);
    await takeScreenshot(page, `${screenshotPrefix}-upload-files`);
  } finally {
    await context.close();
  }
}

async function exercisePopulatedWorkspace(viewport, screenshotPrefix) {
  const { context, page } = await createPage(viewport, "populated");
  try {
    await assertSidebarIdentity(page);
    assert.equal((await fixture(page, "files")).length, 2, "the populated fixture has sample file content");
    await page.locator(".files-item").first().waitFor({ state: "visible" });
    await inspectViewport(page, viewport);
    await inspectFilesAppearance(page, viewport);
    await takeScreenshot(page, `${screenshotPrefix}-populated`);

    const selectionControls = page.locator(".files-item-select");
    const selectionOpacity = () => selectionControls.evaluateAll((controls) => controls.map((control) => getComputedStyle(control).opacity));
    const visibleItemCount = await page.locator(".files-item").count();
    assert.equal(await selectionControls.count(), visibleItemCount, "each visible folder or file has a selection control");
    assert.deepEqual(await selectionOpacity(), Array(visibleItemCount).fill("0"), "selection controls stay visually hidden until an item is selected");
    await page.getByRole("button", { name: "Actions for My files", exact: true }).click();
    await page.getByRole("menuitem", { name: "Select visible", exact: true }).click();
    const bulkActions = page.getByRole("group", { name: "Bulk file actions" });
    await bulkActions.waitFor({ state: "visible" });
    assert.deepEqual(await selectionOpacity(), Array(visibleItemCount).fill("1"), "selecting visible reveals every visible item checkbox");
    await page.getByRole("button", { name: "Clear selection", exact: true }).click();
    await bulkActions.waitFor({ state: "detached" });
    await page.mouse.move(viewport.width - 24, viewport.height - 100);
    assert.deepEqual(await selectionOpacity(), Array(visibleItemCount).fill("0"), "clearing selection hides the checkboxes again");

    await page.getByRole("button", { name: "Open folder: CPE 281", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: FPGA lab", exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Open folder: FPGA lab", exact: true }).click();
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "FPGA lab", exact: true }).waitFor({ state: "visible" });
    await page.locator(".files-breadcrumbs").getByRole("button", { name: "My files", exact: true }).click();
    await page.getByRole("button", { name: "Open folder: CPE 281", exact: true }).waitFor({ state: "visible" });

    const views = page.locator(".files-view-nav");
    await views.getByRole("button", { name: "Recent", exact: true }).click();
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "recent");
    await views.getByRole("button", { name: "Files", exact: true }).click();
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("view") === "my-files");

    const search = page.getByRole("searchbox", { name: "Search files", exact: true });
    const notesRow = page.locator(".files-item").filter({ hasText: "Digital systems notes.txt" }).first();
    await search.fill("Digital systems notes");
    await notesRow.locator(".files-item-main").waitFor({ state: "visible" });
    await search.fill("no matching file in this fixture");
    await page.getByText(/No files match your search|No matching files|No results found/i).waitFor({ state: "visible" });
    await search.fill("");

    await notesRow.locator(".files-item-main").click();
    const preview = page.getByRole("dialog", { name: "Private file preview" });
    await preview.waitFor({ state: "visible" });
    await preview.locator(".syllabus-source").waitFor({ state: "visible" });
    const body = await preview.locator(".syllabus-source").innerText();
    assert.match(body, /Week 4: finite state machines/);
    assert.match(body, /Verify reset behavior before testing transitions/);
    await takeScreenshot(page, `${screenshotPrefix}-preview`);
    await closeDialog(page, "Private file preview");
    await inspectViewport(page, viewport);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function exerciseRichGridWorkspace(viewport, screenshotPrefix) {
  const { context, page } = await createPage(viewport, "rich-grid");
  try {
    await assertSidebarIdentity(page);
    const files = await fixture(page, "files");
    const folders = await fixture(page, "folders");
    assert.equal(files.length, 6, "the rich grid fixture contains six real preview files");
    assert.equal(folders.filter((folder) => folder.parent_id === null).length, 3, "the rich grid fixture contains three top-level folder strips");
    assert.equal(folders.length, 4, "the CPE course path retains its nested FPGA lab folder");
    await page.locator(".files-items.is-grid").waitFor({ state: "visible" });
    assert.equal(await page.locator('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true", "the rich grid scenario opens in grid layout");
    await page.locator(".files-item.is-file").first().waitFor({ state: "visible" });
    assert.equal(await page.locator(".files-item.is-file").count(), 6, "all six file cards render in the grid");
    assert.equal(await page.locator(".files-item.is-folder").count(), 3, "the three root folders render as cards");
    await inspectViewport(page, viewport);
    await inspectFilesAppearance(page, viewport);

    const cardFor = (name) => page.locator(".files-item.is-file").filter({ hasText: name });
    const textCard = cardFor("Digital systems notes.txt");
    await textCard.scrollIntoViewIfNeeded();
    const textPreview = textCard.locator(".files-card-preview-content pre");
    await textPreview.waitFor({ state: "visible" });
    assert.match(await textPreview.innerText(), /Week 4: finite state machines/);

    const imageCard = cardFor("FSM transition diagram.svg");
    await imageCard.scrollIntoViewIfNeeded();
    const previewImage = imageCard.locator(".files-card-preview-content img");
    await previewImage.waitFor({ state: "visible" });
    const imageEvidence = await previewImage.evaluate((image) => ({ complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, source: image.currentSrc }));
    assert.ok(imageEvidence.complete && imageEvidence.naturalWidth >= 640 && imageEvidence.naturalHeight >= 360, `the image card renders its real diagram bytes (${JSON.stringify(imageEvidence)})`);

    const pdfCard = cardFor("Logic design review.pdf");
    await pdfCard.scrollIntoViewIfNeeded();
    const pdfThumbnail = pdfCard.locator(".files-card-preview-content img.files-card-pdf-preview");
    await pdfThumbnail.waitFor({ state: "visible" });
    const pdfThumbnailEvidence = await pdfThumbnail.evaluate(async (image) => {
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not inspect the rendered PDF thumbnail pixels.");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkPixels = 0;
      let topInk = canvas.height;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset] < 220 && pixels[offset + 1] < 220 && pixels[offset + 2] < 220) {
          inkPixels += 1;
          topInk = Math.min(topInk, Math.floor(offset / 4 / canvas.width));
        }
      }
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        source: image.currentSrc.slice(0, 22),
        inkPixels,
        topInkRatio: topInk / canvas.height,
      };
    });
    assert.ok(pdfThumbnailEvidence.width >= 300 && pdfThumbnailEvidence.height >= 400, `the PDF card renders a full page thumbnail (${JSON.stringify(pdfThumbnailEvidence)})`);
    assert.ok(pdfThumbnailEvidence.inkPixels > 20, `the PDF thumbnail contains rendered document content instead of a blank page (${JSON.stringify(pdfThumbnailEvidence)})`);
    assert.ok(pdfThumbnailEvidence.topInkRatio < 0.3, `the first-page text appears near the top of the thumbnail (${JSON.stringify(pdfThumbnailEvidence)})`);
    assert.ok(pdfThumbnailEvidence.source.startsWith("data:image/png"), "the PDF page is rendered locally from the authenticated document bytes");
    const pdfId = files.find((file) => file.name === "Logic design review.pdf").id;
    const pdfBytes = await page.evaluate(async (id) => {
      const response = await fetch(`/api/files?id=${encodeURIComponent(id)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), signature: new TextDecoder().decode(bytes.slice(0, 8)), eof: new TextDecoder().decode(bytes.slice(-8)) };
    }, pdfId);
    assert.equal(pdfBytes.status, 200);
    assert.equal(pdfBytes.type, "application/pdf");
    assert.equal(pdfBytes.signature, "%PDF-1.4");
    assert.match(pdfBytes.eof, /%%EOF/);
    assert.equal(pdfThumbnailEvidence.source, "data:image/png;base64,", "the PDF thumbnail is rendered from the actual PDF document");

    const officeCard = cardFor("Lab checklist.docx");
    await officeCard.scrollIntoViewIfNeeded();
    const officeMetadata = files.find((file) => file.name === "Lab checklist.docx");
    assert.equal(officeMetadata.mime_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "the Office card keeps its truthful MIME type");
    const officeFallback = officeCard.locator(".files-card-preview-fallback");
    await officeFallback.waitFor({ state: "visible" });
    const requestsBeforeOfficeProof = await fixture(page, "requests");
    assert.equal(requestsBeforeOfficeProof.some((request) => request.url === `/api/files?id=${officeMetadata.id}`), false, "an unsupported Office document stays on its honest icon fallback without reading the bytes for preview");
    const officeBytes = await page.evaluate(async (id) => {
      const response = await fetch(`/api/files?id=${encodeURIComponent(id)}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, type: response.headers.get("content-type"), signature: [...bytes.slice(0, 4)] };
    }, officeMetadata.id);
    assert.equal(officeBytes.status, 200);
    assert.equal(officeBytes.type, officeMetadata.mime_type);
    assert.deepEqual(officeBytes.signature, [0x50, 0x4b, 0x03, 0x04], "the Office fallback is backed by a real OOXML zip document");

    const requests = await fixture(page, "requests");
    for (const name of ["Digital systems notes.txt", "FSM transition diagram.svg", "Logic design review.pdf"]) {
      const file = files.find((item) => item.name === name);
      assert.ok(requests.some((request) => request.url === `/api/files?id=${file.id}`), `${name} loads from the local authenticated fixture`);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await takeScreenshot(page, `${screenshotPrefix}-populated`);

    await pdfCard.locator(".files-card-preview").click();
    const pdfDialog = page.getByRole("dialog", { name: "Private file preview" });
    await pdfDialog.waitFor({ state: "visible" });
    const openedPdf = pdfDialog.locator("iframe.private-pdf-preview");
    await openedPdf.waitFor({ state: "visible" });
    assert.match(await openedPdf.getAttribute("src"), /^blob:/, "activating a card opens the real PDF in the file preview dialog");
    await closeDialog(page, "Private file preview");

    await page.getByRole("button", { name: "List view", exact: true }).click();
    await page.locator(".files-items.is-list").waitFor({ state: "visible" });
    const notesRow = cardFor("Digital systems notes.txt").locator(".files-item-main");
    await notesRow.click();
    const textDialog = page.getByRole("dialog", { name: "Private file preview" });
    await textDialog.waitFor({ state: "visible" });
    const openedText = textDialog.locator(".syllabus-source");
    await openedText.waitFor({ state: "visible" });
    assert.match(await openedText.innerText(), /Verify reset behavior before testing transitions/);
    await takeScreenshot(page, `${screenshotPrefix}-row-preview`);
    await closeDialog(page, "Private file preview");
  } finally {
    await context.close();
  }
}

async function exercisePreferenceAppearanceMigration() {
  const viewport = { width: 1672, height: 941 };
  const { context, page } = await createPage(viewport, "legacy-list", { layout: "list" });
  try {
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("layout", "list");
      window.history.replaceState(window.history.state, "", url);
    });
    await page.waitForFunction(() => new URL(window.location.href).searchParams.get("layout") === "list");
    const legacyPreferences = await fixture(page, "dashboard.d.filePreferences");
    assert.deepEqual(legacyPreferences, { filter: "all", view: "list", sortBy: "name" }, "the fixture starts with a pre-appearance-version saved list preference");
    assert.equal(await page.locator('.files-layout-toggle button[aria-label="Grid view"]').getAttribute("aria-pressed"), "true", "legacy list preferences upgrade to the new grid default");
    assert.equal(await fixture(page, "workspaceWrites"), 0, "displaying the in-memory migration does not autosave it");
    await takeScreenshot(page, "preference-migration-grid");

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByLabel("File type", { exact: true }).selectOption("pdf");
    await page.waitForFunction(() => {
      const fixture = window.__filesReferenceFixture;
      return fixture.workspaceWrites > 0 && fixture.dashboard.d.filePreferences?.appearanceVersion === 2;
    });
    const migratedPreferences = await fixture(page, "dashboard.d.filePreferences");
    assert.equal(migratedPreferences.view, "grid", "the first preference edit persists the upgraded grid default");
    assert.equal(migratedPreferences.sortBy, "modified");
    assert.equal(migratedPreferences.sortDirection, "desc");
    assert.equal(migratedPreferences.fileType, "pdf", "the first preference edit keeps the user's filter change");
    assert.equal(migratedPreferences.appearanceVersion, 2);
    assert.equal(new URL(page.url()).searchParams.get("layout"), "grid", "the first preference edit normalizes the old URL layout to grid");

    await page.locator('.files-layout-toggle button[aria-label="List view"]').click();
    await page.locator(".files-items.is-list").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__filesReferenceFixture.dashboard.d.filePreferences?.view === "list");
    const explicitList = await fixture(page, "dashboard.d.filePreferences");
    assert.equal(explicitList.view, "list");
    assert.equal(explicitList.appearanceVersion, 2, "an explicit List choice carries the new appearance marker");
    assert.equal(new URL(page.url()).searchParams.get("layout"), "list");

    await page.goto(`${baseUrl}/home?scenario=legacy-list`);
    await enterFilesView(page);
    assert.equal(await page.locator('.files-layout-toggle button[aria-label="List view"]').getAttribute("aria-pressed"), "true", "an explicit List choice remains after a full browser reload");
    await page.locator(".files-items.is-list").waitFor({ state: "visible" });
    const savedAfterReload = await fixture(page, "dashboard.d.filePreferences");
    assert.equal(savedAfterReload.view, "list");
    assert.equal(savedAfterReload.appearanceVersion, 2);
    assert.equal(await fixture(page, "workspaceWrites"), 0, "reloading an explicitly saved List choice does not write another revision");

  } finally {
    await context.close();
  }
}

async function exerciseMobileEmptyWorkspace() {
  const viewport = { width: 390, height: 844 };
  const { context, page } = await createPage(viewport, "empty");
  try {
    await assertSidebarIdentity(page);
    assert.equal((await fixture(page, "files")).length, 0, "the mobile empty fixture has no files");
    assert.equal((await fixture(page, "folders")).length, 0, "the mobile empty fixture has no folders");
    await inspectViewport(page, viewport);
    await takeScreenshot(page, "mobile-390-empty");
  } finally {
    await context.close();
  }
}

try {
  browser = await playwright.chromium.launch(launchOptions);
  await exerciseEmptyWorkspace();
  for (const viewport of [
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
  ]) await captureWideEmptyAndUpload(viewport, `wide-${viewport.width}`);
  await exerciseMobileEmptyWorkspace();
  await exercisePreferenceAppearanceMigration();
  const populatedDesktop = await exercisePopulatedWorkspace({ width: 1672, height: 941 }, "desktop");
  await populatedDesktop.context.close();

  for (const viewport of [
    { width: 1672, height: 941 },
    { width: 2560, height: 1440 },
    { width: 3440, height: 1440 },
  ]) await exerciseRichGridWorkspace(viewport, `wide-${viewport.width}`);

  for (const viewport of [
    { width: 430, height: 932 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    const run = await exercisePopulatedWorkspace(viewport, `mobile-${viewport.width}`);
    await run.context.close();
  }

  assert.deepEqual(errors, [], errors.join("\n"));
  assert.deepEqual(layoutFailures, [], layoutFailures.join("\n"));
  assert.ok(servedAssets.includes("/files-landscape.png"), "the Files landscape asset was served by the offline harness");
  assert.ok(servedAssets.includes("/files-empty-illustration.png"), "the standalone Files illustration was served by the offline harness");
  assert.equal(servedAssets.includes("/files-reference-art.png"), false, "the screenshot sprite is never routed or used");
  console.log(`Files reference browser verification passed. Screenshots: ${screenshotDir}`);
} finally {
  await browser?.close();
}
