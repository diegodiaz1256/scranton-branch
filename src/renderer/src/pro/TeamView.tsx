import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { TRIGGER_MODES } from '@shared/triggers';
import { StateBadge } from './data';
import { Guide, useGuide } from './Guide';
import { useStore } from '@/store/store';
import { TempAnswerOptions } from '@/components/TempAnswerOptions';

type Status = Awaited<ReturnType<typeof window.cth.teamStatus>>;
type Team = Status['teams'][number];
type Member = Status['peers'][number];
type LogEntry = Awaited<ReturnType<typeof window.cth.teamLog>>[number];
type Level = Team['level'];
type Mode = Team['mode'];

const LEVELS: { value: Level; soon?: boolean }[] = [
  { value: 'message' }, { value: 'view', soon: true }, { value: 'manage', soon: true }
];
/** The guide's steps, `pro.team.step<n>` / `pro.team.step<n>Body`. */
const TEAM_STEPS = (t: TFunction): Array<[string, string]> =>
  [1, 2, 3, 4, 5, 6].map((n) => [t(`pro.team.step${n}`), t(`pro.team.step${n}Body`)]);

const levelLabel = (t: TFunction, l: Level): string => t(`pro.team.level_${l}`, { defaultValue: l });
const modeLabel = (t: TFunction, m: Mode): string => t(`pro.team.mode_${m}`, { defaultValue: TRIGGER_MODES.find((x) => x.value === m)?.label ?? m });

/**
 * Team — your office and your teammates' offices, talking to each other.
 * Teams group people and each has its own relay; you pair with an invite code
 * per team. Messages are sealed end to end; a relay only ever sees encrypted
 * bytes. What each person may do in your office, and whether their messages
 * reach your orchestrator directly or wait for you, is set per team and can be
 * overridden one to one.
 */
export function TeamView() {
  const { t } = useTranslation();
  const [st, setSt] = useState<Status | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [openPeer, setOpenPeer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guide, toggleGuide] = useGuide('cth.teamGuide');

  const reload = useCallback(() => {
    void window.cth.teamStatus().then(setSt).catch(() => { /* keep last */ });
    void window.cth.teamLog().then(setLog).catch(() => { /* keep last */ });
  }, []);
  useEffect(() => { reload(); return window.cth.onTeamUpdated(reload); }, [reload]);

  if (!st) return <div className="pro-page"><p className="pro-sub">{t('pro.team.loading')}</p></div>;
  if (!st.enabled) return <TeamSetup current={st} onDone={reload} />;

  const peer = st.peers.find((p) => p.id === openPeer) ?? null;
  const peerTeam = peer ? st.teams.find((t) => t.id === peer.teamId) : undefined;

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.team')}</h2>
        <span className="pro-sub">{t('pro.team.youAre')} <strong>{st.me?.name}</strong> · {t('pro.team.teams', { count: st.teams.length })} · {t('pro.team.teammates', { count: st.peers.length })}</span>
        <div className="pro-head-end">
          <button className="pro-btn" onClick={toggleGuide}>{guide ? t('pro.conn.hideGuide') : t('pro.team.howTeams')}</button>
          <button className="pro-btn" onClick={() => { void window.cth.teamDisable().then(reload); }}>{t('pro.conn.turnOff')}</button>
        </div>
      </div>
      {guide && <Guide title={t('pro.team.howTeams')} steps={TEAM_STEPS(t)} onClose={toggleGuide} />}
      <p className="pro-text" style={{ marginTop: -6 }}>
        {t('pro.team.sealed')}
      </p>
      <TeamAnswerPicker />
      {error && <p className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {st.teams.map((t) => (
            <TeamCard key={t.id} team={t} members={st.peers.filter((p) => p.teamId === t.id)}
              open={openPeer} onOpen={setOpenPeer} onChanged={reload} onError={setError} />
          ))}
          <NewTeam onChanged={reload} onError={setError} defaultRelay={st.me?.relay ?? DEFAULT_RELAY} />
          <JoinCard onChanged={reload} onError={setError} />
        </div>

        {peer && peerTeam
          ? <Conversation key={peer.id} peer={peer} team={peerTeam} log={log.filter((e) => e.peerId === peer.id)} onChanged={reload} onError={setError} onClose={() => setOpenPeer(null)} />
          : <section className="pro-card"><p className="pro-sub" style={{ margin: 0 }}>{t('pro.team.pick')}</p></section>}
      </div>
    </div>
  );
}

