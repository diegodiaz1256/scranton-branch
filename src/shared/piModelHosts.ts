/**
 * The hosts a pi custodian may reach over HTTPS (sb-netgate, main/netgate.ts).
 * The app detects them from the custodian's pi settings (its default
 * provider, from a fixed map, and remote base URLs in models.json); the human
 * can add more, or replace them, in Settings → AI providers → pi. Saved in
 * config.piModelHosts.
 *
 * Hostnames only, reached on 443: no IP addresses, wildcards, ports, paths or
 * plain http. Loopback needs no entry (sb-netgate relays the app's loopback
 * services and a loopback model by itself).
 *
 * Pure: no electron, no node.
 */

export interface PiModelHostsConfig { hosts: string[]; mode: 'add' | 'replace' }

export type ModelHostError = 'empty' | 'notHttps' | 'port' | 'path' | 'ip' | 'loopback' | 'invalid';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A typed host as a bare lowercase hostname, or why it is refused. Takes
 * `llm.corp.example` or `https://llm.corp.example` (a trailing `/` is fine);
 * not `http://…`, a port other than 443, a path, an IP address or `*.`.
 */
export function normalizeModelHost(input: unknown): { ok: true; host: string } | { ok: false; error: ModelHostError } {
  let s = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!s) return { ok: false, error: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(s);
  if (scheme) {
    if (scheme[1] !== 'https') return { ok: false, error: 'notHttps' };
    s = s.slice(scheme[0].length);
  }
  const slash = s.indexOf('/');
  if (slash >= 0) {
    if (s.slice(slash) !== '/') return { ok: false, error: 'path' };
    s = s.slice(0, slash);
  }
  // IPv6, bracketed or not.
  if (s.startsWith('[') || s.split(':').length > 2) return { ok: false, error: 'ip' };
  const port = /:(\d*)$/.exec(s);
  if (port) {
    if (port[1] !== '443') return { ok: false, error: 'port' };
    s = s.slice(0, port.index);
  }
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (/^\d+(\.\d+){3}$/.test(s)) return { ok: false, error: 'ip' };
  if (s === 'localhost' || s.endsWith('.localhost')) return { ok: false, error: 'loopback' };
  const labels = s.split('.');
  if (s.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return { ok: false, error: 'invalid' };
  return { ok: true, host: s };
}

/** Config as saved: valid hosts only (deduplicated), mode add unless replace. */
export function sanitizePiModelHosts(raw: unknown): PiModelHostsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { hosts?: unknown; mode?: unknown };
  const hosts: string[] = [];
  for (const h of Array.isArray(r.hosts) ? r.hosts : []) {
    const n = normalizeModelHost(h);
    if (n.ok && !hosts.includes(n.host)) hosts.push(n.host);
  }
  return { hosts, mode: r.mode === 'replace' ? 'replace' : 'add' };
}

/** The hosts sb-netgate lets a pi custodian reach: the detected ones plus the
 *  human's, or only the human's when they replace them. */
export function resolvePiModelHosts(detected: string[], cfg: unknown): string[] {
  const c = sanitizePiModelHosts(cfg);
  const own = c?.hosts ?? [];
  if (c?.mode === 'replace') return own;
  const out: string[] = [];
  for (const h of [...detected, ...own]) {
    const n = normalizeModelHost(h);
    if (n.ok && !out.includes(n.host)) out.push(n.host);
  }
  return out;
}
