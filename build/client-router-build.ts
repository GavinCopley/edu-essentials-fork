import type { BuildOptions } from "vite";

// Client router dynamic namespaces need preserved exports; keep this client-scoped.
export const clientRouterBuildOptions: BuildOptions = {
  rolldownOptions: {
    preserveEntrySignatures: "strict",
  },
};
