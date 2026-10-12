# EduEssentials

A student workspace built with React, Vinext, Cloudflare Workers, and Supabase.

## Design standard

Use the [Home and sidebar design standard](docs/design-system.md) for future
features and pages. It includes visual references, design tokens, responsive
layout rules, component patterns, and an implementation acceptance checklist.

## Academic AI pilot

See [ACADEMIC_AI.md](ACADEMIC_AI.md) for the implemented assistant, model selection,
usage-based cost estimates, AI migrations, server configuration, evaluation commands,
and production release gates. Free Gemini testing is limited to explicitly enabled
adults with fictional-data accounts. AI is disabled by default.

## Local development

Requires Node.js 22.13 or later.

1. Install dependencies with npm install.
2. Copy .env.example to .env and set the Supabase URL, publishable key, and server secret key.
3. Apply the database migrations and Google configuration below.
4. Run npm run dev and open http://127.0.0.1:3000.

The new Files browser is enabled by default in local development against the
migrated database. If an existing `.env` sets `FILES_BROWSER_ENABLED=false`,
remove that override or change it to `true`, then restart the server. Explicit
Cloudflare bindings take precedence over process environment settings.
Production remains disabled by default until hosted Batch 11 acceptance passes.

The Worker runtime is required because server modules use cloudflare:workers.
The generic vinext start Node server cannot load that module. For a built local
Worker preview use npx wrangler dev --config dist/server/wrangler.json after npm run build.
Supply Supabase runtime values to that preview through Wrangler's environment configuration.

## Required Supabase setup

See [the October 10 CPU incident and live remediation](docs/cpu-usage.md) for the
required conflict-code and workspace-efficiency migrations.

Apply these SQL files in order using the Supabase SQL editor, or supabase db push
from a linked project. The second migration depends on the first:

- supabase/migrations/20260903000000_workspace_persistence.sql
- supabase/migrations/20260904000000_google_accounts.sql
- supabase/migrations/20260905000000_persistence_foundation.sql
- supabase/migrations/20260907000000_private_files.sql

The new migration adds profile fields, preferences, Google-user profile creation
and identity synchronization triggers, and atomic workspace initialization.
It leaves existing anonymous profiles intact. An unsigned legacy browser cookie
cannot safely prove ownership, so anonymous profiles are not automatically claimed.

The September 5 foundation migration preserves existing data, adds monotonic save
timestamps, an account-owned private file metadata table/bucket, and a transactional
course/workspace save function. Apply it once, after the earlier migrations. It is
tested locally and **applied to the connected project on September 5, 2026**.
Do not reapply it to that project; the SQL editor installation is documented below.
See PERSISTENCE_FOUNDATION.md for the verified setup, installation, and rollout notes.

In Google Cloud, configure an OAuth client of type Web application:

- Add your app's production origin and local development origin.
- Set the authorized redirect URI to https://<project-ref>.supabase.co/auth/v1/callback.
- Configure the consent screen and testing audience as appropriate.

In Supabase Dashboard > Authentication:

1. Enable the Google provider and enter the Google OAuth client ID and secret.
2. Disable Email, anonymous sign-ins, and any other unused providers. This app
   accepts Google accounts only; it has no password or email-signup flow.
3. Set the Site URL to the deployed app origin.
4. Add the exact app callback URL to the redirect allow list:
   https://<app-domain>/auth/callback.
5. For development, also allow http://127.0.0.1:3000/auth/callback.
   If you use localhost, add http://localhost:3000/auth/callback too.

Google Workspace/school Google accounts are supported as well as gmail.com
accounts. Only basic identity scopes (openid, email, profile) are requested;
the app does not request access to email messages.

Official setup reference: https://supabase.com/docs/guides/auth/social-login/auth-google

## Account and access behavior

- /login and /overview are public. Overview is only a placeholder for future work.
- Google sign-in starts with POST /auth/google and a PKCE exchange at /auth/callback.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Middleware refreshes sessions and protects private and future routes by default.
- Each private API independently verifies the user through Supabase getUser().
- New accounts go to /onboarding. A display name is required, prefilled from
  Google, and editable. School, major, year, age, goals, academic structure,
  GPA system, term, week start, and time zone are optional and can be skipped.
