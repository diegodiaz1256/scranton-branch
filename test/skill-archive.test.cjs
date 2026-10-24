'use strict';

/**
 * Installing a skill from a repository tarball or a local folder
 * (src/main/skillArchive.ts + installSkillFromFolder).
 *
 * The archive is someone else's content, so most of these are refusals: a
 * path that climbs out, a symlink pointing at ~/.ssh, a "skill" the size of a
 * dataset. The archives are built here byte by byte (ustar + pax, gzip), the
 * way codeload.github.com serves them, so no network is involved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('./load-ts.cjs');

const {
  safeRelPath, indexArchive, listArchiveDir, planArchiveSkill, extractArchiveSkill,
  overLimitMessage, restoreExecBits, stagingDir, commitStaging, copySkillTreeSync
} = loadTs('src/main/skillArchive.ts');
const { resolveRepoRootSkillDir, installSkillFromFolder, SKILL_LIMITS } = loadTs('src/main/skills.ts');

const tmpdir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-skill-archive-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function header(name, { type = '0', size = 0, mode = 0o644, linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** A pax record: `<len> key=value\n`, where len counts itself. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len++;
  return `${len}${body}`;
}

/** entries: [{ name, body?, type?, mode?, linkname? }] → .tar.gz bytes. */
function tgz(entries) {
  const parts = [];
  for (const e of entries) {
    const type = e.type ?? '0';
    const body = Buffer.from(e.body ?? '');
    const carries = type === '0' || type === 'x' || type === 'g' || type === 'L';
    parts.push(header(e.name, { type, size: carries ? body.length : 0, mode: e.mode, linkname: e.linkname }));
    if (carries && body.length) parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

const ROOT = 'repo-0123abc';
/** A GitHub-shaped archive: a global pax header, then everything under <repo>-<sha>/. */
function githubArchive(t, members) {
  const file = path.join(tmpdir(t), 'repo.tar.gz');
  fs.writeFileSync(file, tgz([
    { name: 'pax_global_header', type: 'g', body: paxRecord('comment', '0123abc') },
    { name: `${ROOT}/`, type: '5', mode: 0o755 },
    ...members.map((m) => ({ ...m, name: `${ROOT}/${m.name}` }))
  ]));
  return file;
}

const SKILL_MD = '---\nname: demo\ndescription: a demo skill\n---\nbody\n';

test('a path that is absolute, climbs, or Windows cannot hold is refused', () => {
  assert.equal(safeRelPath('scripts/run.py'), 'scripts/run.py');
  assert.equal(safeRelPath('data/'), 'data');
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a\\..\\b', 'C:/x', 'SKILL.md:ads', 'nul', 'con.txt', 'a/b.', 'a/b ', 'a\0b', 'x?y']) {
    assert.equal(safeRelPath(bad), null, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('only the skill folder is extracted, with its executables recorded', async (t) => {
  const file = githubArchive(t, [
    { name: 'README.md', body: 'repo readme' },
    { name: 'skills/demo/', type: '5', mode: 0o755 },
    { name: 'skills/demo/SKILL.md', body: SKILL_MD },
    { name: 'skills/demo/scripts/run.sh', body: '#!/bin/sh\necho hi\n', mode: 0o755 },
    { name: 'skills/demo/data/empty.csv', body: '' },
    { name: 'skills/other/SKILL.md', body: SKILL_MD }
  ]);
  const entries = await indexArchive(file);
  assert.ok(entries.every((e) => !e.path.startsWith(ROOT)), 'the archive root folder is stripped');
  const plan = planArchiveSkill(entries, 'skills/demo');
  assert.deepEqual({ files: plan.files, skipped: plan.skipped }, { files: 3, skipped: [] });

  const dest = path.join(tmpdir(t), 'staging');
  const { executables } = await extractArchiveSkill(file, 'skills/demo', dest, SKILL_LIMITS);
  assert.deepEqual(executables, ['scripts/run.sh']);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), SKILL_MD);
  assert.equal(fs.readFileSync(path.join(dest, 'data', 'empty.csv'), 'utf8'), '');
  assert.ok(!fs.existsSync(path.join(dest, 'README.md')));
  assert.ok(!fs.existsSync(path.join(dest, '..', 'other')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dest, 'scripts', 'run.sh')).mode & 0o111, 0o111);
    assert.equal(fs.statSync(path.join(dest, 'SKILL.md')).mode & 0o111, 0);
  }
});

test('a pax long path (over 100 bytes) is honoured', async (t) => {
  const long = `skills/demo/${'nested/'.repeat(14)}deep.md`;
  assert.ok(long.length > 100);
  const file = githubArchive(t, [
    { name: 'skills/demo/SKILL.md', body: SKILL_MD },
    { name: 'PaxHeader', type: 'x', body: paxRecord('path', `${ROOT}/${long}`) },
    { name: 'truncated-name', body: 'deep file' }
  ]);
  const dest = path.join(tmpdir(t), 'staging');
  await extractArchiveSkill(file, 'skills/demo', dest, SKILL_LIMITS);
  assert.equal(fs.readFileSync(path.join(dest, ...long.slice('skills/demo/'.length).split('/')), 'utf8'), 'deep file');
});

test('a member that climbs out of the skill folder refuses the whole install', async (t) => {
  const file = githubArchive(t, [
    { name: 'skills/demo/SKILL.md', body: SKILL_MD },
    { name: 'skills/demo/../../../../evil.txt', body: 'pwned' }
  ]);
  const plan = planArchiveSkill(await indexArchive(file), 'skills/demo');
  assert.match(plan.error, /unsafe path/);
  const dest = path.join(tmpdir(t), 'staging');
  await assert.rejects(extractArchiveSkill(file, 'skills/demo', dest, SKILL_LIMITS), /unsafe path/);
  assert.ok(!fs.existsSync(path.join(dest, '..', '..', 'evil.txt')));
});

test('symlinks and hardlinks are skipped and reported, never created', async (t) => {
  const file = githubArchive(t, [
    { name: 'skills/demo/SKILL.md', body: SKILL_MD },
    { name: 'skills/demo/keys', type: '2', linkname: '/home/me/.ssh' },
    { name: 'skills/demo/hard', type: '1', linkname: `${ROOT}/README.md` }
  ]);
  const plan = planArchiveSkill(await indexArchive(file), 'skills/demo');
  assert.deepEqual(plan.skipped.sort(), ['hard', 'keys']);
  const dest = path.join(tmpdir(t), 'staging');
  await extractArchiveSkill(file, 'skills/demo', dest, SKILL_LIMITS);
  assert.deepEqual(fs.readdirSync(dest), ['SKILL.md']);
});

test('a folder with no SKILL.md is not installed', async (t) => {
  const file = githubArchive(t, [{ name: 'skills/demo/notes.md', body: 'x' }]);
  assert.match(planArchiveSkill(await indexArchive(file), 'skills/demo').error, /no SKILL\.md/);
});

test('an oversized skill is refused before extraction, with its real size and the limit', async (t) => {
  const file = githubArchive(t, [
    { name: 'skills/demo/SKILL.md', body: SKILL_MD },
    { name: 'skills/demo/data.bin', body: 'x'.repeat(3 * 1024 * 1024) }
  ]);
  const plan = planArchiveSkill(await indexArchive(file), 'skills/demo');
  const msg = overLimitMessage(plan, { maxBytes: 2 * 1024 * 1024, maxFiles: 100 });
  assert.equal(msg, 'that skill is 3 MB unpacked (2 files); the limit is 2 MB');
  assert.equal(overLimitMessage(plan, SKILL_LIMITS), null, '3 MB is well inside the shipped limit');
  await assert.rejects(
    extractArchiveSkill(file, 'skills/demo', path.join(tmpdir(t), 's'), { maxBytes: 2 * 1024 * 1024, maxFiles: 100 }),
    /3 MB unpacked/
  );
});

test('a repo-root source finds its skill in the archive index, no API calls', async (t) => {
  const file = githubArchive(t, [
    { name: 'README.md', body: 'x' },
    { name: '.claude/skills/ui-ux-pro-max/SKILL.md', body: SKILL_MD },
    { name: '.claude/skills/ui-ux-pro-max/data/colors.csv', body: 'a,b' }
  ]);
  const entries = await indexArchive(file);
  assert.deepEqual(
    listArchiveDir(entries, '').map((e) => `${e.type}:${e.name}`).sort(),
    ['dir:.claude', 'file:README.md']
  );
  assert.throws(() => listArchiveDir(entries, 'nope'), /404/);
  const resolved = await resolveRepoRootSkillDir(async (p) => listArchiveDir(entries, p), 'ui-ux-pro-max');
  assert.deepEqual(resolved, { path: '.claude/skills/ui-ux-pro-max' });
});

test('staging is outside the skills folder and moves into place in one rename', (t) => {
  const root = path.join(tmpdir(t), '.claude', 'skills');
  const staging = stagingDir(root);
  assert.ok(fs.existsSync(root));
  assert.ok(!staging.startsWith(root + path.sep), 'a half-written skill must not sit where a CLI loads skills');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'SKILL.md'), SKILL_MD);
  commitStaging(staging, path.join(root, 'demo'));
  assert.ok(fs.existsSync(path.join(root, 'demo', 'SKILL.md')));
  fs.mkdirSync(staging);
  assert.throws(() => commitStaging(staging, path.join(root, 'demo')), /Already installed/);
});

