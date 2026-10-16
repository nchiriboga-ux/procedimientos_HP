/* Procedimientos HP Drilling Services S.A.S — app web offline
   Almacena PDFs en IndexedDB del dispositivo. Cada QR contiene solo "DOC:<ID>";
   la app resuelve ese ID al PDF local. No usa servidores. */
'use strict';

const APP_VERSION = '1.0.2';
const QR_PREFIX = 'DOC:';
const PKG_FORMAT = 'docqr-package';
const DEFAULT_CATS = ['Seguridad Industrial', 'Salud Ocupacional', 'Gestión Ambiental', 'Procedimientos operativos', 'Planes de emergencia', 'Instructivos', 'Otros'];

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const fmtBytes = n => n == null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fmtDate = s => { if (!s) return '—'; const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s); return isNaN(d) ? String(s) : d.toLocaleDateString('es-EC', { year: 'numeric', month: 'short', day: 'numeric' }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normId(s) {
  return String(s || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-').replace(/[^A-Z0-9._-]/g, '').slice(0, 64);
}
function payloadFor(id) { return QR_PREFIX + id; }
const CODE_RE = /\b([A-Z]{1,4}-[A-Z]{1,5}-\d{2,4})\b/i;
function parsePayload(text) {
  const t = String(text || '').trim();
  let m = t.match(/^DOC:([A-Za-z0-9._-]{1,64})$/i);
  if (m) return normId(m[1]);
  if (/^[A-Za-z0-9._-]{2,64}$/.test(t)) return normId(t);
  m = t.split('\n')[0].match(CODE_RE);          // compatibilidad con etiquetas de texto anteriores
  return m ? normId(m[1]) : null;
}
function verNums(v) { const n = String(v || '').match(/\d+/g); return n ? n.map(Number) : []; }
function cmpVer(a, b) {
  const x = verNums(a), y = verNums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function isPdf(buf) { const b = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)); const s = String.fromCharCode(...b); return s.includes('%PDF-'); }
function statusOf(d) {
  if (!d.hasFile) return 'pending';
  if (d.fileVersion && cmpVer(d.version, d.fileVersion) > 0) return 'outdated';
  return 'ok';
}
const STATUS_LABEL = { ok: 'Disponible', pending: 'Pendiente de importar', outdated: 'Versión desactualizada' };
function guessFromFilename(name) {
  let base = name.replace(/\.pdf$/i, '');
  const m = base.match(CODE_RE);
  const code = m ? normId(m[1]) : normId(base).slice(0, 24);
  let title = base;
  if (m) title = base.slice(base.toUpperCase().indexOf(m[1].toUpperCase()) + m[1].length);
  title = title.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–.]+|[\s\-–.]+$/g, '');
  return { code, name: title || base };
}
function guessCategory(code) {
  if (/^PL-/.test(code)) return 'Planes de emergencia';
  if (/^I-/.test(code)) return 'Instructivos';
  if (/-SI-|-SST-|-SEG-/.test(code)) return 'Seguridad Industrial';
  if (/-SO-|-SAL-/.test(code)) return 'Salud Ocupacional';
  if (/-CA-|-AMB-/.test(code)) return 'Gestión Ambiental';
  if (/-OP|-MTTO/.test(code)) return 'Procedimientos operativos';
  return 'Otros';
}

/* ---------- base de datos local (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('docqr', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('docs', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: 'id' });
        d.createObjectStore('settings', { keyPath: 'key' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode);
      let out;
      const r = fn(t);
      if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Transacción cancelada'));
    });
  },
  get(store, key) { return this.req(store, 'readonly', t => t.objectStore(store).get(key)); },
  all(store) { return this.req(store, 'readonly', t => t.objectStore(store).getAll()); },
  put(store, val) { return this.req(store, 'readwrite', t => t.objectStore(store).put(val)); },
  del(store, key) { return this.req(store, 'readwrite', t => t.objectStore(store).delete(key)); },
  putDocAndFile(doc, buf) {
    return this.req(['docs', 'files'], 'readwrite', t => {
      t.objectStore('docs').put(doc);
      if (buf) t.objectStore('files').put({ id: doc.id, data: buf });
    });
  },
  deleteDoc(id) {
    return this.req(['docs', 'files'], 'readwrite', t => { t.objectStore('docs').delete(id); t.objectStore('files').delete(id); });
  }
};
async function setting(key, fallback) { const r = await DB.get('settings', key); return r ? r.value : fallback; }
async function setSetting(key, value) { await DB.put('settings', { key, value }); }
async function getFile(id) { const f = await DB.get('files', id); return f ? f.data : null; }

/* ---------- estado ---------- */
const S = { docs: [], cats: DEFAULT_CATS.slice(), filter: { q: '', cat: '', status: '', fav: false }, admin: false, pin: null, restrictAdmin: true, lockApp: false, importQueue: [] };
async function refresh() {
  S.docs = (await DB.all('docs')).sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true }));
  S.cats = await setting('categories', DEFAULT_CATS.slice());
}
const findDoc = id => S.docs.find(d => d.id === id);

/* ---------- interfaz: toast y modales ---------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function modal({ title, html = '', actions = [{ label: 'Cerrar', value: null }], onOpen }) {
  return new Promise(resolve => {
    const root = $('#modalRoot');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><div class="m-body">${html}</div>
      <div class="m-actions">${actions.map((a, i) => `<button class="btn block ${a.kind || ''}" data-i="${i}" type="button">${esc(a.label)}</button>`).join('')}</div></div>`;
    root.appendChild(back);
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('click', async e => {
      if (e.target === back) { close(null); return; }
      const b = e.target.closest('[data-i]'); if (!b) return;
      const a = actions[+b.dataset.i];
      if (a.handler) { const r = await a.handler(back); if (r === false) return; close(r === undefined ? a.value : r); }
      else close(a.value);
    });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    if (onOpen) onOpen(back);
    const f = back.querySelector('input,select,textarea,button'); if (f) setTimeout(() => f.focus(), 30);
  });
}
const confirmModal = (title, text, okLabel = 'Confirmar', kind = 'danger') =>
  modal({ title, html: `<p>${text}</p>`, actions: [{ label: okLabel, value: true, kind }, { label: 'Cancelar', value: false }] });

/* ---------- PIN ---------- */
async function pinHash(pin, saltHex) {
  const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256);
  const hex = a => Array.from(new Uint8Array(a)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { salt: hex(salt), hash: hex(bits) };
}
async function askPin(title, text = '') {
  return modal({
    title,
    html: `${text ? `<p class="muted">${esc(text)}</p>` : ''}<input class="pin-input" id="pinIn" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN">
           <p class="small muted" id="pinErr" style="margin-top:8px"></p>`,
    actions: [{
      label: 'Aceptar', kind: 'primary', handler: async m => {
        const v = $('#pinIn', m).value.trim();
        if (!S.pin) return v;
        const h = await pinHash(v, S.pin.salt);
        if (h.hash === S.pin.hash) return true;
        $('#pinErr', m).textContent = 'PIN incorrecto. Inténtalo de nuevo.'; $('#pinIn', m).value = ''; return false;
      }
    }, { label: 'Cancelar', value: null }],
    onOpen: m => $('#pinIn', m).addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-i="0"]', m).click(); })
  });
}
async function requireAdmin() {
  if (!S.pin || !S.restrictAdmin || S.admin) return true;
  const ok = await askPin('Modo administrador', 'Esta acción está reservada a administradores.');
  if (ok === true) { S.admin = true; toast('Modo administrador activo'); return true; }
  return false;
}