- Settings saves profile details, theme, accessibility and notification preferences.
  Notification delivery is not implemented; the UI labels these as saved preferences.
- POST /auth/signout signs out this browser. Write routes require a same-origin request.
- An expired or invalid session redirects page requests to login; private APIs return
  401. Editors keep pending drafts visible and allow sign-in in a new tab before retry.

Profile identity, Google email and avatar, timestamps, onboarding completion, and
preferences are stored in app_profiles. Google Auth manages account credentials.
The app never stores Google passwords or asks users to create a password.

## User-owned persistence

Every course and dashboard query is scoped to the profile resolved from the
verified auth user ID. No caller-supplied profile or user ID grants access.
RLS remains enabled and anon/authenticated roles have no direct table access;
only the server secret performs scoped database operations.

New accounts start with empty courses, assignments, notes, and events, plus the
existing configurable widget layouts. The compact versioned dashboard document
stores widget types, sizes, order, workspace names, active workspace, quick notes,
assignment progress/notes/checklists, calendar events, and chosen views.
Widget instance IDs and independent note content now persist in v2 documents.
Existing v1 documents remain readable: shared text is copied into existing notes
widgets, or kept recoverable if none exist. The next normal save upgrades the layout;
loading alone does not rewrite it. No SQL migration is needed for this format change.
The API prevents an old client from downgrading a v2 document back to shared notes.
See PERSISTENCE_WORKSPACES.md for the Step 4 format, controls, and verification.

Courses, assignments, calendar events, recurring schedules, and syllabus reviews
now save through one complete course/dashboard snapshot. The API uses the installed
save_account_workspace transaction, so approval and class removal cannot partially
save related data. Reads retry when a concurrent commit changes the document
revision during the course query. Legacy partial course/document write paths
return 426 and require a reload after preserving pending edits.

Dashboard provides class and assignment editors; Calendar provides event editing
and actual month/week/day views with the saved time zone, week start, and filter.
Syllabus review saves actual pasted/.txt source, editable course fields, and review
rows before approval. Approval commits the course and typed assignments together.
PDF/image storage and extraction are not claimed by this text-review workflow.
See PERSISTENCE_ACADEMICS.md for the completed Step 5 surfaces, storage, recovery,
and verification limits.

Timers, daily/weekly study targets, recorded intervals, and term/scale-specific
course grades now persist in dashboard_state.payload.d.study. The Pomodoro and
Focus countdowns use timestamps, support pause/resume and early finish, and
complete atomically into history after reload or a closed page. One timer is active
at a time; display ticks do not write to the database. Study goals, history, and
grade editing are accessible from the sidebar, dashboard, and relevant widgets.

Study totals/streaks honor the saved time zone and week start; grade averages use
matching terms/scales and course credits. Widget/dashboard/sidebar metrics use
actual saved records. Older clients that omit existing study data cannot erase it.
See PERSISTENCE_STUDY.md for Step 6 behavior and local verification.

Private files, class images, assignment attachments and syllabus originals now use
account-owned metadata plus the private Supabase storage bucket. Uploads verify
stored hashes and support stable retries; file edits/deletions require revisions.
Files filters/view persist, search uses actual account records, and Settings exports
a complete saved-account ZIP with original file bytes. Apply the Step 7 migration
after the foundation migration on a fresh database; it is already installed on the
connected project. See PERSISTENCE_FILES.md for behavior, recovery and verification.
Step 8 localhost acceptance is documented in PERSISTENCE_VERIFICATION.md.
Publication and deployed-environment acceptance are deferred at the user's request.

