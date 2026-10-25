/**
 * Team node — paired installs message each other through public relays, sealed
 * end to end (teamCrypto.ts). No server of our own: a relay is an ntfy server
 * (https://ntfy.sh by default, or a self-hosted one) or any MQTT broker
 * (mqtts://, wss://; see teamMqtt.ts), used as a dumb mailbox.
 * Each install listens on its own unguessable topic; a message to a teammate is
 * POSTed to the teammate's topic on their team's relay as one sealed envelope,
 * and ntfy keeps it for hours, so a teammate who was offline still gets it.
 *
 * Teams: an install belongs to any number of teams, each with its own relay,
 * a default level (what its members may do in OUR office) and a default trust
 * mode (whether their messages reach the orchestrator directly or wait for the
 * human). A member can override both, one to one. The node listens on every
 * relay its teams use.
 *
 * Pairing: an invite carries this install's public card, the team (id, name,
 * relay) and a one-time secret. The joiner files the inviter under that team
 * and sends back a sealed `hello` with its own card and the secret; the inviter
 * accepts it only while the secret is pending and unexpired, then answers
 * `welcome`. Anything else from an unpaired sender is dropped, so learning a
 * topic is not enough to talk.
 *
 * Post-quantum: pairing also agrees an ML-KEM secret (teamCrypto.ts). The
 * inviter encapsulates to the joiner's ML-KEM key and sends the ciphertext in
 * `welcome`; pairs made before that upgrade themselves with pq-offer →
 * pq-accept. A pair's `pq` status: 'sent' (we encapsulated; they may not have
 * the secret yet, so we keep sending v1), 'ready' (we decapsulated, so they
 * surely have it: we send v2), 'on' (a v2 arrived from them: from then on v1
 * from them is refused, so nobody can downgrade the pair).
 *
 * Plaintext kinds: msg {id, subject, body, at} · part {id, i, n, d} (a msg too
 * big for one relay message) · hello {card, relay, secret, team} · welcome
 * {kem?} · pq-offer {kem} · pq-accept {ct} · pq-ok {}.
 *
 * Electron-free: state storage, fetch and the inbound handler are injected.
 */
import { createHash, randomBytes } from 'node:crypto';
import { MqttRelays, isMqttRelay } from './teamMqtt';
import {
  decodeInvite, encodeInvite, isEnvelope, isKemPublicKey, isRelayUrl, newInviteSecret, open, openHello, pqDecapsulate, pqEncapsulate,
  publicCard, sameSecret, seal, verifyEnvelope,
  type Envelope, type Identity, type PublicCard
} from './teamCrypto';

export type TeamLevel = 'message' | 'view' | 'manage';
/** Same values as shared/triggers TriggerMode. */
export type TrustMode = 'strict' | 'communication-only' | 'allow-all';

export interface TeamGroup {
  id: string;
  name: string;
  /** The relay this team's members (us included) listen on. */
  relay: string;
  /** Default for members: what they may do in our office. */
  level: TeamLevel;
  /** Default for members: how their messages enter our office. */
  mode: TrustMode;
}

export interface Peer extends PublicCard {
  teamId: string;
  /** Relay this teammate listens on (their team's relay). */
  relay: string;
  addedAt: number;
  /** True once the teammate acknowledged the pairing (welcome, or any message). */
  confirmed: boolean;
  /** One-to-one overrides of the team defaults; absent = inherit. Set by us,
   *  never by the teammate. */
  level?: TeamLevel;
  mode?: TrustMode;
  /** Post-quantum status of the pair (see the header). Absent: classical only. */
  pq?: 'sent' | 'ready' | 'on';
}

export interface TeamState {
  identity: Identity;
  /** Relay for new teams. */
  relay: string;
  teams: TeamGroup[];
  peers: Peer[];
  /** Pending invites, by sha256 of their secret. */
  invites: Array<{ hash: string; expiresAt: number; teamId: string }>;
  /** Last message id seen on our topic, per relay (resume points). */
  cursors?: Record<string, string>;
  /** Recently delivered message ids (replay guard). */
  seen?: string[];
  /** Post-quantum pair secrets by peer id. SECRET: kept in the encrypted store. */
  pq?: Record<string, string>;
}

