import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(repoRoot, "scripts/verify-widget-remove.mjs");

test("widget drag-to-remove works through real browser pointer input", {
  skip: process.env.PLAYWRIGHT_MODULE ? false : "Set PLAYWRIGHT_MODULE to run the Chrome browser regression.",
  timeout: 180_000,
}, () => {
  const result = spawnSync(process.execPath, [runner], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 150_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Browser verification failed.\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
});
