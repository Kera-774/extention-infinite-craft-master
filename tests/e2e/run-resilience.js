/**
 * Test de résilience : reproduit les pannes observées sur le vrai site.
 *  1. IC.craft « fire-and-forget » (rend la main avant la fin de la fusion) ;
 *  2. 429 avec Retry-After énorme (3600 s) ;
 *  3. phase de 403 (Cloudflare) sur toutes les méthodes, puis retour à la normale ;
 *  4. méthode « dom » enregistrée dans les réglages.
 * Dans tous les cas, le moteur doit reprendre SEUL, sans action de l'utilisateur.
 *
 * Usage : node tests/e2e/run-resilience.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright')));
}
const EXT = path.resolve(__dirname, '../..');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-game.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (detail !== undefined ? ' — ' + detail : ''));
}

const server = { mode: 'ok', ok: 0, n: 0, inflight: 0 };
async function handlePair(route) {
  const u = new URL(route.request().url());
  server.n++;
  if (server.mode === '403') return route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Just a moment...</html>' });
  if (server.mode === '429-long') {
    server.mode = 'ok';
    return route.fulfill({ status: 429, headers: { 'retry-after': '3600' }, body: 'Too Many Requests' });
  }
  if (server.inflight >= 6) return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, body: 'x' });
  server.inflight++;
  await sleep(150 + Math.random() * 200);
  server.inflight--;
  server.ok++;
  const k = [u.searchParams.get('first'), u.searchParams.get('second')].map((x) => x.toLowerCase()).sort().join('+');
  const h = [...k].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const body = h % 3 === 0 ? { result: 'Nothing', emoji: '', isNew: false } : { result: 'R' + (h % 5000), emoji: '✨', isNew: h % 11 === 0 };
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main() {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'icx-res-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  await ctx.route('https://neal.fun/api/infinite-craft/pair**', handlePair);
  await ctx.route('https://neal.fun/infinite-craft/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: MOCK }));
  const game = await ctx.newPage();
  await game.goto('https://neal.fun/infinite-craft/?fireforget');
  await game.waitForFunction(() => window.ICX && window.ICX.engine && window.ICX.engine.state === 'idle', null, { timeout: 20000 });
  const snap = () => game.evaluate(() => window.ICX.engine.snapshot());
  const rate = async (ms) => {
    const t0 = server.ok;
    await sleep(ms);
    return server.ok - t0;
  };

  // 1. IC.craft fire-and-forget
  await game.evaluate(() => {
    window.ICX.engine.setLevel('turbo');
    window.ICX.engine.start();
  });
  const r1 = await rate(6000);
  let s = await snap();
  check('IC.craft « fire-and-forget » : la méthode game fonctionne', s.backend === 'game' && r1 >= 10, `${r1} réponses en 6 s, méthode ${s.backend}, erreurs ${s.errors}`);
  check('fire-and-forget : découvertes enregistrées', s.sessionNew > 0, s.sessionNew);
  const diag = await game.evaluate(() => window.ICX.engine.diagnose());
  check('Diagnostic : méthode game détectée comme fonctionnelle', diag.recommendation === 'game', JSON.stringify(diag.results.map((r) => [r.backend, r.ok])));
  await game.evaluate(() => window.ICX.engine.start());

  // 2. 429 avec Retry-After de 3600 s
  server.mode = '429-long';
  await sleep(1500);
  s = await snap();
  check('Retry-After 3600 s plafonné (pause ≤ 60 s)', s.serverPauseS <= 60, s.serverPauseS + ' s');
  const tPause = Date.now();
  let r2 = 0;
  while (Date.now() - tPause < 70000 && r2 < 5) r2 += await rate(2500);
  check('reprise seule après la pause serveur', r2 >= 5, `${r2} réponses, ${Math.round((Date.now() - tPause) / 1000)} s après le 429`);

  // 3. Cloudflare 403 sur tout pendant 12 s, puis retour à la normale
  server.mode = '403';
  await sleep(12000);
  s = await snap();
  check('403 partout : le moteur n’est ni arrêté ni en pause', s.state === 'running', s.state);
  check('403 partout : pas de bascule automatique vers « dom »', s.backend !== 'dom', s.backend);
  check('403 : erreurs visibles dans le panneau', s.lastErrors.length > 0 && s.lastErrors[0].kind === 'forbidden', s.lastErrors[0] && s.lastErrors[0].message);
  server.mode = 'ok';
  const t403 = Date.now();
  let back = 0;
  while (Date.now() - t403 < 75000 && back < 5) back += await rate(2500);
  check('retour à la normale : reprise automatique sans action', back >= 5, `${back} réponses, ${Math.round((Date.now() - t403) / 1000)} s après la fin des 403`);

  // 4. « dom » enregistré dans les réglages + rechargement
  await game.evaluate(() => window.ICX.engine.setSettings({ backend: 'dom' }));
  await game.evaluate(() => window.ICX.engine.stop());
  await game.evaluate(() => window.ICX.engine.start());
  const r4 = await rate(8000);
  s = await snap();
  check('méthode « dom » choisie mais en échec : repli sur une méthode qui marche', r4 >= 5 && s.backend !== 'dom', `${r4} réponses, méthode ${s.backend}`);
  await game.evaluate(() => window.ICX.engine.resetSettings());
  s = await snap();
  check('Réglages par défaut : méthode remise en auto', s.settingsBackend === 'auto', s.settingsBackend);

  // 5. anti-blocage : réservations et génération figées artificiellement
  await game.evaluate(() => {
    const E = window.ICX.engine;
    E._clearQueue();
    E.refilling = new Promise(() => {}); // génération qui ne répond jamais
    E.refillStartedAt = Date.now() - 60000;
    E.lastActivity = Date.now() - 60000;
  });
  const r5 = await rate(20000);
  check('anti-blocage : boucle relancée après une génération figée', r5 >= 5, r5 + ' réponses');

  await game.evaluate(() => window.ICX.engine.stop());
  await sleep(1500);
  check('aucune instance oubliée sur le canevas', (await game.evaluate(() => window.__mock.instances.length)) === 0);
  await ctx.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications OK`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