First-time initialization is transactional and locks the profile row, so another
tab cannot reinitialize and overwrite a saved layout. Dashboard saves are debounced
and serialized within a tab. Failed saves retain the current edits and show Retry
save; leaving with unsaved edits prompts the browser warning. Profile and dashboard
writes now require the loaded updated_at revision and use a conditional database
update. Stale saves return 409 and retain the local edits; requests from old clients
without a revision return 428. Export/copy edits before reloading after a conflict.
Settings drafts now survive section navigation, provide explicit retry/download/reset
actions, and block sign-out until edits are saved or deliberately discarded. Failed
workspace loading can be retried; editing waits for hydration. Pending changes are
marked unsaved immediately, and writes during an active save are coalesced using its
returned revision. A matching readback can acknowledge a lost response; conflicting
content never silently adopts another session's revision. Account-scoped client
requests refuse to send an old draft to a different signed-in account.
See PERSISTENCE_SETTINGS.md for the completed Step 3 review and local test evidence.

## Dashboard widget layout

Every widget supports the same five block footprints: mini (1 × ½), small
(1 × 1), medium horizontal (2 × 1), medium vertical (1 × 2), and large (2 × 2).
The shared small block defaults to 220px high and a target width of 260px; the
board is capped at 1680px. Spans include the space between blocks, so two stacked
minis align with one small and a large aligns with four smalls. Dense placement
fills available spaces while retaining the saved widget order in the DOM.
The grid retains at least two fluid columns on narrow screens so horizontal
variants keep their footprint. Content scrolls inside the fixed card; padding,
icons, and content styling stay the same across sizes.

Widget customization, beside Customize, opens an appearance studio with Basic
and Advanced controls. Six presets and 31 controls cover block size, spacing,
surfaces, opacity, colors, borders, shadows, blur, texture, gradients, typography,
headers, icons, hover effects, and motion timing.
Try desktop, tablet, and phone previews, enlarge the preview for a closer look,
compare the saved and draft looks, and undo or redo changes before applying.
Cancel discards the draft.

The Today section has its own options menu. Hide section removes it from the
current workspace; Customize reveals a dashed outline in its place. Click the
outline to restore Today. Visibility saves separately for each workspace and
survives reload. Edit section is a placeholder for future customization.

Appearance defaults apply across the account, with optional overrides for an
individual widget. Block width, block height, and spacing apply to the entire board;
individual appearance overrides cannot change those shared dimensions.
Duplicating a widget or workspace copies its appearance; removing it cleans up
its override. Applied appearance saves in dashboard_state.payload.d.widgetAppearance
alongside existing account data. Older clients cannot erase saved appearance.
Experimental workspaces let you try styles with sample data without saving them
to the account. System and account reduced-motion preferences remain respected.

Home caches an account-specific layout hint in localStorage: the active workspace's
ordered widget sizes, mini-widget grouping, spacing, and Today visibility. It also
remembers the top section and toolbar heights for the same viewport and content
width, with a responsive fallback when the window size changes. Loading outlines
use that hint and the live grid placement rules. With no valid cache, Home
uses a fixed mix of small, mini, and horizontal medium outlines. The first visible
skeleton waits for the browser to restore the hint, keeping hydration consistent.
When saved data arrives, the skeleton fades out and the server layout fades in,
including when a different browser changed the layout. No outlines move or resize.
Successful loading and subsequent layout edits refresh the hint; failed reads and
experimental data do not. The cache never supplies live workspace content or writes
to the server, and reduced-motion preferences bypass the transition.

## Validation

- npm run build: production Worker build.
- npx tsc --noEmit: TypeScript check.
- npm run lint: lint and accessibility checks.
- node scripts/verify-widget-layout.mjs: optional Chrome layout checks and local
  screenshots using all 18 production widget types. Requires Playwright tooling;
  set PLAYWRIGHT_MODULE to its index.mjs path when using an external bundle, and
  CHROME_EXECUTABLE when Chrome is outside its standard installation location.
- node scripts/verify-widget-reorder.mjs: optional browser checks of live widget
  drag previews, cancellation, touch input, reduced motion, and edge scrolling.
  Uses synthetic workspace data and the same Playwright/Chrome environment
  variables as the layout checks. Research and interaction design are recorded
  in [docs/widget-reordering.md](docs/widget-reordering.md).
