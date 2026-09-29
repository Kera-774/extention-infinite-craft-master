/**
 * Side panel : commande du moteur et statistiques en direct.
 * Le moteur vit dans l'onglet du jeu ; on lui parle via le content script.
 */
'use strict';

const GAME_URL = /^https:\/\/neal\.fun\/infinite-craft\//;
const $ = (id) => document.getElementById(id);
let tabId = null;
let settings = null;
let lastRecentKey = '';

// --- Onglet cible ------------------------------------------------------------
async function findTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && GAME_URL.test(active.url || '')) return active.id;
  const tabs = await chrome.tabs.query({ url: 'https://neal.fun/infinite-craft/*' });
  return tabs.length ? tabs[0].id : null;
}

async function send(cmd, payload) {
  if (tabId == null) throw new Error('aucun onglet Infinite Craft');
  const res = await chrome.tabs.sendMessage(tabId, { type: 'icx-cmd', cmd, payload });
  if (!res) throw new Error('pas de réponse (rechargez l’onglet du jeu)');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

async function refreshTab() {
  const id = await findTab();
  const changed = id !== tabId;
  tabId = id;
  $('notab').hidden = tabId != null;
  $('main').style.opacity = tabId != null ? '1' : '.4';
  if (changed && tabId != null) loadState();
}

async function loadState() {
  try {
    const s = await send('getState');
    settings = s.settings;
    fillSettings(settings);
    render(s.snapshot);
  } catch (err) {
    showWarnings([{ text: 'Extension pas encore active dans cet onglet : rechargez la page du jeu. (' + err.message + ')', error: true }]);
  }
}

// --- Rendu -------------------------------------------------------------------
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('fr-FR') : n ?? '—');
const STATE_LABEL = { init: 'Chargement', idle: 'Arrêté', running: 'En cours', paused: 'En pause', error: 'Erreur' };
const MODE_LABEL = { explore: 'exploration', balanced: 'équilibré', exploit: 'exploitation' };

function render(s) {
  if (!s) return;
  const st = $('state');
  st.textContent = STATE_LABEL[s.state] || s.state;
  st.className = 'pill ' + s.state;
  $('btn-start').disabled = s.state === 'running' || s.state === 'init';
  $('btn-pause').disabled = s.state !== 'running';
  $('btn-stop').disabled = s.state === 'idle' || s.state === 'init';

  for (const b of document.querySelectorAll('#levels button')) b.classList.toggle('active', b.dataset.level === s.level);
  const L = s.levelInfo || {};
  let hint = `Concurrence ${L.minConc}–${L.maxConc}, délai ≥ ${L.delayMs} ms, ${s.workers} worker(s), file ${L.lookahead}, lots ${L.batch}.`;
  if (s.effectiveLevel && s.effectiveLevel !== s.level) hint += ' Forcé en ' + String(s.effectiveLevel).toUpperCase() + ' (batterie < 30 %).';
  if (s.throttleSteps) hint += ` Bridage thermique : −${s.throttleSteps}.`;
  hint += ` Matériel : ${s.hw.cores} threads, ${s.hw.memoryGb} Go.`;
  $('level-hint').textContent = hint;

  const bat = s.battery ? `${Math.round(s.battery.level * 100)} %${s.battery.charging ? ' ⚡' : ''}` : 'n/d';
  const rows = [
    ['Éléments possédés', fmt(s.owned)],
    ['Paires testées', fmt(s.pairsTested)],
    ['Échecs mémorisés', fmt(s.failsKnown)],
    ['Nouveaux (session)', fmt(s.sessionNew)],
    ['Premières découvertes', fmt(s.sessionFirst)],
    ['Requêtes (session)', fmt(s.sessionRequests)],
    ['Requêtes/s', s.rps.toFixed(2)],
    ['Concurrence', `${s.inflight}/${s.concurrency}`],
    ['Délai actuel', s.delayMs + ' ms'],
    ['Erreurs 429', fmt(s.s429)],
    ['Autres erreurs', fmt(s.errors)],
    ['Rendement récent', s.yieldPct.toFixed(1) + ' %'],
    ['Mode', MODE_LABEL[s.mode] || s.mode],
    ['File (lookahead)', fmt(s.queue)],
    ['Méthode', s.backend],
    ['Retard boucle', s.lagMs + ' ms'],
    ['Batterie', bat],
    ['Stockage', s.storage || '—']
  ];
  $('stats').replaceChildren(
    ...rows.map(([k, v]) => {
      const d = document.createElement('div');
      d.className = 'stat';
      const a = document.createElement('span');
      a.textContent = k;
      const b = document.createElement('span');
      b.textContent = v;
      d.append(a, b);
      return d;
    })
  );

  const rk = s.recent.map((r) => r.text).join('|');
  if (rk !== lastRecentKey) {
    lastRecentKey = rk;
    $('recent').replaceChildren(
      ...s.recent.map((r) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = `${r.emoji || ''} ${r.text}`;
        if (r.isNew) {
          name.className = 'first';
          name.title = 'Première découverte mondiale';
          name.textContent += ' ★';
        }
        const from = document.createElement('span');
        from.className = 'from';
        from.textContent = `  ← ${r.a} + ${r.b}`;
        li.append(name, from);
        return li;
      })
    );
  }
  $('logs').replaceChildren(
    ...s.logs.map((l) => {
      const li = document.createElement('li');
      li.textContent = l;
      return li;
    })
  );

  const w = [];
  if (s.cooling) w.push({ text: 'Pause de refroidissement en cours…' });
  if (s.needsReload) w.push({ text: 'Certains éléments n’ont pas pu être ajoutés à chaud : rechargez le jeu pour les voir.', action: 'reload' });
  if (s.materializeError) w.push({ text: 'Ajout à l’inventaire : ' + s.materializeError, error: true });
  if (s.workerError) w.push({ text: s.workerError });
  if (s.storeError) w.push({ text: 'Écriture du cache : ' + s.storeError, error: true });
  if (s.caps && !s.caps.IC && !s.caps.vue && s.state !== 'init') w.push({ text: 'API interne du jeu non détectée : repli sur les requêtes directes.' });
  showWarnings(w);
}

