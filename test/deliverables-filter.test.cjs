const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { isElsewhereDeliverable, isDeliverableLike } = loadTs('src/shared/deliverableOrganize.ts');
const { repoCheck, findArgs, parseFindListing, scanDeliverables } = loadTs('src/main/deliverableScan.ts');

test('written elsewhere keeps documents and tables, not notes, pictures or temp files', () => {
  for (const p of ['C:\\Users\\d\\Desktop\\informe.md', '/home/d/out/plan.pdf', '/home/d/out/costs.xlsx', 'D:\\reports\\q3.html']) assert.ok(isElsewhereDeliverable(p), p);
  for (const p of ['/home/d/notes.txt', '/home/d/shot.png', '/home/d/clip.mp4', '/home/d/app.ts', '/home/d/data.json']) assert.ok(!isElsewhereDeliverable(p), p);
  for (const p of ['/tmp/claude-1000/report.md', 'C:\\Users\\d\\AppData\\Local\\Temp\\x\\plan.html', '/var/folders/ab/T/out.md']) assert.ok(!isElsewhereDeliverable(p), p);
  // research/ still lists notes and pictures.
  assert.ok(isDeliverableLike('notes.txt') && isDeliverableLike('chart.png'));
});

test('a file in a repo or worktree is the project\'s, a home kept in git does not count', () => {
  const gits = new Set(['/home/d/proj/.git', '/home/d/.git', '/home/d/wt/feat-a/.git']);
  let asked = 0;
  const inRepo = repoCheck(['/home/d'], (p) => { asked += 1; return gits.has(p.replace(/\\/g, '/')); });
  assert.equal(inRepo('/home/d/proj/docs/README.md'), true);
  assert.equal(inRepo('/home/d/wt/feat-a/notes/plan.md'), true);
  assert.equal(inRepo('/home/d/Desktop/informe.md'), false, 'the home .git is not looked at');
  const before = asked;
  assert.equal(inRepo('/home/d/proj/docs/OTHER.md'), true);
  assert.equal(asked, before, 'a folder already asked is not asked again');
});

test('find inside the distro: arguments and its listing', () => {
  const args = findArgs('/home/d/office/research/', { skipTop: ['hires'] });
  assert.deepEqual(args.slice(0, 4), ['/home/d/office/research', '-mindepth', '1', '-maxdepth']);
  assert.ok(args.includes('/home/d/office/research/hires') && args.includes('.*'));
  const host = '\\\\wsl.localhost\\Ubuntu\\home\\d\\office\\research';
  const out = 'a/report.md\t120\t1700000000.5\nold.txt\t3\t1600000000.0000000000\nbroken line\n';
  const r = parseFindListing(out, host, { maxFiles: 10 });
  assert.equal(r.total, 2);
  assert.equal(r.files[0].rel, 'a/report.md');
  assert.equal(r.files[0].mtime, 1700000000500);
  assert.equal(r.files[0].abs, path.join(host, 'a', 'report.md'));
});

const hasWsl = (() => {
  if (process.platform !== 'win32') return false;
  try { execFileSync('wsl.exe', ['--exec', 'true'], { windowsHide: true, timeout: 30000 }); return true; } catch { return false; }
})();

test('on a real distro find lists what the walk over \\\\wsl.localhost lists', { skip: !hasWsl && 'no WSL here' }, async () => {
  const linux = '/tmp/md-dlv-find-test';
  execFileSync('wsl.exe', ['--exec', 'bash', '-c', `rm -rf ${linux}; mkdir -p ${linux}/a/b ${linux}/hires ${linux}/.cache; echo x > ${linux}/top.md; echo y > ${linux}/a/b/deep.csv; echo z > "${linux}/a/with space.html"; echo h > ${linux}/hires/cv.md; echo c > ${linux}/.cache/x.md`], { windowsHide: true });
  try {
    const distro = execFileSync('wsl.exe', ['--exec', 'bash', '-c', 'echo -n $WSL_DISTRO_NAME'], { encoding: 'utf8', windowsHide: true });
    const host = path.win32.join(`//wsl.localhost/${distro}`, ...linux.split('/').filter(Boolean));
    const out = execFileSync('wsl.exe', ['--exec', 'find', ...findArgs(linux, { skipTop: ['hires'] })], { encoding: 'utf8', windowsHide: true });
    const viaFind = parseFindListing(out, host, { skipTop: ['hires'] }).files.map((f) => f.rel).sort();
    const viaWalk = (await scanDeliverables(host, { skipTop: ['hires'] })).files.map((f) => f.rel).sort();
    assert.deepEqual(viaFind, ['a/b/deep.csv', 'a/with space.html', 'top.md']);
    assert.deepEqual(viaFind, viaWalk);
  } finally {
    execFileSync('wsl.exe', ['--exec', 'rm', '-rf', linux], { windowsHide: true });
  }
});
