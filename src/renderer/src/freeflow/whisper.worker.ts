/// <reference lib="webworker" />
/**
 * Local Whisper, off the UI thread: transformers.js runs the model here, WASM
 * (or WebGPU when the machine has it). Model files never come from the
 * network on their own: the cache below asks the page, which reads them from
 * disk through main (main/whisperCache.ts). Only a 'load' with download:true
 * may fetch from Hugging Face, and that is the Settings → Voice button.
 */
import { env, pipeline } from '@huggingface/transformers';

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

/** Whisper small: fp32 encoder + q4 decoder, the pair that runs well on
 *  WebGPU (measured: 1.2 s for a 4 s clip; the q8 pair took 11 s on WASM and
 *  80 s on WebGPU). Without WebGPU the same files run on WASM, slower. */
const MODELS = {
  small: { id: 'onnx-community/whisper-small', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
} as const;
type ModelId = keyof typeof MODELS;

// ONNX Runtime's WASM ships with the app (electron.vite.config.ts: ort/), never a CDN.
// Packaged: this worker is out/renderer/assets/*.js and the files are in
// out/renderer/ort/. Dev: the Vite server serves them at /ort/.
const ortDir = self.location.protocol === 'file:' ? new URL('../ort/', self.location.href) : new URL('/ort/', self.location.origin);
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.asyncify.mjs', ortDir).href,
    wasm: new URL('ort-wasm-simd-threaded.asyncify.wasm', ortDir).href
  };
}
env.useWasmCache = false;
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useFSCache = false;

// The cache: every model file goes through the page to main and back.
let seq = 0;
const waiting = new Map<number, (v: unknown) => void>();
function ask<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res) => { waiting.set(id, res as (v: unknown) => void); (self as unknown as Worker).postMessage({ ...msg, id }, transfer); });
}
env.useCustomCache = true;
env.customCache = {
  async match(key: string) {
    const bytes = await ask<Uint8Array | null>({ type: 'cache-match', key });
    return bytes ? new Response(bytes as unknown as BodyInit) : undefined;
  },
  async put(key: string, response: Response) {
    const buf = new Uint8Array(await response.arrayBuffer());
    await ask<boolean>({ type: 'cache-put', key, bytes: buf }, [buf.buffer]);
  }
};

const loaded = new Map<ModelId, Promise<Asr>>();
/** WebGPU loaded the model but failed while transcribing (seen live: ONNX
 *  Runtime's WebGPU backend threw "Cannot read properties of undefined (reading
 *  'destroy')"). From then on this worker runs on WASM. */
let gpuFailed = false;

async function load(model: ModelId, download: boolean): Promise<Asr> {
  env.allowRemoteModels = download;
  // transformers.js 4 refuses to load anything when local AND remote models
  // are both off ("Invalid configuration detected"), before it even looks in
  // the cache. Offline, "local" is switched on only to pass that check: the
  // cache (the app's, above) is read first, and the local path points nowhere,
  // so a missing file is still an error, never a download.
  env.allowLocalModels = !download;
  env.localModelPath = '/__no_local_models__/';
  const m = MODELS[model];
  const device = 'gpu' in navigator && !gpuFailed ? 'webgpu' : 'wasm';
  const make = (dev: string) => pipeline('automatic-speech-recognition', m.id, {
    dtype: m.dtype,
    device: dev,
    progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.total) (self as unknown as Worker).postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    }
  } as Record<string, unknown>) as unknown as Promise<Asr>;
  try {
    return await make(device);
  } catch (e) {
    if (device !== 'wasm') return make('wasm');
    throw e;
  }
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data as { type: string; id?: number; model?: ModelId; audio?: Float32Array; language?: string; download?: boolean; value?: unknown };
  if (m.type === 'reply' && m.id !== undefined) { waiting.get(m.id)?.(m.value); waiting.delete(m.id); return; }
  const post = (msg: Record<string, unknown>) => (self as unknown as Worker).postMessage(msg);
  try {
    if (m.type === 'load' && m.model) {
      if (m.download) loaded.delete(m.model);
      const p = loaded.get(m.model) ?? load(m.model, m.download === true);
      loaded.set(m.model, p);
      await p.catch((e) => { loaded.delete(m.model!); throw e; });
      post({ type: 'loaded', ref: m.id });
      return;
    }
    if (m.type === 'transcribe' && m.model && m.audio) {
      let p = loaded.get(m.model);
      if (!p) { p = load(m.model, false); loaded.set(m.model, p); }
      const asr = await p.catch((e) => { loaded.delete(m.model!); throw e; });
      const opts = { language: m.language || undefined, task: 'transcribe', chunk_length_s: 30 };
      let out: Awaited<ReturnType<Asr>>;
      try {
        out = await asr(m.audio, opts);
      } catch (e) {
        // WebGPU failed mid-run: load the same model on WASM and try once more.
        if (gpuFailed || !('gpu' in navigator)) throw e;
        gpuFailed = true;
        const wasm = load(m.model, false);
        loaded.set(m.model, wasm);
        out = await (await wasm.catch((err) => { loaded.delete(m.model!); throw err; }))(m.audio, opts);
      }
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
      post({ type: 'text', ref: m.id, text });
    }
  } catch (e) {
    post({ type: 'error', ref: m.id, error: e instanceof Error ? e.message : String(e) });
  }
};
