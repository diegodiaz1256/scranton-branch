/**
 * Environment and secrets for the office's agents — where agents can USE a
 * secret but never SEE its value.
 *
 *   plain   NODE_ENV=development — not secret: in every agent's environment.
 *   secret  STRIPE_KEY — encrypted in the app's store (env:<NAME>), written
 *           once from the UI, never shown again.
 *   op      DATABASE_URL = op://Vault/Item/field — a 1Password reference,
 *           resolved with the `op` CLI at the moment it is used; nothing kept.
 *
 * Secret and op values never enter an agent's environment, files, prompt or
 * output. Agents use them two ways only:
 *   - APIs and MCP servers: the key broker / MCP gateway put the key in the
 *     request (integrationBroker.ts, mcpGateway.ts);
 *   - runners: a command YOU define (npm test, npm run migrate…) with the
 *     secrets it needs. An agent may only ask the app to run it by name; the
 *     app runs it in the agent's worktree with those secrets in the PROCESS's
 *     environment and returns its output with every secret value masked
 *     (raw, base64, URL- and JSON-encoded). It cannot change the command, add
 *     arguments or read the environment.
 *
 * A runner executes code from a repo the agent can edit, so by default it asks
 * you before running when the worktree changed since you last allowed it.
 *
 * Electron-free: config, secrets, 1Password and the approval prompt are injected.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseWslPath, secretStdin, wslSecretRun } from './wsl';

export type EnvKind = 'plain' | 'secret' | 'op';

export interface EnvVar {
  name: string;
  kind: EnvKind;
  /** plain: the value; op: the op:// reference (not secret); secret: unused. */
  value?: string;
  /** Agent ids this applies to; null/absent = every agent. */
  agents?: string[] | null;
  note?: string;
}

export type Approval = 'always' | 'on-change' | 'never';

export interface Runner {
  id: string;
  name: string;
  command: string;
  description?: string;
  /** Names of secret/op variables put in this command's environment. */
  secrets: string[];
  approval: Approval;
  timeoutSec?: number;
}

/** The human's answer to a proposal: yes or no, plus the secrets created for it. */
export type ProposalAnswer = boolean | { ok: boolean; secrets?: Record<string, { kind: 'secret' | 'op'; value: string }> };

export interface EnvVaultDeps {
  readVars: () => EnvVar[];
  writeVars: (v: EnvVar[]) => void;
  readRunners: () => Runner[];
  writeRunners: (r: Runner[]) => void;
  getSecret: (ref: string) => string | undefined;
  setSecret: (ref: string, value: string) => { ok: boolean; error?: string };
  deleteSecret: (ref: string) => void;
  /** Ask the human; resolves true to run. */
  approve: (req: { runner: Runner; agentName: string; cwd: string; changed: boolean }) => Promise<'once' | 'always' | 'deny'>;
  /** Ask the human whether to add a runner an agent proposed. `missing` are
   *  secrets it names that do not exist yet: the human can create them in the
   *  same prompt (a value, or a 1Password reference); the agent never sees them. */
  approveProposal?: (req: { proposal: Pick<Runner, 'name' | 'command' | 'secrets' | 'description'>; agentName: string; missing: string[]; cwd?: string }) => Promise<ProposalAnswer>;
  /** `op read <ref>` (injected for tests). */
  opRead?: (ref: string) => Promise<string>;
  log?: (m: string) => void;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OP_REF = /^op:\/\/[^\s/][^\s]*\/[^\s]+\/[^\s]+$/;
const MAX_OUTPUT = 200_000;
const secretRef = (name: string) => `env:${name}`;

/** Every encoding of a value that could show up in output. */
function variants(v: string): string[] {
  const out = new Set<string>([v]);
  try { out.add(Buffer.from(v).toString('base64')); } catch { /* ignore */ }
  try { out.add(Buffer.from(v).toString('base64url')); } catch { /* ignore */ }
  out.add(encodeURIComponent(v));
  out.add(JSON.stringify(v).slice(1, -1));
  return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

/** Replace every secret value (and its encodings) in `text` with ***. */
export function maskSecrets(text: string, values: string[]): string {
  let out = text;
  for (const v of values) for (const form of variants(v)) out = out.split(form).join('***');
  return out;
}

/** 1Password CLI: `op read`. Needs the CLI and the desktop-app integration. */
export function opReadCli(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('op', ['read', '--no-newline', ref], { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((String(stderr || '').trim() || err.message).split('\n')[0]));
      else resolve(String(stdout));
    });
  });
}

