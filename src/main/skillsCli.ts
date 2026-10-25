/**
 * sb-skills: the orchestrator's look at the skills catalog and the office's
 * skills, written to <hive>/bin/sb-skills.cjs. Read-only: it searches the
 * catalog mirror main keeps in <hive>/skills/catalog.json and lists
 * <hive>/skills/office.json. Adding or removing goes through a request file
 * (shared/skillRequests.ts), which main checks.
 *
 *   node sb-skills.cjs search pdf forms     best matches, one line each
 *   node sb-skills.cjs list                 office skills and who has them
 */
export const MD_SKILLS = `'use strict';
var fs = require('fs');
var path = require('path');
var root = process.env.HIVE_ROOT || path.join(__dirname, '..');
function read(f) { try { return JSON.parse(fs.readFileSync(path.join(root, 'skills', f), 'utf8')); } catch (e) { return null; } }
var cmd = process.argv[2] || 'help';
var cat = read('catalog.json') || { policy: 'official', skills: [] };
var office = (read('office.json') || {}).skills || {};
if (cmd === 'list') {
  var names = Object.keys(office);
  if (!names.length) console.log('No office skills yet.');
  names.forEach(function (n) { var s = office[n]; console.log(n + ' (' + s.owner + ') -> ' + (s.agents.indexOf('*') >= 0 ? 'every agent' : s.agents.join(', '))); });
} else if (cmd === 'search') {
  if (cat.policy === 'off') { console.log('Skills are switched off for you (Capabilities > Skills).'); process.exit(0); }
  var words = process.argv.slice(3).join(' ').toLowerCase().split(/\\s+/).filter(Boolean);
  var pool = cat.skills.filter(function (c) { return cat.policy === 'catalog' || c.owner === 'anthropics' || (cat.policy === 'mine' && !!c.marketplace); });
  var hits = pool.map(function (c) {
    var name = c.name.toLowerCase(), hay = (c.description + ' ' + c.category).toLowerCase();
    var score = words.reduce(function (s, w) { return s + (name === w ? 5 : name.indexOf(w) >= 0 ? 3 : hay.indexOf(w) >= 0 ? 1 : 0); }, words.length ? 0 : 1);
    return { c: c, score: score };
  }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score || a.c.name.localeCompare(b.c.name); }).slice(0, 8);
  if (!cat.skills.length) console.log('The catalog is not loaded yet; try again in a minute.');
  else if (!hits.length) console.log('Nothing matches.' + (cat.policy === 'official' ? ' (Only Anthropic skills are allowed.)' : cat.policy === 'mine' ? " (Only Anthropic's and the human's own marketplaces are allowed.)" : ''));
  hits.forEach(function (x) { var d = x.c.description || ''; console.log(x.c.name + ' [' + x.c.owner + (x.c.marketplace ? ', your marketplace' : '') + '] ' + (d.length > 90 ? d.slice(0, 89) + '...' : d) + (office[x.c.name] ? ' (in the office)' : '')); });
} else {
  console.log('sb-skills search <words> | sb-skills list');
}
`;
