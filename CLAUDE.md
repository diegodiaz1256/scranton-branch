# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Scranton Branch (a fork of Munder Difflin, and formerly named after it): an Electron + React desktop app that runs many CLI coding agents (Claude Code, Codex, Gemini CLI, Grok, Kimi, Qwen, OpenCode, Crush, Pi, Copilot, Cursor, Antigravity, or any custom command) as real PTY processes, visualised as an *Office*-themed pixel-art floor (Pixi.js), coordinated by an on-disk multi-agent "hive" with a privileged GOD/orchestrator agent.

## Commands

```bash
npm install            # postinstall runs electron-rebuild for node-pty (needs C/C++ toolchain)
npm run dev            # live-reloading Electron build (electron-vite)
npm run build          # production build into out/ (+ copies main-process .cjs sidecars)
npm run typecheck      # tsc for both tsconfig.node.json (main/preload/shared) and tsconfig.web.json (renderer)
npm run test:focused   # node --test test/*.test.cjs
node --test test/god-identity.test.cjs   # run a single test file
node --test --test-name-pattern="falls back" test/god-identity.test.cjs   # single test by name
npm run check:links    # release gate: download links / version strings must match package.json
npm run dist:win       # (or dist:mac / dist:linux) build + electron-builder package
```

CI (`.github/workflows/ci.yml`) runs `typecheck` + `check:links` (blocking) and `build` (non-blocking). "NODE_MODULE_VERSION" / wrong ELF/Mach-O errors at launch mean the node-pty rebuild failed: re-run `npm install`.

### Tests

Tests are plain CommonJS `node:test` files in `test/`, no Jest/Vitest. They load TypeScript sources directly via `test/load-ts.cjs`, which transpiles on the fly with `typescript.transpileModule` and resolves the `@shared/` alias:

```js
const loadTs = require('./load-ts.cjs');
const { resolveGodName } = loadTs('src/shared/godIdentity.ts');
```

So testable logic is kept in modules that import little or no Electron (much of it in `src/shared/`). `*.electron.test.cjs` files exercise real Electron (with fixtures in `test/fixtures/`); `*.manual.cjs` are not part of the suite.

## Architecture

Three Electron bundles (configured in `electron.vite.config.ts`):

- **`src/main/`**: Node main process. `index.ts` holds the window, quit guard, and ~150 `ipcMain.handle` handlers.
- **`src/preload/index.ts`**: the only bridge, exposed as `window.cth` via `contextBridge` (typed in `index.d.ts`). Any new main↔renderer capability needs a handler in main, an entry here, and a type in `index.d.ts`.
- **`src/renderer/src/`**: React 18 + zustand UI. Aliases: `@` → `src/renderer/src`, `@shared` → `src/shared`, `@brand` → `docs`.
- **`src/shared/`**: pure TS used by both main and renderer (provider definitions, catalogs, task ledger, hire, triggers, etc.).

Two data planes feed the renderer (see `docs/ARCHITECTURE.md`):

- **Terminal plane**: `pty.ts` (`PtyManager`) spawns each agent with node-pty and streams per-id IPC (`pty:data:<id>`). `fs.ts`/`git.ts` are sandboxed bridges (path-containment tested). `ptyEnv.ts`/`shellEnv.ts` build child env and PATH.
- **Event / hive plane**: `hive.ts` is the on-disk multi-agent layer. Each agent writes only in its own `agents/<id>/` dir. The main-process router moves `outbox/` → `inbox/`, and **only the main process commits** to the hive git repo (agents never run git). `hooks.ts` runs the hook server that provider shims (`cth-hook`, `agy-hook`, ...) POST lifecycle events to. The autonomous loop is a `Stop` hook that blocks to drain the inbox. `workerWake.ts`/`workerLaunch.ts` handle idle wakeups and launches. `memory.ts` wraps the semantic memory CLI (degrades to no-op). `breaker.ts`/`control.ts` provide the cost/runaway circuit breaker and HITL steer/stop.
- **Telemetry/cost**: `transcript.ts` reads provider JSONL transcripts, while `usage.ts`, `pricing.ts`, `costLifetime.ts` and `db.ts` (better-sqlite3 ledger) attribute cost. `analytics.ts` is anonymous PostHog and no-ops unless `POSTHOG_KEY` is set at build time (contract in `TELEMETRY.md`).
- **Main-process `.cjs` sidecars** (`slack-trigger.cjs`, `kg-core.cjs`) are `require()`d at runtime and are not bundled. They are copied by the `copyMainSidecars` plugin in `electron.vite.config.ts`, so a new sidecar must be added there.

Renderer areas: `scene/office/` (Pixi floor, characters, pathfinding), `pro/` (newer sidebar "Pro" layout, `ProShell.tsx` + views), `components/` (classic panels), `terminal/` (xterm.js), `ide/`, `realtime/` (voice via OpenAI realtime), `store/` (zustand), `i18n/` (en, es).

Design docs: `HIVE.md` (multi-agent design target), `SPEC.md` (terminal/event plane), `DESIGN.md` (visual system, canonical), `docs/message-queue.md` (who may type into an agent's terminal, and when).

## Project rules (from CONTRIBUTING.md)

- **Cross-platform**: macOS, Windows and Linux. Use `path.join`/Node path helpers, never hand-built `"a/b"` strings. Handle paths containing spaces. Gate platform-specific code behind explicit runtime checks.
- **Provider neutral**: shared behaviour must not assume Claude Code. Put provider-specific logic behind explicit checks (see `src/shared/agentProvider.ts` and the `*Commands.ts` files).
- **Don't assume the local machine**: agents run in their own cwd/env.
- **UI derives from design tokens**: `src/renderer/src/design/tokens.ts` and `tokens.css` are mirrored, so change both. No ad-hoc colors, spacing or fonts. Aesthetic: pixel-snapped SNES/Earthbound, Dunder-Mifflin maroon `#6E1423` + gold `#F4D35E`.
- **i18n**: user-facing strings go through react-i18next locales. Keep key parity between `en.json` and `es.json`.
- **PRs**: one change per PR. No drive-by reformatting. Justify new dependencies. Every PR needs `### Before` / `### After` evidence in the description, enforced by the `PR evidence` check (for test-only changes, use red → green suite output). Before opening: `npm run typecheck`, `npm run test:focused` (add a test for behaviour changes), and `npm run build`.
- **Assets**: new art must be original or compatibly licensed and listed in `src/renderer/src/assets/ATTRIBUTION.md`. Keep the LimeZu credit.

## Other directories

- `blog/`: separate Eleventy site that builds into `docs/blog/` (own `package.json`, see `blog/BLOG_README.md`).
- `docs/`: GitHub Pages marketing site (scranton-branch.zerogeworkshop.com), plus `model-catalog.json` (remote model catalog).
- `landing-remotion/`: Remotion clips for the landing page.
- `seo/`: SEO content notes.
- `tools/`: build helpers (`copy-main-assets.cjs`, node-pty patches), `agent-env.cjs` (per-agent env query, see `tools/AGENT-ENV.md`), `mapgen/` (Python helpers for the Tiled office map).
- Release process: `RELEASE.md` / `RELEASE-CHECKLIST.md`.
