/**
 * Read the code a proposed runner runs (shared/runnerCode.ts finds which
 * files), so the human sees it in the proposal window. Every read goes through
 * fs.ts's `readFileText`, confined to the agent's own folder: a path outside
 * it, or a symlink leaving it, is listed as not readable instead of shown.
 */
import { readFileText } from './fs';
import { capText, packageScript, runnerCodeRefs, type RunnerCodeFile } from '../shared/runnerCode';

/** Characters shown per file, and files per proposal. */
export const MAX_FILE_CHARS = 60_000;
export const MAX_FILES = 6;

type Reader = typeof readFileText;

function errorOf(message: string): RunnerCodeFile['error'] {
  if (/escapes root/.test(message)) return 'outside';
  if (/ENOENT|no such file/i.test(message)) return 'missing';
  if (/binary/.test(message)) return 'binary';
  if (/too large/.test(message)) return 'tooLarge';
  return 'unreadable';
}

async function readOne(cwd: string, rel: string, read: Reader): Promise<RunnerCodeFile> {
  const r = await read(cwd, rel);
  if (!r.ok) return { path: rel, error: errorOf(r.error) };
  const { text, truncated } = capText(r.content, MAX_FILE_CHARS);
  return { path: rel, content: text, ...(truncated ? { truncated } : {}) };
}

/**
 * The code behind `command` in `cwd`: package.json scripts it starts (with the
 * files those name, one level deep) and the script files it names. Without a
 * folder there is nothing to read.
 */
export async function readRunnerCode(cwd: string | undefined, command: string, read: Reader = readFileText): Promise<RunnerCodeFile[]> {
  if (!cwd) return [];
  const out: RunnerCodeFile[] = [];
  const refs = runnerCodeRefs(command);
  const files = [...refs.files];
  if (refs.packageScripts.length) {
    const pkg = await read(cwd, 'package.json');
    for (const name of refs.packageScripts) {
      if (out.length >= MAX_FILES) break;
      if (!pkg.ok) { out.push({ path: 'package.json', script: name, error: errorOf(pkg.error) }); continue; }
      const line = packageScript(pkg.content, name);
      if (line === null) { out.push({ path: 'package.json', script: name, error: 'missing' }); continue; }
      out.push({ path: 'package.json', script: name, content: line });
      for (const f of runnerCodeRefs(line).files) if (!files.includes(f)) files.push(f);
    }
  }
  for (const f of files) {
    if (out.length >= MAX_FILES) break;
    out.push(await readOne(cwd, f, read));
  }
  return out;
}
