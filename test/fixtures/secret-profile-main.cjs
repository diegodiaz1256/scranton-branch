'use strict';
/**
 * Electron main for test/secret-survives-upgrade.electron.test.cjs: one run of
 * the app's profile + secret code with the real safeStorage.
 *
 *   --user-data=<dir>    the profile (what app.getPath('userData') is at launch)
 *   --store=<ref>=<val>  store an integration secret, then quit
 *   --seed-floor=<id>    after storing, seed that floor from this profile (New Floor)
 *   --read=<ref>         read it back (getSecret, hasSecret), then quit
 *   --md-floor=<id>      run as that floor, the way the app starts one
 *   --out=<file>         where the result goes, as JSON
 *
 * The modules are loaded the way index.ts orders them: floorProfile first (it
 * may redirect userData and share the main key), before anything reads a secret.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = arg('out');
const done = (result) => { fs.writeFileSync(out, JSON.stringify(result)); process.argv.includes('--hard-exit') ? app.exit(0) : app.quit(); };

app.setPath('userData', arg('user-data'));
const loadTs = require(path.join(__dirname, '..', 'load-ts.cjs'));
const floor = loadTs('src/main/floorProfile.ts');
const integrations = loadTs('src/main/integrations.ts');

app.whenReady().then(() => {
  try {
    const store = arg('store');
    if (store) {
      const [ref, value] = store.split('=');
      const r = integrations.setSecret(ref, value);
      const seeded = arg('seed-floor') ? floor.seedFloor(arg('seed-floor')) : null;
      return done({ stored: r.ok, error: r.error, seeded, userData: app.getPath('userData') });
    }
    const ref = arg('read');
    done({
      value: integrations.getSecret(ref) ?? null,
      has: integrations.hasSecret(ref),
      floor: floor.FLOOR_ID,
      userData: app.getPath('userData')
    });
  } catch (e) {
    done({ error: e instanceof Error ? e.stack : String(e) });
  }
});
