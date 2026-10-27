'use strict';
// WSL offices (src/main/wsl.ts): where a floor lives decides where it runs, so
// path translation and the wsl.exe command line have to be exactly right.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseWslPath, toWslUnc, toLinuxPath, linuxizeText, wslCommand, parseDistroList, WSL_PRELUDE } = loadTs('src/main/wsl.ts');

test('a \\\\wsl.localhost or \\\\wsl$ path is a WSL floor, a drive path is not', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\diego\\offices\\shop'), { distro: 'Ubuntu', linuxPath: '/home/diego/offices/shop' });
  assert.deepEqual(parseWslPath('\\\\wsl$\\Ubuntu-24.04\\home\\d\\'), { distro: 'Ubuntu-24.04', linuxPath: '/home/d' });
  assert.deepEqual(parseWslPath('//wsl.localhost/Debian/srv/x'), { distro: 'Debian', linuxPath: '/srv/x' });
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', linuxPath: '/' });
  assert.equal(parseWslPath('G:\\Documentos\\office'), null);
  assert.equal(parseWslPath('\\\\server\\share\\x'), null);
  assert.equal(parseWslPath(''), null);
});

test('round trip between the Linux path and the Windows path', () => {
  const unc = toWslUnc('Ubuntu', '/home/diego/offices/shop');
  assert.equal(unc, '\\\\wsl.localhost\\Ubuntu\\home\\diego\\offices\\shop');
  assert.deepEqual(parseWslPath(unc), { distro: 'Ubuntu', linuxPath: '/home/diego/offices/shop' });
});

