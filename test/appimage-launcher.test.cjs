'use strict';
// After an update the menu launcher points at the new AppImage
// (src/main/appImageLauncher.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { repairLaunchers } = loadTs('src/main/appImageLauncher.ts');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-appimage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apps = path.join(root, 'applications'); const bin = path.join(root, 'Applications');
  fs.mkdirSync(apps); fs.mkdirSync(bin);
  const oldPath = path.join(bin, 'Scranton-Branch-1.1.0-linux-x86_64.AppImage');
  const newPath = path.join(bin, 'Scranton-Branch-1.1.1-linux-x86_64.AppImage');
  fs.writeFileSync(newPath, '');
  const entry = (p) => ['[Desktop Entry]', 'Name=Scranton Branch', `Exec="${p}" --no-sandbox %U`, 'X-AppImage-Version=1.1.0', `X-AppImage-Path=${p}`, ''].join('\n');
  return { apps, bin, oldPath, newPath, entry };
}

// AppImages and their launchers exist on Linux only.
const linuxOnly = { skip: process.platform === 'win32' && 'AppImage launchers are Linux only' };

test('a launcher left on the deleted AppImage is pointed at the current one', linuxOnly, (t) => {
  const { apps, oldPath, newPath, entry } = setup(t);
  const f = path.join(apps, 'appimage-scranton-branch.desktop');
  fs.writeFileSync(f, entry(oldPath));
  assert.deepEqual(repairLaunchers(apps, newPath, '1.1.1'), [f]);
  const text = fs.readFileSync(f, 'utf8');
  assert.match(text, new RegExp(`Exec="${newPath.replace(/[.]/g, '\\.')}" --no-sandbox %U`));
  assert.match(text, /X-AppImage-Version=1\.1\.1/);
  assert.ok(!text.includes(oldPath));
  assert.deepEqual(repairLaunchers(apps, newPath, '1.1.1'), [], 'nothing left to do');
});

test('the updater event names the replaced file; others are left alone', linuxOnly, (t) => {
  const { apps, bin, oldPath, newPath, entry } = setup(t);
  fs.writeFileSync(oldPath, ''); // still there at the moment of the event
  const ours = path.join(apps, 'ours.desktop'); fs.writeFileSync(ours, entry(oldPath));
  const other = path.join(apps, 'other.desktop'); fs.writeFileSync(other, entry(path.join(bin, 'Other-App-2.0.AppImage')));
  const live = path.join(apps, 'live.desktop'); fs.writeFileSync(live, entry(path.join(bin, 'Scranton-Branch-0.9.0-linux-x86_64.AppImage')));
  fs.writeFileSync(path.join(bin, 'Scranton-Branch-0.9.0-linux-x86_64.AppImage'), '');
  assert.deepEqual(repairLaunchers(apps, newPath, '1.1.1', oldPath), [ours]);
  assert.match(fs.readFileSync(other, 'utf8'), /Other-App-2\.0/, 'another app untouched');
  assert.match(fs.readFileSync(live, 'utf8'), /0\.9\.0/, 'a copy that still exists is someone else\'s choice');
});