/** Who answers a teammate's request: the orchestrator (default), a temp, or a
 *  temp cloned from an agent. Only the orchestrator writes back over Team, so
 *  a temp's done goes to it and it replies. */
function TeamAnswerPicker() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [answer, setAnswer] = useState('god');
  useEffect(() => { void window.cth.getConfig().then((c) => setAnswer(c.teamAnswer || 'god')).catch(() => { /* keep default */ }); }, []);
  const pick = (v: string): void => {
    setAnswer(v);
    void window.cth.updateConfig({ teamAnswer: v === 'god' ? undefined : v });
  };
  return (
    <label className="pro-row" style={{ gap: 8, fontSize: 13 }}>
      <span>{t('tempAnswer.whoAnswers')}</span>
      <select className="pro-input" style={{ maxWidth: 280 }} value={answer} onChange={(e) => pick(e.target.value)}>
        <option value="god">{agents.find((a) => a.isGod)?.name ?? t('tempAnswer.orchestrator')}</option>
        <TempAnswerOptions agents={agents} />
      </select>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('tempAnswer.teamHint')}</span>
    </label>
  );
}

function TeamSetup({ current, onDone }: { current: Status; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(current.me?.name ?? '');
  const [relay, setRelay] = useState(current.me?.relay ?? DEFAULT_RELAY);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const go = async () => {
    setBusy(true); setError(null);
    const r = await window.cth.teamEnable({ name, relay }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setBusy(false); setError(r.error ?? t('pro.team.couldNotOn')); return; }
    // Came with an invite: join it right away (Team has to be on first).
    if (invite.trim()) {
      const j = await window.cth.teamJoin(invite.trim()).catch((e) => ({ ok: false, error: String(e) }));
      if (!j.ok) { setBusy(false); setError(t('pro.team.inviteFailed', { error: j.error ?? '?' })); onDone(); return; }
    }
    setBusy(false);
    onDone();
  };
  return (
    <div className="pro-page">
      <div className="pro-head"><h2>{t('pro.nav.team')}</h2></div>
      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 620 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.team.connectTitle')}</strong>
        <p className="pro-text" style={{ margin: 0 }}>
          {t('pro.team.connectBody')}
        </p>
        <label className="pro-sub" style={{ fontSize: 12 }} htmlFor="team-name">{t('pro.team.seeYou')}</label>
        <input id="team-name" className="pro-input" placeholder={t('pro.team.namePh')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        {advanced ? (
          <>
            <label className="pro-sub" style={{ fontSize: 12 }} htmlFor="team-relay">{t('pro.team.defaultRelay')}</label>
            <input id="team-relay" className="pro-input pro-mono" list="relay-presets" value={relay} onChange={(e) => setRelay(e.target.value)} />
            <RelayPresets />
          </>
        ) : (
          <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced(true)}>{t('pro.team.relaySettings')}</button>
        )}
        <label className="pro-sub" style={{ fontSize: 12 }} htmlFor="team-invite">{t('pro.team.gotInvitePaste')}</label>
        <textarea id="team-invite" className="pro-input pro-mono" rows={2} placeholder="mdteam1.…" value={invite}
          onChange={(e) => setInvite(e.target.value)} style={{ fontSize: 11, resize: 'vertical' }} />
        {error && <p className="pro-text" style={{ color: 'var(--cth-coral)', margin: 0 }}>{error}</p>}
        <button className="pro-btn pro-btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy || !name.trim()} onClick={() => void go()}>
          {busy ? t('pro.team.turningOn') : invite.trim() ? t('pro.team.turnOnJoin') : t('pro.team.turnOn')}
        </button>
      </section>
      <div style={{ maxWidth: 820 }}><Guide title={t('pro.team.howTeams')} steps={TEAM_STEPS(t)} /></div>
    </div>
  );
}

function PolicySelects({ level, mode, inheritLevel, inheritMode, onLevel, onMode }: {
  level: Level | undefined; mode: Mode | undefined;
  /** When given, an "as team" option appears (a member's override). */
  inheritLevel?: Level; inheritMode?: Mode;
  onLevel: (l: Level | null) => void; onMode: (m: Mode | null) => void;
}) {
  const { t } = useTranslation();
  const asTeam = inheritLevel !== undefined;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 8px', alignItems: 'center', fontSize: 12 }}>
      <span className="pro-sub">{t('pro.team.may')}</span>
      <select className="pro-input" value={level ?? ''} onChange={(e) => onLevel((e.target.value || null) as Level | null)}>
        {asTeam && <option value="">{t('pro.team.asTeam', { value: levelLabel(t, inheritLevel) })}</option>}
        {LEVELS.map((l) => <option key={l.value} value={l.value} disabled={l.soon}>{levelLabel(t, l.value)}{l.soon ? ` (${t('pro.team.soon')})` : ''}</option>)}
      </select>
      <span className="pro-sub">{t('pro.team.messages')}</span>
      <select className="pro-input" value={mode ?? ''} onChange={(e) => onMode((e.target.value || null) as Mode | null)}>
        {asTeam && <option value="">{t('pro.team.asTeam', { value: modeLabel(t, inheritMode!) })}</option>}
        {TRIGGER_MODES.map((m) => <option key={m.value} value={m.value}>{modeLabel(t, m.value)}</option>)}
      </select>
    </div>
  );
}

