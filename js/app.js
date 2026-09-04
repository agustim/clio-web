"use strict";

// Dades: manifest amb fonts (usuaris) + shards per font/mes/part
// (data/u/{font}/{YYYY-MM}-p{N}.json) carregats progressivament segons les
// fonts seguides. Sota file:// (fetch bloquejat) s'injecta data/links.js com a
// fallback amb tot l'índex lleuger (sense seguits ni càrrega per mesos).
const DATAV = '1788538585';
let ALL = [];            // links visibles fusionats (ordre cronològic invers)
let MANIFEST = null;     // { total, users: [{name,dir,role,total,emb,months}], categories }
let MONTHS = [];         // línia temporal fusionada de les fonts seguides: [{key,count}] desc
let SHOWN = 0;           // nombre de mesos visibles
let STATIC_MODE = false; // fallback links.js: tot carregat, sense fonts ni historial
const PART_CACHE = new Map();  // "dir|mes" -> array de links (parts fusionats)
const EXTRA = [];              // links afegits en calent via API (encara sense shard)
const EMB = new Map();         // id -> {e, s} (embedding quantitzat)
const EMB_LOADED = new Set();  // "dir|mes" amb embeddings ja carregats
let activeTag = null;   // filtre per tag (#tag:xxx)
let activeUser = null;  // filtre per reporter (#at:xxx)
let activeId = null;    // permalink: mostra només una card (#id:xxx)
let onlyNew = false;    // mostra només novetats (links no vistos)
let filtersOpen = false; // llistat de tags general plegat per defecte

// ---- Cerca: amagada per defecte, l'estat es recorda a cookie ----
function readSearchOpen() { return /(?:^|;\s*)clio_search=1/.test(document.cookie); }
function writeSearchOpen(v) { document.cookie = 'clio_search=' + (v ? 1 : 0) + '; path=/; max-age=31536000; SameSite=Lax'; }
let searchOpen = readSearchOpen();

const $ = (id) => document.getElementById(id);

// ---- Novetats: marca de temps de l'última visita (cookie) ----
// Es captura a l'arrencada (abans de rerenderitzar) per poder ressaltar els
// links creats després; després s'actualitza a "ara".
function readLastVisit() {
  const m = document.cookie.match(/(?:^|;\s*)clio_seen=([^;]*)/);
  return m ? (parseInt(decodeURIComponent(m[1]), 10) || 0) : 0;
}
function writeLastVisit(ms) {
  document.cookie = 'clio_seen=' + ms + '; path=/; max-age=31536000; SameSite=Lax';
}
const LAST_VISIT = readLastVisit();
function linkTime(l) { const t = Date.parse(l.created_at); return isNaN(t) ? 0 : t; }
function collectedDate(l) {
  const t = linkTime(l);
  return t ? new Date(t).toLocaleDateString('ca-ES', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
}
// Desplaçament del llindar de novetats en dies (persistit). Negatiu = enrere
// (mostra'n més, també les més antigues); positiu = endavant (mostra'n menys).
function readNewOffset() { const m = document.cookie.match(/(?:^|;\s*)clio_newoff=(-?\d+)/); return m ? parseInt(m[1], 10) : 0; }
function writeNewOffset(n) { document.cookie = 'clio_newoff=' + n + '; path=/; max-age=31536000; SameSite=Lax'; }
let NEW_OFFSET = readNewOffset();
function newSince() { return LAST_VISIT + NEW_OFFSET * 86400000; }
function isNew(l) { return LAST_VISIT > 0 && linkTime(l) > newSince(); }

// ---- Sessió / API ----
// Les accions (clau, refer, baixa, usuaris) només tenen sentit contra un
// servei viu (mode `serve`). Es detecta amb /api/v1/ping: la web estàtica pura
// (file:// o hosting sense backend) no respon i s'amaga tota la UI d'accions.
let API_LIVE = false;       // determinat per probeApi()
let ME = null;              // {id, username, role} de /api/v1/me
function getToken() { return localStorage.getItem('clio-token') || ''; }
function setToken(t) { if (t) localStorage.setItem('clio-token', t); else localStorage.removeItem('clio-token'); }
function hasToken() { return API_LIVE && !!getToken(); }
function isAdmin() { return API_LIVE && ME && ME.role === 'admin'; }

async function probeApi() {
  // No n'hi ha prou amb r.ok: hostings estàtics (Cloudflare Pages, etc.) tornen
  // 200 amb l'HTML de fallback per a rutes desconegudes. Cal confirmar que el cos
  // és el JSON del servei viu ({ serve: true }).
  try {
    const r = await fetch('/api/v1/ping', { cache: 'no-store' });
    if (!r.ok) { API_LIVE = false; return; }
    const j = await r.json().catch(() => null);
    API_LIVE = !!(j && j.serve === true);
  } catch (e) { API_LIVE = false; }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + getToken() } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api/v1' + path, opts);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || ('HTTP ' + r.status));
  }
  return r.json().catch(() => ({}));
}

async function loadMe() {
  ME = null;
  if (!API_LIVE || !getToken()) return;
  try { ME = await api('GET', '/me'); } catch (e) { ME = null; }
}

// Toast efímer a baix de la pantalla.
let toastTimer = null;
function toast(msg, kind) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

// Mutacions locals: cal tocar també les caches perquè rebuildAll()
// reconstrueix ALL des d'allà.
function removeLocal(id) {
  ALL = ALL.filter(l => l.id !== id);
  for (const arr of PART_CACHE.values()) {
    const i = arr.findIndex(l => l.id === id);
    if (i >= 0) arr.splice(i, 1);
  }
  const x = EXTRA.findIndex(l => l.id === id);
  if (x >= 0) EXTRA.splice(x, 1);
  hearts.delete(id);
}
function addLocal(l) {
  if (ALL.some(x => x.id === l.id)) return;
  ALL.unshift(l);
  EXTRA.unshift(l);
}

async function reprocessLink(id) {
  try { await api('POST', '/links/' + id + '/reprocess'); toast('Link reencuat: es tornarà a analitzar.', 'ok'); }
  catch (e) { toast('Error en reforçar: ' + e.message, 'err'); }
}
async function deleteLink(id) {
  if (!confirm('Segur que vols donar de baixa aquest link?')) return;
  try {
    await api('DELETE', '/links/' + id);
    removeLocal(id);
    renderStats(); buildFilters(); render();
    toast('Link donat de baixa.', 'ok');
  } catch (e) { toast('Error en donar de baixa: ' + e.message, 'err'); }
}
async function blockLink(id) {
  if (!confirm('Bloquejar aquest URL? S\'afegirà a la blocklist i el link s\'esborrarà.')) return;
  try {
    await api('POST', '/links/' + id + '/block');
    removeLocal(id);
    renderStats(); buildFilters(); render();
    toast('URL bloquejada i link esborrat.', 'ok');
  } catch (e) { toast('Error en bloquejar: ' + e.message, 'err'); }
}

// Actualitza la visibilitat i l'estat dels ítems del menú lligats a l'API
// (només tenen sentit contra un servei viu). S'invoca en canviar de sessió.
function refreshApiItems() {
  const tk = $('mi-token'), ad = $('mi-admin'), af = $('mi-add'), sep = $('menu-api-sep');
  if (!tk) return;
  tk.hidden = !API_LIVE;
  tk.classList.toggle('on', !!getToken());
  tk.textContent = getToken() ? '🔑 Sessió activa (tanca / canvia)' : '🔑 Inicia sessió amb token';
  if (ad) ad.hidden = !isAdmin();
  if (af) af.hidden = !hasToken();
  if (sep) sep.hidden = !API_LIVE;
}

