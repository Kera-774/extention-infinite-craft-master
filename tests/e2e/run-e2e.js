/**
 * Test de bout en bout : Chromium réel + extension chargée (non empaquetée)
 * + maquette du jeu servie à la place de https://neal.fun/infinite-craft/
 * (interception Playwright : aucune requête ne sort vers neal.fun).
 *
 * Le faux serveur /pair : recettes déterministes et commutatives, ~35 % de
 * "Nothing", 429 au-delà de 5 requêtes simultanées, latence 400–800 ms.
 *
 * Vérifie : chargement, démarrage depuis le side panel, découvertes ajoutées
 * à l'inventaire du jeu, aucune paire envoyée deux fois, changement de niveau
 * à chaud, AIMD face aux 429, arrêt, persistance + reprise après rechargement,
 * backend « fetch » + ajout à l'inventaire avec sauvegarde de secours.
 *
 * Usage : node tests/e2e/run-e2e.js   (Playwright requis, installé globalement ici)
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

// ---------------- faux serveur ----------------
const WORDS = 'Steam Lava Mud Dust Cloud Rain Plant Stone Sand Glass Smoke Ash Storm Wave Ocean Lake Island Volcano Mountain Tree Forest Life Human Tool Fire Brick House Village City Energy Lightning Metal Sword Dragon Bird Egg Time Clock Robot Car Rocket Planet Sun Moon Star Galaxy Universe Wizard Magic Potion Gold Coin King Castle Knight Ghost Zombie Vampire Snow Ice Iceberg Titanic Pirate Treasure Map Book Idea Philosophy Music Song Dance Party Cake Bread Flour Wheat Farm Cow Milk Cheese Pizza Internet Computer Phone Cat Dog Wolf Werewolf'.split(
  ' '
);
function h(s) {
  let x = 2166136261;
  for (const c of s) x = Math.imul(x ^ c.codePointAt(0), 16777619) >>> 0;
  return x;
}
const norm = (s) => s.trim().toLowerCase();
const server = { inflight: 0, maxInflight: 0, total: 0, r429: 0, perKey: new Map(), seen: new Set(['water', 'fire', 'wind', 'earth']) };
function recipe(a, b) {
  const [x, y] = [norm(a), norm(b)].sort();
  const v = h(x + '|' + y);
  if (v % 100 < 35) return { result: 'Nothing', emoji: '', isNew: false };
  let name = WORDS[v % WORDS.length];
  if (v % 97 === 0) name = 'Extremely Long Hyper Specific Thing ' + (v % 10);
  if (v % 11 === 0) name = name + ' ' + WORDS[(v >>> 8) % WORDS.length];
  const isNew = !server.seen.has(norm(name)) && v % 5 === 0;
  server.seen.add(norm(name));
  return { result: name, emoji: '✨', isNew };
}

async function handlePair(route) {
  const u = new URL(route.request().url());
  const a = u.searchParams.get('first');
  const b = u.searchParams.get('second');
  server.total++;
  if (server.inflight >= 5) {
    server.r429++;
    return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, body: 'Too Many Requests' });
  }
  server.inflight++;
  server.maxInflight = Math.max(server.maxInflight, server.inflight);
  const k = [norm(a), norm(b)].sort().join('|');
  server.perKey.set(k, (server.perKey.get(k) || 0) + 1);
  await new Promise((r) => setTimeout(r, 400 + (h(k) % 400)));
  server.inflight--;
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(recipe(a, b)) });
}

// ---------------- utilitaires ----------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✔ ' : '  ✘ ') + name + (detail !== undefined ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icx-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  await ctx.route('https://neal.fun/api/infinite-craft/pair**', handlePair);
  await ctx.route('https://neal.fun/infinite-craft/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: MOCK }));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('extension chargée (service worker actif)', !!extId, extId);

  const game = await ctx.newPage();
  const consoleErrors = [];
  game.on('pageerror', (e) => consoleErrors.push(String(e)));
  game.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await game.goto('https://neal.fun/infinite-craft/');
  await game.waitForFunction(() => window.ICX && window.ICX.engine && window.ICX.engine.state === 'idle', null, { timeout: 20000 });
  check('moteur initialisé dans la page', true);
  check('hook craftApi installé', await game.evaluate(() => window.ICX.engine.game.hooked));

  // side panel ouvert comme page d'extension
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#state').textContent === 'Arrêté', null, { timeout: 10000 });
  check('side panel connecté à l’onglet du jeu', true);

  const snap = () => game.evaluate(() => window.ICX.engine.snapshot());

  // --- NORMAL, backend auto (= game) ---
  await panel.click('#levels button[data-level="normal"]');
  await panel.click('#btn-start');
  await sleep(6000);
  let s = await snap();
  check('en cours d’exécution', s.state === 'running', s.state);
  check('backend auto = game (IC.craft)', s.backend === 'game', s.backend);
  check('NORMAL : concurrence plafonnée à 2', server.maxInflight <= 2, 'max serveur ' + server.maxInflight);
  check('des éléments ont été découverts', s.sessionNew > 3, s.sessionNew);
  const items1 = await game.evaluate(() => window.__mock.vue.items.length);
  check('découvertes ajoutées à l’inventaire du jeu par le jeu lui-même', items1 >= 4 + s.sessionNew, `${items1} éléments`);
  const panelOwned = await panel.evaluate(() => [...document.querySelectorAll('.stat')].find((d) => d.firstChild.textContent === 'Éléments possédés')?.lastChild.textContent);
  check('statistiques affichées dans le side panel', !!panelOwned, panelOwned);

  // --- MAX à chaud : AIMD face au plafond serveur (5) ---
  await panel.click('#levels button[data-level="max"]');
  await sleep(12000);
  s = await snap();
  check('changement de niveau à chaud sans perte d’état', s.level === 'max' && s.state === 'running' && s.pairsTested > 0, `${s.pairsTested} paires`);
  check('AIMD : 429 détectés via l’observateur réseau', s.s429 > 0, `${s.s429} (serveur : ${server.r429})`);
  check('AIMD : concurrence ramenée vers le plafond toléré', s.concurrency <= 8, 'limite actuelle ' + s.concurrency);
  check('workers de scoring actifs (≤ 2)', s.workers >= 1 && s.workers <= 2, s.workers + (s.workerError ? ' ' + s.workerError : ''));
  const dup = [...server.perKey.values()].filter((n) => n > 1).length;
  check('aucune paire envoyée deux fois avec succès', dup === 0, `${server.perKey.size} paires uniques, ${dup} doublons`);
  check('échecs "Nothing" mémorisés', s.failsKnown > 0, s.failsKnown);

  // --- Stop instantané ---
  await panel.click('#btn-stop');
  await sleep(500);
  s = await snap();
  const totalAtStop = server.total;
  await sleep(2000);
  check('Stop : état arrêté, plus aucune requête', s.state === 'idle' && server.total === totalAtStop, `${server.total - totalAtStop} requêtes après stop`);
  check('instances temporaires nettoyées après l’arrêt', (await game.evaluate(() => window.__mock.instances.length)) === 0);

  // --- Persistance + reprise après rechargement ---
  const pairsBefore = s.pairsTested;
  await panel.click('#btn-start');
  await sleep(1500);
  // une requête en vol au moment du rechargement est perdue (réponse jamais reçue) :
  // elle sera légitimement renvoyée, on l'exclut du contrôle de doublons
  await game.evaluate(() =>
    addEventListener('pagehide', () => localStorage.setItem('icx-test-lost', JSON.stringify([...window.ICX.engine.inflight.keys()])))
  );
  await game.reload();
  const lostOnReload = await game.evaluate(() => JSON.parse(localStorage.getItem('icx-test-lost') || '[]'));
  await game.waitForFunction(() => window.ICX && window.ICX.engine && window.ICX.engine.state !== 'init', null, { timeout: 20000 });
  s = await snap();
  check('cache rechargé après rechargement de l’onglet', s.pairsTested >= pairsBefore, `${s.pairsTested} ≥ ${pairsBefore}`);
  check('reprise automatique après rechargement', s.state === 'running', s.state);
  await sleep(4000);
  const dup2 = [...server.perKey.entries()].filter(([k, n]) => n > 1 && !lostOnReload.includes(k)).length;
  check('aucune paire retestée après rechargement', dup2 === 0, `${dup2} doublons (${lostOnReload.length} requête(s) perdue(s) pendant le rechargement)`);
  await panel.click('#btn-stop');
  await sleep(500);

  // --- Backend fetch + materializer (ajout à l'inventaire par l'extension) ---
  await game.evaluate(() => window.ICX.engine.setSettings({ backend: 'fetch' }));
  const before = await game.evaluate(() => window.__mock.vue.items.length);
  await game.evaluate(() => window.ICX.engine.start());
  await sleep(6000);
  await game.evaluate(() => window.ICX.engine.stop());
  s = await snap();
  check('backend fetch utilisé', s.backend === 'fetch', s.backend);
  const after = await game.evaluate(() => window.__mock.vue.items.length);
  check('fetch : nouveaux éléments ajoutés à l’état du jeu', after > before, `${before} → ${after}`);
  const idb = await game.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('infinite-craft');
        r.onsuccess = () => {
          const q = r.result.transaction('items').objectStore('items').getAll();
          q.onsuccess = () => res(q.result.length);
        };
      })
  );
  check('fetch : éléments écrits dans la sauvegarde IndexedDB du jeu', idb === after, `${idb} en base / ${after} en mémoire`);
  const backups = await game.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('icx-cache');
        r.onsuccess = () => {
          const q = r.result.transaction('backups').objectStore('backups').getAll();
          q.onsuccess = () => res(q.result.map((b) => b.data.items.length));
        };
      })
  );
  check('sauvegarde de secours créée avant écriture', backups.length >= 1, JSON.stringify(backups));
  const ids = await game.evaluate(() => window.__mock.vue.items.map((x) => x.id));
  check('identifiants d’éléments uniques', new Set(ids).size === ids.length);

  // --- Export / import ---
  const json = await game.evaluate(() => window.ICX.engine.exportCache());
  const parsed = JSON.parse(json);
  check('export JSON complet', parsed.format === 'icx-cache' && parsed.pairs.length === s.pairsTested, parsed.pairs.length + ' paires');
  const imp = await game.evaluate((j) => window.ICX.engine.importCache(j), json);
  check('import idempotent (rien de dupliqué)', imp.addedPairs === 0, JSON.stringify(imp));

  const relevantErrors = consoleErrors.filter((e) => !/429|Too Many/.test(e));
  check('aucune erreur JS dans la page', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));

  // --- Garde-fous : batterie < 30 % (simulée) et retard de boucle soutenu ---
  const g2 = await ctx.newPage();
  await g2.addInitScript(() => {
    const fake = { level: 0.2, charging: false, addEventListener() {} };
    Object.defineProperty(navigator, 'getBattery', { value: () => Promise.resolve(fake) });
  });
  await g2.goto('https://neal.fun/infinite-craft/?guards');
  await g2.bringToFront();
  await g2.waitForFunction(() => window.ICX && window.ICX.engine && window.ICX.engine.state !== 'init', null, { timeout: 20000 });
  await g2.evaluate(() => window.ICX.engine.stop());
  await g2.evaluate(() => window.ICX.engine.setLevel('max'));
  let s2 = await g2.evaluate(() => window.ICX.engine.snapshot());
  check('batterie < 30 % : MAX ramené en NORMAL', s2.level === 'max' && s2.effectiveLevel === 'normal', s2.effectiveLevel);
  await g2.evaluate(() => window.ICX.engine.setSettings({ backend: 'auto' }));
  // blocage du thread principal 260 ms toutes les 290 ms pendant ~11 s (période ≠ 250 ms du moniteur)
  await g2.evaluate(
    () =>
      new Promise((res) => {
        const end = Date.now() + 11000;
        const id = setInterval(() => {
          const t = performance.now();
          while (performance.now() - t < 260);
          if (Date.now() > end) (clearInterval(id), res());
        }, 290);
      })
  );
  s2 = await g2.evaluate(() => window.ICX.engine.snapshot());
  check('retard de boucle > 100 ms soutenu : concurrence réduite d’un cran', s2.throttleSteps >= 1, `lag ${s2.lagMs} ms, crans ${s2.throttleSteps}`);
  await g2.close();

  await ctx.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications OK`);
  console.log(`Serveur simulé : ${server.total} requêtes, ${server.r429} × 429, ${server.perKey.size} paires uniques`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