const DEFAULT_RELAY = 'mqtts://broker.emqx.io:8883';

/** Public relays that work out of the box (all carry only sealed bytes). */
function RelayPresets() {
  const { t } = useTranslation();
  return (
    <datalist id="relay-presets">
      <option value="mqtts://broker.emqx.io:8883">{t('pro.team.presetEmqx')}</option>
      <option value="wss://broker.hivemq.com:8884/mqtt">{t('pro.team.presetHivemq')}</option>
      <option value="https://ntfy.sh">{t('pro.team.presetNtfy')}</option>
    </datalist>
  );
}

function TeamCard({ team, members, open, onOpen, onChanged, onError }: {
  team: Team; members: Member[]; open: string | null; onOpen: (id: string) => void; onChanged: () => void; onError: (e: string | null) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [relay, setRelay] = useState(team.relay);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState('');

  // Write-only: the token goes to main's encrypted store; the app never shows it again.
  const saveToken = async (value: string) => {
    onError(null);
    const r = await window.cth.teamSetRelayToken({ relay: team.relay, token: value });
    if (!r.ok) onError(r.error ?? t('pro.team.tokenNotSaved'));
    else setToken('');
    onChanged();
  };

  const update = async (patch: Parameters<typeof window.cth.teamUpdateTeam>[1]) => {
    onError(null);
    const r = await window.cth.teamUpdateTeam(team.id, patch);
    if (!r.ok) onError(r.error ?? t('pro.env.notSaved'));
    onChanged();
    return r.ok;
  };
  const invite = async () => {
    onError(null);
    const r = await window.cth.teamCreateInvite(team.id);
    if (r.ok && r.code) { setCode(r.code); setCopied(false); } else onError(r.error ?? t('pro.team.couldNotInvite'));
  };
  const remove = async () => {
    if (!(await window.cth.confirm(t('pro.team.deleteTeam', { name: team.name }), { detail: t('pro.team.deleteTeamDetail', { count: members.length }), ok: t('pro.caps.delete') }))) return;
    void window.cth.teamRemoveTeam(team.id).then(onChanged);
  };

  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="pro-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <input className="pro-input pro-mono" list="relay-presets" value={relay} onChange={(e) => setRelay(e.target.value)} title={t('pro.team.relayTitle')} />
          <RelayPresets />
          <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.team.newRelay')}</span>
          <label className="pro-sub" style={{ fontSize: 12 }} htmlFor={`relay-token-${team.id}`}>
            {t('pro.team.relayToken')} {team.relayAuth ? t('pro.team.tokenStored') : t('pro.team.tokenWhen')}
          </label>
          <div className="pro-row">
            <input id={`relay-token-${team.id}`} className="pro-input pro-mono" type="password" autoComplete="off" placeholder="tk_…"
              value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1 }} />
            <button className="pro-btn" disabled={!token.trim()} onClick={() => void saveToken(token)}>{t('pro.team.saveToken')}</button>
            {team.relayAuth && <button className="pro-btn" onClick={() => void saveToken('')}>{t('pro.conn.remove')}</button>}
          </div>
          <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.team.tokenHint')}</span>
          <div className="pro-row">
            <button className="pro-btn pro-btn-primary" onClick={() => { void update({ name, relay }).then((ok) => ok && setEditing(false)); }}>{t('common.save')}</button>
            <button className="pro-btn" onClick={() => { setEditing(false); setName(team.name); setRelay(team.relay); }}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <div className="pro-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="pro-title">{team.name}</p>
            <p className="pro-sub pro-mono" style={{ fontSize: 11, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{team.relay}{team.relayAuth ? ` · ${t('pro.team.token')}` : ''}</p>
          </div>
          <button className="pro-btn" onClick={() => setEditing(true)}>{t('pro.caps.edit')}</button>
          <button className="pro-btn" onClick={remove}>{t('pro.caps.delete')}</button>
        </div>
      )}

      <PolicySelects level={team.level} mode={team.mode}
        onLevel={(l) => { if (l) void update({ level: l }); }} onMode={(m) => { if (m) void update({ mode: m }); }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {members.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.team.noMembers')}</span>}
        {members.map((p) => (
          <button key={p.id} className="pro-card pro-row" aria-pressed={open === p.id} onClick={() => onOpen(p.id)} style={{ padding: '6px 10px' }}>
            <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <strong style={{ fontSize: 13 }}>{p.name}</strong>
              <span className="pro-sub" style={{ fontSize: 11 }}>
                {levelLabel(t, p.level ?? team.level)}{p.level ? ` (${t('pro.team.own')})` : ''} · {modeLabel(t, p.mode ?? team.mode)}{p.mode ? ` (${t('pro.team.own')})` : ''}
                {p.pq === 'on' ? ` · ${t('pro.team.pq')}` : p.confirmed ? ` · ${t('pro.team.classical')}` : ''}
              </span>
            </span>
            <StateBadge label={p.confirmed ? t('pro.team.paired') : t('pro.team.waiting')} tone={p.confirmed ? 'green' : 'amber'} />
          </button>
        ))}
      </div>

      {code ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea className="pro-input pro-mono" readOnly rows={4} value={code} style={{ fontSize: 11, resize: 'none' }} onFocus={(e) => e.currentTarget.select()} />
          <div className="pro-row">
            <button className="pro-btn pro-btn-primary" onClick={() => { void navigator.clipboard.writeText(code).then(() => setCopied(true)); }}>{copied ? t('pro.conn.copied') : t('pro.team.copyInvite')}</button>
            <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.team.inviteHint')}</span>
          </div>
        </div>
      ) : (
        <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => void invite()}>{t('pro.team.inviteTo', { name: team.name })}</button>
      )}
    </section>
  );
}

