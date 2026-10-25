#!/usr/bin/env node
'use strict';

/**
 * The mechanical half of the rename from "Munder Difflin" to "Scranton Branch".
 *
 * WHY A SCRIPT. The rename touches hundreds of files (most of them the built blog
 * in docs/blog) while other branches keep landing in the same files. Rebasing a
 * hand-made sweep means hand-resolving every one of those conflicts; re-running
 * this does not. After a rebase: drop the sweep commit, run
 *
 *     node tools/rename-sweep.cjs names
 *     cd blog && npm ci && npm run build     # CI checks docs/blog against a fresh build
 *
 * and commit what they changed. `--check` only reports (exit 1 if anything would
 * change), which also catches new "Munder Difflin" text that a later branch adds
 * to one of the swept areas.
 *
 * Every rule is idempotent: a replacement whose text is no longer there is
 * skipped, so running it twice changes nothing the second time.
 *
 * WHAT IT NEVER TOUCHES (and why). These still say munder-difflin on purpose:
 *   - package.json "name" (munder-difflin): the Linux executable name and the
 *     default npm/userData name derive from it; legacyMigration.ts reads it.
 *   - src/main/legacyMigration.ts and the old-name comments in index.ts: they
 *     describe and migrate the OLD install.
 *   - src/main/teamCrypto.ts HKDF info strings: changing them breaks decryption
 *     of every existing Team pairing.
 *   - the munderdifflin:// URL scheme, the `munder-difflin/hire@1` manifest spec,
 *     the `\\.\pipe\munder-difflin-<id>` hook pipe, ~/.<cli>/<kind>/munder-difflin
 *     session dirs, and the munder-* MCP server ids: data and links that already
 *     exist on disk, in shared manifests and in agents' configs.
 *   - LICENSE, NOTICE, LICENSES/MIT-munder-difflin.txt, CONTRIBUTORS.md,
 *     CHANGELOG.md, RELEASE.md (upstream's notes): attribution and history.
 *   - blog post bodies (blog/src/posts, and the same text in docs/blog): written
 *     for upstream Munder Difflin; the blog footer and About page now say so.
 *   - "Munder Difflin" as the in-world company (the office theme: this app is its
 *     Scranton Branch), e.g. src/shared/fork.ts and the hero blurb.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/diegodiaz1256/scranton-branch';
const UPSTREAM = 'https://github.com/chaitanyagiri/munder-difflin';

// A line that mentions the old name on purpose: history, the upstream project,
// the migration from the old install, or the in-world company.
const KEEP_LINE = /old name|used to install|upstream|fork of|forked from|branch of|built on|formerly|company|Moving in from|not affiliated|Chaitanya/i;
const KEEP_FILES = new Set([
  'src/main/legacyMigration.ts',
  'src/main/teamCrypto.ts',
  'src/shared/fork.ts',
]);

// ── generic: "Munder Difflin" (the product's display name) in text people read ──
const GENERIC_DIRS = ['src'];
const GENERIC_EXT = /\.(ts|tsx|json|cjs|txt|md|html)$/;
const GENERIC_FILES = [
  'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'HIVE.md', 'SPEC.md', 'DESIGN.md',
  'SERVER.md', 'PRIVACY.md', 'FACTORY-MCP.md', 'docs/ARCHITECTURE.md', 'docs/message-queue.md',
  '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/other.yml',
  'build/SIGNING.md', 'build/entitlements.mac.plist', 'build/icon.svg',
  'tools/make-logo.cjs', 'tools/seed-demo-hive.cjs', 'resources/md-slack-reply.cjs',
];

// ── exact, per file: identifiers that are safe to change, links, wording ──
const EXACT = {
  'CLAUDE.md': [
    ['\nMunder Difflin: an Electron', '\nScranton Branch (a fork of Munder Difflin, and formerly named after it): an Electron'],
  ],
  'CONTRIBUTING.md': [
    [`${UPSTREAM}/releases/latest`, `${REPO}/releases/latest`],
    ['git clone <your-fork-url> munder-difflin\ncd munder-difflin\n', 'git clone <your-fork-url> scranton-branch\ncd scranton-branch\n'],
  ],
  'SECURITY.md': [
    [`vulnerability* tab on ${UPSTREAM}, **or**`, `vulnerability* tab on ${REPO}, **or**`],
  ],
  'docs/ARCHITECTURE.md': [
    ['(<a href="#munder-difflin">↑ back to top</a>)', '(<a href="#architecture-project-structure-and-design-system">↑ back to top</a>)'],
  ],
  'docs/DESIGN.md': [
    ['# Munder Difflin — Landing Site Design System', '# Scranton Branch — Landing Site Design System'],
    ["We keep Munder Difflin's own identity", "We keep Scranton Branch's own identity"],
    ['| Wordmark | mono | 13px | 700 | 0.02em | "MUNDER DIFFLIN" |', '| Wordmark | mono | 13px | 700 | 0.02em | "SCRANTON BRANCH" |'],
  ],
  'docs/hires/README.md': [
    ['[Munder Difflin](https://scranton-branch.zerogeworkshop.com) multi-agent harness', '[Scranton Branch](https://scranton-branch.zerogeworkshop.com) multi-agent harness'],
  ],
  'docs/hires/index.html': [
    ['community hires for Munder Difflin', 'community hires for Scranton Branch'],
    ['for the Munder Difflin multi-agent harness', 'for the Scranton Branch multi-agent harness'],
    ['rel="noopener">Munder Difflin</a> — browse a role', 'rel="noopener">Scranton Branch</a> — browse a role'],
    [`<a href="${UPSTREAM}" rel="noopener">the harness ↗</a>`, `<a href="${REPO}" rel="noopener">the harness ↗</a>`],
  ],
  'resources/skills/md-audit/SKILL.md': [['(munder-difflin)\n', '(scranton-branch)\n']],
  'resources/skills/md-fetch-summarize/SKILL.md': [['(munder-difflin)\n', '(scranton-branch)\n']],
  'resources/skills/md-hive-sync/SKILL.md': [['(munder-difflin)\n', '(scranton-branch)\n']],
  '.claude/skills/ian-xiaohei-illustrations/SKILL.md': [
    ['（Munder Difflin blog — local overrides）', '（Scranton Branch blog — local overrides）'],
    ['filled with the Munder Difflin accent yellow', "filled with the blog's accent yellow"],
  ],
  'blog/BLOG_README.md': [
    ['# Munder Difflin Blog\n', '# Scranton Branch Blog\n'],
    ['\nThe Munder Difflin blog — a static', '\nThe Scranton Branch blog — a static'],
    ['(else `"<title> — Munder Difflin Blog"`)', '(else `"<title> — Scranton Branch Blog"`)'],
  ],
  'blog/package.json': [
    ['"description": "The Munder Difflin blog', '"description": "The Scranton Branch blog'],
  ],
  'blog/src/_data/site.js': [
    ['  name: "Munder Difflin",', '  name: "Scranton Branch",'],
    [`github: "${UPSTREAM}",`, `github: "${REPO}",`],
  ],
  'blog/src/_includes/footer.njk': [
    ['© {{ build.year }} Munder Difflin · Local-first · MIT-licensed ·', '© {{ build.year }} Scranton Branch · Local-first · Apache-2.0 ·'],
  ],
  // User-Agent headers name the product to the APIs it calls.
  'src/main/connections.ts': [["'User-Agent': 'munder-difflin-connections'", "'User-Agent': 'scranton-branch-connections'"]],
  'src/main/fetchText.ts': [["headers: { 'user-agent': 'munder-difflin' }", "headers: { 'user-agent': 'scranton-branch' }"]],
  'src/main/integrationBroker.ts': [["const DEFAULT_USER_AGENT = 'munder-difflin-broker/1';", "const DEFAULT_USER_AGENT = 'scranton-branch-broker/1';"]],
  'src/main/teamNode.ts': [["'User-Agent': 'munder-difflin-team'", "'User-Agent': 'scranton-branch-team'"]],
  'src/main/updater.ts': [["'User-Agent': 'munder-difflin-updater'", "'User-Agent': 'scranton-branch-updater'"]],
  // The generated-docs header is matched by this test.
  'test/hive-generated-docs.test.cjs': [
    ["'<!-- Generated and managed by Munder Difflin.'", "'<!-- Generated and managed by Scranton Branch.'"],
  ],
};

// ── the blog's chrome, in its sources and in the committed build (docs/blog) ──
const BLOG_NOTE = 'Most posts here were written for <a href="https://github.com/HarnessMD/munder-difflin">Munder Difflin</a>, the open-source project Scranton Branch is built on.';
const BLOG_RULES = [
  [/Munder Difflin Blog/g, 'Scranton Branch Blog'],
  [/Munder Difflin blog posts/g, 'Scranton Branch blog posts'],
  [/Browse the Munder Difflin blog by topic/g, 'Browse the Scranton Branch blog by topic'],
  [/aria-label="Munder Difflin home"/g, 'aria-label="Scranton Branch home"'],
  [/alt="Munder Difflin, Inc\. — Multi-Agent Harness"/g, 'alt="Scranton Branch"'],
  [/("@type": "Organization",\s*"name": )"Munder Difflin"/g, '$1"Scranton Branch"'],
  [/(blog — )Munder Difflin(["<])/g, '$1Scranton Branch$2'],
  [/The Munder Difflin (<span class="hl">Blog\.<\/span>)/g, 'The Scranton Branch $1'],
  [/^title: The Munder Difflin Blog$/gm, 'title: The Scranton Branch Blog'],
  // The footer's GitHub link only (it ends its line); posts link upstream on purpose.
  [new RegExp(`${UPSTREAM.replace(/[.]/g, '\\.')}(">GitHub</a>\\n)`, 'g'), `${REPO}$1`],
  [/(© \d{4} )Munder Difflin · Local-first · MIT-licensed ·/g, '$1Scranton Branch · Local-first · Apache-2.0 ·'],
  // The archive note, once, after the footer's last line.
  [/(\n([ \t]*)Run an office of agents while you sleep\.\n)(\s*<\/div>\s*\n\s*<\/div>\s*\n<\/footer>)/g,
    (m, line, indent, tail) => `${line}${indent}${BLOG_NOTE}\n${tail}`],
];
const BLOG_DIRS = ['blog/src', 'docs/blog'];
const BLOG_EXT = /\.(html|xml|njk|md|txt|js|json)$/;

// ─────────────────────────────────────────────────────────────────────────────

const check = process.argv.includes('--check');
const mode = process.argv[2];
if (mode !== 'names') {
  console.error('usage: node tools/rename-sweep.cjs names [--check]');
  process.exit(2);
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const changed = new Map();

function rewrite(file, fn) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return;
  const raw = fs.readFileSync(abs, 'utf8');
  const crlf = raw.includes('\r\n');
  const before = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const after = fn(before, file);
  if (after === before) return;
  changed.set(file, (changed.get(file) || 0) + 1);
  if (!check) fs.writeFileSync(abs, crlf ? after.replace(/\n/g, '\r\n') : after);
}

function walk(dir, ext, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'private') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) walk(rel(p), ext, out);
    else if (ext.test(e.name)) out.push(rel(p));
  }
  return out;
}

function generic(text, file) {
  if (KEEP_FILES.has(file)) return text;
  return text.split('\n').map((line) => (
    line.includes('Munder Difflin') && !KEEP_LINE.test(line) ? line.split('Munder Difflin').join('Scranton Branch') : line
  )).join('\n');
}

function exact(text, file) {
  let s = text;
  for (const [from, to] of EXACT[file] || []) if (s.includes(from)) s = s.split(from).join(to);
  return s;
}

function blog(text) {
  let s = text;
  for (const [re, to] of BLOG_RULES) s = s.replace(re, to);
  return s;
}

// Exact rules first (they carry wording the generic pass would flatten).
for (const file of Object.keys(EXACT)) rewrite(file, exact);
for (const file of [...GENERIC_FILES, ...GENERIC_DIRS.flatMap((d) => walk(d, GENERIC_EXT)), ...walk('resources/skills', /^SKILL\.md$/)]) {
  rewrite(file, generic);
}
for (const file of BLOG_DIRS.flatMap((d) => walk(d, BLOG_EXT))) {
  if (file.startsWith('blog/src/posts/')) continue; // upstream's writing
  rewrite(file, blog);
}

console.log(`${check ? 'would change' : 'changed'} ${changed.size} file(s)`);
if (check) {
  for (const f of changed.keys()) console.log('  ' + f);
  process.exit(changed.size ? 1 : 0);
}