async function promptToken() {
  if (!API_LIVE) { toast('Aquesta web no té servei API actiu.', 'err'); return; }
  const cur = getToken();
  const t = prompt(cur ? 'API token (buit per tancar sessió):' : 'Enganxa el teu API token:', cur);
  if (t === null) return;
  setToken(t.trim());
  await loadMe();
  refreshApiItems(); render();
  toast(getToken() ? 'Sessió iniciada.' : 'Sessió tancada.', 'ok');
}

// ---- Afegir enllaç (qualsevol usuari amb token) ----

async function addLink() {
  if (!hasToken()) { toast('Cal iniciar sessió amb un token.', 'err'); return; }
  const raw = prompt('URL del nou enllaç (pots enganxar-ne diversos separats per espais):');
  if (raw === null) return;
  const urls = raw.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (!urls.length) { toast('Cap URL.', 'err'); return; }
  try {
    const res = await api('POST', '/links', urls.length === 1 ? { url: urls[0] } : { urls });
    // Resposta única (un enllaç) o lot amb { results }.
    const ids = res.results
      ? res.results.filter(r => r.link_id).map(r => r.link_id)
      : (res.link_id ? [res.link_id] : []);
    // Prepend dels nous links perquè apareguin sense recarregar (encara "pending").
    for (const id of ids) {
      try { const l = await api('GET', '/links/' + id); if (l && l.id) addLocal(l); }
      catch (e) {}
    }
    renderStats(); buildFilters(); render();
    toast(ids.length === 1 ? "Enllaç afegit: s'analitzarà en breu." : ids.length + ' enllaços afegits.', 'ok');
  } catch (e) { toast('Error afegint: ' + e.message, 'err'); }
}

// ---- Admin: gestió d'usuaris ----
// Mostra un token un sol cop (és copiable des del prompt).
function showToken(username, token) {
  prompt("Token de " + username + " (copia'l ara, no es tornarà a mostrar):", token);
}