function showWarnings(list) {
  $('warnings').replaceChildren(
    ...list.map((w) => {
      const d = document.createElement('div');
      d.className = 'banner' + (w.error ? ' error' : '');
      d.textContent = w.text + ' ';
      if (w.action === 'reload') {
        const b = document.createElement('button');
        b.textContent = 'Recharger le jeu';
        b.onclick = () => send('reloadGame').catch(alert);
        d.append(b);
      }
      return d;
    })
  );
}

// --- Réglages ----------------------------------------------------------------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fillSettings(s) {
  const f = $('settings');
  for (const el of f.elements) {
    if (!el.name) continue;
    if (el.name.startsWith('delay.')) {
      const v = s.delayMs && s.delayMs[el.name.slice(6)];
      el.value = v ?? '';
    } else if (el.name === 'blacklist' || el.name === 'whitelist') {
      el.value = (s[el.name] || []).join('\n');
    } else if (el.type === 'checkbox') {
      el.checked = !!getPath(s, el.name);
    } else {
      const v = getPath(s, el.name);
      el.value = v ?? '';
    }
  }
}

function readSettings() {
  const f = $('settings');
  const out = { weights: {}, planner: {}, delayMs: {} };
  for (const el of f.elements) {
    if (!el.name) continue;
    const n = el.name;
    if (n.startsWith('delay.')) {
      if (el.value !== '') out.delayMs[n.slice(6)] = Number(el.value);
    } else if (n === 'blacklist' || n === 'whitelist') {
      out[n] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    } else if (el.type === 'checkbox') out[n] = el.checked;
    else if (n.includes('.')) {
      const [grp, key] = n.split('.');
      if (el.value !== '') out[grp][key] = el.type === 'number' ? Number(el.value) : el.value;
    } else if (el.value !== '') out[n] = el.type === 'number' ? Number(el.value) : el.value;
  }
  return out;
}

// --- Événements UI -----------------------------------------------------------
const act = (fn) => async () => {
  try {
    const r = await fn();
    if (r && r.state) render(r);
  } catch (err) {
    alert(err.message);
  }
};

$('btn-start').onclick = act(() => send('start'));
$('btn-pause').onclick = act(() => send('pause'));
$('btn-stop').onclick = act(() => send('stop'));
for (const b of document.querySelectorAll('#levels button')) b.onclick = act(() => send('setLevel', { level: b.dataset.level }));

$('settings').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const r = await send('setSettings', readSettings());
    settings = r.settings;
    fillSettings(settings);
  } catch (err) {
    alert(err.message);
  }
};

$('btn-export').onclick = act(async () => {
  const json = await send('exportCache');
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `infinite-craft-cache-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('file-import').onchange = act(async () => {
  const file = $('file-import').files[0];
  if (!file) return;
  const text = await file.text();
  const r = await send('importCache', text);
  $('file-import').value = '';
  alert(`Import terminé : ${r.addedPairs} paires, ${r.addedElements} éléments ajoutés.`);
});

$('btn-clear').onclick = act(async () => {
  if (!confirm('Effacer tout le cache (paires testées, statistiques) ? Exportez-le d’abord si besoin.')) return;
  await send('clearCache');
});

// Statistiques poussées par le moteur (throttlées à 1–2 Hz selon le niveau)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'icx-event' && msg.event === 'stats' && sender.tab && sender.tab.id === tabId) render(msg.payload);
});
chrome.tabs.onActivated.addListener(refreshTab);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete') refreshTab();
});
chrome.tabs.onRemoved.addListener((id) => id === tabId && refreshTab());

refreshTab();
