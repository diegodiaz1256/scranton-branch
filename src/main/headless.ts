/**
 * Headless mode: the whole app, with no window shown — for a machine that just
 * hosts an office. Two hosts:
 *
 *   munder-difflin --headless …          the desktop app, window never shown
 *   node server/index.cjs …              the server build (src/server): plain
 *                                        Node, no Chromium — what Ubuntu
 *                                        servers and containers run
 *
 *   --office <dir>        SB_OFFICE        the office (first run: skips onboarding)
 *   --name <name>         SB_NAME          this office's name on Team
 *   --team-join <code>    SB_TEAM_JOIN     pair with an invite from Manager → Team
 *   --max-workers <n>     SB_MAX_WORKERS   cap on concurrent workers
 *   (each SB_* is also read as MD_*, its name before the rename; @shared/envName)
 *
 * In the desktop host the renderer still runs, in a window that is never shown, so every bit of
 * orchestration (the orchestrator's boot, team restore, inbox wake-ups, queue
 * delivery, context rules) behaves exactly as on a desktop. On Linux with no
 * display server, Chromium's headless Ozone backend is selected so nothing needs
 * X or Wayland (xvfb-run is the fallback if a distro's build objects).
 *
 * Must be imported right after demo.ts in index.ts: the Chromium switches have
 * to be set before the app is ready.
 *
 * Talk to a headless office from your desktop through Team: create an invite in
 * Manager → Team and pass it as --team-join; the server's orchestrator is then one of
 * your teammates.
 */
import { app } from 'electron';
import { resolve } from 'node:path';
import { appEnv, takeAppEnv } from '../shared/envName';

/** A flag's value, else its environment variable (systemd units and
 *  containers configure through the environment). */
function argValue(name: string): string | undefined {
  const env = appEnv(name.toUpperCase().replace(/-/g, '_'));
  return flagValue(name) ?? (env && env.trim() ? env.trim() : undefined);
}

/** Read a secret from the environment and remove it, so no child (agents
 *  inherit this process's environment) ever sees it. */
function takeEnv(name: string): string | undefined {
  const v = takeAppEnv(name);
  return v && v.trim() ? v.trim() : undefined;
}

function flagValue(name: string): string | undefined {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

export const HEADLESS = process.argv.includes('--headless') || appEnv('HEADLESS') === '1';

/** The GUI-less server build (src/server): plain Node, no Electron at all. */
export const SERVER = appEnv('SERVER') === '1';

/** First-run setup from the command line (headless only). */
export const HEADLESS_SETUP = HEADLESS
  ? {
      office: argValue('office') ? resolve(argValue('office')!) : undefined,
      name: argValue('name'),
      teamJoin: argValue('team-join'),
      maxWorkers: Number(argValue('max-workers')) || undefined,
      relayTokens: takeEnv('RELAY_TOKEN')?.split(',').map((s) => s.trim()).filter(Boolean)
    }
  : null;

if (HEADLESS && !SERVER) {
  // No display server (a typical server): Chromium's headless Ozone platform.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    app.commandLine.appendSwitch('ozone-platform', 'headless');
  }
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  // Nothing to show in a dock or taskbar.
  if (process.platform === 'darwin') app.dock?.hide();
}
