#!/usr/bin/env node
'use strict';
/**
 * Licensed art comes from ZerogeWorkshop's private assets repo
 * (github.com/ZerogeWorkshop/assets), never from this public repo: the packs
 * (LimeZu) allow use inside our software but not redistribution.
 *
 *   node tools/zw-assets.cjs        copy the files listed in tools/zw-assets.json
 *                                   into src/renderer/src/assets/private/ (gitignored)
 *
 * Where the assets repo is: ZW_ASSETS, else a `zw-assets` folder next to this
 * repo. Without it (public forks, contributors) nothing is copied and the app
 * builds with its free art; a listed file missing from a present repo fails
 * the build, so a release never ships half the art.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'zw-assets.json');
const OUT = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'private');

function assetsDir(env = process.env) {
  if (env.ZW_ASSETS) return path.resolve(env.ZW_ASSETS);
  const sibling = path.join(ROOT, '..', 'zw-assets');
  return fs.existsSync(sibling) ? sibling : null;
}

/** A manifest path that stays inside the assets repo and the output folder, else null. */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  return parts;
}

/** Copy every manifest file from `src` to `out`. Returns the copied paths. */
function sync(files, src, out) {
  for (const f of files) if (!safeRel(f)) throw new Error(`zw-assets: unsafe path in manifest: ${f}`);
  const missing = files.filter((f) => !fs.existsSync(path.join(src, ...safeRel(f))));
  if (missing.length) throw new Error(`zw-assets: missing from ${src}: ${missing.join(', ')}`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(out, ...safeRel(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(src, ...safeRel(f)), dest);
  }
  return files;
}

function main() {
  const { files = [] } = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const src = assetsDir();
  if (!src) { console.log('zw-assets: no assets repo (ZW_ASSETS or ../zw-assets); building with the free art'); return 0; }
  sync(files, src, OUT);
  console.log(`zw-assets: ${files.length} licensed file(s) ready for this build`);
  return 0;
}

module.exports = { assetsDir, safeRel, sync };
if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
