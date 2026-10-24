#!/usr/bin/env node
'use strict';

/**
 * The mechanical half of renaming the hive's commands from md-* to sb-*
 * (md-api → sb-api, md-run, md-browse, md-skills, md-lists, md-netgate).
 *
 * It rewrites every mention in the app's code, prompts and protocol docs, and in
 * the tests that check them. The aliases themselves are hand-written and are not
 * touched: src/main/agentBinAliases.ts writes each sb-<x>.cjs again as
 * md-<x>.cjs, and src/shared/envName.ts reads SB_* with MD_* as the fallback.
 * Environment variable names (MD_BROKER_URL…) are not part of this sweep: the
 * sites that set or read them are hand-written to handle both names.
 *
 * After a rebase: drop the sweep commit, run
 *
 *     node tools/rename-sweep-tools.cjs
 *
 * and commit what it changed. `--check` only reports (exit 1 if anything would
 * change), which also catches md-* mentions a later branch adds. Idempotent.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NAME = /\bmd-(api|run|skills|browse|netgate|lists)\b/g;
const DIRS = ['src', 'test', 'resources'];
const EXT = /\.(ts|tsx|cjs|js|json|md)$/;
const KEEP = new Set([
  'src/main/agentBinAliases.ts', // the alias table
  'test/sb-agent-tools.test.cjs', // tests both names on purpose
  'tools/rename-sweep-tools.cjs',
]);

const check = process.argv.includes('--check');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'private' || e.name === 'fixtures') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) walk(rel(p), out);
    else if (EXT.test(e.name)) out.push(rel(p));
  }
  return out;
}

const changed = [];
for (const file of DIRS.flatMap((d) => walk(d))) {
  if (KEEP.has(file)) continue;
  const abs = path.join(ROOT, file);
  const before = fs.readFileSync(abs, 'utf8');
  const after = before.replace(NAME, 'sb-$1');
  if (after === before) continue;
  changed.push(file);
  if (!check) fs.writeFileSync(abs, after);
}
console.log(`${check ? 'would change' : 'changed'} ${changed.length} file(s)`);
for (const f of changed) console.log('  ' + f);
if (check && changed.length) process.exit(1);
