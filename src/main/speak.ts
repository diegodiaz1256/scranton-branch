/**
 * Read text aloud with the operating system's own voices, offline: Windows'
 * speech engine (System.Speech, through PowerShell), macOS `say`, and on
 * Linux espeak-ng / espeak or spd-say. Used by offline talk to read the
 * orchestrator's reply. Electron's web speech API has no voices on some
 * installs, so the app goes to the OS directly.
 *
 * The text never goes through a shell: stdin where the tool reads it, else a
 * plain argument. Electron-free; one voice at a time.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface SpeakCommand { file: string; args: string[]; stdin: boolean }

/** How to speak on this platform; null when there is nothing to try. */
export function speakCommands(platform: NodeJS.Platform, lang: string, silent = false): SpeakCommand[] {
  const culture = /^es/i.test(lang) ? 'es-ES' : 'en-US';
  if (platform === 'win32') {
    // A voice for the language when one is installed, else the default voice.
    const script = [
      // The text arrives as UTF-8 (accents, ñ), not in the console's code page.
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq '${culture}' } | Select-Object -First 1`,
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      // Tests run the real engine without sound.
      ...(silent ? ['$s.SetOutputToNull()'] : []),
      '$t = [Console]::In.ReadToEnd()',
      'if ($t) { $s.Speak($t) }'
    ].join('; ');
    return [{ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], stdin: true }];
  }
  if (platform === 'darwin') return [{ file: 'say', args: [], stdin: true }];
  const v = culture.slice(0, 2);
  return [
    { file: 'espeak-ng', args: ['-v', v, '--stdin'], stdin: true },
    { file: 'espeak', args: ['-v', v, '--stdin'], stdin: true },
    { file: 'spd-say', args: ['-w', '-l', v], stdin: false }
  ];
}

let current: ChildProcess | null = null;

/** Speak `text`; resolves when done, stopped, or no voice could be started. */
export function speak(text: string, lang: string, platform: NodeJS.Platform = process.platform, silent = false): Promise<{ ok: boolean; error?: string }> {
  stopSpeaking();
  const cmds = speakCommands(platform, lang, silent);
  const tryAt = (i: number): Promise<{ ok: boolean; error?: string }> => new Promise((resolve) => {
    const c = cmds[i];
    if (!c) { resolve({ ok: false, error: 'no text-to-speech on this system' }); return; }
    let child: ChildProcess;
    try {
      child = spawn(c.file, c.stdin ? c.args : [...c.args, text], { stdio: [c.stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch { void tryAt(i + 1).then(resolve); return; }
    current = child;
    let started = true;
    child.on('error', () => { started = false; if (current === child) current = null; void tryAt(i + 1).then(resolve); });
    child.on('exit', (code, signal) => {
      if (current === child) current = null;
      if (!started) return;
      resolve(code === 0 || signal ? { ok: true } : { ok: false, error: `${c.file} exited with ${code}` });
    });
    if (c.stdin && child.stdin) {
      child.stdin.on('error', () => { /* the voice ended early */ });
      child.stdin.end(text, 'utf8');
    }
  });
  return tryAt(0);
}

export function stopSpeaking(): void {
  if (current) { try { current.kill(); } catch { /* gone */ } current = null; }
}