- node scripts/verify-home-skeleton.mjs: optional Chrome checks of cached and default
  loading layouts and their fade to saved layouts on desktop and phones,
  hydration, reduced motion, successful loading, retry, and other routes. Uses synthetic workspace data; set
  PLAYWRIGHT_MODULE and ESBUILD_MODULE when using external tooling bundles.
- npm test: build, account/API tests with a fake Supabase adapter, and HTTP route
  integration tests against a temporary local development server. Test files run
  serially so the SQL/DOM suites do not cause wall-clock UI assertions to fail
  under parallel CPU contention; all test cases still run.
- tests/persistence-foundation.test.mjs additionally executes all app migrations
  in an isolated PGlite PostgreSQL instance and tests constraints, RLS, stale saves,
  rollback, legacy layouts, and two-account isolation. Its auth/storage schemas are
  local fixtures; it never modifies production accounts or uploads real files.
- tests/autosave.test.mjs exercises pending writes, retries, conflicts, and session
  recovery. tests/settings-ui.test.mjs mounts the actual React editors in JSDOM,
  with simulated API responses, to test settings, workspace and widget controls,
  independent notes, search navigation, recovery and draft protection.
- tests/widget-appearance.test.mjs validates appearance fields and safe CSS values;
  tests/widget-customization-ui.test.mjs exercises studio controls, draft history,
  cancellation, account persistence, per-widget overrides, and experimental previews.
- tests/workspaces.test.mjs covers v1 upgrades, stable IDs, independent note copies,
  maximum legacy layouts, note references, and UTF-8 storage limits. The foundation
  suite also verifies v2 saves and downgrade protection through PostgreSQL queries.
- tests/academics.test.mjs covers date/time-zone calculations, syllabus suggestions,
  meeting validation and academic references. The React and PostgreSQL suites also
  verify academic CRUD/reloads, atomic review approval, concurrent reads, safe class
  removal, legacy repairs, and save/retry protection.
- tests/study.test.mjs covers timer transitions, recorded intervals, DST/midnight
  allocation, streaks, grade weighting and references. React/PostgreSQL tests also
  cover study control reloads, offline/lost-response recovery, atomic completion,
  populated metrics, grade CRUD, and old-client protection.
- node --env-file=.env scripts/verify-database.mjs: read-only live schema, auth
  settings, anonymous-access and named-bucket check. Prints no keys or user records.
- node --env-file=.env scripts/verify-files-release.mjs: read-only Files schema,
  optional AI RPC, anonymous denial and private-bucket preflight. Exit 0 means
  structural metadata passed, 2 means blocked, 1 means unavailable; it never marks
  hosted release acceptance complete or prints user rows/keys.
- node scripts/verify-files-accessibility.mjs: Chrome keyboard, dialog focus,
  selection/save announcements and measured contrast checks at desktop/mobile
  in normal/high-contrast modes, using real components and deterministic APIs.
- Set TEST_BASE_URL to an existing local preview origin to reuse that server.

Tests exercise Google-only identity, profile validation, ownership isolation,
onboarding enforcement, anonymous route/API denial, CSRF rejection, PKCE initiation,
callback safety and saved workspace round trips. They do not create production
accounts or complete a real Google consent flow. A real end-to-end sign-in and
cross-device save check requires the provider and migration setup above.

## Deployment

Preserve .openai/hosting.json and configure the same Supabase URL, publishable key,
and secret key in the hosted Worker environment. Never include .env in a deployment
archive or place secrets in client components. Deploy only after the migrations
and Google callback allow list are configured for the final app origin.

The Files redesign remains disabled by default in production. Follow
[the Files release and recovery runbook](docs/files-release.md) to apply additive
migrations, deploy compatible APIs and verify two-account/private-storage,
concurrency, browser and large-ZIP acceptance before enabling
`FILES_BROWSER_ENABLED`. A successful local test or structural probe does not
satisfy those hosted gates. Retain the schema and saved data if disabling the UI.