export class EnvVault {
  /** runnerId|cwd → fingerprint you last allowed (on-change approval). */
  private allowed = new Map<string, string>();
  /** runnerId|cwd allowed for good this session ('always' answer). */
  private trusted = new Set<string>();

  constructor(private readonly deps: EnvVaultDeps) {}

  // ─── variables ──────────────────────────────────────────────────────────────

  /** For the UI: secret values never leave this module. */
  listVars(): Array<EnvVar & { stored?: boolean }> {
    return this.deps.readVars().map((v) => v.kind === 'secret'
      ? { name: v.name, kind: v.kind, agents: v.agents ?? null, note: v.note, stored: !!this.deps.getSecret(secretRef(v.name)) }
      : { ...v, agents: v.agents ?? null });
  }

  /** Add or change a variable. `secretValue` is only for kind 'secret' and is
   *  write-only (omit it to keep the stored one). */
  setVar(input: unknown, secretValue?: unknown): { ok: boolean; error?: string } {
    const v = (input ?? {}) as Partial<EnvVar>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!NAME.test(name)) return { ok: false, error: 'names are letters, digits and _ (not starting with a digit)' };
    if (v.kind !== 'plain' && v.kind !== 'secret' && v.kind !== 'op') return { ok: false, error: 'unknown kind' };
    if (v.kind === 'op' && !OP_REF.test(String(v.value ?? '').trim())) return { ok: false, error: 'a 1Password reference looks like op://Vault/Item/field' };
    if (v.kind === 'plain' && typeof v.value !== 'string') return { ok: false, error: 'give it a value' };
    const agents = Array.isArray(v.agents) ? v.agents.filter((a): a is string => typeof a === 'string').slice(0, 200) : null;
    const rec: EnvVar = {
      name, kind: v.kind, agents,
      ...(v.kind === 'plain' ? { value: String(v.value).slice(0, 10_000) } : {}),
      ...(v.kind === 'op' ? { value: String(v.value).trim() } : {}),
      ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim().slice(0, 200) } : {})
    };
    if (v.kind === 'secret') {
      const s = typeof secretValue === 'string' ? secretValue : '';
      if (s) {
        const r = this.deps.setSecret(secretRef(name), s);
        if (!r.ok) return { ok: false, error: r.error ?? 'could not store it securely' };
      } else if (!this.deps.getSecret(secretRef(name))) {
        return { ok: false, error: 'paste the secret value' };
      }
    } else {
      this.deps.deleteSecret(secretRef(name)); // it used to be a secret: forget the value
    }
    this.deps.writeVars([...this.deps.readVars().filter((x) => x.name !== name), rec]);
    return { ok: true };
  }

  removeVar(name: unknown): { ok: boolean } {
    if (typeof name !== 'string') return { ok: false };
    this.deps.deleteSecret(secretRef(name));
    this.deps.writeVars(this.deps.readVars().filter((x) => x.name !== name));
    return { ok: true };
  }

  /** The PLAIN variables an agent gets in its environment. Never secrets. */
  plainEnvFor(agentId: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const v of this.deps.readVars()) {
      if (v.kind !== 'plain' || typeof v.value !== 'string') continue;
      if (v.agents && v.agents.length && !v.agents.includes(agentId)) continue;
      out[v.name] = v.value;
    }
    return out;
  }

  /** Secret and 1Password variables by name, resolved now. */
  private async resolve(names: string[]): Promise<Record<string, string>> {
    const vars = new Map(this.deps.readVars().map((v) => [v.name, v]));
    const out: Record<string, string> = {};
    for (const n of names) {
      const v = vars.get(n);
      if (!v) throw new Error(`no variable named ${n}`);
      if (v.kind === 'plain') { out[n] = v.value ?? ''; continue; }
      if (v.kind === 'secret') {
        const s = this.deps.getSecret(secretRef(n));
        if (!s) throw new Error(`${n} has no value stored`);
        out[n] = s;
        continue;
      }
      try { out[n] = await (this.deps.opRead ?? opReadCli)(v.value!); }
      catch (e) { throw new Error(`1Password could not read ${n}: ${e instanceof Error ? e.message : e}`); }
    }
    return out;
  }

  // ─── runners ────────────────────────────────────────────────────────────────

  listRunners(): Runner[] { return this.deps.readRunners(); }

  setRunner(input: unknown): { ok: boolean; id?: string; error?: string } {
    const r = (input ?? {}) as Partial<Runner>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
    const command = typeof r.command === 'string' ? r.command.trim().slice(0, 1000) : '';
    if (!name) return { ok: false, error: 'give it a name' };
    if (!command) return { ok: false, error: 'give it a command' };
    const known = new Set(this.deps.readVars().map((v) => v.name));
    const secrets = Array.isArray(r.secrets) ? [...new Set(r.secrets.filter((s): s is string => typeof s === 'string' && known.has(s)))] : [];
    const id = typeof r.id === 'string' && r.id ? r.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `runner-${Date.now()}`;
    const approval: Approval = r.approval === 'always' || r.approval === 'never' ? r.approval : 'on-change';
    const timeoutSec = typeof r.timeoutSec === 'number' && r.timeoutSec > 0 ? Math.min(r.timeoutSec, 3600) : 600;
    const rec: Runner = { id, name, command, secrets, approval, timeoutSec, ...(typeof r.description === 'string' && r.description.trim() ? { description: r.description.trim().slice(0, 200) } : {}) };
    this.deps.writeRunners([...this.deps.readRunners().filter((x) => x.id !== id), rec]);
    for (const k of [...this.trusted]) if (k.startsWith(`${id}|`)) this.trusted.delete(k); // a changed runner is asked about again
    return { ok: true, id };
  }

  removeRunner(id: unknown): { ok: boolean } {
    if (typeof id !== 'string') return { ok: false };
    this.deps.writeRunners(this.deps.readRunners().filter((x) => x.id !== id));
    return { ok: true };
  }

  /** Names of the secrets (secret and 1Password variables) — never values —
   *  so an agent can say which one a runner it proposes needs. */
  secretNames(): string[] {
    return this.deps.readVars().filter((v) => v.kind !== 'plain').map((v) => v.name);
  }

  /**
   * An agent proposes a runner: a command that needs secrets it will never
   * see (a migration, a dev server check, a deploy script). Nothing is added
   * until the human approves it in a prompt that shows the exact command and
   * the secrets; then it is an ordinary runner (asked about again whenever
   * the worktree changed, like any other). A secret it names that does not
   * exist yet is created by the human in that same prompt (never by the
   * agent); a plain variable cannot be named as a secret, and an existing
   * runner is never replaced from here. `cwd` is the agent's folder (chosen by
   * the app), so the prompt can show the code the command runs.
   */
  async proposeRunner(input: unknown, ctx: { agentName: string; cwd?: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
    const r = (input ?? {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
    const command = typeof r.command === 'string' ? r.command.trim() : '';
    if (!name) return { ok: false, error: 'give the runner a name' };
    if (!command) return { ok: false, error: 'give the runner a command' };
    if (command.length > 1000) return { ok: false, error: 'the command is longer than 1000 characters' };
    const secretsIn = Array.isArray(r.secrets) ? r.secrets.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
    const known = new Set(this.secretNames());
    const plain = new Set(this.deps.readVars().filter((v) => v.kind === 'plain').map((v) => v.name));
    const clash = secretsIn.filter((x) => plain.has(x));
    if (clash.length) {
      return { ok: false, error: `${clash.join(', ')} ${clash.length === 1 ? 'is a plain variable' : 'are plain variables'}, not a secret. Stored secrets: ${[...known].join(', ') || 'none yet'}` };
    }
    const badName = secretsIn.filter((x) => !NAME.test(x));
    if (badName.length) return { ok: false, error: `secret names are letters, digits and _ (not starting with a digit): ${badName.join(', ')}` };
    const missing = [...new Set(secretsIn.filter((x) => !known.has(x)))];
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) return { ok: false, error: 'the name needs a letter or a digit' };
    if (this.deps.readRunners().some((x) => x.id === id)) return { ok: false, error: `a runner named ${id} already exists: run it, or propose another name` };
    if (!this.deps.approveProposal) return { ok: false, error: 'proposals are not available here' };
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim().slice(0, 200) : undefined;
    const proposal = { name, command, secrets: [...new Set(secretsIn)], ...(description ? { description } : {}) };
    const raw = await this.deps.approveProposal({ proposal, agentName: ctx.agentName, missing, ...(ctx.cwd ? { cwd: ctx.cwd } : {}) });
    const answer = typeof raw === 'boolean' ? { ok: raw, secrets: {} } : raw;
    if (!answer.ok) return { ok: false, error: 'the human declined this runner' };
    // The secrets the human created in the prompt. The agent gets only names.
    for (const m of missing) {
      const s = answer.secrets?.[m];
      if (!s || !s.value.trim()) return { ok: false, error: `the human did not add the secret ${m}` };
      const r = s.kind === 'op'
        ? this.setVar({ name: m, kind: 'op', value: s.value.trim(), note: `added for runner ${name}` })
        : this.setVar({ name: m, kind: 'secret', note: `added for runner ${name}` }, s.value);
      if (!r.ok) return { ok: false, error: `could not store the secret ${m}: ${r.error ?? 'unknown error'}` };
    }
    this.deps.log?.(`runner ${id} added at ${ctx.agentName}'s request`);
    return this.setRunner({ ...proposal, id, approval: 'on-change' });
  }

  /** What an agent may know about runners: names, descriptions and which
   *  secrets they use — never values. */
  describeRunners(): Array<{ id: string; name: string; description?: string; secrets: string[] }> {
    return this.deps.readRunners().map((r) => ({ id: r.id, name: r.name, description: r.description, secrets: r.secrets }));
  }

  /**
   * Run a runner for an agent, in `cwd` (the agent's worktree — chosen by the
   * app, never by the agent). Output comes back with every secret masked.
   * `fingerprint` describes the worktree's state for on-change approval.
   */
  async run(runnerId: string, ctx: { agentName: string; cwd: string; fingerprint: string }): Promise<{ ok: boolean; exitCode?: number | null; output?: string; error?: string }> {
    const r = this.deps.readRunners().find((x) => x.id === runnerId);
    if (!r) return { ok: false, error: `no runner named ${runnerId}` };
    const key = `${r.id}|${ctx.cwd}`;
    const changed = this.allowed.get(key) !== ctx.fingerprint;
    const mustAsk = !this.trusted.has(key) && (r.approval === 'always' || (r.approval === 'on-change' && changed));
    if (mustAsk) {
      const answer = await this.deps.approve({ runner: r, agentName: ctx.agentName, cwd: ctx.cwd, changed });
      if (answer === 'deny') return { ok: false, error: 'the human declined to run it' };
      if (answer === 'always') this.trusted.add(key);
    }
    this.allowed.set(key, ctx.fingerprint);
    let secrets: Record<string, string>;
    try { secrets = await this.resolve(r.secrets); }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const values = Object.values(secrets).filter(Boolean);
    const res = await execRunner(r, ctx.cwd, secrets);
    return { ok: true, exitCode: res.code, output: maskSecrets(res.output, values) };
  }
}

/** A fingerprint of a worktree's state (HEAD + uncommitted changes), so an
 *  on-change runner asks again after the agent edited something. */
export function fingerprintOf(head: string, status: string): string {
  return createHash('sha256').update(head).update('\0').update(status).digest('hex').slice(0, 16);
}

/** Run the command with the secrets in its own environment only (never on a
 *  command line other processes could read). */
function execRunner(r: Runner, cwd: string, secrets: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const add = (d: Buffer) => { if (output.length < MAX_OUTPUT) output += d.toString('utf8'); };
    // A WSL floor's worktree: run inside its distro, secrets over stdin.
    const wsl = parseWslPath(cwd);
    const child = wsl
      ? (() => { const c = wslSecretRun(wsl.distro, wsl.linuxPath, r.command); return spawn(c.file, c.args, { windowsHide: true }); })()
      : spawn(r.command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...secrets } });
    child.stdin.end(wsl ? secretStdin(secrets) : undefined);
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      output += `\n[runner stopped after ${r.timeoutSec ?? 600} s]`;
      try { child.kill(); } catch { /* gone */ }
    }, (r.timeoutSec ?? 600) * 1000);
    child.on('error', (e) => { output += `\n[could not start: ${e.message}]`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: output.length >= MAX_OUTPUT ? output + '\n[output truncated]' : output }); });
  });
}