export interface TeamInbound {
  id: string;
  from: Peer;
  team: TeamGroup | undefined;
  /** The member's effective policy: override, else team default. */
  level: TeamLevel;
  mode: TrustMode;
  subject: string;
  body: string;
  sentAt: string;
}

export interface TeamNodeDeps {
  load: () => TeamState;
  save: (s: TeamState) => void;
  onMessage: (m: TeamInbound) => void;
  onChange?: () => void;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Access token for a relay that requires one (a paid ntfy.sh plan, a
   *  self-hosted ntfy with access control), by relay URL. Main-only. */
  relayToken?: (relay: string) => string | undefined;
  /** Tests: where to connect for an MQTT relay URL. */
  mqttConnectUrl?: (relay: string) => string;
}

/** ntfy rejects bodies over 4096 bytes; stay well under with the envelope overhead. */
const MAX_ENVELOPE = 3600;
const CHUNK = 1800;
const INVITE_TTL_MS = 24 * 3600_000;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const now = (): number => Date.now();

function relayError(status: number): string {
  if (status === 429) return 'the relay is rate-limiting this office (the public ntfy.sh allows 250 messages a day per IP; a team on its own relay has no such cap)';
  if (status === 401 || status === 403) return 'the relay refused access: it needs an access token (Manager → Team → the team → Relay token)';
  return `relay answered ${status}`;
}
const trimRelay = (r: string): string => r.replace(/\/+$/, '');

/** A member's policy: their own setting, else their team's, else the safest. */
export function effectivePolicy(s: Pick<TeamState, 'teams'>, p: Peer): { level: TeamLevel; mode: TrustMode } {
  const team = s.teams.find((t) => t.id === p.teamId);
  return { level: p.level ?? team?.level ?? 'message', mode: p.mode ?? team?.mode ?? 'strict' };
}

