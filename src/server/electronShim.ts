/**
 * The slice of Electron's main-process API that src/main uses, implemented on
 * plain Node — so the same main code runs as a server with no Chromium at all.
 *
 * The server build (tools/build-server.cjs) aliases `electron` to this module.
 * The desktop build never sees it.
 *
 *   app            data dir (MD_DATA_DIR), lifecycle events, quit/exit, a
 *                  pid-file single-instance lock
 *   ipcMain        an in-process handler registry; the engine (src/server/
 *                  engine.ts) calls it through `rendererBridge`
 *   BrowserWindow  a window that never draws: its webContents.send() feeds the
 *                  engine instead of a renderer
 *   safeStorage    AES-256-GCM under a key that lives only in the server process
 *                  (see secretKey.ts) — fail closed when there is none
 *   the rest       dialogs, shell, clipboard, menus, power, screen: inert
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadSecretKey } from './secretKey';
import { open, seal } from './secretBox';

declare const __APP_VERSION__: string;

// ─── app ─────────────────────────────────────────────────────────────────────

const dataDir = resolve(process.env.MD_DATA_DIR || join(homedir(), '.scranton-branch-server'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const appRoot = resolve(__dirname, '..');

class App extends EventEmitter {
  readonly isPackaged = true;
  readonly commandLine = { appendSwitch: (): void => {}, hasSwitch: (): boolean => false, getSwitchValue: (): string => '' };
  readonly dock = undefined;
  private ready = false;
  private quitting = false;
  private lockPath = join(dataDir, 'server.pid');

  constructor() {
    super();
    // Nothing to wait for: ready on the next turn, after the main module has
    // registered its whenReady handlers.
    setImmediate(() => { this.ready = true; this.emit('ready'); });
  }

  getPath(name: string): string {
    switch (name) {
      case 'home': return homedir();
      case 'logs': return join(dataDir, 'logs');
      case 'temp': return process.env.TMPDIR || '/tmp';
      default: return dataDir; // userData, appData, sessionData…
    }
  }
  getAppPath(): string { return appRoot; }
  getVersion(): string { return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'; }
  getName(): string { return 'Scranton Branch Server'; }
  getLocale(): string { return process.env.LANG?.split('.')[0]?.replace('_', '-') || 'en-US'; }
  isReady(): boolean { return this.ready; }
  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.once('ready', () => r()));
  }
  disableHardwareAcceleration(): void {}
  setAsDefaultProtocolClient(): boolean { return false; }
  setLoginItemSettings(): void {}
  getLoginItemSettings(): { openAtLogin: boolean } { return { openAtLogin: false }; }
  relaunch(): void { /* a supervisor (systemd, docker) restarts us */ }
  focus(): void {}

  /** One server per data dir: a pid file, taken over when its owner is dead. */
  requestSingleInstanceLock(): boolean {
    try {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); return false; } catch { /* stale */ }
      }
    } catch { /* no lock yet */ }
    writeFileSync(this.lockPath, String(process.pid));
    process.once('exit', () => { try { unlinkSync(this.lockPath); } catch { /* gone */ } });
    return true;
  }

  quit(): void {
    if (this.quitting) return;
    const ev = preventable();
    this.emit('before-quit', ev);
    if (ev.defaultPrevented) return;
    this.quitting = true;
    const will = preventable();
    this.emit('will-quit', will);
    if (!will.defaultPrevented) this.exit(0);
  }
  exit(code = 0): void {
    this.emit('quit', preventable(), code);
    process.exit(code);
  }
}

function preventable(): { defaultPrevented: boolean; preventDefault: () => void } {
  const ev = { defaultPrevented: false, preventDefault: () => { ev.defaultPrevented = true; } };
  return ev;
}

export const app = new App();

// ─── IPC ─────────────────────────────────────────────────────────────────────

type Handler = (event: IpcEvent, ...args: unknown[]) => unknown;
type Listener = (event: IpcEvent, ...args: unknown[]) => void;
interface IpcEvent { sender: FakeWebContents; returnValue?: unknown; senderFrame?: null }

const handlers = new Map<string, Handler>();
const listeners = new EventEmitter();
listeners.setMaxListeners(0);

interface IpcMainShim {
  handle(channel: string, fn: Handler): void;
  handleOnce(channel: string, fn: Handler): void;
  removeHandler(channel: string): void;
  on(channel: string, fn: Listener): IpcMainShim;
  once(channel: string, fn: Listener): IpcMainShim;
  removeListener(channel: string, fn: Listener): IpcMainShim;
  removeAllListeners(channel?: string): IpcMainShim;
}

