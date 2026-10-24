/**
 * What an agent's hook does when the office does not answer.
 *
 * Every CLI's hook (cth-hook, agy, Gemini, Grok, the pi extension, the
 * OpenCode plugin) asks the app's hook server about each tool call; the
 * server's guard (toolGuard.ts) is what keeps a file tool inside the agent's
 * folders. When the app was down, busy or restarting, the hooks used to let
 * every call through unchecked: an agent's Write/Edit reached anywhere on the
 * disk while "the hive had a problem".
 *
 * Now a hive agent's hook tries again for a few seconds and, still without an
 * answer, decides from the folders it was given at spawn (HIVE_GUARD):
 * - a file write inside its folders goes ahead; outside them, or to one of the
 *   office's control files, it is refused;
 * - a shell command goes ahead where an OS sandbox contains it (Claude Code's
 *   or the app's bubblewrap), and waits for the office where none does;
 * - everything else (reads, searches, connections) goes ahead.
 * Other events never wait on the office: a dead app must not stop an agent.
 *
 * Plain ES5 source, pasted into each shim (CommonJS and ESM alike); every
 * function takes what it needs, so it runs anywhere a hook does.
 */
export const HOOK_OFFLINE_JS = String.raw`
var HIVE_GUARD = (function () { try { return JSON.parse(process.env.HIVE_GUARD || 'null'); } catch (e) { return null; } })();
// Ask the office: one payload, its raw answer, or null when none came. A
// refused or missing socket is tried again (the app may be restarting its
// hook server) up to tries times; the whole wait is capped at waitMs.
function officeAsk(connect, sock, payload, waitMs, tries, cb) {
  var done = false, attempt = 0, timer = null, c = null;
  // Never leaves a connection open: a long-lived CLI (pi, OpenCode) asks on
  // every tool call.
  function finish(v) { if (done) return; done = true; if (timer && typeof clearTimeout === 'function') clearTimeout(timer); try { if (c) c.destroy(); } catch (e) {} cb(v); }
  timer = setTimeout(function () { finish(null); }, waitMs);
  function retry() { if (attempt < tries) setTimeout(go, 1000); else finish(null); }
  function go() {
    if (done) return;
    if (!sock) return finish(null);
    attempt++;
    var resp = '', connected = false;
    try {
      var s = String(sock);
      c = connect(s.indexOf('tcp://') === 0 ? { host: '127.0.0.1', port: Number(s.slice(s.lastIndexOf(':') + 1)) } : s, function () { connected = true; try { c.write(JSON.stringify(payload) + '\n'); } catch (e) {} });
    } catch (e) { return retry(); }
    try { c.setEncoding('utf8'); } catch (e) {}
    c.on('data', function (d) { resp += d; });
    // The office always answers with a JSON body: nothing at all (a relay
    // whose far end is down) is no answer.
    c.on('end', function () { if (resp.trim()) finish(resp); else if (!connected) retry(); else finish(null); });
    c.on('error', function () { if (!connected) retry(); else finish(null); });
  }
  go();
}
var OFFLINE_WRITE_TOOLS = ['write', 'edit', 'multiedit', 'notebookedit', 'create', 'write_file', 'edit_file', 'create_file', 'replace', 'str_replace', 'insert', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'str_replace_editor', 'str_replace_based_edit_tool', 'apply_patch', 'patch'];
var OFFLINE_SHELL_TOOLS = ['bash', 'powershell', 'shell', 'run_shell_command', 'exec_command', 'local_shell', 'run_command', 'run_terminal_cmd', 'execute_command'];
var OFFLINE_PATH_KEYS = ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'targetFile', 'target_file', 'AbsolutePath', 'absolutePath', 'absolute_path', 'notebook_path', 'filename', 'file'];
// A comparable path (toolGuard.ts normPath): forward slashes, C:\ and /mnt/c
// as /c, a WSL share as the distro path, no . or .. left.
function officeNorm(p) {
  var s = String(p).trim().replace(/\\/g, '/');
  s = s.replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(?=\/|$)/i, '') || '/';
  var d = /^([a-zA-Z]):(\/|$)/.exec(s);
  if (d) s = '/' + d[1].toLowerCase() + '/' + s.slice(d[0].length);
  s = s.replace(/^\/(?:mnt|cygdrive)\/([a-zA-Z])(\/|$)/, function (m, x, sl) { return '/' + x.toLowerCase() + sl; });
  var drive = /^\/[a-z](\/|$)/.test(s), out = [];
  s.split('/').forEach(function (x) { if (!x || x === '.') return; if (x === '..') out.pop(); else out.push(x); });
  var j = '/' + out.join('/');
  return drive ? j.toLowerCase() : j;
}
function officeWithin(p, root) {
  var a = officeNorm(p), b = officeNorm(root);
  if (b.indexOf('*') < 0) return b === '/' || a === b || a.indexOf(b + '/') === 0;
  var xs = a.split('/'), ys = b.split('/');
  if (xs.length < ys.length) return false;
  for (var i = 0; i < ys.length; i++) if (ys[i] === '*' ? !xs[i] : ys[i] !== xs[i]) return false;
  return true;
}
// Why a tool call the office did not answer is refused, or null to let it go.
// Only for a hive agent (AGENT_ID); a custodian (HIVE_GUARD_STRICT) waits for
// the office on every call.
function officeOffline(tool, input, cwd) {
  if (!process.env.AGENT_ID) return null;
  var wait = 'The office (the app) did not answer, so this call could not be checked. Wait a few seconds and try again; if it keeps happening, tell the human the office is not responding.';
  if (process.env.HIVE_GUARD_STRICT === '1') return 'Refused: the office could not be asked about this call, and this agent may not act without its answer. Try again in a moment.';
  var g = HIVE_GUARD || {};
  var name = String(tool || '').toLowerCase();
  var inp = input && typeof input === 'object' ? input : {};
  if (OFFLINE_SHELL_TOOLS.indexOf(name) >= 0) return g.sandboxed ? null : 'Refused for now: your shell has no OS sandbox here. ' + wait;
  var paths = [];
  if (OFFLINE_WRITE_TOOLS.indexOf(name) >= 0) {
    for (var k = 0; k < OFFLINE_PATH_KEYS.length; k++) { var v = inp[OFFLINE_PATH_KEYS[k]]; if (typeof v === 'string' && v) { paths.push(v); break; } }
  }
  var re = /^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm, m, text = '';
  try { text = JSON.stringify(inp).replace(/\\n/g, '\n'); } catch (e) {}
  while ((m = re.exec(text))) paths.push(m[1]);
  if (!paths.length) return null;
  var base = cwd || (typeof process.cwd === 'function' ? process.cwd() : ''), home = process.env.HOME || process.env.USERPROFILE || '';
  for (var i = 0; i < paths.length; i++) {
    var raw = String(paths[i]).trim();
    var abs = /^~(?:[\\/]|$)/.test(raw) ? home + raw.slice(1) : /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(raw) ? raw : base + '/' + raw;
    if ((g.controls || []).some(function (c) { return officeWithin(abs, c); })) return 'Refused: ' + raw + ' is one of the office\'s control files (agent settings, hooks, the hive\'s bin/). Agents never change them. If something there needs changing, tell the human what and why.';
    if (g.contained !== false && !(g.roots || []).some(function (r) { return officeWithin(abs, r); })) return 'Refused for now: ' + raw + ' is outside your folders. ' + wait;
  }
  return null;
}
`;