function NewTeam({ onChanged, onError, defaultRelay }: { onChanged: () => void; onError: (e: string | null) => void; defaultRelay: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [relay, setRelay] = useState(defaultRelay);
  if (!open) return <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>+ {t('pro.team.newTeam')}</button>;
  const create = async () => {
    onError(null);
    const r = await window.cth.teamCreateTeam({ name, relay });
    if (!r.ok) { onError(r.error ?? t('pro.team.couldNotCreate')); return; }
    setOpen(false); setName(''); onChanged();
  };
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <strong style={{ fontSize: 13 }}>{t('pro.team.newTeam')}</strong>
      <input className="pro-input" placeholder={t('pro.team.teamNamePh')} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className="pro-input pro-mono" list="relay-presets" placeholder="mqtts://broker.emqx.io:8883" value={relay} onChange={(e) => setRelay(e.target.value)} title={t('pro.team.relayTitle')} />
      <RelayPresets />
      <div className="pro-row">
        <button className="pro-btn pro-btn-primary" disabled={!name.trim()} onClick={() => void create()}>{t('pro.lists.create')}</button>
        <button className="pro-btn" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
      </div>
    </section>
  );
}

function JoinCard({ onChanged, onError }: { onChanged: () => void; onError: (e: string | null) => void }) {
  const { t } = useTranslation();
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const join = async () => {
    setBusy(true); onError(null);
    const r = await window.cth.teamJoin(paste).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) { setPaste(''); onChanged(); } else onError(r.error ?? t('pro.team.couldNotJoin'));
  };
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <strong style={{ fontSize: 13 }}>{t('pro.team.gotInvite')}</strong>
      <textarea className="pro-input pro-mono" rows={2} placeholder="mdteam1.…" value={paste} onChange={(e) => setPaste(e.target.value)} style={{ fontSize: 11, resize: 'vertical' }} />
      <button className="pro-btn" style={{ alignSelf: 'flex-start' }} disabled={busy || !paste.trim()} onClick={() => void join()}>{busy ? t('pro.team.joining') : t('pro.team.join')}</button>
      <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.team.joinHint')}</span>
    </section>
  );
}

