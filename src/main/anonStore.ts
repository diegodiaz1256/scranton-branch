/**
 * Where anonymization keeps what it must not leave lying around: the human's
 * dictionary (real names, ticket prefixes, known secret values) and each
 * office's pseudonym map (real value <-> codename, so a resumed session's
 * history is rewritten the same way and its answers restored).
 *
 * Both live in the app's data folder, never in a repo or an office folder an
 * agent works in, and are encrypted with the OS key store (Electron
 * safeStorage, injected as a codec) when it is available. When it is not
 * (some Linux desktops without a keyring), they are written as plain JSON in
 * the app's data folder: a protection lost is better than the dictionary lost.
 *
 * Electron-free: the folder and the codec are injected (tests).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PseudonymMap } from '../shared/anonymize';
import { cleanDictionary, EMPTY_DICTIONARY, type AnonDictionary } from '../shared/anonSettings';

export interface StoreCodec {
  available(): boolean;
  encrypt(plain: string): string;
  /** undefined when it cannot be decrypted (another machine/user, corrupt). */
  decrypt(cipher: string): string | undefined;
}

interface Envelope { v: 1; enc: boolean; data: string }

export class AnonStore {
  /** Set when the dictionary file exists but cannot be read (shown in Settings). */
  dictionaryError: string | null = null;

  constructor(private dir: string, private codec: StoreCodec) {}

  private read(file: string): string | null {
    let raw: string;
    try { raw = readFileSync(join(this.dir, file), 'utf8'); } catch { return null; }
    const env = JSON.parse(raw) as Envelope;
    if (!env || typeof env.data !== 'string') throw new Error('unreadable file');
    if (!env.enc) return env.data;
    if (!this.codec.available()) throw new Error('the OS key store is not available');
    const plain = this.codec.decrypt(env.data);
    if (plain === undefined) throw new Error('it was encrypted under another user or machine');
    return plain;
  }

  private write(file: string, plain: string): { encrypted: boolean } {
    mkdirSync(join(this.dir, ...file.split('/').slice(0, -1)), { recursive: true });
    const enc = this.codec.available();
    const env: Envelope = { v: 1, enc, data: enc ? this.codec.encrypt(plain) : plain };
    const target = join(this.dir, ...file.split('/'));
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    return { encrypted: enc };
  }

  readDictionary(): AnonDictionary {
    try {
      const plain = this.read('dictionary.json');
      this.dictionaryError = null;
      return plain === null ? { ...EMPTY_DICTIONARY } : cleanDictionary(JSON.parse(plain));
    } catch (e) {
      this.dictionaryError = e instanceof Error ? e.message : String(e);
      return { ...EMPTY_DICTIONARY };
    }
  }

  writeDictionary(d: AnonDictionary): { ok: boolean; encrypted?: boolean; error?: string } {
    try {
      const r = this.write('dictionary.json', JSON.stringify(cleanDictionary(d)));
      this.dictionaryError = null;
      return { ok: true, encrypted: r.encrypted };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }

  /** The map file of one office (by its folder; the name is a hash of it). */
  static officeKey(office: string): string {
    return createHash('sha256').update(office).digest('hex').slice(0, 24);
  }

  loadMap(office: string): PseudonymMap {
    try {
      const plain = this.read(`maps/${AnonStore.officeKey(office)}.json`);
      return plain === null ? new PseudonymMap() : PseudonymMap.fromJSON(plain);
    } catch (e) {
      // A map that cannot be read starts over: old sessions then show
      // codenames instead of names in their history (said in the log).
      console.warn('[anon] pseudonym map unreadable, starting a new one:', e instanceof Error ? e.message : e);
      return new PseudonymMap();
    }
  }

  saveMap(office: string, map: PseudonymMap): void {
    try { this.write(`maps/${AnonStore.officeKey(office)}.json`, JSON.stringify(map.toJSON())); }
    catch (e) { console.error('[anon] could not save the pseudonym map:', e instanceof Error ? e.message : e); }
  }

  hasMap(office: string): boolean {
    return existsSync(join(this.dir, 'maps', `${AnonStore.officeKey(office)}.json`));
  }
}
