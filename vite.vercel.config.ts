import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import { clientRouterBuildOptions } from "./build/client-router-build";

const vercelRuntimeEnvShim = fileURLToPath(
  new URL("./build/vercel-runtime-env.ts", import.meta.url),
);

const cloudflareWorkersVercelShim: Plugin = {
  name: "eduessentials:cloudflare-workers-vercel-shim",
  enforce: "pre",
  apply: "build",
  resolveId(source) {
    if (source !== "cloudflare:workers") return null;

    if (this.environment.name === "client") {
      this.error(
        "cloudflare:workers is server-only and cannot be imported into the Vercel client bundle.",
      );
    }

    return vercelRuntimeEnvShim;
  },
};

export default defineConfig({
  environments: {
    client: { build: clientRouterBuildOptions },
  },
  resolve: {
    // Nitro's aliases make Vite's CSS @import resolver miss Tailwind's style
    // export, so pin this stylesheet directly for the Vercel build.
    alias: {
      tailwindcss: fileURLToPath(import.meta.resolve("tailwindcss/index.css")),
    },
  },
  plugins: [vinext(), cloudflareWorkersVercelShim, nitro()],
});