/* ---------- QR ---------- */
function qrObj(text) { const q = qrcode(0, 'M'); q.addData(text, 'Byte'); q.make(); return q; }
function drawQR(canvas, text, targetPx = 600) {
  const q = qrObj(text), n = q.getModuleCount(), quiet = 4;
  const cell = Math.max(2, Math.floor(targetPx / (n + quiet * 2)));
  const size = cell * (n + quiet * 2);
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); c.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) c.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
  return canvas;
}
function wrapLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width <= maxW) cur = t; else { if (cur) lines.push(cur); cur = w; } }
  if (cur) lines.push(cur); return lines;
}
function labelCanvas(d) {
  const W = 1200, qrPx = 1000;
  const qc = drawQR(document.createElement('canvas'), payloadFor(d.id), qrPx);
  const cv = document.createElement('canvas'); const c = cv.getContext('2d');
  c.font = 'bold 50px system-ui, Arial, sans-serif';
  const nameLines = wrapLines(c, d.name || d.id, W - 120).slice(0, 3);
  const H = 60 + qc.height + 30 + nameLines.length * 62 + 60 + 50 + 50;
  cv.width = W; cv.height = H;
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f2c200'; c.fillRect(0, 0, W, 24);
  c.drawImage(qc, (W - qc.width) / 2, 50);
  let y = 50 + qc.height + 40;
  c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'top';
  c.font = 'bold 50px system-ui, Arial, sans-serif';
  for (const l of nameLines) { c.fillText(l, W / 2, y); y += 62; }
  c.font = '600 40px ui-monospace, Menlo, Consolas, monospace';
  c.fillText([d.id, d.version].filter(Boolean).join('  ·  '), W / 2, y + 6); y += 56;
  c.font = '36px system-ui, Arial, sans-serif'; c.fillStyle = '#444';
  c.fillText(d.category || '', W / 2, y + 6);
  return cv;
}
const canvasBlob = cv => new Promise(r => cv.toBlob(r, 'image/png'));

async function qrSheetPdf(docs) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const cols = 2, rows = 3, mx = 10, my = 10, cw = (210 - 2 * mx) / cols, ch = (297 - 2 * my) / rows;
  docs.forEach((d, i) => {
    if (i && i % (cols * rows) === 0) pdf.addPage();
    const k = i % (cols * rows), x = mx + (k % cols) * cw, y = my + Math.floor(k / cols) * ch;
    pdf.setLineDashPattern([1.5, 1.5], 0); pdf.setDrawColor(150); pdf.rect(x + 1, y + 1, cw - 2, ch - 2);
    pdf.setLineDashPattern([], 0);
    pdf.setFillColor(242, 194, 0); pdf.rect(x + 1, y + 1, cw - 2, 3, 'F');
    const qs = 52, q = qrObj(payloadFor(d.id)), n = q.getModuleCount(), cell = qs / (n + 8);
    const qx = x + (cw - qs) / 2 + 4 * cell, qy = y + 7 + 4 * cell;
    pdf.setFillColor(0, 0, 0);
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) pdf.rect(qx + k * cell, qy + r * cell, cell + 0.02, cell + 0.02, 'F');
    let ty = y + 7 + qs + 6;
    pdf.setTextColor(17); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10.5);
    const lines = pdf.splitTextToSize(d.name || d.id, cw - 12).slice(0, 2);
    lines.forEach(l => { pdf.text(l, x + cw / 2, ty, { align: 'center' }); ty += 4.6; });
    pdf.setFont('courier', 'bold'); pdf.setFontSize(10);
    pdf.text([d.id, d.version].filter(Boolean).join('  ·  '), x + cw / 2, ty + 1, { align: 'center' }); ty += 5;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(80);
    pdf.text(d.category || '', x + cw / 2, ty + 1, { align: 'center' }); ty += 5;
    pdf.setFontSize(7.5); pdf.text('Escanear con la app Procedimientos HP - funciona sin internet', x + cw / 2, y + ch - 4, { align: 'center' });
  });
  return pdf.output('blob');
}

/* ---------- entregar archivos (compartir / guardar) ---------- */
async function deliverFile(blob, filename, title = 'Archivo listo') {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const actions = [];
  if (canShare) actions.push({ label: 'Compartir / Guardar en Archivos', kind: 'primary', handler: async () => { try { await navigator.share({ files: [file], title: filename }); return true; } catch (e) { if (e.name === 'AbortError') return false; toast('No se pudo compartir: ' + e.message); return false; } } });
  actions.push({ label: 'Descargar', kind: canShare ? '' : 'primary', handler: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return true; } });
  actions.push({ label: 'Cerrar', value: null });
  return modal({ title, html: `<p><span class="mono small">${esc(filename)}</span><br><span class="muted small">${fmtBytes(blob.size)}</span></p>`, actions });
}

/* ---------- vistas ---------- */
const ICON = {
  import: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  lib: '<svg viewBox="0 0 24 24"><path d="M5 4h4v16H5zM10 4h4v16h-4zM15.5 5l3.8-1 3 15.5-3.8 1z"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4"/></svg>',
  pkgOut: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4v10l-9 4-9-4zM12 11v10M3 7l9 4 9-4"/></svg>',
  pkgIn: '<svg viewBox="0 0 24 24"><path d="M12 3v10M8 9l4 4 4-4M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>',
  cats: '<svg viewBox="0 0 24 24"><path d="M3 6h7l2 2h9v11H3z"/></svg>',
  cfg: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
};
function setTitle(t, back = false) { $('#viewTitle').textContent = t; $('#backBtn').hidden = !back; document.title = t + ' · Procedimientos HP'; }
function setTab(tab) { $$('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab)); }
const main = () => $('#main');

function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (location.hash === '#/inicio' || !location.hash) route(); });

function viewHome() {
  setTitle('Procedimientos HP Drilling Services S.A.S'); setTab('inicio');
  const c = { ok: 0, pending: 0, outdated: 0 }; S.docs.forEach(d => c[statusOf(d)]++);
  const favs = S.docs.filter(d => d.favorite).slice(0, 6);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const install = isStandalone() ? '' : `<div class="notice"><b>Instala la app en este dispositivo.</b> ${ios
    ? 'En Safari toca <b>Compartir</b> y luego <b>Agregar a pantalla de inicio</b>. Importa los documentos <u>después</u> de abrirla desde el ícono: en iPhone la app instalada y Safari guardan datos por separado.'
    : (deferredInstall ? '<br><button class="btn signal" data-act="install" style="margin-top:8px">Instalar ahora</button>' : 'En Chrome abre el menú ⋮ y elige <b>Instalar app</b> o <b>Agregar a pantalla principal</b>.')}</div>`;
  main().innerHTML = `${install}
    <button class="scan-hero" data-act="scan">${ICON.scan}<div><strong>Escanear QR</strong><span>Abre el documento al instante, sin internet</span></div></button>
    <div class="stats">
      <a class="stat ok" href="#/biblioteca?s=ok"><b>${c.ok}</b><span>Disponibles</span></a>
      <a class="stat pending" href="#/biblioteca?s=pending"><b>${c.pending}</b><span>Pendientes</span></a>
      <a class="stat outdated" href="#/biblioteca?s=outdated"><b>${c.outdated}</b><span>Desactualizados</span></a>
    </div>
    <h2>Funciones</h2>
    <div class="tiles">
      <a class="tile" href="#/importar">${ICON.import}Importar PDF<small>Solo administrador</small></a>
      <a class="tile" href="#/biblioteca">${ICON.lib}Biblioteca documental<small>${S.docs.length} documentos</small></a>
      <a class="tile" href="#/escanear">${ICON.scan}Escanear QR<small>Cámara del dispositivo</small></a>
      <a class="tile" href="#/qr">${ICON.qr}Generar códigos QR<small>PNG y hojas para imprimir</small></a>
      <a class="tile" href="#/paquetes?a=export">${ICON.pkgOut}Crear paquete offline<small>Para otros dispositivos</small></a>
      <a class="tile" href="#/paquetes?a=import">${ICON.pkgIn}Importar paquete offline<small>Verifica integridad</small></a>
      <a class="tile" href="#/categorias">${ICON.cats}Administrar categorías<small>${S.cats.length} categorías</small></a>
      <a class="tile" href="#/ajustes">${ICON.cfg}Configuración<small>PIN y almacenamiento</small></a>
    </div>
    ${favs.length ? `<h2>Favoritos</h2><div class="list">${favs.map(docRow).join('')}</div>` : ''}
    ${S.docs.length ? '' : `<div class="empty"><p><b>La biblioteca está vacía.</b></p><p>Importa un paquete offline o tus PDF para empezar.</p></div>`}`;
}

