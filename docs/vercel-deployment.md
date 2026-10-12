# Deploying to Vercel

This app uses vinext, not the Next.js compiler. Its default `npm run build`
targets Cloudflare Workers. Vercel needs the separate Nitro build configured in
`vercel.json`; importing the repository with the old defaults builds a Worker
that Vercel cannot run and separately compiles `middleware.ts` without vinext's
`next/*` shims.

## Vercel dashboard setup

1. Include the Vercel build changes in the Git branch connected to your project.
2. Under **Settings > Build and Deployment**, use **Other** as the framework
   preset. The repository config sets the build command to
   `npm run build:vercel` and the install command to `npm ci`. Remove any old
   output-directory override; Nitro generates `.vercel/output` using Vercel's
   Build Output API, including the server function and static assets.
3. Under **Settings > Environment Variables**, configure `SUPABASE_URL`,
   `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` for the deployment's
   environment (Production, and Preview if you use previews). These are runtime
   server settings. Do not add a `NEXT_PUBLIC_` prefix to the secret key.
4. In Supabase Authentication URL Configuration, add
   `https://edu-essentials-fork.vercel.app/auth/callback` to the redirect allow
   list, and set the Site URL to the intended production app origin.
5. Redeploy after changing the code or environment variables.

Cloudflare bindings are replaced only in the Vercel build by a server-only
environment adapter. The existing server code then reads Vercel's runtime
`process.env`; no Supabase credentials are compiled into browser assets.
Cloudflare development and builds continue to use the native Worker bindings.
The separate AI ingestion Worker remains a Cloudflare deployment.

## Verification

Run `npm run build:vercel` to generate `.vercel/output`. A successful deployment
must include an app server function, not only a standalone middleware function.
Run `node --test tests/vercel-runtime.test.mjs` after that build to exercise the
emitted function with authentication settings cleared and outbound requests
blocked. It also checks the generated routes/assets and browser credential
exposure. The test skips when Vercel artifacts have not been built.
After deployment, check:

- `GET /` without session cookies redirects to `/login`.
- `GET /login` renders the Google sign-in page.
- `GET /api/workspace` without a session returns 401.
- Google sign-in returns to this deployment and private pages load.

## October 12 deployment diagnosis

The failing deployment of commit `0bbe8e9` ran `pnpm run build` (`vinext build`)
with the Cloudflare Vite plugin. Vercel then compiled root `middleware.ts`
separately and logged `Cannot find module 'next/server'`. Deployment metadata
listed only a `middleware` function and no app server. Both `/` and `/login`
returned `500 MIDDLEWARE_INVOCATION_FAILED`.

The middleware also transitively imports `cloudflare:workers`, which requires
the Worker runtime and fails in Node's default module loader. Catching errors
inside the request handler cannot catch failures while loading its imports.
The exact runtime exception for the original request was unavailable from the
Vercel log lookup; the build log and deployment output confirm that the wrong
runtime and output were deployed.

References: [vinext deployment adapters](https://github.com/cloudflare/vinext#other-platforms-via-nitro)
and [Vercel middleware invocation errors](https://vercel.com/docs/errors/middleware_invocation_failed).
