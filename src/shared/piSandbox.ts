/**
 * pi has no OS sandbox of its own; the app builds one with bubblewrap on Linux
 * and inside a WSL floor's distro (bwrapSandbox.ts). Where bubblewrap cannot
 * run, a pi agent starts unconfined with a "Not sandboxed" badge, unless the
 * human turned on Settings → AI providers → "Refuse pi agents without an OS
 * sandbox" (config.piRequireSandbox). Then it is not started, and its terminal
 * says why and how to install bubblewrap.
 *
 * Pure: no electron, no node.
 */

/** Where the agent would run, for the explanation. */
export type PiSandboxPlace = 'wsl' | 'linux' | 'windows' | 'mac';

/** Refuse this spawn? Only pi, only with the setting on, only without bubblewrap. */
export function refusePiWithoutSandbox(provider: string | undefined, requireSandbox: boolean | undefined, sandboxAvailable: boolean): boolean {
  return provider === 'pi' && requireSandbox === true && !sandboxAvailable;
}

/** How to install bubblewrap on Ubuntu/Debian, a WSL distro included (toolCatalog.ts). */
export const BWRAP_INSTALL = 'sudo apt update && sudo apt install -y bubblewrap socat';

/** The lines the agent's terminal shows instead of starting pi. ASCII only,
 *  no quotes or shell metacharacters but `&&` in the install line (each line
 *  is echoed single-quoted on unix, by cmd on Windows: see the script below). */
export function piNoSandboxLines(place: PiSandboxPlace, distro?: string): string[] {
  const rule = '------------------------------------------------------------';
  const head = [rule, '  This pi agent was not started: it would run with no OS sandbox.', ''];
  const setting = [
    '  pi has no sandbox of its own, and Settings > AI providers > pi',
    '  has Refuse pi agents without an OS sandbox turned on.'
  ];
  if (place === 'wsl' || place === 'linux') {
    return [
      ...head,
      `  The app sandboxes pi with bubblewrap, which is not installed ${place === 'wsl' ? `in WSL${distro ? ` (${distro.replace(/[^A-Za-z0-9._-]/g, '')})` : ''}` : 'on this machine'}.`,
      ...setting,
      '',
      `  Install it${place === 'wsl' ? ' inside the distro' : ''}, then restart this agent:`,
      `    ${BWRAP_INSTALL}`,
      '    Fedora: sudo dnf install bubblewrap socat   Arch: sudo pacman -S bubblewrap socat',
      '  Or turn the setting off to run pi without a sandbox.',
      rule
    ];
  }
  return [
    ...head,
    `  The app can sandbox pi only on a Linux or WSL floor, not on ${place === 'mac' ? 'macOS' : 'native Windows'}.`,
    ...setting,
    '',
    '  Run this agent on a WSL floor (with bubblewrap installed there),',
    '  use another engine, or turn the setting off to run pi without a sandbox.',
    rule
  ];
}

/** The script PtyManager runs in the agent's terminal (`shellScript`): bash
 *  -lc on Linux and WSL, cmd.exe /d /s /c on Windows (no double quotes). */
export function piNoSandboxScript(place: PiSandboxPlace, distro?: string): string {
  const lines = ['', ...piNoSandboxLines(place, distro), ''];
  if (place === 'windows') {
    return lines.map((l) => (l ? `echo ${l.replace(/[&|<>^()%!"]/g, (c) => (c === '%' ? '%%' : c === '"' ? '' : `^${c}`))}` : 'echo.')).join(' & ');
  }
  return lines.map((l) => `echo '${l.replace(/'/g, '')}'`).join('\n');
}