function docRow(d) {
  const st = statusOf(d);
  return `<a class="doc" href="#/doc/${encodeURIComponent(d.id)}">
    <span class="dot ${st}" title="${STATUS_LABEL[st]}" aria-label="${STATUS_LABEL[st]}"></span>
    <span class="body"><span class="code">${esc(d.id)}${d.version ? ' · ' + esc(d.version) : ''}</span><br>
      <span class="name">${esc(d.name)}</span>
      <span class="meta">${esc(d.category || '')}${st !== 'ok' ? ' · ' + STATUS_LABEL[st] : ''}</span></span>
    <span class="fav">${d.favorite ? '★' : ''}</span></a>`;
}
function matches(d) {
  const f = S.filter;
  if (f.cat && d.category !== f.cat) return false;
  if (f.status && statusOf(d) !== f.status) return false;
  if (f.fav && !d.favorite) return false;
  if (f.q) {
    const hay = [d.id, d.name, d.category, d.area, d.keywords, d.version].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const words = f.q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
    if (!words.every(w => hay.includes(w))) return false;
  }
  return true;
}
function viewLibrary(params) {
  setTitle('Biblioteca'); setTab('biblioteca');
  if (params.get('s')) { S.filter.status = params.get('s'); }
  const chip = (key, val, label) => `<button class="chip ${S.filter[key] === val ? 'on' : ''}" data-act="filter" data-k="${key}" data-v="${esc(val)}">${esc(label)}</button>`;
  main().innerHTML = `
    <div class="search">${ICON.search}<input id="q" type="search" placeholder="Buscar por nombre, código, categoría o palabra clave" value="${esc(S.filter.q)}" aria-label="Buscar"></div>
    <div class="chips">${chip('status', '', 'Todos')}${chip('status', 'ok', 'Disponibles')}${chip('status', 'pending', 'Pendientes')}${chip('status', 'outdated', 'Desactualizados')}
      <button class="chip ${S.filter.fav ? 'on' : ''}" data-act="fav-filter">★ Favoritos</button></div>
    <div class="chips">${chip('cat', '', 'Todas las categorías')}${S.cats.map(c => chip('cat', c, c)).join('')}</div>
    <div class="row" style="margin:6px 0 12px"><a class="btn primary" href="#/importar">${ICON.import} Importar PDF</a></div>
    <div class="list" id="docList"></div>`;
  renderList();
  $('#q').addEventListener('input', e => { S.filter.q = e.target.value; renderList(); });
}
function renderList() {
  const items = S.docs.filter(matches);
  $('#docList').innerHTML = items.length ? items.map(docRow).join('')
    : `<div class="empty">${S.docs.length ? 'No hay documentos que coincidan con la búsqueda.' : 'La biblioteca está vacía. Importa un paquete offline o tus PDF.'}</div>`;
}

async function viewDoc(id) {
  const d = findDoc(id);
  setTab('biblioteca'); setTitle(d ? d.id : 'Documento', true);
  if (!d) { main().innerHTML = notFoundHtml(id); return; }
  const st = statusOf(d);
  const hist = (d.history || []).slice().reverse();
  main().innerHTML = `
    <div class="card">
      <div class="doc-head"><div><span class="pill ${st}">${STATUS_LABEL[st]}</span><h3>${esc(d.name)}</h3></div>
        <button class="icon-btn" data-act="fav" data-id="${esc(d.id)}" aria-label="Favorito" style="font-size:24px;color:var(--signal)">${d.favorite ? '★' : '☆'}</button></div>
      ${st === 'pending' ? `<div class="notice">Este documento está en el catálogo pero su PDF no está en este dispositivo. Importa el paquete offline que lo contiene o el PDF.</div>` : ''}
      ${st === 'outdated' ? `<div class="notice">El PDF guardado es la versión <b>${esc(d.fileVersion)}</b>, pero el catálogo indica la versión <b>${esc(d.version)}</b>. Importa el paquete actualizado.</div>` : ''}
      ${d.integrityError ? `<div class="notice bad">El último paquete traía este PDF dañado o alterado (falló la verificación SHA-256), por eso no se guardó.</div>` : ''}
      <dl class="kv">
        <dt>Código</dt><dd class="mono">${esc(d.id)}</dd>
        <dt>Versión</dt><dd>${esc(d.version || '—')}${d.hasFile && d.fileVersion && d.fileVersion !== d.version ? ` (PDF: ${esc(d.fileVersion)})` : ''}</dd>
        <dt>Actualizado</dt><dd>${fmtDate(d.updated)}</dd>
        <dt>Categoría</dt><dd>${esc(d.category || '—')}</dd>
        <dt>Área</dt><dd>${esc(d.area || '—')}</dd>
        ${d.keywords ? `<dt>Palabras clave</dt><dd>${esc(d.keywords)}</dd>` : ''}
        <dt>Tamaño</dt><dd>${d.hasFile ? fmtBytes(d.size) : '—'}</dd>
        <dt>SHA-256</dt><dd class="mono small">${d.sha256 ? esc(d.sha256.slice(0, 16)) + '…' : '—'}</dd>
        <dt>Contenido QR</dt><dd class="mono">${esc(payloadFor(d.id))}</dd>
      </dl>
      <div class="actions">
        <button class="btn primary wide" data-act="open" data-id="${esc(d.id)}" ${d.hasFile ? '' : 'disabled'}>Abrir documento</button>
        <a class="btn" href="#/qr/${encodeURIComponent(d.id)}">Ver QR</a>
        <button class="btn" data-act="share-pdf" data-id="${esc(d.id)}" ${d.hasFile ? '' : 'disabled'}>Compartir PDF</button>
        <button class="btn" data-act="edit" data-id="${esc(d.id)}">Editar datos</button>
        <button class="btn" data-act="replace" data-id="${esc(d.id)}">Nueva versión PDF</button>
        <button class="btn danger wide" data-act="delete" data-id="${esc(d.id)}">Eliminar</button>
      </div>
    </div>
    ${hist.length ? `<h2>Versiones anteriores</h2><div class="card small">${hist.map(h => `<div>${esc(h.version || '—')} · ${fmtDate(h.updated)} · reemplazada el ${fmtDate(h.replacedAt)}</div>`).join('')}</div>` : ''}`;
}
function notFoundHtml(id) {
  return `<div class="notice bad"><b>${esc(id)}</b> no está en la biblioteca de este dispositivo.</div>
    <p>Importa el paquete offline que contiene este documento, o su PDF si eres administrador.</p>
    <div class="row"><a class="btn primary" href="#/paquetes?a=import">Importar paquete</a><a class="btn" href="#/importar">Importar PDF</a></div>`;
}

