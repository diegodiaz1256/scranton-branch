#!/usr/bin/env node
'use strict';
/**
 * Licensed tile art travels in the repo encrypted, and only the built app
 * carries it in the clear. The LimeZu packs allow use inside our software but
 * not redistribution, and the repo is public.
 *
 *   node tools/tiles-bundle.cjs keygen        new key in ~/.scranton/tiles.key (never printed)
 *   node tools/tiles-bundle.cjs pack <dir>    <dir> → assets-private/tiles.bundle
 *   node tools/tiles-bundle.cjs unpack        bundle → src/renderer/src/assets/private/
 *
 * The key comes from TILES_KEY (base64, the CI secret) or the file in
 * TILES_KEY_FILE (default ~/.scranton/tiles.key). Without a key, unpack does
 * nothing and the app builds with the free art, so forks and contributors
 * still build.
 *
 * Bundle: "STB1" | iv (12) | tag (16) | AES-256-GCM(gzip(manifest length (4) | manifest JSON | files)).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'assets-private', 'tiles.bundle');
const OUT = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'private');
const MAGIC = Buffer.from('STB1');

function keyFile(env = process.env) {
  return env.TILES_KEY_FILE || path.join(os.homedir(), '.scranton', 'tiles.key');
}

/** The 32-byte key, or null when this machine has none. */
function readKey(env = process.env) {
  let b64 = (env.TILES_KEY || '').trim();
  if (!b64) {
    try { b64 = fs.readFileSync(keyFile(env), 'utf8').trim(); } catch { return null; }
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('tiles key must be 32 bytes, base64');
  return key;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function pack(srcDir, key) {
  const files = listFiles(srcDir);
  const bufs = files.map((f) => fs.readFileSync(path.join(srcDir, ...f.split('/'))));
  const manifest = Buffer.from(JSON.stringify(files.map((f, i) => ({ path: f, size: bufs[i].length }))));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  const plain = zlib.gzipSync(Buffer.concat([len, manifest, ...bufs]), { level: 9 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

/** A bundle path that stays inside the output folder, else null. */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  return parts;
}

/** Decrypt a bundle into { path: Buffer }. Throws on a wrong key or a damaged bundle. */
function unpack(bundle, key) {
  if (bundle.length < 32 || !bundle.subarray(0, 4).equals(MAGIC)) throw new Error('not a tiles bundle');
  const iv = bundle.subarray(4, 16);
  const tag = bundle.subarray(16, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  const plain = zlib.gunzipSync(Buffer.concat([d.update(bundle.subarray(32)), d.final()]));
  const mlen = plain.readUInt32BE(0);
  const manifest = JSON.parse(plain.subarray(4, 4 + mlen).toString('utf8'));
  const files = {};
  let at = 4 + mlen;
  for (const { path: p, size } of manifest) {
    if (!safeRel(p)) throw new Error(`unsafe path in tiles bundle: ${p}`);
    files[p] = plain.subarray(at, at + size);
    at += size;
  }
  return files;
}

function writeFiles(files, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [p, buf] of Object.entries(files)) {
    const dest = path.join(outDir, ...safeRel(p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
}

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === 'keygen') {
    const f = keyFile();
    if (fs.existsSync(f)) { console.error(`tiles: a key already exists at ${f}; not replacing it`); return 1; }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    console.log(`tiles: new key written to ${f} (not shown). Add it to GitHub with: gh secret set TILES_KEY < "${f}"`);
    return 0;
  }
  if (cmd === 'pack') {
    if (!arg) { console.error('usage: tiles-bundle.cjs pack <dir>'); return 1; }
    const key = readKey();
    if (!key) { console.error('tiles: no key (TILES_KEY or ' + keyFile() + ')'); return 1; }
    const out = pack(path.resolve(arg), key);
    fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
    fs.writeFileSync(BUNDLE, out);
    console.log(`tiles: ${listFiles(path.resolve(arg)).length} files → ${path.relative(ROOT, BUNDLE)} (${(out.length / 1048576).toFixed(1)} MB)`);
    return 0;
  }
  if (cmd === 'unpack') {
    if (!fs.existsSync(BUNDLE)) { console.log('tiles: no bundle; building with the free art'); return 0; }
    const key = readKey();
    if (!key) { console.log('tiles: no key; building with the free art'); return 0; }
    const files = unpack(fs.readFileSync(BUNDLE), key);
    writeFiles(files, OUT);
    console.log(`tiles: ${Object.keys(files).length} licensed files ready for this build`);
    return 0;
  }
  console.error('usage: tiles-bundle.cjs keygen | pack <dir> | unpack');
  return 1;
}

module.exports = { pack, unpack, readKey, safeRel, writeFiles };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
