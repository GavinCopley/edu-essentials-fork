// Non-Cloudflare builds get no worker bindings. Callers fall through to
// process.env at runtime, which Vercel supplies to the Node server function.
export const env: Readonly<Record<string, string | undefined>> =
  Object.freeze({});