/* ---------- importar PDF ---------- */
async function viewImport() {
  setTitle('Importar PDF', true); setTab('biblioteca');
  if (!(await requireAdmin())) { history.back(); return; }
  main().innerHTML = `
    <p class="muted">Elige uno o varios PDF. El código documental es el identificador permanente del QR: no cambia aunque subas nuevas versiones.</p>
    <label class="btn primary block" style="cursor:pointer">${ICON.import} Elegir archivos PDF
      <input id="pdfInput" type="file" accept="application/pdf,.pdf" multiple hidden></label>
    <div id="queue" style="margin-top:14px"></div>`;
  $('#pdfInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    toast('Leyendo ' + files.length + ' archivo(s)…');
    S.importQueue = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      if (!isPdf(buf)) { S.importQueue.push({ file: f, bad: true }); continue; }
      const sha = await sha256(buf);
      const g = guessFromFilename(f.name);
      S.importQueue.push({ file: f, buf, sha, code: g.code, name: g.name, category: guessCategory(g.code), area: '', version: '', updated: today(), keywords: '' });
    }
    renderQueue();
  });
}
function queueChecks(item) {
  const id = normId(item.code); const out = [];
  if (!id) out.push(['warn', 'Falta el código documental.']);
  const same = S.docs.find(d => d.sha256 === item.sha && d.hasFile);
  if (same) out.push(['warn', `Archivo idéntico al ya guardado como ${same.id}. No se importará de nuevo.`]);
  const ex = findDoc(id);
  if (ex && (!same || same.id !== id)) {
    const c = cmpVer(item.version, ex.fileVersion || ex.version);
    if (!ex.hasFile) out.push(['ok', `Completa el documento pendiente ${id}.`]);
    else if (c < 0) out.push(['warn', `Ya existe ${id} versión ${ex.fileVersion || ex.version}. Esta es una versión ANTERIOR.`]);
    else if (c === 0) out.push(['warn', `Ya existe ${id} con la misma versión (${ex.fileVersion || ex.version || 'sin versión'}). Se reemplazará el PDF.`]);
    else out.push(['ok', `Reemplazará la versión ${ex.fileVersion || ex.version || 'anterior'} de ${id}. El QR impreso sigue funcionando.`]);
  }
  const dupInQueue = S.importQueue.filter(q => !q.bad && normId(q.code) === id).length > 1;
  if (dupInQueue) out.push(['warn', 'Hay otro archivo en esta lista con el mismo código.']);
  return out;
}
function renderQueue() {
  const q = $('#queue');
  const catOpts = v => S.cats.map(c => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('');
  q.innerHTML = S.importQueue.map((it, i) => it.bad
    ? `<div class="card"><b>${esc(it.file.name)}</b><div class="warnline">No es un PDF válido y se omitirá.</div></div>`
    : `<div class="card" data-q="${i}">
        <p class="small muted" style="margin-bottom:8px">${esc(it.file.name)} · ${fmtBytes(it.buf.byteLength)}</p>
        <div class="form">
          <label class="f">Código documental<input data-f="code" value="${esc(it.code)}" autocapitalize="characters"></label>
          <label class="f">Versión<input data-f="version" value="${esc(it.version)}" placeholder="Ej. 4.0"></label>
          <label class="f full">Nombre<input data-f="name" value="${esc(it.name)}"></label>
          <label class="f">Categoría<select data-f="category">${catOpts(it.category)}</select></label>
          <label class="f">Área responsable<input data-f="area" value="${esc(it.area)}"></label>
          <label class="f">Fecha de actualización<input data-f="updated" type="date" value="${esc(it.updated)}"></label>
          <label class="f">Palabras clave<input data-f="keywords" value="${esc(it.keywords)}"></label>
        </div><div class="checks"></div></div>`).join('') +
    (S.importQueue.some(x => !x.bad) ? `<button class="btn signal block" data-act="save-queue" style="margin-top:12px">Guardar en la biblioteca</button>` : '');
  $$('[data-q]', q).forEach(card => {
    const it = S.importQueue[+card.dataset.q];
    const upd = () => { $('.checks', card).innerHTML = queueChecks(it).map(([k, t]) => `<div class="${k === 'ok' ? 'okline' : 'warnline'}">${esc(t)}</div>`).join(''); };
    card.addEventListener('input', e => { const f = e.target.dataset.f; if (f) { it[f] = e.target.value; if (f === 'code') $$('[data-q]', q).forEach(c => c.dispatchEvent(new Event('recheck'))); upd(); } });
    card.addEventListener('recheck', upd);
    upd();
  });
}
async function saveDoc(meta, buf, sha) {
  const id = normId(meta.code);
  const prev = await DB.get('docs', id);
  const history = (prev && prev.history) ? prev.history.slice() : [];
  if (prev && prev.hasFile && prev.sha256 !== sha) history.push({ version: prev.fileVersion || prev.version, updated: prev.updated, sha256: prev.sha256, replacedAt: new Date().toISOString() });
  const doc = {
    ...(prev || {}), id, code: id,
    name: meta.name || id, category: meta.category || 'Otros', area: meta.area || '', version: meta.version || '',
    updated: meta.updated || today(), keywords: meta.keywords || '',
    sha256: sha, size: buf.byteLength, hasFile: true, fileVersion: meta.version || '', integrityError: false,
    importedAt: new Date().toISOString(), favorite: prev ? !!prev.favorite : false, history: history.slice(-20)
  };
  await DB.putDocAndFile(doc, buf);
  return { doc, replaced: !!(prev && prev.hasFile) };
}
async function saveQueue() {
  const items = S.importQueue.filter(x => !x.bad);
  const report = []; let saved = 0;
  for (const it of items) {
    const id = normId(it.code);
    if (!id) { report.push(`✗ ${it.file.name}: falta el código`); continue; }
    const same = S.docs.find(d => d.sha256 === it.sha && d.hasFile);
    if (same) { report.push(`= ${id}: idéntico a ${same.id}, omitido`); continue; }
    const ex = findDoc(id);
    if (ex && ex.hasFile && cmpVer(it.version, ex.fileVersion || ex.version) < 0) {
      const ok = await confirmModal('Versión anterior', `Vas a reemplazar <b>${esc(id)}</b> versión ${esc(ex.fileVersion || ex.version)} por la versión <b>${esc(it.version || 'sin versión')}</b>, que es anterior. ¿Continuar?`, 'Reemplazar de todas formas');
      if (!ok) { report.push(`– ${id}: no se reemplazó (versión anterior)`); continue; }
    }
    const r = await saveDoc(it, it.buf, it.sha);
    saved++; report.push(`✓ ${id}: ${r.replaced ? 'nueva versión guardada' : 'importado'}`);
    await refresh();
  }
  await requestPersist();
  await refresh();
  await modal({ title: `${saved} documento(s) guardado(s)`, html: `<div class="report">${report.map(r => `<div>${esc(r)}</div>`).join('')}</div>`, actions: [{ label: 'Ir a la biblioteca', value: 1, kind: 'primary' }] });
  S.importQueue = [];
  location.hash = '#/biblioteca';
}

/* ---------- editar / reemplazar / eliminar ---------- */
async function editDoc(id) {
  if (!(await requireAdmin())) return;
  const d = findDoc(id);
  const catOpts = S.cats.map(c => `<option ${c === d.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const r = await modal({
    title: 'Editar ' + d.id,
    html: `<p class="small muted">El código <b class="mono">${esc(d.id)}</b> es permanente porque está impreso en los QR.</p>
      <div class="form">
        <label class="f full">Nombre<input id="e_name" value="${esc(d.name)}"></label>
        <label class="f">Versión del catálogo<input id="e_version" value="${esc(d.version)}"></label>
        <label class="f">Fecha de actualización<input id="e_updated" type="date" value="${esc((d.updated || '').slice(0, 10))}"></label>
        <label class="f">Categoría<select id="e_category">${catOpts}</select></label>
        <label class="f">Área responsable<input id="e_area" value="${esc(d.area)}"></label>
        <label class="f full">Palabras clave<input id="e_keywords" value="${esc(d.keywords)}"></label>
      </div>`,
    actions: [{ label: 'Guardar cambios', kind: 'primary', handler: m => ({ name: $('#e_name', m).value.trim(), version: $('#e_version', m).value.trim(), updated: $('#e_updated', m).value, category: $('#e_category', m).value, area: $('#e_area', m).value.trim(), keywords: $('#e_keywords', m).value.trim() }) }, { label: 'Cancelar', value: null }]
  });
  if (!r) return;
  await DB.put('docs', { ...d, ...r, name: r.name || d.name });
  await refresh(); toast('Cambios guardados'); route();
}
function pickFile(accept) {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.hidden = true;
    i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); });
    document.body.appendChild(i); i.click();
  });
}
async function replacePdf(id) {
  if (!(await requireAdmin())) return;
  const d = findDoc(id);
  const f = await pickFile('application/pdf,.pdf'); if (!f) return;
  const buf = await f.arrayBuffer();
  if (!isPdf(buf)) { toast('El archivo no es un PDF válido'); return; }
  const sha = await sha256(buf);
  if (sha === d.sha256) { toast('Es el mismo archivo que ya está guardado'); return; }
  const r = await modal({
    title: 'Nueva versión de ' + d.id,
    html: `<p class="small muted">Versión actual del PDF: <b>${esc(d.fileVersion || d.version || '—')}</b>. El QR no cambia.</p>
      <div class="form"><label class="f">Nueva versión<input id="r_v" value="" placeholder="Ej. 5.0"></label>
      <label class="f">Fecha<input id="r_d" type="date" value="${today()}"></label></div>`,
    actions: [{ label: 'Guardar nueva versión', kind: 'primary', handler: m => ({ version: $('#r_v', m).value.trim(), updated: $('#r_d', m).value }) }, { label: 'Cancelar', value: null }]
  });
  if (!r) return;
  if (d.hasFile && cmpVer(r.version, d.fileVersion || d.version) < 0 &&
    !(await confirmModal('Versión anterior', `La versión ${esc(r.version)} es anterior a la guardada (${esc(d.fileVersion || d.version)}). ¿Reemplazar igual?`, 'Reemplazar'))) return;
  await saveDoc({ ...d, ...r }, buf, sha); await refresh(); toast('Nueva versión guardada'); route();
}
async function deleteDoc(id) {
  if (!(await requireAdmin())) return;
  const d = findDoc(id);
  const ok = await confirmModal('Eliminar documento', `Se eliminará <b>${esc(d.id)} – ${esc(d.name)}</b> de este dispositivo. Los QR impresos dejarán de abrir el documento aquí hasta que lo vuelvas a importar.`, 'Eliminar');
  if (!ok) return;
  await DB.deleteDoc(id); await refresh(); toast('Documento eliminado'); location.hash = '#/biblioteca';
}

/* ---------- vista QR ---------- */
function viewQr(id) {
  setTab('inicio');
  if (id) {
    const d = findDoc(id); setTitle('QR ' + id, true);
    if (!d) { main().innerHTML = notFoundHtml(id); return; }
    main().innerHTML = `<div class="qr-box"><canvas id="qrc" aria-label="Código QR de ${esc(d.id)}"></canvas>
      <div class="t">${esc(d.name)}</div><div class="s">${esc(d.id)}${d.version ? ' · ' + esc(d.version) : ''}</div><div class="small">${esc(d.category || '')}</div></div>
      <p class="small muted" style="margin-top:10px">Contenido del QR: <span class="mono">${esc(payloadFor(d.id))}</span>. No contiene enlaces web; solo la app lo resuelve al PDF guardado.</p>
      <div class="actions"><button class="btn primary" data-act="qr-png" data-id="${esc(d.id)}">Descargar PNG</button>
      <button class="btn" data-act="qr-sheet-one" data-id="${esc(d.id)}">Hoja PDF</button></div>`;
    drawQR($('#qrc'), payloadFor(d.id), 560);
    return;
  }
  setTitle('Generar códigos QR', true);
  main().innerHTML = `<p class="muted">Elige los documentos para crear una hoja PDF imprimible (6 etiquetas por hoja A4) o abre uno para descargar su PNG.</p>
    <div class="row" style="margin-bottom:10px"><button class="btn" data-act="sel-all">Seleccionar todos</button><button class="btn" data-act="sel-none">Ninguno</button></div>
    <div class="card" id="qrSel">${S.docs.length ? S.docs.map(d => `<label class="check"><input type="checkbox" value="${esc(d.id)}" checked>
      <span><span class="mono small">${esc(d.id)}</span> ${esc(d.name)}</span></label>`).join('') : '<p class="muted">No hay documentos todavía.</p>'}</div>
    <button class="btn signal block" data-act="qr-sheet" style="margin-top:12px" ${S.docs.length ? '' : 'disabled'}>Crear hoja PDF de etiquetas</button>
    <h2>Abrir un QR individual</h2><div class="list">${S.docs.map(d => `<a class="doc" href="#/qr/${encodeURIComponent(d.id)}"><span class="dot ${statusOf(d)}"></span><span class="body"><span class="code">${esc(d.id)}</span><br><span class="name">${esc(d.name)}</span></span><span></span></a>`).join('')}</div>`;
}

/* ---------- paquetes ---------- */
function viewPackages(params) {
  setTitle('Paquetes offline'); setTab('paquetes');
  const focus = params.get('a');
  main().innerHTML = `
    <div class="card" id="pkgExport" ${focus === 'import' ? 'style="order:2"' : ''}>
      <h2 style="margin-top:0">Crear paquete</h2>
      <p class="small muted">Genera un archivo .zip con los PDF, el catálogo, los identificadores QR, las imágenes QR y los hashes SHA-256. Pásalo por cable USB, AirDrop, Bluetooth o una memoria.</p>
      <label class="f" style="margin-bottom:8px">Documentos<select id="pkgCat"><option value="">Todos (${S.docs.length})</option>${S.cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="pkgPdfs" checked> Incluir los archivos PDF</label>
      <p class="small muted">Sin PDFs, el paquete solo actualiza el catálogo: los documentos aparecen como pendientes o desactualizados en el otro dispositivo.</p>
      <button class="btn primary block" data-act="export">Crear paquete</button>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Importar paquete</h2>
      <p class="small muted">Elige el archivo .zip recibido. Se verifica la integridad de cada PDF antes de guardarlo y no se reemplazan versiones más nuevas.</p>
      <label class="btn signal block" style="cursor:pointer">${ICON.pkgIn} Elegir paquete .zip<input id="pkgIn" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden></label>
    </div>`;
  $('#pkgIn').addEventListener('change', e => { const f = e.target.files[0]; if (f) importPackage(f); });
}
async function exportPackage() {
  if (!(await requireAdmin())) return;
  const cat = $('#pkgCat').value, withPdf = $('#pkgPdfs').checked;
  const docs = S.docs.filter(d => !cat || d.category === cat);
  if (!docs.length) { toast('No hay documentos para exportar'); return; }
  toast('Preparando paquete…', 8000);
  const zip = new JSZip();
  const manifest = { format: PKG_FORMAT, formatVersion: 1, app: 'Procedimientos HP ' + APP_VERSION, createdAt: new Date().toISOString(), includesPdfs: withPdf, categories: S.cats, docs: [] };
  for (const d of docs) {
    const e = { id: d.id, code: d.code || d.id, name: d.name, category: d.category, area: d.area, version: d.version, updated: d.updated, keywords: d.keywords || '', qrPayload: payloadFor(d.id), qr: `qr/${d.id}.png` };
    if (withPdf && d.hasFile) {
      const buf = await getFile(d.id);
      if (buf) { zip.file(`pdf/${d.id}.pdf`, buf, { compression: 'STORE' }); Object.assign(e, { file: `pdf/${d.id}.pdf`, sha256: d.sha256, size: d.size, fileVersion: d.fileVersion }); }
    }
    zip.file(e.qr, await canvasBlob(labelCanvas(d)));
    manifest.docs.push(e);
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('LEEME.txt', 'Paquete documental de la app Procedimientos HP Drilling Services S.A.S.\nPara usarlo: abre la app > Paquetes > Importar paquete y elige este archivo .zip.\nNo descomprimas el archivo.\n');
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
  const name = `Paquete_HSE_${today()}${cat ? '_' + normId(cat) : ''}.zip`;
  await deliverFile(blob, name, 'Paquete listo');
}
async function importPackage(file) {
  let zip, manifest;
  try {
    zip = await JSZip.loadAsync(file);
    const mf = zip.file('manifest.json');
    if (!mf) throw new Error('El archivo no contiene manifest.json');
    manifest = JSON.parse(await mf.async('string'));
    if (manifest.format !== PKG_FORMAT) throw new Error('No es un paquete de esta app');
  } catch (e) {
    await modal({ title: 'No se pudo leer el paquete', html: `<p>${esc(e.message)}</p><p class="muted small">Elige el archivo .zip tal como lo exportó la app, sin descomprimirlo.</p>` }); return;
  }
  toast(`Verificando ${manifest.docs.length} documentos…`, 10000);
  if (Array.isArray(manifest.categories)) {
    const merged = Array.from(new Set([...S.cats, ...manifest.categories])); await setSetting('categories', merged);
  }
  const rep = { added: [], updated: [], same: [], older: [], bad: [], catalog: [] };
  for (const e of manifest.docs) {
    const id = normId(e.id); if (!id) continue;
    const local = await DB.get('docs', id);
    const meta = { code: id, name: e.name, category: e.category, area: e.area, version: e.version, updated: e.updated, keywords: e.keywords };
    const entry = e.file ? zip.file(e.file) : null;
    if (e.file) {
      if (!entry) { rep.bad.push(`${id}: falta el PDF dentro del paquete`); await markPending(local, id, meta, true); continue; }
      const buf = await entry.async('arraybuffer');
      const sha = await sha256(buf);
      if (sha !== e.sha256 || !isPdf(buf)) { rep.bad.push(`${id}: el PDF no coincide con su hash SHA-256 (dañado o alterado)`); await markPending(local, id, meta, true); continue; }
      if (local && local.hasFile && local.sha256 === sha) {
        await DB.put('docs', { ...local, ...meta, name: meta.name || local.name, version: e.version || local.version, integrityError: false });
        rep.same.push(id); continue;
      }
      if (local && local.hasFile && cmpVer(e.fileVersion || e.version, local.fileVersion || local.version) < 0) {
        rep.older.push(`${id}: el paquete trae ${e.fileVersion || e.version}, se conserva ${local.fileVersion || local.version}`); continue;
      }
      await saveDoc({ ...meta, version: e.fileVersion || e.version }, buf, sha);
      if (e.version && e.fileVersion && e.version !== e.fileVersion) { const d = await DB.get('docs', id); d.version = e.version; await DB.put('docs', d); }
      (local && local.hasFile ? rep.updated : rep.added).push(id);
    } else {
      if (!local) { await markPending(null, id, meta, false); rep.catalog.push(`${id}: agregado como pendiente`); }
      else if (cmpVer(e.version, local.version) > 0) { await DB.put('docs', { ...local, ...meta, name: meta.name || local.name }); rep.catalog.push(`${id}: el catálogo indica la versión ${e.version}`); }
    }
  }
  await requestPersist();
  await refresh();
  const sec = (t, a, cls = '') => a.length ? `<p style="margin:10px 0 4px"><b>${t} (${a.length})</b></p><div class="report ${cls}">${a.map(x => `<div>${esc(x)}</div>`).join('')}</div>` : '';
  await modal({
    title: 'Paquete importado',
    html: `<p class="small muted">${esc(file.name)} · creado ${fmtDate(manifest.createdAt)}</p>
      ${rep.bad.length ? `<div class="notice bad">${rep.bad.length} archivo(s) fallaron la verificación de integridad y no se guardaron.</div>` : `<div class="notice ok">Todos los PDF pasaron la verificación SHA-256.</div>`}
      ${sec('Nuevos', rep.added)}${sec('Actualizados a una versión más nueva', rep.updated)}${sec('Sin cambios', rep.same)}${sec('Se conservó la versión instalada', rep.older)}${sec('Con error de integridad', rep.bad)}${sec('Solo catálogo', rep.catalog)}`,
    actions: [{ label: 'Ir a la biblioteca', value: 1, kind: 'primary' }]
  });
  location.hash = '#/biblioteca';
}
async function markPending(local, id, meta, integrityError) {
  if (local && local.hasFile) { await DB.put('docs', { ...local, integrityError }); return; }
  await DB.put('docs', { ...(local || {}), id, code: id, ...meta, name: meta.name || id, hasFile: false, fileVersion: '', sha256: '', size: null, integrityError, favorite: local ? !!local.favorite : false, history: (local && local.history) || [] });
}
async function requestPersist() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* opcional */ } }

/* ---------- categorías ---------- */
async function viewCategories() {
  setTitle('Categorías', true); setTab('ajustes');
  const count = c => S.docs.filter(d => d.category === c).length;
  main().innerHTML = `<div class="card">${S.cats.map((c, i) => `<div class="switch"><span>${esc(c)} <span class="muted small">· ${count(c)}</span></span>
      <span class="row"><button class="btn" data-act="cat-ren" data-i="${i}">Renombrar</button><button class="btn danger" data-act="cat-del" data-i="${i}">Quitar</button></span></div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" data-act="cat-add">Agregar categoría</button></div>`;
}
async function catAction(act, i) {
  if (!(await requireAdmin())) return;
  const cats = S.cats.slice();
  if (act === 'cat-add' || act === 'cat-ren') {
    const v = await modal({ title: act === 'cat-add' ? 'Nueva categoría' : 'Renombrar categoría', html: `<label class="f">Nombre<input id="catName" value="${act === 'cat-ren' ? esc(cats[i]) : ''}"></label>`, actions: [{ label: 'Guardar', kind: 'primary', handler: m => $('#catName', m).value.trim() || false }, { label: 'Cancelar', value: null }] });
    if (!v) return;
    if (act === 'cat-add') { if (!cats.includes(v)) cats.push(v); }
    else { const old = cats[i]; cats[i] = v; for (const d of S.docs.filter(d => d.category === old)) await DB.put('docs', { ...d, category: v }); }
  } else {
    const old = cats[i]; const n = S.docs.filter(d => d.category === old).length;
    if (!(await confirmModal('Quitar categoría', `Se quitará <b>${esc(old)}</b>.${n ? ` Sus ${n} documento(s) pasarán a <b>Otros</b>.` : ''}`, 'Quitar'))) return;
    cats.splice(i, 1); if (!cats.includes('Otros')) cats.push('Otros');
    for (const d of S.docs.filter(d => d.category === old)) await DB.put('docs', { ...d, category: 'Otros' });
  }
  await setSetting('categories', cats); await refresh(); route();
}

/* ---------- ajustes ---------- */
async function viewSettings() {
  setTitle('Configuración'); setTab('ajustes');
  let est = null; try { est = await navigator.storage.estimate(); } catch (e) {}
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (e) {}
  const swOk = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  main().innerHTML = `
    <h2>Seguridad</h2>
    <div class="card">
      <div class="switch"><span><b>PIN de administrador</b><br><span class="small muted">${S.pin ? 'Configurado' : 'Sin PIN: cualquiera puede importar, editar y eliminar'}</span></span>
        <button class="btn" data-act="pin-set">${S.pin ? 'Cambiar' : 'Crear PIN'}</button></div>
      ${S.pin ? `<label class="switch"><span>Pedir PIN para importar, editar, eliminar y exportar</span><input type="checkbox" data-act="toggle-restrict" ${S.restrictAdmin ? 'checked' : ''}></label>
      <label class="switch"><span>Pedir PIN también al abrir la app</span><input type="checkbox" data-act="toggle-lock" ${S.lockApp ? 'checked' : ''}></label>
      <div class="switch"><span>Quitar el PIN</span><button class="btn danger" data-act="pin-del">Quitar</button></div>` : ''}
      <p class="small muted" style="margin-top:8px">El PIN limita el acceso dentro de la app. Los archivos se guardan en el almacenamiento interno de la app sin cifrado adicional: para información confidencial usa además el bloqueo y cifrado del propio teléfono.</p>
    </div>
    <h2>Almacenamiento</h2>
    <div class="card"><dl class="kv">
      <dt>Documentos</dt><dd>${S.docs.length} (${S.docs.filter(d => d.hasFile).length} con PDF)</dd>
      <dt>Espacio usado</dt><dd>${est ? fmtBytes(est.usage) + ' de ' + fmtBytes(est.quota) : '—'}</dd>
      <dt>Almacenamiento persistente</dt><dd>${persisted ? 'Sí' : 'No confirmado'}</dd>
      <dt>Funciona sin internet</dt><dd>${swOk ? 'Sí, la app está guardada en el dispositivo' : 'Abre la app una vez con conexión para activarlo'}</dd>
      <dt>Versión de la app</dt><dd>${APP_VERSION}</dd></dl>
      ${persisted ? '' : '<button class="btn" data-act="persist" style="margin-top:10px">Pedir almacenamiento persistente</button>'}
    </div>
    <h2>Más</h2>
    <div class="tiles"><a class="tile" href="#/categorias">${ICON.cats}Administrar categorías</a><a class="tile" href="#/qr">${ICON.qr}Generar códigos QR</a></div>
    <p class="small muted" style="margin-top:16px">Incluye PDF.js (Apache 2.0), jsQR (Apache 2.0), qrcode-generator (MIT), JSZip (MIT) y jsPDF (MIT).</p>`;
}
async function setPin() {
  if (S.pin && !(await requireAdmin())) return;
  const p1 = await modal({ title: 'Nuevo PIN', html: `<p class="muted">De 4 a 8 dígitos.</p><input class="pin-input" id="p1" type="password" inputmode="numeric" maxlength="8" aria-label="Nuevo PIN"><p class="small" id="pe" style="color:var(--bad);margin-top:6px"></p>`,
    actions: [{ label: 'Continuar', kind: 'primary', handler: m => { const v = $('#p1', m).value; if (!/^\d{4,8}$/.test(v)) { $('#pe', m).textContent = 'Usa entre 4 y 8 dígitos.'; return false; } return v; } }, { label: 'Cancelar', value: null }] });
  if (!p1) return;
  const p2 = await modal({ title: 'Confirma el PIN', html: `<input class="pin-input" id="p2" type="password" inputmode="numeric" maxlength="8" aria-label="Confirmar PIN">`, actions: [{ label: 'Guardar PIN', kind: 'primary', handler: m => $('#p2', m).value }, { label: 'Cancelar', value: null }] });
  if (p2 !== p1) { if (p2 !== null) toast('Los PIN no coinciden'); return; }
  S.pin = await pinHash(p1); S.admin = true;
  await setSetting('pin', S.pin); toast('PIN guardado'); route();
}

/* ---------- visor PDF ---------- */
const V = { pdf: null, scale: 1, observer: null, rendered: new Map(), id: null };
async function openViewer(id) {
  const d = findDoc(id);
  if (!d) { location.hash = '#/doc/' + encodeURIComponent(id); return; }
  if (!d.hasFile) { location.hash = '#/doc/' + encodeURIComponent(id); return; }
  const buf = await getFile(id);
  if (!buf) { toast('No se encontró el PDF en el dispositivo'); return; }
  if (!window.pdfjsLib) { toast('Falta el archivo vendor/pdf.min.js: no se puede mostrar el PDF'); return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  closeViewer(true);
  V.id = id;
  $('#viewer').hidden = false; document.body.style.overflow = 'hidden';
  $('#viewerTitle').textContent = d.name;
  $('#viewerMeta').textContent = [d.id, d.version, fmtBytes(d.size)].filter(Boolean).join(' · ');
  const notice = $('#viewerNotice');
  if (statusOf(d) === 'outdated') { notice.className = 'viewer-notice'; notice.textContent = `Versión ${d.fileVersion}; existe la versión ${d.version}. Importa el paquete actualizado.`; notice.hidden = false; }
  else { notice.hidden = true; }
  sha256(buf).then(h => {
    if (V.id !== id) return;
    if (h !== d.sha256) { notice.className = 'viewer-notice bad'; notice.textContent = 'Advertencia: el archivo no coincide con su hash SHA-256 registrado. Puede estar dañado.'; notice.hidden = false; }
    else if (notice.hidden) { notice.className = 'viewer-notice ok'; notice.textContent = 'Integridad verificada (SHA-256)'; notice.hidden = false; setTimeout(() => { if (notice.classList.contains('ok')) notice.hidden = true; }, 2500); }
  });
  const pages = $('#pages'); pages.innerHTML = '<p style="color:#fff;text-align:center;margin-top:40px">Abriendo documento…</p>';
  try {
    V.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise;
  } catch (e) { pages.innerHTML = `<p style="color:#fff;text-align:center;margin-top:40px">No se pudo abrir el PDF: ${esc(e.message)}</p>`; return; }
  const first = await V.pdf.getPage(1); const vp = first.getViewport({ scale: 1 });
  V.ratio = vp.height / vp.width; V.scale = 1;
  pages.innerHTML = '';
  for (let i = 1; i <= V.pdf.numPages; i++) {
    const el = document.createElement('div'); el.className = 'page'; el.dataset.n = i;
    el.innerHTML = `<span class="pn">${i}</span>`; pages.appendChild(el);
  }
  layoutPages();
  V.observer = new IntersectionObserver(entries => {
    for (const en of entries) { const n = +en.target.dataset.n; if (en.isIntersecting) renderPage(n); }
    updateIndicator();
  }, { root: pages, rootMargin: '600px 0px' });
  $$('.page', pages).forEach(p => V.observer.observe(p));
  pages.onscroll = updateIndicator; updateIndicator();
}
function pageWidth() { return Math.min($('#pages').clientWidth - 16, 900) * V.scale; }
function layoutPages() { const w = pageWidth(); $$('#pages .page').forEach(p => { p.style.width = w + 'px'; p.style.height = (w * (p._ratio || V.ratio)) + 'px'; }); }
async function renderPage(n) {
  if (!V.pdf) return;
  const key = n + '@' + V.scale; const el = $(`#pages .page[data-n="${n}"]`);
  if (!el || el.dataset.r === key) return; el.dataset.r = key;
  const page = await V.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 }); el._ratio = base.height / base.width;
  const cssW = pageWidth(); el.style.height = cssW * el._ratio + 'px';
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let scale = cssW / base.width * dpr;
  const maxPx = 12e6; if (base.width * base.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (base.width * base.height));
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas'); cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  if (el.dataset.r !== key) return;
  el.querySelector('canvas')?.remove(); el.prepend(cv); V.rendered.set(n, cv);
  // liberar páginas lejanas para no agotar la memoria con documentos grandes
  if (V.rendered.size > 10) {
    const cur = currentPage();
    for (const [k, c] of V.rendered) if (Math.abs(k - cur) > 5) { c.width = c.height = 0; c.remove(); V.rendered.delete(k); const p = $(`#pages .page[data-n="${k}"]`); if (p) p.dataset.r = ''; }
  }
}
function currentPage() {
  const pages = $('#pages'); const mid = pages.scrollTop + pages.clientHeight / 2; let best = 1;
  for (const p of $$('.page', pages)) { if (p.offsetTop <= mid) best = +p.dataset.n; else break; }
  return best;
}
function updateIndicator() { if (V.pdf) $('#pageInd').textContent = `${currentPage()} / ${V.pdf.numPages}`; }
function zoom(f) {
  if (!V.pdf) return;
  const pages = $('#pages'); const rel = pages.scrollTop / (pages.scrollHeight || 1);
  V.scale = Math.max(0.6, Math.min(3, V.scale * f)); layoutPages();
  pages.scrollTop = rel * pages.scrollHeight;
  for (const [, c] of V.rendered) { c.width = c.height = 0; c.remove(); } V.rendered.clear();
  $$('.page', pages).forEach(p => { p.dataset.r = ''; });
  V.observer.disconnect(); $$('.page', pages).forEach(p => V.observer.observe(p));
}
function closeViewer(silent) {
  if (V.observer) V.observer.disconnect();
  for (const [, c] of V.rendered) { c.width = c.height = 0; } V.rendered.clear();
  if (V.pdf) { V.pdf.destroy(); V.pdf = null; }
  V.id = null; $('#pages').innerHTML = ''; $('#viewer').hidden = true; document.body.style.overflow = '';
  if (!silent && location.hash.startsWith('#/ver/')) history.back();
}

/* ---------- escáner ---------- */
const SC = { stream: null, timer: null, busy: false, canvas: document.createElement('canvas') };
async function openScanner() {
  $('#scanner').hidden = false; document.body.style.overflow = 'hidden';
  const msg = $('#scanMsg'); msg.textContent = 'Iniciando cámara…';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanFallback('Este navegador no permite usar la cámara aquí.'); return; }
  try {
    SC.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    scanFallback(e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Actívalo en los ajustes del teléfono para esta app.' : 'No se pudo iniciar la cámara.'); return;
  }
  const v = $('#scanVideo'); v.srcObject = SC.stream; try { await v.play(); } catch (e) {}
  const track = SC.stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  $('#torchBtn').hidden = !caps.torch;
  msg.innerHTML = `Buscando código…<br><button class="btn" data-act="scan-photo">Usar una foto</button><button class="btn" data-act="scan-manual">Escribir código</button>`;
  SC.timer = setInterval(scanFrame, 140);
}
function scanFallback(text) {
  $('#scanMsg').innerHTML = `${esc(text)}<br><button class="btn" data-act="scan-photo">Tomar o elegir una foto del QR</button><button class="btn" data-act="scan-manual">Escribir código</button>`;
}
function scanFrame() {
  const v = $('#scanVideo'); if (SC.busy || !v.videoWidth) return;
  const s = Math.min(1, 800 / Math.max(v.videoWidth, v.videoHeight));
  const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
  SC.canvas.width = w; SC.canvas.height = h;
  const c = SC.canvas.getContext('2d', { willReadFrequently: true }); c.drawImage(v, 0, 0, w, h);
  const r = jsQR(c.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  if (r && r.data) handleScan(r.data);
}
function decodeImage(img) {
  for (const max of [1000, 1600, 700, 2200]) {
    const s = Math.min(1, max / Math.max(img.width, img.height)); const w = Math.round(img.width * s), h = Math.round(img.height * s);
    SC.canvas.width = w; SC.canvas.height = h; const c = SC.canvas.getContext('2d', { willReadFrequently: true }); c.drawImage(img, 0, 0, w, h);
    const r = jsQR(c.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' }); if (r) return r.data;
  }
  return null;
}
async function scanPhoto() {
  const f = await pickFile('image/*'); if (!f) return;
  const img = new Image(); img.src = URL.createObjectURL(f);
  try { await img.decode(); } catch (e) { toast('No se pudo leer la imagen'); return; }
  const data = decodeImage(img); URL.revokeObjectURL(img.src);
  if (data) handleScan(data); else toast('No se encontró un QR en la foto. Acércate y evita reflejos.');
}
async function scanManual() {
  const v = await modal({ title: 'Escribir código', html: `<label class="f">Código del documento<input id="mc" placeholder="Ej. P-SI-005" autocapitalize="characters"></label>`, actions: [{ label: 'Abrir', kind: 'primary', handler: m => $('#mc', m).value.trim() || false }, { label: 'Cancelar', value: null }] });
  if (v) handleScan(v);
}
async function handleScan(text) {
  if (SC.busy) return; SC.busy = true;
  const id = parsePayload(text);
  if (navigator.vibrate) try { navigator.vibrate(60); } catch (e) {}
  stopScanner();
  if (!id) { await modal({ title: 'Código no reconocido', html: `<p>Este QR no corresponde a un documento de la biblioteca.</p><p class="mono small">${esc(String(text).slice(0, 120))}</p>` }); SC.busy = false; location.hash = '#/inicio'; return; }
  const d = findDoc(id);
  SC.busy = false;
  if (d && d.hasFile) { location.replace('#/doc/' + encodeURIComponent(id)); setTimeout(() => { location.hash = '#/ver/' + encodeURIComponent(id); }, 30); }
  else location.replace('#/doc/' + encodeURIComponent(id));
}
function stopScanner() {
  clearInterval(SC.timer); SC.timer = null;
  if (SC.stream) { SC.stream.getTracks().forEach(t => t.stop()); SC.stream = null; }
  $('#scanVideo').srcObject = null; $('#scanner').hidden = true; document.body.style.overflow = '';
}
async function toggleTorch() {
  const t = SC.stream && SC.stream.getVideoTracks()[0]; if (!t) return;
  SC.torch = !SC.torch; try { await t.applyConstraints({ advanced: [{ torch: SC.torch }] }); } catch (e) { toast('La linterna no está disponible'); }
}

/* ---------- enrutador ---------- */
async function route() {
  const raw = location.hash || '#/inicio';
  const [path, qs] = raw.slice(2).split('?'); const params = new URLSearchParams(qs || '');
  const [view, arg] = [path.split('/')[0], decodeURIComponent(path.split('/').slice(1).join('/'))];
  if (view !== 'escanear' && !$('#scanner').hidden) stopScanner();
  if (view !== 'ver' && !$('#viewer').hidden) closeViewer(true);
  if (view === 'escanear') { if ($('#scanner').hidden) openScanner(); return; }
  if (view === 'ver') { openViewer(arg); return; }
    switch (view) {
    case 'biblioteca': viewLibrary(params); break;
    case 'doc': await viewDoc(arg); break;
    case 'importar': await viewImport(); break;
    case 'qr': viewQr(arg || null); break;
    case 'paquetes': viewPackages(params); break;
    case 'categorias': await viewCategories(); break;
    case 'ajustes': await viewSettings(); break;
    default: viewHome();
  }
  window.scrollTo(0, 0);
}

/* ---------- eventos globales ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case 'scan': location.hash = '#/escanear'; break;
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } break;
    case 'filter': S.filter[el.dataset.k] = el.dataset.v; if (location.hash.includes('?')) history.replaceState(null, '', '#/biblioteca'); viewLibrary(new URLSearchParams()); break;
    case 'fav-filter': S.filter.fav = !S.filter.fav; viewLibrary(new URLSearchParams()); break;
    case 'open': location.hash = '#/ver/' + encodeURIComponent(id); break;
    case 'fav': { const d = findDoc(id); await DB.put('docs', { ...d, favorite: !d.favorite }); await refresh(); viewDoc(id); break; }
    case 'edit': editDoc(id); break;
    case 'replace': replacePdf(id); break;
    case 'delete': deleteDoc(id); break;
    case 'share-pdf': { const d = findDoc(id); const buf = await getFile(id); if (buf) deliverFile(new Blob([buf], { type: 'application/pdf' }), `${d.id}.pdf`, d.name); break; }
    case 'save-queue': el.disabled = true; await saveQueue(); break;
    case 'qr-png': { const d = findDoc(id); deliverFile(await canvasBlob(labelCanvas(d)), `QR_${d.id}.png`, 'Imagen QR lista'); break; }
    case 'qr-sheet-one': { if (!(await requireAdmin())) return; deliverFile(await qrSheetPdf([findDoc(id)]), `QR_${id}.pdf`, 'Hoja de etiquetas lista'); break; }
    case 'qr-sheet': {
      if (!(await requireAdmin())) return;
      const ids = $$('#qrSel input:checked').map(i => i.value); if (!ids.length) { toast('Selecciona al menos un documento'); return; }
      toast('Creando hoja…'); deliverFile(await qrSheetPdf(ids.map(findDoc)), `Etiquetas_QR_${today()}.pdf`, 'Hoja de etiquetas lista'); break;
    }
    case 'sel-all': $$('#qrSel input').forEach(i => i.checked = true); break;
    case 'sel-none': $$('#qrSel input').forEach(i => i.checked = false); break;
    case 'export': exportPackage(); break;
    case 'cat-add': case 'cat-ren': case 'cat-del': catAction(act, +el.dataset.i); break;
    case 'pin-set': setPin(); break;
    case 'pin-del': if (await requireAdmin() && await confirmModal('Quitar PIN', 'Cualquier persona con el dispositivo podrá importar, editar y eliminar documentos.', 'Quitar PIN')) { S.pin = null; S.lockApp = false; await DB.del('settings', 'pin'); await setSetting('lockApp', false); toast('PIN eliminado'); route(); } break;
    case 'persist': await requestPersist(); route(); break;
    case 'scan-photo': scanPhoto(); break;
    case 'scan-manual': scanManual(); break;
  }
});
document.addEventListener('change', async e => {
  const act = e.target.dataset.act;
  if (act === 'toggle-restrict') { if (!(await requireAdmin())) { e.target.checked = !e.target.checked; return; } S.restrictAdmin = e.target.checked; await setSetting('restrictAdmin', S.restrictAdmin); }
  if (act === 'toggle-lock') { if (!(await requireAdmin())) { e.target.checked = !e.target.checked; return; } S.lockApp = e.target.checked; await setSetting('lockApp', S.lockApp); }
});
$('#backBtn').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/inicio'; });
$('#viewerClose').addEventListener('click', () => { closeViewer(true); if (location.hash.startsWith('#/ver/')) history.back(); });
$('#zoomIn').addEventListener('click', () => zoom(1.25));
$('#zoomOut').addEventListener('click', () => zoom(0.8));
$('#scanClose').addEventListener('click', () => { stopScanner(); history.back(); });
$('#torchBtn').addEventListener('click', toggleTorch);
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (V.pdf) layoutPages(); });
function updateNet() { const b = $('#netBadge'); const on = navigator.onLine; b.textContent = on ? 'En línea' : 'Sin conexión'; b.classList.toggle('off', !on); }
window.addEventListener('online', updateNet); window.addEventListener('offline', updateNet);

/* ---------- arranque ---------- */
const LIBS = [['qrcode', 'vendor/qrcode.js'], ['jsQR', 'vendor/jsQR.js'], ['JSZip', 'vendor/jszip.min.js'], ['jspdf', 'vendor/jspdf.umd.min.js'], ['pdfjsLib', 'vendor/pdf.min.js']];
async function boot() {
  window.__appStarted = true;
  updateNet();
  const missing = LIBS.filter(([g]) => !window[g]).map(([, f]) => f);
  if (missing.length) {
    main().innerHTML = `<div class="notice bad"><b>Faltan archivos de la app en el servidor.</b><br>No se cargaron: <span class="mono small">${missing.map(esc).join(', ')}</span>.<br>Sube la carpeta <b>vendor</b> completa al repositorio (junto a index.html) y vuelve a abrir la app.</div>`;
    return;
  }
  if (!window.isSecureContext || !crypto.subtle) {
    main().innerHTML = '<div class="notice bad">La app debe abrirse desde una dirección https para funcionar.</div>'; return;
  }
  await DB.open();
  S.pin = await setting('pin', null);
  S.restrictAdmin = await setting('restrictAdmin', true);
  S.lockApp = await setting('lockApp', false);
  await refresh();
  if (S.pin && S.lockApp) {
    main().innerHTML = '<div class="empty"><p><b>App bloqueada</b></p></div>';
    let ok = null; while (ok !== true) { ok = await askPin('Ingresa tu PIN', 'La app está protegida con PIN.'); }
    S.admin = true;
  }
  route();
  window.__appReady = true;
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && S._swControlled) { reloaded = true; toast('App actualizada a la última versión'); } S._swControlled = true; });
      S._swControlled = !!navigator.serviceWorker.controller;
    } catch (e) { console.warn('SW', e); }
  }
}
boot().catch(e => { main().innerHTML = `<div class="notice bad">Error al iniciar: ${esc(e.message)}</div>`; });