test('paths as a process inside the distro sees them', () => {
  assert.equal(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\d\\o', 'ubuntu'), '/home/d/o');
  assert.equal(toLinuxPath('G:\\Documentos\\Github\\x', 'Ubuntu'), '/mnt/g/Documentos/Github/x');
  assert.equal(toLinuxPath('C:\\', 'Ubuntu'), '/mnt/c');
  assert.equal(toLinuxPath('\\\\wsl.localhost\\Debian\\x', 'Ubuntu'), null, "another distro's files have no path here");
  assert.equal(toLinuxPath('relative/thing', 'Ubuntu'), 'relative/thing');
});

test('UNC paths inside text (prompts, settings) become Linux paths', () => {
  const text = 'Your inbox is \\\\wsl.localhost\\Ubuntu\\home\\d\\o\\hive\\agents\\god\\inbox; read "\\\\wsl$\\Ubuntu\\home\\d\\o\\hive\\tasks.json".';
  assert.equal(linuxizeText(text, 'Ubuntu'), 'Your inbox is /home/d/o/hive/agents/god/inbox; read "/home/d/o/hive/tasks.json".');
  assert.equal(linuxizeText('\\\\wsl.localhost\\Debian\\x', 'Ubuntu'), '\\\\wsl.localhost\\Debian\\x', 'other distros untouched');
});

test('the wsl.exe command runs through a login shell, in the right folder, with env', () => {
  const c = wslCommand('Ubuntu', '/home/d/o', 'claude', ['--model', 'opus'], { MD_AGENT_ID: 'god', MD_BROKER_TOKEN: 's3cret', 'BAD-NAME': 'x' }, '');
  assert.equal(c.file, 'wsl.exe');
  assert.deepEqual(c.args, ['-d', 'Ubuntu', '--cd', '/home/d/o', '--exec', 'bash', '-lc', WSL_PRELUDE, 'bash', 'claude', '--model', 'opus']);
  // env goes through the process environment + WSLENV, never the command line
  assert.ok(!c.args.join(' ').includes('s3cret'));
  assert.deepEqual(c.env, { MD_AGENT_ID: 'god', MD_BROKER_TOKEN: 's3cret', WSLENV: 'MD_AGENT_ID:MD_BROKER_TOKEN' });
  assert.equal(wslCommand('U', '/', 'x', [], { A: '1' }, 'USERPROFILE/p').env.WSLENV, 'A:USERPROFILE/p', 'keeps the user\'s own WSLENV');
  // '' = no WSLENV of the user's own (undefined would read this process's, e.g. Windows Terminal's).
  assert.deepEqual(wslCommand('U', '/', 'x', [], {}, '').env, {});
  assert.match(WSL_PRELUDE, /nvm.sh/);
  assert.ok(WSL_PRELUDE.endsWith('exec "$@"'), "the prelude ends by running the command");
});

test('wsl -l -q output (UTF-16LE with a BOM) parses to distro names', () => {
  const raw = Buffer.from('\uFEFFUbuntu\r\nDebian\r\ndocker-desktop\r\n\r\n', 'utf16le');
  assert.deepEqual(parseDistroList(raw), ['Ubuntu', 'Debian']);
  assert.deepEqual(parseDistroList('Ubuntu-24.04\n'), ['Ubuntu-24.04']);
});

test('wsl.exe failures become sentences a person can act on', () => {
  const { describeWslError } = loadTs('src/main/wsl.ts');
  assert.match(describeWslError(Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' })), /not installed or is disabled/);
  assert.match(describeWslError(Object.assign(new Error('spawn wsl.exe EPERM'), { code: 'EPERM' })), /security software/i);
  assert.match(describeWslError('timed out', 'Ubuntu'), /Ubuntu.*too long/);
  const utf16 = Buffer.from('﻿There is no distribution with the supplied name.\r\n', 'utf16le');
  assert.match(describeWslError(utf16, 'Foo'), /was not found/);
  assert.match(describeWslError('Error code: Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED'), /virtualization/i);
  assert.equal(describeWslError('boom\nsecond'), 'boom');
  assert.ok(describeWslError('').length > 0);
});

test('mempalace runs inside the distro for a WSL floor, with Linux paths', () => {
  const { mempalaceInvocation } = loadTs('src/main/memory.ts');
  const wsl = { distro: 'Ubuntu', linuxPath: '/home/d/offices/shop' };
  const palace = '\\\\wsl.localhost\\Ubuntu\\home\\d\\offices\\shop\\palace';
  const inv = mempalaceInvocation('/home/d/.local/bin/mempalace',
    ['mine', '\\\\wsl.localhost\\Ubuntu\\home\\d\\offices\\shop\\hive\\agents\\a1', '--wing', 'a1'],
    { MEMPALACE_PALACE_PATH: palace, MEMPALACE_EMBEDDING_MODEL: 'minilm' }, wsl);
  assert.equal(inv.file, 'wsl.exe');
  assert.ok(inv.args.includes('/home/d/offices/shop/hive/agents/a1'));
  assert.equal(inv.env.MEMPALACE_PALACE_PATH, '/home/d/offices/shop/palace');
  assert.match(inv.env.WSLENV, /MEMPALACE_PALACE_PATH/);
  assert.ok(inv.args.includes('/home/d/.local/bin/mempalace'));
  const plain = mempalaceInvocation('mempalace.exe', ['search', 'x'], {}, null);
  assert.deepEqual(plain, { file: 'mempalace.exe', args: ['search', 'x'] });
});

test('Windows drive paths become /mnt paths for agents in the distro', () => {
  const { fromLinuxPath } = loadTs('src/main/wsl.ts');
  assert.equal(linuxizeText('run "C:\\Program Files\\Scranton Branch\\resources\\kg.cjs" search x', 'Ubuntu'),
    'run "/mnt/c/Program Files/Scranton Branch/resources/kg.cjs" search x');
  assert.equal(linuxizeText('KG at C:\\Users\\d\\AppData\\kg now', 'Ubuntu'), 'KG at /mnt/c/Users/d/AppData/kg now');
  assert.equal(linuxizeText('ROOT=G:\\x', 'Ubuntu'), 'ROOT=/mnt/g/x');
  assert.equal(linuxizeText('no paths: a:b, http://x', 'Ubuntu'), 'no paths: a:b, http://x');
  // and back: what an agent in the distro writes, as the app opens it
  assert.equal(fromLinuxPath('/home/d/repo', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\d\\repo');
  assert.equal(fromLinuxPath('~/repo/x', 'Ubuntu', () => '\\\\wsl.localhost\\Ubuntu\\home\\d'), '\\\\wsl.localhost\\Ubuntu\\home\\d\\repo\\x');
  assert.equal(fromLinuxPath('/mnt/c/Users/d', 'Ubuntu'), 'C:\\Users\\d');
  assert.equal(fromLinuxPath('G:\\x', 'Ubuntu'), 'G:\\x');
  assert.equal(fromLinuxPath('~', 'Ubuntu', () => null), '~');
});

test('a WSL agent\'s Claude transcripts live in the distro home, keyed by the Linux path', () => {
  const { claudeProjects } = loadTs('src/main/transcript.ts');
  const loc = claudeProjects('\\\\wsl.localhost\\Ubuntu\\home\\d\\offices\\shop', 'win32', () => '\\\\wsl.localhost\\Ubuntu\\home\\d');
  assert.equal(loc.root, '\\\\wsl.localhost\\Ubuntu\\home\\d\\.claude\\projects');
  assert.equal(loc.cwd, '/home/d/offices/shop');
  const plain = claudeProjects('/home/d/x', 'linux', () => { throw new Error('no wsl here'); });
  assert.equal(plain.cwd, '/home/d/x');
});

test('.wslconfig turns on mirrored networking however the line is written', () => {
  const { wslconfigMirrored } = loadTs('src/main/wsl.ts');
  assert.ok(wslconfigMirrored('[wsl2]\nnetworkingMode=mirrored\n'));
  assert.ok(wslconfigMirrored('[wsl2]\r\nnetworkingMode = "Mirrored"  # set by IT\r\n'));
  assert.ok(wslconfigMirrored("[wsl2]\nnetworkingmode='mirrored' ; note\n"));
  assert.ok(!wslconfigMirrored('[wsl2]\nnetworkingMode=nat\n'));
  assert.ok(!wslconfigMirrored('[wsl2]\n# networkingMode=mirrored\n'));
});
