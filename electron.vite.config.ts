import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { readFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';

// Single source of truth for the displayed app version: package.json.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };

// Product analytics (src/main/analytics.ts): this fork ships none. The key is
// pinned empty rather than read from the environment, so no build — local, CI,
// or one with a stray POSTHOG_KEY secret — can turn it on, and the analytics
// module stays dark (no client, no install id). See src/shared/fork.ts.
const defineMain = {
  ...define,
  __POSTHOG_KEY__: JSON.stringify(''),
  __POSTHOG_HOST__: JSON.stringify('')
};

// Copy raw .cjs main-process sidecars into out/main after the main bundle is
// written. electron-vite/rollup neither bundles nor copies require()'d .cjs
// sidecars, so without this the boot-time `require('./slack-trigger.cjs')` is
// missing from out/main — which crashed the packaged app (#66) AND `npm run
// dev` (#67). A writeBundle hook runs after the main build in BOTH dev and
// build, so the sidecar is emitted from a single place for every path.
/** ONNX Runtime's WASM files for local Whisper (renderer/src/freeflow), served
 *  as `ort/<file>` next to the page. onnxruntime-web does not export them, so
 *  they cannot be imported; transformers.js would otherwise fetch them from a
 *  CDN, and dictation must work offline. */
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
function ortWasmFiles() {
  const dir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
  return {
    name: 'ort-wasm-files',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const f = ORT_FILES.find((x) => req.url === `/ort/${x}`);
        if (!f) { next(); return; }
        res.setHeader('Content-Type', f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(resolve(dir, f)));
      });
    },
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: Buffer }) => void }) {
      for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(resolve(dir, f)) });
    }
  };
}

function copyMainSidecars() {
  const ASSETS: Array<[string, string]> = [
    ['src/main/slack-trigger.cjs', 'out/main/slack-trigger.cjs'],
    // Knowledge Graph core: required by knowledge.ts at runtime (pure-JS, no
    // native deps), so it must be emitted next to the main bundle like the
    // Slack sidecar above.
    ['src/main/kg-core.cjs', 'out/main/kg-core.cjs']
  ];
  return {
    name: 'copy-main-cjs-sidecars',
    writeBundle() {
      for (const [fromRel, toRel] of ASSETS) {
        const from = resolve(__dirname, fromRel);
        const to = resolve(__dirname, toRel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        const copied = statSync(to);
        if (!copied.isFile() || copied.size === 0) {
          throw new Error(`Failed to copy main-process sidecar: ${fromRel} -> ${toRel}`);
        }
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [copyMainSidecars()],
    define: defineMain,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    define,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      // electron-vite leaves the renderer unminified: the entry was 12.8 MB of
      // JS parsed on every launch. Minified, it loads faster and weighs less in
      // memory. (Main stays readable: the freeze log names functions.)
      minify: 'esbuild',
      target: 'chrome152',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react(), ortWasmFiles()],
    worker: { format: 'es' },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@brand': resolve(__dirname, 'docs'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
});