async function openUsersModal() {
  let users;
  try { users = (await api('GET', '/users')).users || []; }
  catch (e) { toast('Error carregant usuaris: ' + e.message, 'err'); return; }

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>👤 Usuaris</h3><button class="modal-x" title="Tanca">✕</button></div>
    <div class="modal-body">
      <table class="utable">
        <thead><tr><th>Usuari</th><th>Rol</th><th>Telegram</th><th>Creat</th><th></th></tr></thead>
        <tbody id="ulist"></tbody>
      </table>
      <div class="ucreate">
        <input id="nu-name" placeholder="nom del nou usuari" autocomplete="off">
        <input id="nu-tg" placeholder="telegram id (opcional)" autocomplete="off">
        <label class="nu-adm"><input type="checkbox" id="nu-admin"> admin</label>
        <button id="nu-add" class="act">+ Crea</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.modal-x').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.addEventListener('keydown', function esc2(e){ if(e.key==='Escape'){ close(); document.removeEventListener('keydown', esc2);} });

  const refresh = async () => {
    try { fill((await api('GET', '/users')).users || []); }
    catch (e) { toast(e.message, 'err'); }
  };
  function fill(list) {
    const tb = ov.querySelector('#ulist');
    tb.innerHTML = '';
    list.forEach(u => {
      const tr = document.createElement('tr');
      const mine = ME && u.id === ME.id;
      const tg = u.telegram_id ? esc(u.telegram_id) : '<span class="you">—</span>';
      tr.innerHTML = `<td>${esc(u.username)}${mine ? ' <span class="you">(tu)</span>' : ''}</td>
        <td><span class="rolebadge ${u.role}">${u.role}</span></td>
        <td class="tgcell">${tg}</td>
        <td>${(u.created_at || '').slice(0,10)}</td>
        <td class="urow-actions">
          <button class="act" data-act="role" title="Canvia el rol">${u.role==='admin'?'→ user':'→ admin'}</button>
          <button class="act" data-act="rename" title="Reanomena">✎</button>
          <button class="act" data-act="tg" title="Edita telegram id">✈</button>
          <button class="act" data-act="token" title="Regenera token">🔑</button>
          <button class="act act-delete" data-act="del" title="Esborra"${mine?' disabled':''}>🗑</button>
        </td>`;
      tr.querySelector('[data-act=role]').onclick = async () => {
        try { await api('PATCH', '/users/' + u.id, { admin: u.role !== 'admin' }); toast('Rol actualitzat.', 'ok'); refresh(); if (mine) { await loadMe(); refreshApiItems(); } }
        catch (e) { toast(e.message, 'err'); }
      };
      tr.querySelector('[data-act=rename]').onclick = async () => {
        const n = prompt('Nou nom per ' + u.username + ':', u.username);
        if (!n || !n.trim()) return;
        try { await api('PATCH', '/users/' + u.id, { username: n.trim() }); toast('Nom actualitzat.', 'ok'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      };
      tr.querySelector('[data-act=tg]').onclick = async () => {
        const v = prompt('Telegram id de ' + u.username + ' (buit per treure):', u.telegram_id || '');
        if (v === null) return;
        try { await api('PATCH', '/users/' + u.id, { telegram_id: v.trim() }); toast('Telegram id actualitzat.', 'ok'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      };
      tr.querySelector('[data-act=token]').onclick = async () => {
        if (!confirm('Regenerar el token de ' + u.username + '? El token actual deixarà de funcionar.')) return;
        try { showToken(u.username, (await api('POST', '/users/' + u.id + '/token')).api_token); }
        catch (e) { toast(e.message, 'err'); }
      };
      const del = tr.querySelector('[data-act=del]');
      if (!mine) del.onclick = async () => {
        if (!confirm('Esborrar definitivament ' + u.username + '?')) return;
        try { await api('DELETE', '/users/' + u.id); toast('Usuari esborrat.', 'ok'); refresh(); }
        catch (e) { toast(e.message, 'err'); }
      };
      tb.appendChild(tr);
    });
  }
  fill(users);

  ov.querySelector('#nu-add').onclick = async () => {
    const name = ov.querySelector('#nu-name').value.trim();
    if (!name) { toast('Cal un nom.', 'err'); return; }
    const adm = ov.querySelector('#nu-admin').checked;
    const tg = ov.querySelector('#nu-tg').value.trim();
    try {
      const d = await api('POST', '/users', { username: name, admin: adm, telegram_id: tg });
      ov.querySelector('#nu-name').value = '';
      ov.querySelector('#nu-tg').value = '';
      ov.querySelector('#nu-admin').checked = false;
      refresh();
      showToken(d.username, d.api_token);
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---- Personalització per "cors" (sense usuaris; estat desat a cookie) ----
// La cookie guarda NOMÉS els ids marcats; el vector de l'usuari (centroide)
// es recalcula al client a partir dels embeddings dels links amb cor.
function readHearts() {
  const m = document.cookie.match(/(?:^|;\s*)clio_hearts=([^;]*)/);
  if (!m) return [];
  try { return JSON.parse(decodeURIComponent(m[1])) || []; } catch (e) { return []; }
}
function writeHearts(ids) {
  document.cookie = 'clio_hearts=' + encodeURIComponent(JSON.stringify(ids)) +
    '; path=/; max-age=31536000; SameSite=Lax';
}
let hearts = new Set(readHearts());
// Hi ha embeddings publicats a alguna font seguida? Si no, el cor no té efecte
// d'ordre: l'amaguem. Els vectors viuen a data/u/{font}/emb-{mes}-p{N}.json i
// només es baixen quan hi ha cors.
function embAvailable() {
  return !STATIC_MODE && !!MANIFEST && followedUsers().some(u => u.emb);
}

// Baixa els embeddings dels mesos visibles de les fonts seguides (un fetch per
// part, un sol cop). No fa res sense cors: la majoria de visites no el paguen.
async function ensureEmb() {
  if (!embAvailable() || !hearts.size) return;
  const keys = new Set(MONTHS.slice(0, SHOWN).map(m => m.key));
  const jobs = [];
  for (const u of followedUsers()) {
    if (!u.emb) continue;
    for (const m of u.months) {
      const ck = u.dir + '|' + m.key;
      if (!keys.has(m.key) || EMB_LOADED.has(ck)) continue;
      EMB_LOADED.add(ck);
      jobs.push((async () => {
        try {
          for (let p = 0; p < (m.parts || 1); p++) {
            const d = await fetchJson('data/u/' + u.dir + '/emb-' + m.key + '-p' + p + '.json');
            for (const id in d) EMB.set(id, d[id]);
          }
        } catch (e) { EMB_LOADED.delete(ck); }
      })());
    }
  }
  await Promise.all(jobs);
}

function toggleHeart(id) {
  if (hearts.has(id)) hearts.delete(id); else hearts.add(id);
  writeHearts([...hearts]);
}

// Dequantitza l'embedding int8 d'un link -> array de floats (o null).
function embVec(id) {
  const d = EMB.get(id);
  if (!d || !Array.isArray(d.e) || typeof d.s !== 'number') return null;
  const e = d.e, s = d.s, out = new Array(e.length);
  for (let i = 0; i < e.length; i++) out[i] = e[i] * s;
  return out;
}

// Centroide (mitjana) dels embeddings dels links amb cor. null si no n'hi ha cap.
function centroid() {
  let acc = null, n = 0;
  for (const id of hearts) {
    const v = embVec(id);
    if (!v) continue;
    if (!acc) acc = new Array(v.length).fill(0);
    for (let i = 0; i < v.length; i++) acc[i] += v[i];
    n++;
  }
  if (!acc || n === 0) return null;
  for (let i = 0; i < acc.length; i++) acc[i] /= n;
  return acc;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function esc(s){ return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---- Neteja de resums (prosa periodística en català) ----
//
// Treu del resum el metallenguatge amb què de vegades el LLM obre el text
// («L'article descriu...», «L'anàlisi de l'article...», «## Resum», «**Resum:**»)
// perquè comenci directament per la notícia. Només actua a l'inici i només sobre
// text que *presenta* el contingut: no s'edita cap altra part (fidelitat).

const META_OPEN = [
  // Català (les variants amb verb van abans que el subjecte sol: primer match guanya)
  /^l['’]anàlisi de l['’]article (presenta|descriu|explica|analitza|resumeix)/i,
  /^l['’]anàlisi de l['’]article/i,
  /^aquesta anàlisi (presenta|descriu|explica|analitza)/i,
  /^aquesta anàlisi/i,
  /^l['’]article (descriu|explica|analitza|resumeix|presenta|tracta|parla|aborda)/i,
  /^aquest article (descriu|explica|analitza|presenta|tracta|parla)/i,
  /^en aquest article/i,
  /^aquest article/i,
  /^(el v[ií]deo|el video) (descriu|explica|analitza|tracta|parla)/i,
  /^en aquest v[ií]deo/i,
  /^aquest v[ií]deo/i,
  /^el v[ií]deo/i,
  /^el repositori (descriu|explica|analitza|conté|ofereix)/i,
  /^aquest repositori/i,
  // Castellà / anglès (equivalents que alguns models barregen)
  /^el art[ií]culo (analiza|describe|explica|trata)/i,
  /^en este art[ií]culo/i,
  /^este art[ií]culo/i,
  /^este v[ií]deo/i,
  /^el v[ií]deo (analiza|describe|explica)/i,
  /^this article (describes|explains|analyzes)/i,
  /^in this article/i,
  /^this article/i,
  /^the article (describes|explains|analyzes)/i,
  /^this video (describes|explains)/i,
  /^this video/i,
  /^the video (describes|explains)/i,
  /^this repository/i,
  /^the repository/i,
];
const META_LABELS_JS = ['resum', 'resumen', 'anàlisi', 'anàlisis', 'síntesi', 'sintesi', 'nota'];

function recap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

// Treu la primera obertura metalingüística (una línia de format, una label
// «Resum: X», o un prefix com «L'article descriu que X»). Si no n'hi ha cap,
// retorna el text sense canvis.
function stripMetaOpen(t) {
  const nl = t.indexOf('\n');
  const firstLine = (nl === -1 ? t : t.slice(0, nl)).trim();
  const rest2 = nl === -1 ? '' : t.slice(nl);
  const unwrapped = firstLine.replace(/^[#*\-+>•·]+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
  const bare = unwrapped.replace(/:+$/, '').trim().toLowerCase();

  // (a) Línia de format pur o label sola («## Resum», «- », «**Resum:**»).
  if (!bare || META_LABELS_JS.indexOf(bare) !== -1) return rest2.trim();

  // (b) Label encapçalant contingut a la mateixa línia («Resum: X», «## Resum: X»).
  for (let i = 0; i < META_LABELS_JS.length; i++) {
    const m = unwrapped.match(new RegExp('^' + META_LABELS_JS[i] + '[:·.—–-]\\s*', 'i'));
    if (!m) continue;
    const body = unwrapped.slice(m[0].length)
      .replace(/^[\s*#>\-+•·]+/, '')
      .replace(/^\*+|\*+$/g, '')
      .trim();
    if (!body) return rest2.trim();
    return recap(body + rest2);
  }

  // (c) Prefix de metallenguatge («L'article descriu que X»). Es fa servir la
  // primera línia desembolicada de markdown (per a «**L'article descriu**…»).
  for (let i = 0; i < META_OPEN.length; i++) {
    const m = unwrapped.match(META_OPEN[i]);
    if (!m || m.index !== 0) continue;
    let rest = unwrapped.slice(m[0].length)
      .replace(/^[\s:—–.\-*,]+/, '')
      .replace(/^\*+|\*+$/g, '')
      .trim();
    rest = rest.replace(/^que\s+/i, ''); // «descriu que X» -> «X»
    if (!rest) return rest2.trim();
    return recap(rest + rest2);
  }
  return t;
}

// Neteja completa d'un resum: aplica stripMetaOpen repetidament (les obertures
// poden estar encadenades o embolicades amb format) i retorna el text net.
function polishSummary(s) {
  let t = (s || '').trim();
  if (!t) return '';
  for (let i = 0; i < 8; i++) {
    const before = t;
    t = stripMetaOpen(t);
    if (t === before) break;
  }
  return t.trim();
}

// Resum curt: explicació de què és, màxim 150 caràcters, sense punts suspensius.
// L'anàlisi profunda cobreix el text llarg.
function summaryText(s) {
  const t = polishSummary(s);
  if (!t) return 'Sense resum disponible.';
  return t.length > 150 ? t.slice(0, 150).trimEnd() : t;
}

// URL de la imatge d'una card, mirall de l'overlay: primer la còpia local dins
// la web estàtica (data/img), després la còpia de l'API (/imgout/{id}) i, com a
// últim recurs, el proxy remot (/img?u=). Retorna '' si l'enllaç no té imatge.
function cardImage(l) {
  if (l.img) return l.img;
  if (l.image_file) return '/imgout/' + l.id;
  if (l.image_url) return '/img?u=' + encodeURIComponent(l.image_url);
  return '';
}

// Si una card-img falla (p.ex. web estàtica sense API on no hi ha còpia local),
// cau un sol cop al proxy remot i, si també falla, amaga la imatge.
function cardImgFail(img) {
  const box = img.closest('.card-img');
  const src = img.getAttribute('src') || '';
  if (src.indexOf('/imgout/') === 0) {
    const id = src.slice('/imgout/'.length);
    const l = ALL.find(x => x.id === id);
    if (l && l.image_url) { img.src = '/img?u=' + encodeURIComponent(l.image_url); return; }
  }
  const proxy = img.getAttribute('data-proxy');
  if (proxy && src.indexOf('/img?') !== 0) { img.src = proxy; return; }
  if (box) box.remove();
}

// Renderitzador de Markdown minimal i segur: s'escapa primer l'HTML i després
// es reintrodueixen només les etiquetes generades aquí. Cobreix el subconjunt
// que produeix el LLM: titols, negreta/cursiva, codi, llistes, enllaços, cites.
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(src) {
  const lines = (src || '').split(/\r?\n/);
  const out = [];
  let inList = false, inCode = false, para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; } };
  const flushList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (let raw of lines) {
    if (/^```/.test(raw)) {
      flushPara(); flushList();
      if (!inCode) { out.push('<pre><code>'); inCode = true; }
      else { out.push('</code></pre>'); inCode = false; }
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const n = h[1].length; out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>'); continue; }
    const li = line.match(/^[-*+]\s+(.*)$/);
    if (li) { flushPara(); if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + mdInline(li[1]) + '</li>'); continue; }
    para.push(mdInline(line));
  }
  if (inCode) out.push('</code></pre>');
  flushPara(); flushList();
  return out.join('\n');
}

// ---- Enrutament per hash: #tag:xxx o #at:usuari ----
function applyHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim();
  activeTag = null; activeUser = null; activeId = null;
  if (h.toLowerCase().startsWith('tag:')) activeTag = h.slice(4).toLowerCase();
  else if (h.toLowerCase().startsWith('at:')) activeUser = h.slice(3).toLowerCase();
  else if (h.toLowerCase().startsWith('id:')) activeId = h.slice(3);
}
function setHash(h) {
  if (location.hash.replace(/^#/, '') === h) { onHashChange(); }
  else location.hash = h;
}
function onHashChange() { applyHash(); buildFilters(); render(); }

// ---- Tema fosc/clar ----
function initTheme() {
  const saved = localStorage.getItem('clio-theme');
  const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (sysDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('clio-theme', next);
}

// ---- Nombre de columnes de la graella (desat a cookie) ----
// 0 = automàtic (per defecte del CSS). >0 força N columnes.
function readCols() {
  const m = document.cookie.match(/(?:^|;\s*)clio_cols=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function writeCols(n) {
  document.cookie = 'clio_cols=' + n + '; path=/; max-age=31536000; SameSite=Lax';
}
function applyCols() {
  const n = readCols();
  const g = $('grid');
  g.style.gridTemplateColumns = n > 0 ? `repeat(${n}, minmax(0, 1fr))` : '';
}
// Columnes actuals: la cookie si hi és, altrament les que calcula el CSS auto-fill.
function curCols() {
  const n = readCols();
  if (n > 0) return n;
  const cs = getComputedStyle($('grid')).gridTemplateColumns;
  return cs && cs !== 'none' ? cs.split(' ').length : 1;
}
function colsInc() { writeCols(Math.min(curCols() + 1, 8)); applyCols(); }
function colsDec() { writeCols(Math.max(curCols() - 1, 1)); applyCols(); }
function initCols() { applyCols(); }

function buildFilters() {
  const counts = {};
  ALL.forEach(l => (l.tags || []).forEach(t => counts[t] = (counts[t]||0)+1));
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,24);
  const box = $('filters');
  box.innerHTML = '';
  // Llistat general plegat per defecte: només visible si s'obre des del toggle
  // de tags o si hi ha un filtre actiu (per poder treure'l).
  const show = filtersOpen || activeTag || activeUser;
  box.classList.toggle('open', !!show);
  if (!show) return;
  // Filtre actiu per usuari (#at:): chip destacable i removible.
  if (activeUser) {
    const u = document.createElement('span');
    u.className = 'chip active';
    u.textContent = '@' + activeUser + ' ✕';
    u.title = "Enllaços enviats per " + activeUser + ' (clica per treure)';
    u.onclick = () => setHash('');
    box.appendChild(u);
  }
  top.forEach(([tag, n]) => {
    const c = document.createElement('span');
    c.className = 'chip' + (tag===activeTag ? ' active' : '');
    c.textContent = '#' + tag + ' · ' + n;
    c.onclick = () => setHash(activeTag===tag ? '' : 'tag:' + tag);
    box.appendChild(c);
  });
}

const SENT_LABEL = { positive: 'Positiu', neutral: 'Neutral', negative: 'Negatiu' };

// Info del repositori o del vídeo (stats): es mostra dins "Detalls".
function repoBlock(l) {
  const cs = l.code_stats;
  if (!cs || typeof cs !== 'object') return '';
  // Vídeos: canal + durada + si té transcripció.
  if (cs.channel !== undefined || cs.duration_secs !== undefined) {
    const parts = [];
    if (cs.channel) parts.push(`<span title="Canal">📺 ${esc(cs.channel)}</span>`);
    if (cs.duration_secs) parts.push(`<span title="Durada">⏱ ${fmtDur(cs.duration_secs)}</span>`);
    if (cs.has_transcript) parts.push(`<span title="Transcripció disponible">📝 transcripció</span>`);
    return `<div class="codestats">${parts.join('')}</div>`;
  }
  // Repos: fitxers + LOC + llenguatges.
  const langs = (cs.top_languages || []).slice(0,4)
    .map(x => `<span class="lang">${esc(x.lang)} <i>${x.loc}</i></span>`).join('');
  return `<div class="codestats">
      <span title="Fitxers de codi">📄 ${cs.files||0}</span>
      <span title="Línies de codi">⌁ ${cs.loc||0} LOC</span>
      <span class="langs">${langs}</span>
    </div>`;
}

function fmtDur(s) {
  s = parseInt(s, 10) || 0;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return (h ? h+'h ' : '') + (m ? m+'m ' : '') + (h ? '' : sec+'s');
}

// Bloc de la segona passada (deep): anàlisi profunda en text.
// El text pesat viu a data/deep/{id}.json i es carrega mandrosament en obrir.
function deepPanel(l) {
  if (l.deep_status === 'done') {
    return `<div class="deep-md" data-deep="${esc(l.id)}"><span class="deep-loading">Carregant…</span></div>`;
  } else if (l.deep_status === 'pending' || l.deep_status === 'processing') {
    return `<div class="deep-pending">🔬 Anàlisi profunda en curs…</div>`;
  }
  return `<div class="deep-pending">Sense anàlisi profunda.</div>`;
}
function deepAvailable(l) { return l.deep_status === 'done'; }

// Cache i càrrega mandrosa del resum profund (un fetch per enllaç, un sol cop).
const DEEP_CACHE = new Map();
async function loadDeep(box) {
  const id = box.dataset.deep;
  if (!id || box.dataset.loaded) return;
  box.dataset.loaded = '1';
  let text = DEEP_CACHE.get(id);
  if (text === undefined) {
    try {
      const r = await fetch('data/deep/' + id + '.json?v=1788538585');
      text = r.ok ? ((await r.json()).deep_summary || '') : '';
    } catch (e) { text = ''; }
    DEEP_CACHE.set(id, text);
  }
  box.innerHTML = text ? md(polishSummary(text)) : '<span class="deep-loading">No disponible.</span>';
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const typeF = $('type-filter').value;
  const sentF = $('sent-filter').value;
  const grid = $('grid');
  grid.innerHTML = '';

  // Vista permalink (#id:xxx): només una card, sense filtres ni estadístiques.
  document.body.classList.toggle('single-view', !!activeId);
  if (activeId) { renderSingle(grid); return; }

  const items = ALL.filter(l => {
    if (activeTag && !(l.tags||[]).includes(activeTag)) return false;
    if (activeUser && !(l.reporters||[]).some(u => u.toLowerCase() === activeUser)) return false;
    if (typeF && l.link_type !== typeF) return false;
    if (sentF && l.sentiment !== sentF) return false;
    if (!q) return true;
    return (l.title||'').toLowerCase().includes(q) || (l.summary||'').toLowerCase().includes(q);
  });

  // Ordre personalitzat: per afinitat (cosine) amb el centroide dels cors.
  // Sense cors, es manté l'ordre cronològic invers (created_at DESC).
  const cen = centroid();
  if (cen) items.forEach(l => { const v = embVec(l.id); l.__score = v ? cosine(v, cen) : -1; });
  if (onlyNew || cen) {
    items.sort((a, b) => {
      // Amb "novetats" actiu: nous primer, antics després; cada grup per interès.
      if (onlyNew) { const d = (isNew(b)?1:0) - (isNew(a)?1:0); if (d) return d; }
      return cen ? b.__score - a.__score : 0;
    });
  }
  renderPerso();

  // Render incremental: pintar milers de cards de cop crema CPU (i bateria als
  // mòbils). Es pinten RENDER_CAP i s'estiren més amb el botó (o en fer scroll
  // fins a ell, via IntersectionObserver).
  const visible = items.slice(0, RENDER_CAP);
  visible.forEach(l => { grid.appendChild(buildCard(l)); });

  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = MONTHS.length && SHOWN < MONTHS.length
      ? 'Cap resultat amb aquests filtres en el període carregat.'
      : 'Cap resultat amb aquests filtres.';
    grid.appendChild(e);
  }

  const w = document.createElement('div');
  w.className = 'load-more-wrap';
  if (items.length > visible.length) {
    // Encara hi ha links carregats per pintar.
    const b = document.createElement('button');
    b.className = 'load-more';
    b.textContent = '＋ Mostra\'n més (' + (items.length - visible.length) + ' pendents)';
    b.onclick = () => { RENDER_CAP += CAP_STEP; render(); };
    w.appendChild(b);
    grid.appendChild(w);
    observeMore(b);
  } else if (!STATIC_MODE && MONTHS.length && SHOWN < MONTHS.length) {
    // Tot el carregat és visible: oferir un mes més d'historial.
    const next = MONTHS[SHOWN];
    const b = document.createElement('button');
    b.className = 'load-more';
    b.textContent = '⬇ Carrega ' + monthLabel(next.key) + ' · ' + next.count +
      (next.count === 1 ? ' enllaç' : ' enllaços');
    b.onclick = async () => { b.disabled = true; await showMonths(SHOWN + 1); };
    w.appendChild(b);
    grid.appendChild(w);
  }
}

// Vista d'una sola card via permalink (#id:xxx). Afegeix un enllaç a l'inici.
// Si el link no és als mesos carregats, es baixa la seva fitxa data/i/{id}.json.
const SINGLE_CACHE = new Map(); // id -> link | null (null = no existeix)
function renderSingle(grid) {
  const l = ALL.find(x => x.id === activeId) || SINGLE_CACHE.get(activeId) || null;
  if (l) {
    grid.appendChild(buildCard(l, true));
  } else if (!STATIC_MODE && !SINGLE_CACHE.has(activeId)) {
    const id = activeId;
    grid.innerHTML = '<div class="empty">Carregant l\'enllaç…</div>';
    (async () => {
      let link = null;
      try { link = await fetchJson('data/i/' + id + '.json'); } catch (e) {}
      SINGLE_CACHE.set(id, link && link.id ? link : null);
      if (activeId === id) render();
    })();
  } else {
    grid.innerHTML = '<div class="empty">Aquest enllaç no existeix o s\'ha donat de baixa.</div>';
  }
  const home = document.createElement('div');
  home.className = 'home-link';
  home.innerHTML = '<a href="#">← Torna a tots els enllaços</a>';
  home.querySelector('a').onclick = (e) => { e.preventDefault(); setHash(''); };
  grid.appendChild(home);
}

// Construeix l'element <article> d'una card. Reutilitzat per la graella i el permalink.
// `single`: vista permalink — mostra info+anàlisi+detalls a la vegada, sense tabs.
function buildCard(l, single) {
    const reps = l.reporters || [];
    const type = esc(l.link_type || 'other');
    const sent = esc(l.sentiment || 'neutral');
    const tags = (l.tags||[]).slice(0,8)
      .map(t => `<span class="chip" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
    const users = reps.slice(0,6)
      .map(u => `<span class="chip user" data-user="${esc(u)}">@${esc(u)}</span>`).join('');
    const img = cardImage(l);
    const proxy = l.image_url ? '/img?u=' + encodeURIComponent(l.image_url) : '';
    const card = document.createElement('article');
    card.className = 'card' + (isNew(l) ? ' is-new' : '');
    card.innerHTML = `
      ${img ? `<div class="card-img">
        <a href="${esc(l.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
          <img src="${esc(img)}" alt="" loading="lazy"${proxy ? ` data-proxy="${esc(proxy)}"` : ''} onerror="cardImgFail(this)">
        </a>
      </div>` : ''}
      <div class="card-top">
        <h2><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.url)}</a></h2>
      </div>
      <div class="card-row2">
        <div class="card-row2-left">
          ${isNew(l) ? '<span class="badge-new" title="Nou des de la teva última visita">NOU</span>' : ''}
          ${l.status === 'failed' ? '<span class="badge badge-fail" title="L\'anàlisi va fallar (l\'LLM potser no va respondre): no s\'ha publicat cap text en un altre idioma. Fes «↻ Refer» per tornar-la a generar.">⚠ Revisa</span>' : ''}
          <span class="badge t-${type}">${type}</span>
          <a class="permalink" href="#id:${esc(l.id)}" title="Enllaç permanent a aquesta card" aria-label="Enllaç permanent">🔗</a>
          ${embAvailable() ? `<button class="heart ${hearts.has(l.id)?'on':''}" data-id="${esc(l.id)}" title="Marca per personalitzar l'ordre" aria-label="M'agrada">♥</button>` : ''}
        </div>
        <div class="card-tabs">
          <button class="tab on" data-panel="info" title="Info">ℹ️</button>
          <button class="tab" data-panel="deep" title="Anàlisi profunda"${deepAvailable(l) ? '' : ' disabled'}>🔬</button>
          <button class="tab" data-panel="details" title="Detalls">📋</button>
        </div>
      </div>
      <div class="card-panels">
        <div class="panel" data-panel="info"><p class="summary">${esc(summaryText(l.summary))}</p></div>
        <div class="panel" data-panel="deep" hidden>${deepPanel(l)}</div>
        <div class="panel" data-panel="details" hidden>
          ${repoBlock(l)}
          <div class="tags">${tags}</div>
          <div class="meta">
            <span class="sent ${sent}"><span class="dot"></span>${SENT_LABEL[sent] || sent}</span>
            <span class="collected" title="Data de recollida">📅 ${collectedDate(l)}</span>
            <span class="reporters" title="Qui ha enviat aquest enllaç">${users || '👤 —'}</span>
          </div>
        </div>
      </div>
      ${hasToken() ? `<div class="actions">
        <button class="act act-refresh" data-id="${esc(l.id)}" title="Reforça: torna a analitzar">↻ Refer</button>
        <button class="act act-delete" data-id="${esc(l.id)}" title="Dona de baixa aquest link">🗑 Baixa</button>
        ${isAdmin() ? `<button class="act act-block" data-id="${esc(l.id)}" title="Bloqueja aquest URL: l'afegeix a la blocklist i esborra el link">🚫 Bloqueja</button>` : ''}
      </div>` : ''}`;
    card.querySelectorAll('.tags .chip').forEach(ch => {
      ch.onclick = () => setHash('tag:' + ch.dataset.tag);
    });
    card.querySelectorAll('.reporters .user').forEach(ch => {
      ch.onclick = () => setHash('at:' + ch.dataset.user.toLowerCase());
    });
    const tabs = card.querySelectorAll('.card-tabs .tab');
    const panels = card.querySelectorAll('.card-panels .panel');
    tabs.forEach(t => t.addEventListener('click', () => {
      if (t.disabled) return;
      const name = t.dataset.panel;
      tabs.forEach(x => x.classList.toggle('on', x === t));
      panels.forEach(p => p.hidden = p.dataset.panel !== name);
      card.classList.toggle('is-expanded', name === 'deep');
      if (name === 'deep') {
        const box = card.querySelector('.panel[data-panel="deep"] .deep-md');
        if (box) loadDeep(box);
      }
    }));
    // Vista permalink: info + anàlisi + detalls oberts alhora (sense tabs).
    if (single) {
      const box = card.querySelector('.panel[data-panel="deep"] .deep-md');
      if (box) loadDeep(box);
    }
    const hb = card.querySelector('.heart');
    if (hb) hb.onclick = async () => { toggleHeart(l.id); await ensureEmb(); render(); };
    const rf = card.querySelector('.act-refresh');
    if (rf) rf.onclick = () => reprocessLink(l.id);
    const dl = card.querySelector('.act-delete');
    if (dl) dl.onclick = () => deleteLink(l.id);
    const bl = card.querySelector('.act-block');
    if (bl) bl.onclick = () => blockLink(l.id);
    const pl = card.querySelector('.permalink');
    if (pl) pl.onclick = (e) => { e.preventDefault(); setHash('id:' + l.id); };
    return card;
}

// Banner d'estat de la personalització + botó de neteja.
function renderPerso() {
  const box = $('perso');
  if (!box) return;
  const n = [...hearts].filter(id => EMB.has(id) || ALL.some(l => l.id === id)).length;
  if (!embAvailable() || !n) { box.className = 'perso'; box.innerHTML = ''; return; }
  box.className = 'perso on';
  box.innerHTML = '<span>❤ Ordenat per afinitat amb <b>' + n + '</b> ' +
    (n === 1 ? 'enllaç marcat' : 'enllaços marcats') + '</span>' +
    '<button id="perso-clear" class="perso-clear">Neteja</button>';
  $('perso-clear').onclick = () => { hearts.clear(); writeHearts([]); render(); };
}

function renderStats() {
  const flw = (!STATIC_MODE && MANIFEST) ? followedUsers() : [];
  const total = flw.length ? flw.reduce((a, u) => a + u.total, 0) : ALL.length;
  const done = ALL.filter(l => l.status === 'done').length;
  const tags = new Set(); ALL.forEach(l => (l.tags||[]).forEach(t => tags.add(t)));
  const newCount = ALL.filter(isNew).length;
  let html =
    `<span><b>${ALL.length}</b>${total > ALL.length ? ' de ' + total : ''} enllaços</span>` +
    `<span><b>${done}</b> processats</span>` +
    `<span id="tags-toggle" class="tags-toggle${filtersOpen ? ' on' : ''}" ` +
      `title="Mostra/amaga el llistat de tags"># <b>${tags.size}</b> tags</span>`;
  // Fonts seguides; clicant s'obre el selector de fonts i categories.
  if (flw.length) {
    html += `<span id="follow-toggle" class="follow-toggle" ` +
      `title="Fonts seguides: ${flw.map(u => '@' + u.name).join(', ')}. Clica per canviar-les.">` +
      `👥 <b>${flw.length}</b> ${flw.length === 1 ? 'font' : 'fonts'}</span>`;
  }
  if (newCount) {
    html += `<span id="new-toggle" class="new-toggle${onlyNew ? ' on' : ''}" ` +
      `title="Mostra només novetats">✨ <b>${newCount}</b> novetats</span>`;
  }
  // Fins a quin mes es veu l'historial; clicant es carrega un mes més.
  if (!STATIC_MODE && MONTHS.length) {
    const cur = MONTHS[Math.min(SHOWN, MONTHS.length) - 1];
    const more = SHOWN < MONTHS.length;
    html += `<span id="hist-toggle" class="hist-toggle${more ? '' : ' end'}" ` +
      `title="${more ? 'Historial visible. Clica per carregar un mes més' : 'Tot l\'historial és visible'}">` +
      `📅 fins <b>${monthLabel(cur.key)}</b>${more ? ' ＋' : ''}</span>`;
  }
  $('stats').innerHTML = html;
  const tt = $('tags-toggle');
  if (tt) tt.onclick = () => { filtersOpen = !filtersOpen; renderStats(); buildFilters(); updateMenuState(); };
  const nt = $('new-toggle');
  if (nt) nt.onclick = () => { onlyNew = !onlyNew; renderStats(); render(); updateMenuState(); };
  const ht = $('hist-toggle');
  if (ht && SHOWN < MONTHS.length) ht.onclick = () => showMonths(SHOWN + 1);
  const ft = $('follow-toggle');
  if (ft) ft.onclick = openFollowModal;
}

// ---- Menú (☰): cercador, tags, novetats, columnes, tema, accions API ----
function applySearch() { const c = $('controls'); if (c) c.style.display = searchOpen ? '' : 'none'; }

function shiftNew(days) {
  NEW_OFFSET += days;
  writeNewOffset(NEW_OFFSET);
  renderStats(); render();
  const label = NEW_OFFSET === 0 ? "a l'última visita"
    : (NEW_OFFSET > 0 ? '+' : '') + NEW_OFFSET + (Math.abs(NEW_OFFSET) === 1 ? ' dia' : ' dies') + ' respecte l’última visita';
  toast('Llindar de novetats: ' + label + '.', 'ok');
}

function updateMenuState() {
  const set = (act, on) => { const el = document.querySelector('.menu-item[data-act="' + act + '"]'); if (el) el.classList.toggle('on', !!on); };
  set('search', searchOpen); set('tags', filtersOpen); set('new', onlyNew);
}

function menuAction(act) {
  switch (act) {
    case 'search': searchOpen = !searchOpen; writeSearchOpen(searchOpen); applySearch(); updateMenuState(); break;
    case 'tags': filtersOpen = !filtersOpen; renderStats(); buildFilters(); updateMenuState(); break;
    case 'new': onlyNew = !onlyNew; renderStats(); render(); updateMenuState(); break;
    case 'new-dec': shiftNew(-1); break;
    case 'new-inc': shiftNew(1); break;
    case 'follow': openFollowModal(); break;
    case 'hist-more': showMonths(SHOWN + 1); break;
    case 'hist-less': showMonths(SHOWN - 1); break;
    case 'cols-dec': colsDec(); break;
    case 'cols-inc': colsInc(); break;
    case 'theme': toggleTheme(); break;
    case 'token': promptToken(); break;
    case 'admin': openUsersModal(); break;
    case 'add': addLink(); break;
    case 'about': openAboutModal(); break;
  }
}

function openAboutModal() {
  const meta = document.querySelector('meta[name="app-version"]');
  const ver = meta ? meta.getAttribute('content') : '';
  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>❓ Què és això?</h3><button class="modal-x" title="Tanca">✕</button></div>
    <div class="modal-body">
      <p><strong>Clio</strong> és un LinkAnalyzer: recull enllaços, els analitza i en genera
      resums, tipus i sentiment amb IA. Aquesta web mostra tot el que ha recollit,
      amb cerca, filtres i tags per navegar-hi.</p>
      <p class="about-ver">Versió <strong>${esc(ver)}</strong></p>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc2); };
  function esc2(e){ if(e.key==='Escape') close(); }
  ov.querySelector('.modal-x').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.addEventListener('keydown', esc2);
}

function initMenu() {
  const btn = $('menu-btn'), menu = $('menu');
  if (!btn || !menu) return;
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); updateMenuState(); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('.menu-item'); if (!it) return;
    const act = it.dataset.act;
    // Les accions que obren un prompt/modal tanquen el menú; els toggles el deixen obert.
    if (act === 'token' || act === 'admin' || act === 'add' || act === 'follow') close();
    menuAction(act);
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  applySearch();
  refreshApiItems();
  updateMenuState();
}

// ---- Càrrega progressiva de dades (manifest + shards mensuals) ----

async function fetchJson(path) {
  const r = await fetch(path + '?v=' + DATAV);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

const MONTHS_CA = ['gener','febrer','març','abril','maig','juny','juliol','agost','setembre','octubre','novembre','desembre'];
function monthLabel(key) {
  const p = (key || '').split('-');
  const m = parseInt(p[1], 10);
  return (MONTHS_CA[m - 1] || key) + ' ' + p[0];
}

// Mesos visibles persistits (0 = decideix el defecte inicial).
function readMonthsCookie() { const m = document.cookie.match(/(?:^|;\s*)clio_months=(\d+)/); return m ? parseInt(m[1], 10) : 0; }
function writeMonthsCookie(n) { document.cookie = 'clio_months=' + n + '; path=/; max-age=31536000; SameSite=Lax'; }

// ---- Fonts seguides (cookie clio_follow: {u:[usuaris], c:[categories]}) ----
// null = defecte: la categoria marcada com a default al manifest, o totes les fonts.
function readFollow() {
  const m = document.cookie.match(/(?:^|;\s*)clio_follow=([^;]*)/);
  if (!m) return null;
  try {
    const f = JSON.parse(decodeURIComponent(m[1]));
    return (f && (Array.isArray(f.u) || Array.isArray(f.c))) ? { u: f.u || [], c: f.c || [] } : null;
  } catch (e) { return null; }
}
function writeFollow(f) {
  document.cookie = f
    ? 'clio_follow=' + encodeURIComponent(JSON.stringify(f)) + '; path=/; max-age=31536000; SameSite=Lax'
    : 'clio_follow=; path=/; max-age=0; SameSite=Lax';
}
let FOLLOW = readFollow();

function catByName(n) { return ((MANIFEST && MANIFEST.categories) || []).find(c => c.name === n); }

// Noms de les fonts seguides, resolts contra el manifest. Mai buit si hi ha
// fonts: una selecció que ja no existeix cau al defecte (i el defecte, a tot).
function followedNames() {
  if (!MANIFEST) return new Set();
  const all = MANIFEST.users.map(u => u.name);
  let sel = new Set();
  if (FOLLOW) {
    (FOLLOW.u || []).forEach(n => sel.add(n));
    (FOLLOW.c || []).forEach(cn => { const c = catByName(cn); if (c) c.users.forEach(n => sel.add(n)); });
    sel = new Set([...sel].filter(n => all.includes(n)));
  }
  if (!sel.size) {
    const def = (MANIFEST.categories || []).find(c => c.default);
    (def ? def.users : all).forEach(n => sel.add(n));
    sel = new Set([...sel].filter(n => all.includes(n)));
    if (!sel.size) all.forEach(n => sel.add(n));
  }
  return sel;
}
function followedUsers() {
  if (!MANIFEST) return [];
  const s = followedNames();
  return MANIFEST.users.filter(u => s.has(u.name));
}

// Línia temporal fusionada (mesos desc) de les fonts seguides.
function computeMonths() {
  const agg = new Map();
  for (const u of followedUsers()) {
    for (const m of u.months) agg.set(m.key, (agg.get(m.key) || 0) + m.count);
  }
  MONTHS = [...agg.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

// Carrega totes les parts d'un mes per a cada font seguida que el tingui.
async function loadMonth(key) {
  const jobs = [];
  for (const u of followedUsers()) {
    const m = u.months.find(x => x.key === key);
    if (!m) continue;
    const ck = u.dir + '|' + key;
    if (PART_CACHE.has(ck)) continue;
    PART_CACHE.set(ck, []);
    jobs.push((async () => {
      try {
        const parts = await Promise.all(Array.from({ length: m.parts || 1 },
          (_, p) => fetchJson('data/u/' + u.dir + '/' + key + '-p' + p + '.json')));
        PART_CACHE.set(ck, [].concat.apply([], parts));
      } catch (e) { PART_CACHE.delete(ck); }
    })());
  }
  await Promise.all(jobs);
}

// Reconstrueix ALL amb els SHOWN primers mesos de les fonts seguides.
// Dedup per id: un link co-reportat apareix al shard de cada reporter.
function rebuildAll() {
  const seen = new Set();
  ALL = [];
  for (const l of EXTRA) { if (!seen.has(l.id)) { seen.add(l.id); ALL.push(l); } }
  const keys = MONTHS.slice(0, SHOWN).map(m => m.key);
  for (const u of followedUsers()) {
    for (const k of keys) {
      const arr = PART_CACHE.get(u.dir + '|' + k) || [];
      for (const l of arr) { if (!seen.has(l.id)) { seen.add(l.id); ALL.push(l); } }
    }
  }
  ALL.sort((a, b) => linkTime(b) - linkTime(a));
}

// Fixa el nombre de mesos visibles (clamp a [1, total]), carregant el que falti.
async function showMonths(n, persist = true) {
  if (STATIC_MODE || !MONTHS.length) return;
  const grow = n > SHOWN;
  n = Math.max(1, Math.min(n, MONTHS.length));
  SHOWN = n;
  if (persist) writeMonthsCookie(n);
  await Promise.all(MONTHS.slice(0, n).map(m => loadMonth(m.key)));
  rebuildAll();
  await ensureEmb();
  // En estirar historial, deixar marge de render perquè el nou mes es vegi.
  if (grow) RENDER_CAP += CAP_STEP;
  refreshHistItems();
  renderStats(); buildFilters(); render();
}

// Re-aplica un canvi de fonts seguides: recalcula mesos i recarrega el que calgui.
async function applyFollow() {
  computeMonths();
  resetCap();
  const n = SHOWN || initialMonths();
  SHOWN = 0; // força showMonths encara que n no canviï
  await showMonths(n, false);
}

// Mesos inicials: cookie si n'hi ha; si no, els que calguin per a ~60 enllaços.
function initialMonths() {
  const c = readMonthsCookie();
  if (c) return c;
  let acc = 0, n = 0;
  for (const m of MONTHS) { n++; acc += m.count; if (acc >= 60) break; }
  return Math.max(n, 1);
}

// Ítems del menú de fonts/historial: només amb manifest (i >1 mes per l'historial).
function refreshHistItems() {
  const fol = document.querySelector('.menu-item[data-act="follow"]');
  const more = document.querySelector('.menu-item[data-act="hist-more"]');
  const less = document.querySelector('.menu-item[data-act="hist-less"]');
  const sep = $('menu-hist-sep');
  const base = !STATIC_MODE && !!MANIFEST;
  const ok = base && MONTHS.length > 1;
  if (fol) fol.hidden = !base;
  if (sep) sep.hidden = !base;
  if (more) { more.hidden = !ok; more.disabled = ok && SHOWN >= MONTHS.length; }
  if (less) { less.hidden = !ok; less.disabled = ok && SHOWN <= 1; }
}

// ---- Modal de fonts i categories ----
function openFollowModal() {
  if (STATIC_MODE || !MANIFEST) return;
  const cats = MANIFEST.categories || [];
  const selC = new Set(FOLLOW ? (FOLLOW.c || []) : cats.filter(c => c.default).map(c => c.name));
  const selU = new Set(FOLLOW ? (FOLLOW.u || []) : []);
  const catTotal = (c) => c.users.reduce((a, n) => {
    const u = MANIFEST.users.find(x => x.name === n);
    return a + (u ? u.total : 0);
  }, 0);

  const ov = document.createElement('div');
  ov.className = 'modal-ov';
  const catRows = cats.map(c =>
    `<label class="flw-row"><input type="checkbox" data-cat="${esc(c.name)}"${selC.has(c.name) ? ' checked' : ''}>
      <span>${esc(c.name)}${c.default ? ' <span class="you">(defecte)</span>' : ''}</span>
      <span class="flw-n" title="${esc(c.users.join(', '))}">${c.users.length} fonts · ${catTotal(c)}</span></label>`).join('');
  const userRows = MANIFEST.users.map(u =>
    `<label class="flw-row"><input type="checkbox" data-user="${esc(u.name)}"${selU.has(u.name) ? ' checked' : ''}>
      <span>@${esc(u.name)}</span>${u.role === 'npc' ? ' <span class="rolebadge user">npc</span>' : ''}
      <span class="flw-n">${u.total}</span></label>`).join('');
  ov.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>👥 Fonts que segueixes</h3><button class="modal-x" title="Tanca">✕</button></div>
    <div class="modal-body">
      ${cats.length ? `<div class="flw-sec"><h4>Categories</h4>${catRows}</div>` : ''}
      <div class="flw-sec"><h4>Fonts</h4>${userRows}</div>
      <div class="flw-foot">
        <span class="flw-hint">Sense selecció es mostra ${cats.some(c => c.default) ? 'la categoria per defecte' : 'tot'}.</span>
        <button id="flw-reset" class="act">Per defecte</button>
        <button id="flw-save" class="act">✓ Desa</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc3); };
  function esc3(e) { if (e.key === 'Escape') close(); }
  ov.querySelector('.modal-x').onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  document.addEventListener('keydown', esc3);

  ov.querySelector('#flw-reset').onclick = async () => {
    FOLLOW = null; writeFollow(null);
    close(); await applyFollow();
    toast('Fonts restaurades al defecte.', 'ok');
  };
  ov.querySelector('#flw-save').onclick = async () => {
    const u = [...ov.querySelectorAll('input[data-user]:checked')].map(i => i.dataset.user);
    const c = [...ov.querySelectorAll('input[data-cat]:checked')].map(i => i.dataset.cat);
    FOLLOW = (u.length || c.length) ? { u, c } : null;
    writeFollow(FOLLOW);
    close(); await applyFollow();
    toast('Fonts actualitzades: ' + followedUsers().length + ' seguides.', 'ok');
  };
}

// ---- Render incremental ----
// Pintar tot el que hi ha carregat de cop és el que crema CPU al mòbil: es
// pinta a trams de CAP_STEP i s'estira amb el botó o fent scroll fins a ell.
const CAP_STEP = 60;
let RENDER_CAP = CAP_STEP;
function resetCap() { RENDER_CAP = CAP_STEP; }
let moreObserver = null;
function observeMore(btn) {
  if (!('IntersectionObserver' in window)) return;
  if (!moreObserver) {
    moreObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (en.isIntersecting) { moreObserver.unobserve(en.target); en.target.click(); }
      }
    }, { rootMargin: '600px' });
  }
  moreObserver.observe(btn);
}

// Fallback file:// (o manifest absent): injecta data/links.js amb tot l'índex
// lleuger incrustat. Sense embeddings ni historial per mesos.
function loadFallbackScript() {
  return new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'data/links.js?v=' + DATAV;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function loadData() {
  if (location.protocol !== 'file:') {
    try {
      const m = await fetchJson('data/manifest.json');
      if (m && Array.isArray(m.users)) { MANIFEST = m; return; }
    } catch (e) {}
  }
  STATIC_MODE = true;
  await loadFallbackScript();
  ALL = Array.isArray(window.__LINKS__) ? window.__LINKS__ : [];
  ALL.sort((a, b) => linkTime(b) - linkTime(a));
}

(async function init() {
  initTheme();
  initCols();
  await probeApi();
  await loadMe();
  initMenu();
  await loadData();
  applyHash();
  if (MANIFEST) {
    computeMonths();
    await showMonths(initialMonths(), false);
  } else {
    renderStats();
    buildFilters();
    render();
  }
  refreshHistItems();
  window.addEventListener('hashchange', () => { resetCap(); onHashChange(); });
  $('search').addEventListener('input', () => { resetCap(); render(); });
  $('type-filter').addEventListener('change', () => { resetCap(); render(); });
  $('sent-filter').addEventListener('change', () => { resetCap(); render(); });
  // Marca aquesta visita: els links nous deixaran de ser-ho a la pròxima.
  writeLastVisit(Date.now());
})();
