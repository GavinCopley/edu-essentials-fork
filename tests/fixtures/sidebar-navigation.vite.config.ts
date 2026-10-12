import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import vercelConfig from "../../vite.vercel.config.ts";

if (process.env.EDU_NAVIGATION_TEST !== "1") {
  throw new Error("This fixture requires EDU_NAVIGATION_TEST=1.");
}

const productionClientBuild = vercelConfig.environments?.client?.build;
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE|NEXT_PUBLIC_SUPABASE|VITE_SUPABASE|DATABASE_URL|POSTGRES_URL)/i.test(key)) {
    delete process.env[key];
  }
}
process.env.FILES_BROWSER_ENABLED = "false";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(fixtureDir, "../..");
const outputDir = resolve(projectRoot, ".vinext/verify-sidebar-navigation");
const emptyEnvDir = resolve(outputDir, "empty-env");
mkdirSync(emptyEnvDir, { recursive: true });
const clientOutputDir = resolve(outputDir, "client");
const nitroOutputDir = resolve(outputDir, "nitro");
const authPath = resolve(projectRoot, "lib/auth.ts");
const proxyPath = resolve(projectRoot, "proxy.ts");
const runtimeEnvShim = resolve(projectRoot, "build/vercel-runtime-env.ts");
const fixtureProfile = {
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

const fixtureAuth = String.raw`
const fixtureProfile = ${JSON.stringify(fixtureProfile)};

export class AuthError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export async function requireProfile() { return fixtureProfile; }
export async function ensureProfile() { return fixtureProfile; }
export async function createAuthClient() { throw new Error("Auth is disabled in the isolated navigation fixture."); }
export function requireSameOrigin() {}
export function apiError(error) {
  const status = error instanceof AuthError ? error.status : 503;
  return Response.json({ error: "Isolated navigation fixture API." }, { status, headers: { "cache-control": "no-store" } });
}
`;

const fixtureProxy = String.raw`
import { NextResponse } from "next/server";
export async function proxy(request) { return NextResponse.next({ request }); }
export const config = { matcher: ["/((?!_next/|_vinext/|assets/|@vite/|@id/|favicon.svg$|og.png$|file.svg$|globe.svg$|window.svg$).*)"] };
`;

const isolatedAuthAndProxy: Plugin = {
  name: "eduessentials:sidebar-navigation-test-auth",
  enforce: "pre",
  transform(_source, id) {
    const file = id.split("?", 1)[0];
    if (file === authPath) return { code: fixtureAuth, map: null };
    if (file === proxyPath) return { code: fixtureProxy, map: null };
    return null;
  },
};

const cloudflareWorkersVercelShim: Plugin = {
  name: "eduessentials:sidebar-navigation-test-cloudflare-shim",
  enforce: "pre",
  apply: "build",
  resolveId(source) {
    if (source !== "cloudflare:workers") return null;
    if (this.environment.name === "client") this.error("cloudflare:workers is server-only.");
    return runtimeEnvShim;
  },
};

export default defineConfig({
  root: projectRoot,
  envDir: emptyEnvDir,
  environments: {
    client: { build: productionClientBuild },
  },
  resolve: {
    alias: {
      tailwindcss: import.meta.resolve("tailwindcss/index.css"),
    },
  },
  plugins: [vinext(), isolatedAuthAndProxy, cloudflareWorkersVercelShim, nitro({
    preset: "node-server",
    rootDir: projectRoot,
    buildDir: resolve(outputDir, "build"),
    output: { dir: nitroOutputDir },
  })],
  build: {
    outDir: clientOutputDir,
    emptyOutDir: true,
  },
});