function Conversation({ peer, team, log, onChanged, onError, onClose }: {
  peer: Member; team: Team; log: LogEntry[]; onChanged: () => void; onError: (e: string | null) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(() => log.slice().sort((a, b) => a.at.localeCompare(b.at)), [log]);
  const send = async () => {
    setBusy(true); onError(null);
    const r = await window.cth.teamSend({ to: peer.id, subject, body }).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) { setSubject(''); setBody(''); onChanged(); } else onError(r.error ?? t('pro.team.notSent'));
  };
  const remove = async () => {
    if (!(await window.cth.confirm(t('pro.mcp.removeConfirm', { name: peer.name }), { detail: t('pro.team.removePeerDetail'), ok: t('pro.conn.remove') }))) return;
    void window.cth.teamRemovePeer(peer.id).then(() => { onClose(); onChanged(); });
  };
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 420 }}>
      <div className="pro-row" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="pro-row"><strong style={{ fontSize: 14 }}>{peer.name}</strong>
            <StateBadge label={peer.confirmed ? t('pro.team.paired') : t('pro.team.waitingOnline')} tone={peer.confirmed ? 'green' : 'amber'} /></div>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.team.inTeam', { name: team.name })}</span>
        </div>
        <PolicySelects level={peer.level} mode={peer.mode} inheritLevel={team.level} inheritMode={team.mode}
          onLevel={(l) => { void window.cth.teamSetMember(peer.id, { level: l }).then(onChanged); }}
          onMode={(m) => { void window.cth.teamSetMember(peer.id, { mode: m }).then(onChanged); }} />
        <button className="pro-btn" onClick={remove}>{t('pro.conn.remove')}</button>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', maxHeight: 460 }}>
        {sorted.length === 0 && <p className="pro-sub" style={{ margin: 0 }}>{t('pro.team.noMessages', { name: peer.name })}</p>}
        {sorted.map((m) => (
          <article key={`${m.id}-${m.direction}`} className="pro-card" style={{
            padding: '8px 10px', alignSelf: m.direction === 'out' ? 'flex-end' : 'flex-start', maxWidth: '85%',
            background: m.direction === 'out' ? 'var(--cth-lemon-light)' : undefined
          }}>
            <div className="pro-sub" style={{ fontSize: 11 }}>
              {m.direction === 'out' ? (m.by === 'agent' ? t('pro.team.yourOrchestrator') : t('pro.inbox.you')) : peer.name} · {new Date(m.at).toLocaleString()}
            </div>
            {m.subject && <strong style={{ fontSize: 13 }}>{m.subject}</strong>}
            <div style={{ fontSize: 13 }}><MarkdownPreview source={m.body} variant="card" /></div>
          </article>
        ))}
      </div>
      <input className="pro-input" placeholder={t('pro.team.subjectPh')} value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea className="pro-input" rows={3} placeholder={t('pro.team.writeTo', { name: peer.name })} value={body} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} />
      <div className="pro-row">
        <button className="pro-btn pro-btn-primary" disabled={busy || !body.trim()} onClick={() => void send()}>{busy ? t('askMe.sending') : t('threads.send')}</button>
        <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.team.sendHint')}</span>
      </div>
    </section>
  );
}
