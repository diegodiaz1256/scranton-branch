const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const { wslCommand, spillLongArgs, WSL_PRELUDE, WSL_PRELUDE_SPILLED, WSL_ARG_SPILL } = loadTs('src/main/wsl.ts');

const prompt = 'You are pi.\nSay "hi" and \'bye\' $HOME `x` \\ end\n' + 'p'.repeat(60000);

test('short arguments stay on the command line, with the plain prelude', () => {
  const s = spillLongArgs(['--model', 'x', 'y'.repeat(WSL_ARG_SPILL)]);
  assert.deepEqual(s.args, ['--model', 'x', 'y'.repeat(WSL_ARG_SPILL)]);
  assert.deepEqual(s.env, {});
  assert.ok(wslCommand('Ubuntu', '/', 'pi', s.args, s.env).args.includes(WSL_PRELUDE));
});

test('a long argument leaves argv in chunks a Windows variable can hold', () => {
  const s = spillLongArgs(['--tools', 'read', prompt]);
  assert.equal(s.args[2], '@@md-env-arg:MD_ARG_2:4');
  assert.equal(Object.values(s.env).join(''), prompt);
  for (const v of Object.values(s.env)) assert.ok(v.length < 32767);
  const c = wslCommand('Ubuntu', '/', 'pi', s.args, s.env);
  assert.ok(c.args.includes(WSL_PRELUDE_SPILLED));
  assert.ok(c.args.join(' ').length < 8000, 'the command line is short');
  assert.match(c.env.WSLENV, /MD_ARG_2_0:MD_ARG_2_1:MD_ARG_2_2:MD_ARG_2_3/);
});

// The real thing: wsl.exe hands the pieces over and bash puts them back.
const hasWsl = (() => {
  if (process.platform !== 'win32') return false;
  try { execFileSync('wsl.exe', ['--exec', 'true'], { windowsHide: true, timeout: 30000 }); return true; } catch { return false; }
})();

test('inside WSL the command gets the argument intact and the variables are gone', { skip: !hasWsl && 'no WSL here' }, () => {
  const s = spillLongArgs(['first', prompt, 'last']);
  const script = 'printf %s "$2" | md5sum | cut -c1-32; echo "$1|$3|$#"; env | grep -c "^MD_ARG_" || true';
  const c = wslCommand('', '/', 'bash', ['-c', script, 'x', ...s.args], s.env, '');
  const args = c.args.slice(2); // no -d: the default distro
  const out = execFileSync(c.file, args, { env: { ...process.env, ...c.env }, encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim().split('\n');
  assert.equal(out[0], crypto.createHash('md5').update(prompt).digest('hex'));
  assert.equal(out[1], 'first|last|3');
  assert.equal(out[2], '0');
});
