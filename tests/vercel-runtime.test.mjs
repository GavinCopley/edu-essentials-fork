import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, ".vercel", "output");
const functionRoot = path.join(outputRoot, "functions");
const functionEntry = path.join(functionRoot, "__server.func", "index.mjs");
const staticRoot = path.join(outputRoot, "static");
const artifactsReady = await Promise.all([
  stat(functionEntry).then(() => true, () => false),
  stat(staticRoot).then(() => true, () => false),
]).then((checks) => checks.every(Boolean));

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function envCredentialValue(name, value) {
  return /(?:SUPABASE|DATABASE_URL|SECRET|SERVICE_ROLE|PRIVATE_KEY|API_KEY|TOKEN|PASSWORD)/i.test(name)
    && typeof value === "string"
    && value.trim().length >= 12
    && !/^(?:changeme|replace.?me|your.?value|example|test)$/i.test(value.trim());
}

async function configuredCredentialValues() {
  const values = new Map();
  for (const [name, value] of Object.entries(process.env)) {
    if (envCredentialValue(name, value)) values.set(name, value.trim());
  }

  for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\.env(?:\.|$)/.test(entry.name)) continue;
    const contents = await readFile(path.join(projectRoot, entry.name), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !envCredentialValue(match[1], match[2])) continue;
      const raw = match[2];
      const value = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
      if (value.length >= 12) values.set(match[1], value);
    }
  }
  return values;
}

test("Vercel output serves public pages and fails closed without auth configuration", { skip: !artifactsReady && "Run npm run build:vercel to emit .vercel/output." }, async (t) => {
  const credentials = await configuredCredentialValues();
  const previousSupabaseEnv = new Map(Object.entries(process.env).filter(([name]) => name.startsWith("SUPABASE_")));
  for (const name of previousSupabaseEnv.keys()) delete process.env[name];

  const originalFetch = globalThis.fetch;
  const blockedOutboundRequests = [];
  globalThis.fetch = async () => {
    blockedOutboundRequests.push(true);
    throw new Error("Outbound network access blocked by the Vercel runtime smoke test.");
  };

  try {
    const { default: app } = await import(pathToFileURL(functionEntry).href);
    assert.equal(typeof app.fetch, "function", "the emitted Node function must expose Nitro fetch handling");

    const functionEntries = (await readdir(functionRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".func"))
      .map((entry) => entry.name);
    assert.deepEqual(functionEntries, ["__server.func"], "Vercel output should use one server function and no separate middleware function");

    const generatedModules = (await filesUnder(path.join(functionRoot, "__server.func")))
      .filter((file) => /\.(?:mjs|js|cjs)$/.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`));
    for (const file of generatedModules) {
      const source = await readFile(file, "utf8");
      assert.ok(!source.includes("cloudflare:workers"), `${path.relative(outputRoot, file)} must not retain a cloudflare:workers specifier`);
      assert.ok(!source.includes("next/server"), `${path.relative(outputRoot, file)} must not retain a next/server specifier`);
    }

    const staticFiles = await filesUnder(staticRoot);
    const clientFiles = staticFiles.filter((file) => /\.(?:css|js)$/.test(file));
    assert.ok(clientFiles.some((file) => file.endsWith(".css")), "Vercel static output must include CSS assets");
    assert.ok(clientFiles.some((file) => file.endsWith(".js")), "Vercel static output must include JavaScript assets");
    for (const [name, value] of credentials) {
      const secret = Buffer.from(value);
      for (const file of staticFiles) {
        const asset = await readFile(file);
        assert.ok(!asset.includes(secret), `client asset ${path.relative(outputRoot, file)} must not contain configured ${name}`);
      }
    }

    const baseUrl = "http://vercel-smoke.invalid";
    const get = (route, headers = {}) => app.fetch(new Request(new URL(route, baseUrl), { headers }));

    const root = await get("/");
    assert.equal(root.status, 307, "anonymous GET / should redirect");
    assert.equal(new URL(root.headers.get("location"), baseUrl).pathname, "/login");

    const login = await get("/login");
    assert.equal(login.status, 200, "GET /login should render successfully");
    const loginHtml = await login.text();
    assert.match(loginHtml, /\/_next\/static\/css\/[^"\s]+\.css/, "public login HTML should reference emitted CSS");
    assert.match(loginHtml, /\/_next\/static\/chunks\/[^"\s]+\.js/, "public login HTML should reference emitted JavaScript");

    const overview = await get("/overview");
    assert.equal(overview.status, 200, "GET /overview should render successfully");

    const workspaceApi = await get("/api/workspace");
    assert.equal(workspaceApi.status, 401, "unauthenticated workspace API requests should fail closed");
    assert.match(workspaceApi.headers.get("content-type") ?? "", /application\/json/i);

    const privatePage = await get("/home");
    assert.equal(privatePage.status, 307, "anonymous GET /home should redirect");
    assert.equal(new URL(privatePage.headers.get("location"), baseUrl).pathname, "/login");

    const fakeCookie = await get("/home", { cookie: "sb-smoke-auth-token=fake-cookie-value" });
    assert.equal(fakeCookie.status, 307, "a fake Supabase cookie with no credentials should fail closed");
    const fakeCookieLocation = new URL(fakeCookie.headers.get("location"), baseUrl);
    assert.equal(fakeCookieLocation.pathname, "/login");
    assert.equal(fakeCookieLocation.searchParams.get("error"), "unavailable");
    assert.deepEqual(blockedOutboundRequests, [], "the missing-configuration checks must not make live auth requests");

    t.diagnostic(`Verified ${generatedModules.length} emitted server modules and ${clientFiles.length} CSS/JS client assets.`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previousSupabaseEnv) process.env[name] = value;
  }
});