test('on a WSL floor the executable bits are set inside the distro', { skip: process.platform !== 'win32' }, async () => {
  const calls = [];
  const run = async (distro, cmd, args) => { calls.push([distro, cmd, ...args]); return ''; };
  await restoreExecBits('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\skills\\my skill', ['scripts/run.sh', 'bin/x'], run);
  assert.deepEqual(calls, [['Ubuntu', 'chmod', '+x', '--', '/home/me/.claude/skills/my skill/scripts/run.sh', '/home/me/.claude/skills/my skill/bin/x']]);
  calls.length = 0;
  await restoreExecBits('C:\\Users\\me\\.claude\\skills\\demo', ['run.sh'], run);
  await restoreExecBits('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\skills\\demo', [], run);
  assert.equal(calls.length, 0, 'a Windows folder has no bit to set, and nothing to mark means no wsl.exe call');
});

test('an agent\'s skill copy (bundled and office skills) names the scripts to mark executable', (t) => {
  const tmp = tmpdir(t);
  const src = path.join(tmp, 'store', 'my skill');
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(src, 'empty'));
  fs.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD);
  fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'scripts', 'data.txt'), 'plain');
  const dest = path.join(tmp, 'agent', '.claude', 'skills', 'my skill');
  const scripts = copySkillTreeSync(src, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.ok(fs.existsSync(path.join(dest, 'scripts', 'data.txt')));
  assert.ok(!fs.existsSync(path.join(dest, 'empty')), 'an empty folder is left out, as before');
  if (process.platform === 'win32') {
    assert.deepEqual(scripts, ['scripts/run.sh'], 'NTFS has no mode: a #! line is the sign');
  } else {
    assert.deepEqual(scripts, [], 'the mode was copied with the file');
    assert.ok(fs.statSync(path.join(dest, 'scripts', 'run.sh')).mode & 0o111);
  }
});