export const ipcMain: IpcMainShim = {
  handle(channel: string, fn: Handler): void {
    if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    handlers.set(channel, fn);
  },
  handleOnce(channel: string, fn: Handler): void {
    handlers.set(channel, (e, ...a) => { handlers.delete(channel); return fn(e, ...a); });
  },
  removeHandler(channel: string): void { handlers.delete(channel); },
  on(channel: string, fn: Listener): typeof ipcMain { listeners.on(channel, fn); return ipcMain; },
  once(channel: string, fn: Listener): typeof ipcMain { listeners.once(channel, fn); return ipcMain; },
  removeListener(channel: string, fn: Listener): typeof ipcMain { listeners.removeListener(channel, fn); return ipcMain; },
  removeAllListeners(channel?: string): typeof ipcMain { listeners.removeAllListeners(channel); return ipcMain; }
};

/** The renderer's side of IPC, bound to one window's webContents. What the
 *  preload's `ipcRenderer` becomes on the server. */
export function rendererBridge(wc: FakeWebContents) {
  const wrapped = new Map<Function, (...a: unknown[]) => void>();
  return {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler registered for '${channel}'`);
      // Structured-clone semantics, as over real IPC: neither side may keep a
      // live reference to the other's objects.
      return clone(await fn({ sender: wc }, ...clone(args)));
    },
    send(channel: string, ...args: unknown[]): void {
      listeners.emit(channel, { sender: wc }, ...clone(args));
    },
    sendSync(channel: string, ...args: unknown[]): unknown {
      const ev: IpcEvent = { sender: wc };
      listeners.emit(channel, ev, ...clone(args));
      return clone(ev.returnValue);
    },
    on(channel: string, fn: (...a: unknown[]) => void) {
      const w = (...a: unknown[]): void => fn({ sender: wc }, ...clone(a));
      wrapped.set(fn, w);
      wc.bus.on(channel, w);
      return this;
    },
    removeListener(channel: string, fn: (...a: unknown[]) => void) {
      const w = wrapped.get(fn);
      if (w) { wc.bus.removeListener(channel, w); wrapped.delete(fn); }
      return this;
    }
  };
}

function clone<T>(v: T): T {
  return v === undefined ? v : structuredClone(v);
}

// ─── windows ─────────────────────────────────────────────────────────────────

let nextId = 1;

export class FakeWebContents extends EventEmitter {
  readonly id = nextId++;
  /** Messages from main to "the renderer" — the engine listens here. */
  readonly bus = new EventEmitter();
  readonly session = { setPermissionRequestHandler: (): void => {}, setPermissionCheckHandler: (): void => {}, protocol };
  private destroyed = false;
  constructor() { super(); this.bus.setMaxListeners(0); }
  send(channel: string, ...args: unknown[]): void {
    if (!this.destroyed) this.bus.emit(channel, ...args);
  }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.emit('destroyed'); }
  setWindowOpenHandler(): void {}
  isLoading(): boolean { return false; }
  getURL(): string { return 'server://floor'; }
  openDevTools(): void {}
  reload(): void {}
}

/** Called when main "loads the renderer" into a window: the server starts its
 *  engine there (src/server/main.ts registers it). */
let onLoad: ((wc: FakeWebContents) => void) | null = null;
export function onWindowLoad(fn: (wc: FakeWebContents) => void): void { onLoad = fn; }

const windows = new Set<BrowserWindow>();

export class BrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  readonly id = this.webContents.id;
  private destroyed = false;
  private bounds = { x: 0, y: 0, width: 1280, height: 800 };
  constructor(_opts?: unknown) { super(); windows.add(this); }
  static getAllWindows(): BrowserWindow[] { return [...windows]; }
  static fromWebContents(wc: unknown): BrowserWindow | null {
    return [...windows].find((w) => w.webContents === wc) ?? null;
  }
  static getFocusedWindow(): BrowserWindow | null { return [...windows][0] ?? null; }
  loadURL(): Promise<void> { return this.load(); }
  loadFile(): Promise<void> { return this.load(); }
  private load(): Promise<void> {
    setImmediate(() => {
      onLoad?.(this.webContents);
      this.emit('ready-to-show');
    });
    return Promise.resolve();
  }
  show(): void {} hide(): void {} focus(): void {} blur(): void {} restore(): void {}
  minimize(): void {} maximize(): void {} setTitle(): void {} flashFrame(): void {}
  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return false; }
  isMaximized(): boolean { return false; }
  isVisible(): boolean { return false; }
  isFocused(): boolean { return false; }
  getBounds(): typeof this.bounds { return { ...this.bounds }; }
  setBounds(): void {}
  close(): void {
    const ev = preventable();
    this.emit('close', ev);
    if (!ev.defaultPrevented) this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    windows.delete(this);
    this.webContents.destroy();
    this.emit('closed');
    if (windows.size === 0) app.emit('window-all-closed');
  }
}

// ─── secrets ─────────────────────────────────────────────────────────────────

const secretKey = loadSecretKey(dataDir);

export const safeStorage = {
  isEncryptionAvailable(): boolean { return secretKey !== null; },
  encryptString(plain: string): Buffer {
    if (!secretKey) throw new Error('no secret key (set MD_SECRET_KEY_FILE)');
    return seal(secretKey, plain);
  },
  decryptString(buf: Buffer): string {
    if (!secretKey) throw new Error('no secret key (set MD_SECRET_KEY_FILE)');
    return open(secretKey, buf);
  },
  getSelectedStorageBackend(): string { return 'md_server_key'; }
};

// ─── inert desktop surfaces ──────────────────────────────────────────────────

export class Notification extends EventEmitter {
  constructor(private opts: { title?: string; body?: string } = {}) { super(); }
  static isSupported(): boolean { return true; }
  /** No desktop to pop up on: the log is where a server's operator looks. */
  show(): void { console.log(`[notify] ${this.opts.title ?? ''}${this.opts.body ? ` — ${this.opts.body}` : ''}`); }
  close(): void {}
}

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: (): number => 0,
  showErrorBox: (title: string, content: string): void => { console.error(`[error] ${title}: ${content}`); }
};

export const shell = {
  openExternal: async (url: string): Promise<void> => { console.log(`[shell] (server) would open ${url}`); },
  openPath: async (): Promise<string> => 'not available on a server',
  showItemInFolder: (): void => {},
  trashItem: async (): Promise<void> => { throw new Error('not available on a server'); }
};

let clip = '';
// Promise-based like Electron 44's clipboard; a server has no image to paste.
export const clipboard = {
  readText: async (): Promise<string> => clip,
  writeText: async (t: string): Promise<void> => { clip = String(t); },
  read: async (): Promise<Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>> => []
};

export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) };

export const Menu = {
  buildFromTemplate: () => ({ popup: (): void => {} }),
  setApplicationMenu: (): void => {},
  getApplicationMenu: (): null => null
};

export const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleTime: (): number => 0,
  isOnBatteryPower: (): boolean => false
});

let blockerId = 0;
const blockers = new Set<number>();
export const powerSaveBlocker = {
  start: (): number => { blockers.add(++blockerId); return blockerId; },
  stop: (id: number): void => { blockers.delete(id); },
  isStarted: (id: number): boolean => blockers.has(id)
};

export const screen = {
  getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
};

// The preload's side. contextBridge publishes onto the engine's fake window.
export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (globalThis as unknown as { window: Record<string, unknown> }).window[key] = api;
  }
};
export const webUtils = { getPathForFile: (): string => '' };
/** No Chromium here, so no web pages: the deliverables' md-dlv:// scheme is
 *  registered and handled by nobody (the server has no HTML preview). */
export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(): void {}
};
/** No Chromium here: the office browser (main/browser.ts) says so instead of crashing. */
export const session = {
  fromPartition(): never { throw new Error('The office browser needs the desktop app: the server edition has no Chromium.'); }
};

/** Bound per window by the engine before the preload module is evaluated. */
export let ipcRenderer: ReturnType<typeof rendererBridge> = null as never;
export function bindIpcRenderer(wc: FakeWebContents): void { ipcRenderer = rendererBridge(wc); }

export default {
  app, ipcMain, BrowserWindow, safeStorage, Notification, dialog, shell, clipboard, nativeImage,
  Menu, powerMonitor, powerSaveBlocker, screen, contextBridge, webUtils, session, protocol, get ipcRenderer() { return ipcRenderer; }
};

// A first boot writes nothing here; keeps the data dir obviously ours.
if (!existsSync(join(dataDir, 'README'))) {
  try { writeFileSync(join(dataDir, 'README'), 'Scranton Branch server data (config, encrypted secrets, logs). Back it up with the office.\n'); } catch { /* read-only */ }
}