export class TeamNode {
  private stopped = true;
  private listeners = new Map<string, AbortController>();
  private parts = new Map<string, { n: number; got: Map<number, string>; at: number }>();
  /** Peers we sent a pq-offer to this run (collision tie-break, no repeats). */
  private offered = new Set<string>();
  private readonly mqtt: MqttRelays;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: TeamNodeDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.mqtt = new MqttRelays({
      installId: () => this.state().identity.id,
      token: (relay) => deps.relayToken?.(relay),
      onMessage: (_relay, payload) => {
        try { this.receive(payload); } catch (e) { this.log(`dropped a relay message: ${e instanceof Error ? e.message : String(e)}`); }
      },
      log: (m) => this.log(m),
      connectUrl: deps.mqttConnectUrl
    });
  }

  private state(): TeamState { return this.deps.load(); }
  private headers(relay: string, extra: Record<string, string> = {}): Record<string, string> {
    const token = this.deps.relayToken?.(trimRelay(relay));
    return { 'User-Agent': 'scranton-branch-team', ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }
  private persist(s: TeamState): void { this.deps.save(s); this.syncListeners(); this.deps.onChange?.(); }
  private log(m: string): void { this.deps.log?.(m); }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.syncListeners();
    // Pairs from before post-quantum pairing upgrade themselves.
    for (const p of this.state().peers) if (p.confirmed && !p.pq) void this.offerPq(p);
  }

  /** Reconnect every listener (a relay's token changed). */
  reconnect(): void {
    for (const c of this.listeners.values()) c.abort();
    this.listeners.clear();
    this.mqtt.stopAll();
    this.syncListeners();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.listeners.values()) c.abort();
    this.mqtt.stopAll();
    this.listeners.clear();
  }

  /** One listener per relay our teams use; started and stopped as teams change. */
  private syncListeners(): void {
    if (this.stopped) return;
    const want = new Set(this.state().teams.map((t) => trimRelay(t.relay)));
    for (const [relay, c] of this.listeners) if (!want.has(relay)) { c.abort(); this.listeners.delete(relay); if (isMqttRelay(relay)) this.mqtt.close(relay); }
    for (const relay of want) {
      if (this.listeners.has(relay)) continue;
      const c = new AbortController();
      this.listeners.set(relay, c);
      if (isMqttRelay(relay)) this.mqtt.listen(relay, this.state().identity.topic);
      else void this.listen(relay, c);
    }
  }

  private async listen(relay: string, ctl: AbortController): Promise<void> {
    let backoff = 2000;
    while (!this.stopped && !ctl.signal.aborted) {
      const s = this.state();
      const cursor = s.cursors?.[relay];
      const url = `${relay}/${s.identity.topic}/json${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`;
      try {
        const res = await this.fetchImpl(url, { signal: ctl.signal, headers: this.headers(relay) });
        if (!res.ok || !res.body) throw new Error(relayError(res.status));
        backoff = 2000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.onRelayLine(relay, line);
          }
        }
      } catch (e) {
        if (this.stopped || ctl.signal.aborted) return;
        this.log(`relay ${relay} dropped: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (this.stopped || ctl.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private onRelayLine(relay: string, line: string): void {
    let ev: { id?: string; event?: string; message?: string };
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.event !== 'message' || typeof ev.message !== 'string') return;
    try { this.receive(ev.message); } catch (e) { this.log(`dropped a relay message: ${e instanceof Error ? e.message : String(e)}`); }
    if (ev.id) { const s = this.state(); s.cursors = { ...(s.cursors ?? {}), [relay]: ev.id }; this.deps.save(s); }
  }

  // ─── inbound ───────────────────────────────────────────────────────────────

  /** Handle one raw relay message (an envelope as JSON). Exposed for tests. */
  receive(raw: string): void {
    let env: Envelope;
    try { env = JSON.parse(raw); } catch { return; }
    if (!isEnvelope(env)) return;
    const s = this.state();
    if (env.t !== s.identity.id) return;
    const peer = s.peers.find((p) => p.id === env.f);
    if (!peer) { this.receiveHello(env, s); return; }
    // Once a pair has gone post-quantum, a classical envelope from that peer is
    // a downgrade (or a very old resend): refuse it.
    if (env.v === 1 && peer.pq === 'on') { this.log(`refused a non-post-quantum message from ${peer.name}`); return; }
    const plain = JSON.parse(open(env, s.identity, peer.ed, s.pq?.[peer.id])) as Record<string, unknown>;
    let changed = false;
    if (!peer.confirmed) { peer.confirmed = true; changed = true; }
    const firstV2 = env.v === 2 && peer.pq !== 'on';
    if (firstV2) { peer.pq = 'on'; changed = true; }
    if (changed) this.persist(s);
    if (plain.k === 'msg') this.deliver(peer, plain);
    else if (plain.k === 'part') this.collect(peer, plain);
    else if (plain.k === 'welcome' || plain.k === 'pq-accept') this.finishPq(peer, plain.k === 'welcome' ? plain.kem : plain.ct);
    else if (plain.k === 'pq-offer') this.answerPq(peer, plain.kem);
    // A classical pair that just talked to us (e.g. one paired before this
    // version): offer the upgrade, once per run.
    if (!peer.pq && plain.k !== 'pq-offer') void this.offerPq(peer);
    // Both sides learn the pair is post-quantum by receiving a v2 envelope;
    // answer the first one so the other side gets there too (stops after one
    // round: by then both are 'on').
    if (firstV2 && plain.k === 'pq-ok') void this.publish(peer, { k: 'pq-ok' }).catch(() => {});
  }

  // ─── post-quantum upgrade ──────────────────────────────────────────────────

  private secretFor(peerId: string): string | undefined { return this.state().pq?.[peerId]; }

  private setPq(peerId: string, secret: string, status: 'sent' | 'ready', k?: string): void {
    const s = this.state();
    const peer = s.peers.find((p) => p.id === peerId);
    if (!peer) return;
    s.pq = { ...(s.pq ?? {}), [peerId]: secret };
    peer.pq = status;
    if (k) peer.k = k;
    this.persist(s);
  }

  /** Ask a classical pair to go post-quantum: here is our ML-KEM key. */
  private async offerPq(peer: Peer): Promise<void> {
    const me = this.state().identity;
    if (!me.k || this.secretFor(peer.id) || this.offered.has(peer.id)) return;
    this.offered.add(peer.id);
    try { await this.publish(peer, { k: 'pq-offer', kem: me.k }, { classical: true }); }
    catch (e) { this.offered.delete(peer.id); this.log(`post-quantum offer to ${peer.name} not sent: ${e instanceof Error ? e.message : e}`); }
  }

  /** They offered: encapsulate to their key, keep the secret, send the ciphertext. */
  private answerPq(peer: Peer, kem: unknown): void {
    if (!isKemPublicKey(kem) || this.secretFor(peer.id)) return;
    const me = this.state().identity;
    // Both offered at once: the larger id's offer wins, so only one secret is made.
    if (this.offered.has(peer.id) && me.id > peer.id) return;
    const { ct, secret } = pqEncapsulate(me, { id: peer.id, k: kem });
    this.setPq(peer.id, secret, 'sent', kem);
    void this.publish(peer, { k: 'pq-accept', ct }, { classical: true })
      .catch((e) => this.log(`post-quantum answer to ${peer.name} failed: ${e instanceof Error ? e.message : e}`));
  }

  /** Our key was encapsulated to (welcome or pq-accept): take the secret and
   *  prove it with a first v2 envelope. */
  private finishPq(peer: Peer, ct: unknown): void {
    if (ct === undefined || this.secretFor(peer.id)) return;
    let secret: string;
    try { secret = pqDecapsulate(this.state().identity, peer.id, ct); }
    catch (e) { this.log(`post-quantum pairing with ${peer.name} failed: ${e instanceof Error ? e.message : e}`); return; }
    this.setPq(peer.id, secret, 'ready');
    void this.publish(peer, { k: 'pq-ok' }).catch(() => {});
  }

  /** The one thing an unpaired sender may send: a hello carrying a pending invite secret. */
  private receiveHello(env: Envelope, s: TeamState): void {
    let plain: Record<string, unknown>;
    // Decrypting needs only our key; the signature is checked against the card
    // the hello itself carries, and the invite secret is what proves the right
    // to pair. Without a live secret, nothing from a stranger gets through.
    try { plain = JSON.parse(openHello(env, s.identity)); } catch { this.log('ignored a message from an unknown sender (cannot open)'); return; }
    const card = plain.card as PublicCard | undefined;
    if (plain.k !== 'hello' || !card || card.id !== env.f || typeof plain.secret !== 'string' || typeof plain.relay !== 'string') { this.log('ignored a message from an unknown sender (not a hello)'); return; }
    if (!verifyEnvelope(env, card.ed)) { this.log('ignored a hello with a bad signature'); return; }
    const live = s.invites.filter((i) => i.expiresAt > now());
    const match = live.find((i) => sameSecret(i.hash, sha(plain.secret as string)));
    if (!match || !isRelayUrl(plain.relay)) { this.log(`ignored a hello from "${String(card.name).slice(0, 60)}": no matching live invite`); return; }
    if (!s.teams.some((t) => t.id === match.teamId)) { this.log('ignored a hello for a team that no longer exists'); return; }
    s.invites = live.filter((i) => i !== match); // one-time
    s.peers = s.peers.filter((p) => p.id !== card.id);
    const peer: Peer = {
      id: card.id, name: String(card.name).slice(0, 60), x: card.x, ed: card.ed, topic: card.topic,
      teamId: match.teamId, relay: trimRelay(plain.relay), addedAt: now(), confirmed: true
    };
    // Post-quantum from the first message: encapsulate to the joiner's ML-KEM
    // key and send the ciphertext in the welcome.
    let kem: string | undefined;
    if (isKemPublicKey(card.k) && s.identity.k) {
      const pq = pqEncapsulate(s.identity, card);
      peer.k = card.k;
      peer.pq = 'sent';
      s.pq = { ...(s.pq ?? {}), [peer.id]: pq.secret };
      kem = pq.ct;
    }
    s.peers.push(peer);
    this.persist(s);
    void this.publish(peer, { k: 'welcome', ...(kem ? { kem } : {}), at: new Date().toISOString() }, { classical: true })
      .catch((e) => this.log(`welcome to ${peer.name} failed: ${e instanceof Error ? e.message : e}`));
  }

  private deliver(peer: Peer, m: Record<string, unknown>): void {
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id) return;
    const s = this.state();
    const seen = s.seen ?? [];
    if (seen.includes(id)) return; // relay replay or a resend
    s.seen = [...seen, id].slice(-500);
    this.deps.save(s);
    const policy = effectivePolicy(s, peer);
    this.deps.onMessage({
      id,
      from: peer,
      team: s.teams.find((t) => t.id === peer.teamId),
      level: policy.level,
      mode: policy.mode,
      subject: String(m.subject ?? '').slice(0, 200),
      body: String(m.body ?? '').slice(0, 100_000),
      sentAt: typeof m.at === 'string' ? m.at : new Date().toISOString()
    });
  }

  private collect(peer: Peer, p: Record<string, unknown>): void {
    const id = String(p.id ?? ''); const i = Number(p.i); const n = Number(p.n);
    if (!id || !Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 200 || i < 0 || i >= n || typeof p.d !== 'string') return;
    for (const [k, v] of this.parts) if (now() - v.at > 30 * 60_000) this.parts.delete(k);
    const key = `${peer.id}:${id}`;
    const entry = this.parts.get(key) ?? { n, got: new Map(), at: now() };
    entry.got.set(i, p.d);
    this.parts.set(key, entry);
    if (entry.got.size < entry.n) return;
    this.parts.delete(key);
    const json = Array.from({ length: entry.n }, (_, k) => entry.got.get(k) ?? '').join('');
    try { this.deliver(peer, JSON.parse(json)); } catch { /* corrupt reassembly: drop */ }
  }

  // ─── outbound ──────────────────────────────────────────────────────────────

  /** v2 once the pair's secret is known to be on both sides ('ready'/'on');
   *  `classical` for the pairing messages that set it up. */
  private pqFor(peer: Peer, classical = false): string | undefined {
    const s = this.state();
    const live = s.peers.find((p) => p.id === peer.id) ?? peer;
    return !classical && (live.pq === 'ready' || live.pq === 'on') ? s.pq?.[peer.id] : undefined;
  }

  private async publish(peer: Peer, plain: Record<string, unknown>, opts: { classical?: boolean } = {}): Promise<void> {
    const env = seal(JSON.stringify(plain), this.state().identity, peer, this.pqFor(peer, opts.classical));
    if (isMqttRelay(peer.relay)) { await this.mqtt.publish(trimRelay(peer.relay), peer.topic, JSON.stringify(env)); return; }
    const res = await this.fetchImpl(`${trimRelay(peer.relay)}/${peer.topic}`, {
      method: 'POST',
      body: JSON.stringify(env),
      headers: this.headers(peer.relay, { 'Content-Type': 'text/plain' })
    });
    if (!res.ok) throw new Error(relayError(res.status));
  }

  /** Send a message to a teammate (by id, or by name). Long ones go as several sealed parts. */
  async send(peerRef: string, subject: string, body: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    const peers = this.state().peers;
    const peer = peers.find((p) => p.id === peerRef) ?? peers.find((p) => p.name.toLowerCase() === peerRef.toLowerCase());
    if (!peer) return { ok: false, error: 'no such teammate' };
    const msg = { k: 'msg', id: randomBytes(12).toString('base64url'), subject: subject.slice(0, 200), body: body.slice(0, 100_000), at: new Date().toISOString() };
    try {
      const json = JSON.stringify(msg);
      const whole = JSON.stringify(seal(json, this.state().identity, peer, this.pqFor(peer)));
      if (whole.length <= MAX_ENVELOPE) {
        await this.publish(peer, msg);
      } else {
        const chunks: string[] = [];
        for (let i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
        if (chunks.length > 200) return { ok: false, error: 'message too long' };
        for (let i = 0; i < chunks.length; i++) await this.publish(peer, { k: 'part', id: msg.id, i, n: chunks.length, d: chunks[i] });
      }
      return { ok: true, id: msg.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ─── teams and members ─────────────────────────────────────────────────────

  createTeam(name: string, relay?: string): { ok: boolean; team?: TeamGroup; error?: string } {
    const s = this.state();
    const r = trimRelay((relay ?? '').trim() || s.relay);
    if (!isRelayUrl(r)) return { ok: false, error: 'the relay must be an https:// (ntfy), mqtts:// or wss:// (MQTT) address' };
    const team: TeamGroup = { id: randomBytes(9).toString('base64url'), name: name.trim().slice(0, 60) || 'Team', relay: r, level: 'message', mode: 'strict' };
    s.teams = [...s.teams, team];
    this.persist(s);
    return { ok: true, team };
  }

  /** Change a team's name, relay or defaults. A relay change reaches members
   *  who are paired after it; existing ones keep the relay they paired on. */
  updateTeam(teamId: string, patch: Partial<Pick<TeamGroup, 'name' | 'relay' | 'level' | 'mode'>>): { ok: boolean; error?: string } {
    const s = this.state();
    const t = s.teams.find((x) => x.id === teamId);
    if (!t) return { ok: false, error: 'no such team' };
    if (patch.relay !== undefined) {
      const r = trimRelay(patch.relay.trim());
      if (!isRelayUrl(r)) return { ok: false, error: 'the relay must be an https:// (ntfy), mqtts:// or wss:// (MQTT) address' };
      t.relay = r;
    }
    if (patch.name !== undefined) t.name = patch.name.trim().slice(0, 60) || t.name;
    if (patch.level) t.level = patch.level;
    if (patch.mode) t.mode = patch.mode;
    this.persist(s);
    return { ok: true };
  }

  /** Delete a team and forget its members. */
  removeTeam(teamId: string): void {
    const s = this.state();
    s.teams = s.teams.filter((t) => t.id !== teamId);
    const gone = new Set(s.peers.filter((p) => p.teamId === teamId).map((p) => p.id));
    s.peers = s.peers.filter((p) => p.teamId !== teamId);
    if (s.pq) s.pq = Object.fromEntries(Object.entries(s.pq).filter(([id]) => !gone.has(id)));
    s.invites = s.invites.filter((i) => i.teamId !== teamId);
    this.persist(s);
  }

  /** One-to-one overrides; `null` puts that setting back to the team default. */
  setMember(peerId: string, patch: { level?: TeamLevel | null; mode?: TrustMode | null }): void {
    const s = this.state();
    const p = s.peers.find((x) => x.id === peerId);
    if (!p) return;
    if (patch.level !== undefined) { if (patch.level === null) delete p.level; else p.level = patch.level; }
    if (patch.mode !== undefined) { if (patch.mode === null) delete p.mode; else p.mode = patch.mode; }
    this.persist(s);
  }

  removePeer(peerId: string): void {
    const s = this.state();
    s.peers = s.peers.filter((p) => p.id !== peerId);
    if (s.pq?.[peerId]) { const { [peerId]: _gone, ...rest } = s.pq; s.pq = rest; }
    this.persist(s);
  }

  /** A one-time invite to a team, valid for a day. */
  createInvite(teamId: string): { ok: boolean; code?: string; error?: string } {
    const s = this.state();
    const team = s.teams.find((t) => t.id === teamId);
    if (!team) return { ok: false, error: 'no such team' };
    const secret = newInviteSecret();
    const expiresAt = now() + INVITE_TTL_MS;
    s.invites = [...s.invites.filter((i) => i.expiresAt > now()), { hash: sha(secret), expiresAt, teamId }];
    this.persist(s);
    return { ok: true, code: encodeInvite({ card: publicCard(s.identity), secret, relay: team.relay, expiresAt, team: { id: team.id, name: team.name } }) };
  }

  /** Accept someone's invite: join (or create) their team here, add them, and
   *  send the hello that adds us on their side. */
  async join(code: string): Promise<{ ok: boolean; peer?: Peer; error?: string }> {
    const inv = decodeInvite(code);
    if (!inv) return { ok: false, error: 'that is not a valid invite code' };
    if (inv.expiresAt < now()) return { ok: false, error: 'that invite has expired; ask for a new one' };
    const s = this.state();
    if (inv.card.id === s.identity.id) return { ok: false, error: 'that is your own invite' };
    const relay = trimRelay(inv.relay);
    const teamId = inv.team?.id ?? `t-${inv.card.id}`;
    if (!s.teams.some((t) => t.id === teamId)) {
      s.teams = [...s.teams, { id: teamId, name: (inv.team?.name ?? `${inv.card.name}'s team`).slice(0, 60), relay, level: 'message', mode: 'strict' }];
    }
    const peer: Peer = { ...inv.card, name: inv.card.name.slice(0, 60), teamId, relay, addedAt: now(), confirmed: false };
    s.peers = [...s.peers.filter((p) => p.id !== peer.id), peer];
    this.persist(s);
    try {
      await this.publish(peer, { k: 'hello', card: publicCard(s.identity), relay, secret: inv.secret, team: teamId, at: new Date().toISOString() });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, peer };
  }
}
