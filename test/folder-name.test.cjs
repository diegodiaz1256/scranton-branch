const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { folderName } = loadTs('src/shared/folderName.ts');

test('POSIX paths give the last folder', () => {
  assert.equal(folderName('/home/me/work/repo'), 'repo');
  assert.equal(folderName('/home/me/work/repo/'), 'repo');
});

test('Windows paths give the last folder, not the whole path', () => {
  assert.equal(folderName('C:\\work\\repo'), 'repo');
  assert.equal(folderName('C:\\work\\repo\\'), 'repo');
  assert.equal(folderName('C:\\Users\\Jo Smith\\My Projects\\web app'), 'web app');
  assert.equal(folderName('C:/work/repo'), 'repo');
});

test('WSL UNC paths give the last folder', () => {
  assert.equal(folderName('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'), 'repo');
  assert.equal(folderName('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\'), 'repo');
  assert.equal(folderName('\\\\wsl$\\Ubuntu\\home\\me\\repo'), 'repo');
});

test('a bare name or empty string comes back as is', () => {
  assert.equal(folderName('repo'), 'repo');
  assert.equal(folderName(''), '');
});