test('a local folder installs under its SKILL.md name, links skipped', async (t) => {
  const tmp = tmpdir(t);
  const src = path.join(tmp, 'my folder');
  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD);
  fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  let linked = false;
  try { fs.symlinkSync(path.join(tmp), path.join(src, 'escape'), 'dir'); linked = true; } catch { /* no symlink privilege on this Windows */ }
  const home = path.join(tmp, 'home');
  const res = await installSkillFromFolder(src, home);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.path, path.join(home, '.claude', 'skills', 'demo'));
  assert.ok(fs.existsSync(path.join(res.path, 'scripts', 'run.sh')));
  assert.ok(!fs.existsSync(path.join(res.path, 'escape')), 'a symlink is never copied or followed');
  if (linked) assert.equal(res.skipped, 1);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['skills'], 'no staging folder left behind');

  const again = await installSkillFromFolder(src, home);
  assert.match(again.error, /Already installed/);
});

test('a local folder without SKILL.md, or over the limit, is refused', async (t) => {
  const tmp = tmpdir(t);
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'notes.md'), 'x');
  assert.match((await installSkillFromFolder(plain, path.join(tmp, 'home'))).error, /no SKILL\.md/);

  const big = path.join(tmp, 'big');
  fs.mkdirSync(big);
  fs.writeFileSync(path.join(big, 'SKILL.md'), SKILL_MD);
  fs.writeFileSync(path.join(big, 'blob.bin'), Buffer.alloc(2 * 1024 * 1024));
  const res = await installSkillFromFolder(big, path.join(tmp, 'home'), { maxBytes: 1024 * 1024, maxFiles: 10 });
  assert.match(res.error, /that skill is 2 MB unpacked \(2 files\); the limit is 1 MB/);
  assert.ok(!fs.existsSync(path.join(tmp, 'home', '.claude', 'skills', 'demo')));
});
