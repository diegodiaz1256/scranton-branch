/**
 * First module of the server bundle: settles the process before main's modules
 * read anything at import time.
 */
import { join } from 'node:path';

// Where a packaged desktop app keeps its extraResources (kg CLI, Slack helper,
// bundled skills); the server build copies them next to itself.
(process as { resourcesPath?: string }).resourcesPath = join(__dirname, 'resources');
// main reads this at import (src/main/headless.ts): no window is ever shown.
process.env.SB_HEADLESS = '1';
// …and there is no Electron: no self-updater (update the server with its
// package), no Chromium switches.
process.env.SB_SERVER = '1';
// Agents in another user's group must be able to write what main creates in
// the office (inboxes, the hook socket): group-writable by default.
if ((process.env.SB_AGENT_UID || process.env.MD_AGENT_UID) && process.platform !== 'win32') process.umask(0o002);

