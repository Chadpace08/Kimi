/* ═══════════ Kimi — voice-first reminder assistant ═══════════ */
'use strict';
const C = window.KimiCore;
const APP_VERSION = '5.0.0';

/* ───────── Small helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = o => JSON.parse(JSON.stringify(o));
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
function haptic(p = 12) { try { if (S.settings.haptics !== false && navigator.vibrate) navigator.vibrate(p); } catch { /* unsupported */ } }

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const TYPE_LABEL = { task: 'Task', bill: 'Bill', subscription: 'Subscription' };
const TYPE_ICON = { task: 'task', bill: 'receipt', subscription: 'repeat' };

/* ───────── State & storage ───────── */
const DEFAULTS = {
  v: 5,
  settings: {
    name: '', currency: 'PHP', defaultTime: '09:00', lang: 'en-US', speak: true, autoSave: true,
    sound: true, haptics: true, notifications: true, theme: 'auto', onboarded: false, lastBackup: null, dismissed: {}
  },
  reminders: [], log: [], legacyNotes: [], updatedAt: 0
};
let S = clone(DEFAULTS);
const ui = { tab: 'home', listSeg: 'upcoming', q: '', awayCount: 0 };

const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('kimi', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  async set(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
};

function normalize(st) {
  const d = clone(DEFAULTS);
  st = st || {};
  return {
    ...d, ...st,
    settings: { ...d.settings, ...(st.settings || {}), dismissed: { ...(st.settings && st.settings.dismissed) } },
    reminders: Array.isArray(st.reminders) ? st.reminders.filter(r => r && r.id && r.due) : [],
    log: Array.isArray(st.log) ? st.log : [],
    legacyNotes: Array.isArray(st.legacyNotes) ? st.legacyNotes : []
  };
}

/* Bring over reminders/notes from the original Kimi (v3/v4) */
function migrateOld() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem('kimi_v4') || localStorage.getItem('kimi_v3') || 'null'); } catch { /* corrupt */ }
  if (!old || !Array.isArray(old.items)) return null;
  const st = clone(DEFAULTS);
  st.settings.name = old.user || '';
  st.settings.theme = old.dark ? 'dark' : 'auto';
  st.settings.haptics = old.vibrate !== false;
  const rmap = { Daily: 'daily', Weekly: 'weekly', Monthly: 'monthly' };
  let n = 0;
  for (const it of old.items) {
    if (it.type === 'reminder' && it.title) {
      const due = (it.date || C.toLocal(new Date()).slice(0, 10)) + 'T' + (it.time || '09:00');
      st.reminders.push({
        id: 'm' + it.id, title: it.title, type: it.category === 'Bills' ? 'bill' : 'task', due, base: due,
        repeat: rmap[it.repeat] ? clone(C.REPEAT_PRESETS[rmap[it.repeat]]) : null, amount: null, currency: 'PHP',
        notes: it.notes || '', done: !!it.done, doneAt: it.done ? due : null, createdAt: Date.now(), history: [],
        alertedFor: due // don't ring old items on first open
      });
      n++;
    } else if (it.type === 'note') {
      st.legacyNotes.push({ title: it.noteTitle || '', body: it.noteContent || '', date: it.date || '' });
    }
  }
  st.migratedCount = n;
  return st;
}

async function loadState() {
  let a = null, b = null;
  try { a = await DB.get('state'); } catch { /* IndexedDB unavailable */ }
  try { b = JSON.parse(localStorage.getItem('kimi_v5') || 'null'); } catch { /* corrupt */ }
  const best = [a, b].filter(Boolean).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
  S = normalize(best || migrateOld());
}

function save() {
  S.updatedAt = Date.now();
  try { localStorage.setItem('kimi_v5', JSON.stringify(S)); }
  catch { toast('Phone storage is full. Export a backup and clear done items.', { icon: 'alert' }); }
  DB.set('state', S).catch(() => {});
  updateBadge();
}

let testRem = null;
const find = id => S.reminders.find(r => r.id === id) || (testRem && testRem.id === id ? testRem : null);
const activeReminders = () => S.reminders.filter(r => !r.done);
const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
function logAction(r, action) {
  S.log.unshift({ id: r.id, title: r.title, type: r.type, amount: r.amount, currency: r.currency, action, at: C.toLocal(new Date()) });
  if (S.log.length > 300) S.log.length = 300;
}

/* ───────── Theme ───────── */
function applyTheme() {
  const t = S.settings.theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $$('meta[name="theme-color"]').forEach(m => m.setAttribute('content', dark ? '#0F1512' : '#F6F3EE'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

/* ───────── Sound & speech ───────── */
let audioCtx = null;
function unlockAudio() {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
}
function chime() {
  if (!S.settings.sound || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    [659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + i * 0.16);
      g.gain.linearRampToValueAtTime(0.22, t0 + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.16 + 0.9);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 1);
    });
  } catch { /* ignore */ }
}
function blip(up = true) {
  if (!S.settings.sound || !audioCtx) return;
  try {
    const t0 = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(up ? 620 : 880, t0); o.frequency.linearRampToValueAtTime(up ? 880 : 620, t0 + 0.12);
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.12, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.22);
  } catch { /* ignore */ }
}
function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  const lang = S.settings.lang.toLowerCase();
  return voices.find(v => v.lang.toLowerCase().replace('_', '-') === lang && /google|natural|samantha|karen|female/i.test(v.name))
    || voices.find(v => v.lang.toLowerCase().replace('_', '-') === lang)
    || voices.find(v => v.lang.toLowerCase().startsWith('en')) || null;
}
function speak(text) {
  if (!S.settings.speak || !('speechSynthesis' in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = S.settings.lang; u.rate = 1.03; u.pitch = 1.05;
    const v = pickVoice(); if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
const stopSpeaking = () => { try { speechSynthesis.cancel(); } catch { /* ignore */ } };

/* ───────── Sheets (bottom drawers) with Android back-button support ───────── */
let sheetEl = null, ignorePop = 0, pendingPush = false;
window.addEventListener('popstate', () => {
  if (ignorePop > 0) {
    ignorePop--;
    if (pendingPush && sheetEl) { pendingPush = false; history.pushState({ sheet: 1 }, ''); }
    return;
  }
  if (sheetEl) destroySheet();
});
function openSheet({ title, body, foot = '', full = false, onClose = null }) {
  const inner = `<div class="grab"></div>
    <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body">${body}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
  if (sheetEl) {
    const prev = sheetEl._onClose; sheetEl._onClose = null;
    if (prev) prev();
    const sh = $('.sheet', sheetEl);
    sh.className = 'sheet' + (full ? ' full' : '');
    sh.innerHTML = inner;
    sheetEl._onClose = onClose;
    return sh;
  }
  const bd = document.createElement('div');
  bd.className = 'sheet-backdrop';
  bd.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog" aria-modal="true">${inner}</div>`;
  bd._onClose = onClose;
  $('#sheet-root').appendChild(bd);
  sheetEl = bd;
  document.body.classList.add('sheet-open');
  bd.addEventListener('click', e => { if (e.target === bd) closeSheet(); });
  enableSheetDrag(bd);
  requestAnimationFrame(() => requestAnimationFrame(() => bd.classList.add('in')));
  if (ignorePop > 0) pendingPush = true; else history.pushState({ sheet: 1 }, '');
  return $('.sheet', bd);
}
function destroySheet() {
  const bd = sheetEl; if (!bd) return;
  sheetEl = null;
  document.body.classList.remove('sheet-open');
  const cb = bd._onClose; bd._onClose = null;
  if (cb) cb();
  bd.classList.remove('in');
  setTimeout(() => bd.remove(), 380);
}
function closeSheet() {
  if (!sheetEl) return;
  destroySheet();
  if (pendingPush) { pendingPush = false; return; }
  ignorePop++; history.back();
}
function enableSheetDrag(bd) {
  const sheet = $('.sheet', bd);
  let y0 = null, dy = 0, t0 = 0;
  bd.addEventListener('pointerdown', e => {
    if (!e.target.closest('.grab, .sheet-head') || e.target.closest('button')) return;
    y0 = e.clientY; dy = 0; t0 = Date.now(); sheet.classList.add('dragging');
    try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  bd.addEventListener('pointermove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    bd.style.setProperty('--drag', dy + 'px');
  });
  const end = () => {
    if (y0 == null) return;
    sheet.classList.remove('dragging');
    const fast = dy > 40 && Date.now() - t0 < 250;
    y0 = null;
    bd.style.setProperty('--drag', '0px');
    if (dy > 120 || fast) closeSheet();
  };
  bd.addEventListener('pointerup', end);
  bd.addEventListener('pointercancel', end);
}

function confirmSheet({ title, msg, ok = 'Confirm', danger = false, icon: ic = 'alert' }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    openSheet({
      title,
      body: `<div class="empty" style="box-shadow:none;background:transparent;padding:6px 6px 0"><div class="empty-art ${danger ? 'gold' : ''}">${icon(ic)}</div><p>${msg}</p></div>`,
      foot: `<div class="btn-row"><button class="btn" data-act="confirm-no">Cancel</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="confirm-yes">${esc(ok)}</button></div>`,
      onClose: () => finish(false)
    });
    confirmResolver = v => { finish(v); closeSheet(); };
  });
}
let confirmResolver = null;

/* ───────── Toasts ───────── */
let toastTimer = null;
function toast(msg, { icon: ic = 'check', action = null, onAction = null, ms = 4500 } = {}) {
  const root = $('#toast-root');
  root.innerHTML = '';
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="t-ic">${icon(ic, 'sm')}</span><span class="t-msg">${msg}</span>${action ? `<button class="t-btn">${esc(action)}</button>` : ''}`;
  root.appendChild(el);
  const hide = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  if (action) $('.t-btn', el).addEventListener('click', () => { hide(); onAction && onAction(); });
  toastTimer = setTimeout(hide, ms);
}

function confetti(x, y, n = 18) {
  const colors = ['#1F7A5C', '#2C9A74', '#D6B56D', '#F2D38E', '#6A51C9', '#CF4337'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
    p.style.cssText = `background:${colors[i % colors.length]};--x0:${x}px;--y0:${y}px;--x1:${x + Math.cos(a) * d}px;--y1:${y + Math.sin(a) * d + 60}px;--r:${Math.random() * 720 - 360}deg;width:${6 + Math.random() * 5}px`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }
}

/* ───────── Rendering ───────── */
function bucketOf(r, now) {
  const d = C.fromLocal(r.due);
  if (d < now) return 'overdue';
  const diff = C.dayDiff(now, d);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}

function cardHTML(r, now, i = 0) {
  const d = C.fromLocal(r.due);
  const over = !r.done && d < now;
  const meta = [];
  if (r.done) meta.push(`<span class="m green">${icon('check', 'xs')} Done ${esc(r.doneAt ? C.whenLabel(r.doneAt, now).split(' · ')[0] : '')}</span>`);
  else if (over) meta.push(`<span class="m red">${icon('alert', 'xs')} ${esc(C.whenLabel(r.due, now))} · ${esc(C.relative(r.due, now))}</span>`);
  else meta.push(`<span class="m">${icon('calendar', 'xs')} ${esc(C.whenLabel(r.due, now))}</span>`);
  if (r.repeat && !r.done) meta.push(`<span class="m">${icon('repeat', 'xs')} ${esc(C.repeatLabel(r.repeat, r.base || r.due))}</span>`);
  if (!r.done && r.base && r.base !== r.due) meta.push(`<span class="m">${icon('snooze', 'xs')} Snoozed</span>`);
  let right = '';
  if (r.amount != null) right = `<div class="card-right"><span class="amount">${esc(C.money(r.amount, r.currency))}</span><span class="tag ${r.type}">${TYPE_LABEL[r.type]}</span></div>`;
  else if (r.type !== 'task') right = `<div class="card-right"><span class="tag ${r.type}">${TYPE_LABEL[r.type]}</span></div>`;
  const doneWord = r.type === 'task' ? 'Done' : 'Paid';
  return `<div class="swipe" data-id="${r.id}" style="animation-delay:${Math.min(i, 8) * 35}ms">
    <div class="swipe-bg"><span class="l">${icon('check')} ${doneWord}</span><span class="r">Snooze ${icon('snooze')}</span></div>
    <div class="card${over ? ' overdue' : ''}${r.done ? ' is-done' : ''}" data-act="open" data-id="${r.id}">
      <button class="check t-${r.type}${r.done ? ' done' : ''}" data-act="${r.done ? 'restore' : 'complete'}" data-id="${r.id}" aria-label="${r.done ? 'Restore' : 'Mark ' + doneWord.toLowerCase()}">${icon('check')}</button>
      <div class="card-main"><div class="card-title">${esc(r.title)}</div><div class="card-meta">${meta.join('')}</div></div>
      ${right}
    </div>
  </div>`;
}
function section(title, items, now, { danger = false, more = '' } = {}) {
  if (!items.length) return '';
  return `<div class="section-h${danger ? ' danger' : ''}"><h3>${title} <span class="count">${items.length}</span></h3>${more}</div>
    <div class="list">${items.map((r, i) => cardHTML(r, now, i)).join('')}</div>`;
}

const EXAMPLES = [
  ['Bill', 'Remind me to pay my bill on October 15'],
  ['Subscription', 'My Canva subscription is 1,299 pesos monthly'],
  ['Tomorrow', 'Remind me tomorrow morning to send the invoice'],
  ['Every week', 'Remind me every Friday to check my bookkeeping'],
  ['Later', 'I need to renew my domain in December'],
  ['Quick', 'Call the bank in 2 hours']
];

function greeting(now) {
  const h = now.getHours();
  const g = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return g + (S.settings.name ? ', ' + esc(S.settings.name) : '');
}
function dayWord(due, now) {
  const d = C.fromLocal(due), diff = C.dayDiff(now, d);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff > 1 && diff < 7) return 'on ' + C.DAYS[d.getDay()].replace(/^./, c => c.toUpperCase());
  return 'on ' + C.MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate();
}
function assistantLine(now, over, today, act) {
  if (!S.reminders.length) return `Hi! I'm <b>Kimi</b>. Tap the mic and just tell me what you need to remember. I'll work out the date, the time and whether it repeats.`;
  const parts = [];
  if (over.length) parts.push(`Heads up: <span class="hl-red">${plural(over.length, 'thing')}</span> slipped past. Let's clear ${over.length === 1 ? 'it' : 'them'}.`);
  if (today.length) {
    const next = today[0];
    parts.push(`You have <b>${plural(today.length, 'reminder')}</b> today. Next up: <b>${esc(next.title)}</b> at ${C.fmtTime(C.fromLocal(next.due))}.`);
  } else if (!over.length) {
    const nxt = act[0];
    parts.push(nxt ? `Nothing due today <span class="hl-green">🎉</span> Next is <b>${esc(nxt.title)}</b> ${esc(dayWord(nxt.due, now))} at ${C.fmtTime(C.fromLocal(nxt.due))}.` : `You're all clear. Nothing on your plate <span class="hl-green">🎉</span>`);
  }
  const money = act.find(r => r.type !== 'task' && r.amount != null && !over.includes(r) && !today.includes(r) && C.dayDiff(now, C.fromLocal(r.due)) <= 7);
  if (money && parts.length < 2) parts.push(`<b>${esc(money.title)}</b> (${esc(C.money(money.amount, money.currency))}) is due ${esc(dayWord(money.due, now))}.`);
  return parts.join(' ');
}

function nudgesHTML() {
  const out = [];
  const dis = S.settings.dismissed;
  if ('Notification' in window && Notification.permission === 'default' && !dis.notif && S.reminders.length) {
    out.push(`<div class="nudge"><div class="nudge-ic">${icon('bell')}</div><div class="nudge-txt"><b>Let me nudge you</b>Turn on alerts so reminders pop up on time.</div><button class="btn primary sm" data-act="enable-notif">Allow</button><button class="nudge-x" data-act="dismiss" data-k="notif" aria-label="Dismiss">${icon('x', 'sm')}</button></div>`);
  }
  if (!isStandalone() && !dis.install && (deferredInstall || isIOS)) {
    out.push(`<div class="nudge"><div class="nudge-ic" style="background:var(--brand-soft);color:var(--brand)">${icon('phone')}</div><div class="nudge-txt"><b>Add Kimi to your home screen</b>Opens like an app, works offline.</div><button class="btn soft sm" data-act="install">Install</button><button class="nudge-x" data-act="dismiss" data-k="install" aria-label="Dismiss">${icon('x', 'sm')}</button></div>`);
  }
  const lb = S.settings.lastBackup;
  const oldest = Math.min(...S.reminders.map(r => r.createdAt || Date.now()));
  const backupDue = S.reminders.length >= 5 && Date.now() - oldest > 3 * 864e5 && (!lb || Date.now() - lb > 14 * 864e5) && (!dis.backup || Date.now() - dis.backup > 7 * 864e5);
  if (backupDue) {
    out.push(`<div class="nudge"><div class="nudge-ic" style="background:var(--violet-soft);color:var(--violet)">${icon('shield')}</div><div class="nudge-txt"><b>Back up your reminders</b>${lb ? 'Last backup ' + Math.round((Date.now() - lb) / 864e5) + ' days ago.' : 'They only live on this phone.'}</div><button class="btn soft sm" data-act="export">Back up</button><button class="nudge-x" data-act="dismiss" data-k="backup" aria-label="Dismiss">${icon('x', 'sm')}</button></div>`);
  }
  return out.slice(0, 2).join('');
}

function renderHome() {
  const now = new Date();
  const act = activeReminders().sort(byDue);
  const over = act.filter(r => C.fromLocal(r.due) < now);
  const today = act.filter(r => !over.includes(r) && C.dayDiff(now, C.fromLocal(r.due)) === 0);
  const tomorrow = act.filter(r => C.dayDiff(now, C.fromLocal(r.due)) === 1);
  const soon = act.filter(r => { const d = C.dayDiff(now, C.fromLocal(r.due)); return d > 1 && d < 8; });
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const showExamples = S.reminders.length < 4;

  let lists = '';
  if (!S.reminders.length) {
    lists = '';
  } else {
    lists += section(over.length && ui.awayCount ? 'Missed while you were away' : 'Overdue', over, now, { danger: true });
    lists += today.length ? section('Today', today, now) : (over.length ? '' : `<div class="section-h"><h3>Today</h3></div><div class="allclear">${icon('sparkle')} Nothing due today. Enjoy it!</div>`);
    lists += section('Tomorrow', tomorrow, now);
    lists += section('Next 7 days', soon.slice(0, 6), now, { more: soon.length > 6 || act.length > over.length + today.length + tomorrow.length + soon.length ? `<button class="link-btn" data-tab="list">See all</button>` : '' });
    if (!over.length && !today.length && !tomorrow.length && !soon.length) {
      lists += `<div class="section-h"><h3>Coming up</h3><button class="link-btn" data-tab="list">See all</button></div><div class="list">${act.slice(0, 3).map((r, i) => cardHTML(r, now, i)).join('')}</div>`;
    }
  }

  $('#screen-home').innerHTML = `
    <div class="hero">
      <div class="kimi-avatar" aria-hidden="true">K</div>
      <div><div class="hero-date">${esc(dateStr)}</div><div class="hero-hello">${greeting(now)}</div></div>
    </div>
    <div class="bubble">${assistantLine(now, over, today, act)}</div>
    <div class="talk-card">
      <div class="talk-title">What should I remember?</div>
      <div class="talk-sub">Tap and talk. I'll handle the rest.</div>
      <button class="mic-orb" data-act="capture" aria-label="Speak a reminder">${icon('mic')}</button>
      <button class="talk-alt" data-act="capture-type">${icon('keyboard', 'sm')} Type instead</button>
    </div>
    ${showExamples ? `<div class="section-h"><h3>Try saying</h3></div><div class="try-row">${EXAMPLES.map(([k, t]) => `<button class="try-chip" data-act="try" data-text="${esc(t)}"><small>${k}</small>“${esc(t)}”</button>`).join('')}</div>` : ''}
    ${nudgesHTML()}
    ${lists}
  `;
}

function renderList() {
  const now = new Date();
  const counts = {
    upcoming: activeReminders().length,
    repeating: activeReminders().filter(r => r.repeat).length,
    done: S.reminders.filter(r => r.done).length
  };
  $('#screen-list').innerHTML = `
    <div class="page-head"><div><div class="page-title">Reminders</div><div class="page-sub">Swipe right when done · swipe left to snooze</div></div>
      <button class="icon-btn" data-act="new" aria-label="Add reminder without voice">${icon('plus')}</button></div>
    <label class="search">${icon('search', 'sm')}<input id="list-q" type="search" placeholder="Search reminders" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="seg" role="tablist">
      ${['upcoming', 'repeating', 'done'].map(k => `<button class="${ui.listSeg === k ? 'on' : ''}" data-act="seg" data-v="${k}">${k[0].toUpperCase() + k.slice(1)} <span class="n">${counts[k]}</span></button>`).join('')}
    </div>
    <div id="list-body"></div>`;
  renderListBody(now);
}
function renderListBody(now = new Date()) {
  const q = ui.q.trim().toLowerCase();
  const match = r => !q || r.title.toLowerCase().includes(q) || (r.notes || '').toLowerCase().includes(q) || (r.heard || '').toLowerCase().includes(q);
  let html = '';
  if (ui.listSeg === 'upcoming') {
    const act = activeReminders().filter(match).sort(byDue);
    const g = { overdue: [], today: [], tomorrow: [], week: [], later: [] };
    act.forEach(r => g[bucketOf(r, now)].push(r));
    html = section('Overdue', g.overdue, now, { danger: true }) + section('Today', g.today, now) + section('Tomorrow', g.tomorrow, now) + section('This week', g.week, now) + section('Later', g.later, now);
    if (!act.length) html = q ? emptyHTML('search', 'No matches', `Nothing found for “${esc(ui.q)}”.`) : emptyHTML('sparkle', 'Your mind is clear', 'No reminders yet. Tap the mic and say something like:', '“Remind me to call the bank tomorrow at 10”');
  } else if (ui.listSeg === 'repeating') {
    const rep = activeReminders().filter(r => r.repeat && match(r)).sort(byDue);
    html = rep.length ? `<div class="list" style="margin-top:16px">${rep.map((r, i) => cardHTML(r, now, i)).join('')}</div>`
      : emptyHTML('repeat', 'No repeating reminders', 'Say “every” and I\'ll repeat it for you:', '“Every Friday, check my bookkeeping”', 'violet');
  } else {
    const done = S.reminders.filter(r => r.done && match(r)).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
    html = done.length ? `<div class="section-h"><h3>Completed <span class="count">${done.length}</span></h3><button class="link-btn" data-act="clear-done">Clear all</button></div><div class="list">${done.slice(0, 100).map((r, i) => cardHTML(r, now, i)).join('')}</div>`
      : emptyHTML('check', 'Nothing finished yet', 'One-time reminders you complete show up here. Tap the circle to bring one back.');
  }
  const body = $('#list-body');
  if (body) body.innerHTML = html;
}
function emptyHTML(ic, title, text, say = '', tone = '') {
  return `<div class="empty" style="margin-top:16px"><div class="empty-art ${tone}">${icon(ic)}</div><h4>${title}</h4><p>${text}</p>${say ? `<button class="say" data-act="try" data-text="${esc(say.replace(/[“”]/g, ''))}">${esc(say)}</button>` : ''}</div>`;
}

function renderBills() {
  const now = new Date();
  const items = activeReminders().filter(r => r.type !== 'task').sort(byDue);
  const cur = S.settings.currency;
  const monthly = {}, next30 = {};
  let subs = 0, bills = 0;
  items.forEach(r => {
    if (r.type === 'subscription') subs++; else bills++;
    if (r.amount == null) return;
    if (r.repeat) monthly[r.currency] = (monthly[r.currency] || 0) + C.monthlyEquivalent(r.amount, r.repeat);
    if (C.dayDiff(now, C.fromLocal(r.due)) <= 30) next30[r.currency] = (next30[r.currency] || 0) + r.amount;
  });
  const monthKey = C.toLocal(now).slice(0, 7);
  const paid = {};
  S.log.filter(l => l.action === 'done' && l.type !== 'task' && l.amount != null && l.at.startsWith(monthKey)).forEach(l => { paid[l.currency] = (paid[l.currency] || 0) + l.amount; });
  const fmtMulti = (obj, big = false) => {
    const keys = Object.keys(obj).sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0));
    if (!keys.length) return C.money(0, cur);
    const [first, ...rest] = keys;
    return esc(C.money(Math.round(obj[first] * 100) / 100, first)) + (rest.length ? (big ? '<small> + ' : ' + ') + rest.map(k => esc(C.money(Math.round(obj[k] * 100) / 100, k))).join(' + ') + (big ? '</small>' : '') : '');
  };
  const g = { overdue: [], week: [], later: [] };
  items.forEach(r => { const b = bucketOf(r, now); g[b === 'overdue' ? 'overdue' : b === 'later' ? 'later' : 'week'].push(r); });
  const recent = S.log.filter(l => l.action === 'done' && l.type !== 'task').slice(0, 5);

  $('#screen-bills').innerHTML = `
    <div class="page-head"><div><div class="page-title">Bills</div><div class="page-sub">Subscriptions & payments you track</div></div>
      <button class="icon-btn" data-act="new" data-type="bill" aria-label="Add bill">${icon('plus')}</button></div>
    <div class="money-hero">
      <div class="mh-label">Recurring per month</div>
      <div class="mh-total">${fmtMulti(monthly, true)}</div>
      <div style="opacity:.75;font-size:14px;position:relative;z-index:1">${plural(subs, 'subscription')} · ${plural(bills, 'bill')}</div>
      <div class="mh-row">
        <div class="mh-stat"><b>${fmtMulti(next30)}</b><span>Due in 30 days</span></div>
        <div class="mh-stat"><b>${fmtMulti(paid)}</b><span>Paid this month</span></div>
      </div>
    </div>
    ${items.length ? section('Overdue', g.overdue, now, { danger: true }) + section('Due this week', g.week, now) + section('Later', g.later, now)
      : emptyHTML('wallet', 'No bills yet', 'Tell me about a bill or subscription and I\'ll remind you before it\'s due:', '“My Netflix is 549 pesos every month”', 'gold')}
    ${recent.length ? `<div class="section-h"><h3>Recently paid</h3></div><div class="group">${recent.map(l => `<div class="row"><div class="row-ic">${icon('check', 'sm')}</div><div class="row-txt"><b>${esc(l.title)}</b><span>${esc(C.whenLabel(l.at, now).split(' · ')[0])}</span></div><span class="amount">${l.amount != null ? esc(C.money(l.amount, l.currency)) : ''}</span></div>`).join('')}</div>` : ''}
  `;
}

function toggleHTML(key, on) {
  return `<label class="toggle"><input type="checkbox" data-set="${key}" ${on ? 'checked' : ''}><span></span></label>`;
}
function notifStatus() {
  if (!('Notification' in window)) return ['warn', 'Not supported in this browser'];
  if (Notification.permission === 'granted') return S.settings.notifications ? ['ok', 'On. You\'ll get alerts on this phone'] : ['warn', 'Allowed, but turned off in Kimi'];
  if (Notification.permission === 'denied') return ['warn', 'Blocked. Allow it in your browser\'s site settings'];
  return ['', 'Off. Tap to allow'];
}
function renderSettings() {
  const st = S.settings;
  const [ns, nt] = notifStatus();
  const langs = [['en-US', 'English (US)'], ['en-PH', 'English (Philippines)'], ['en-AU', 'English (Australia)'], ['en-GB', 'English (UK)'], ['en-IN', 'English (India)'], ['en-SG', 'English (Singapore)'], ['fil-PH', 'Filipino / Taglish']];
  const lb = st.lastBackup ? new Date(st.lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Never';
  $('#screen-settings').innerHTML = `
    <div class="page-head"><div><div class="page-title">Settings</div><div class="page-sub">Make Kimi yours</div></div></div>

    <div class="group">
      <div class="row"><div class="row-ic">${icon('sparkle', 'sm')}</div><div class="row-txt"><b>Your name</b><span>So I can greet you</span></div><input type="text" data-set="name" value="${esc(st.name)}" placeholder="Name" autocomplete="given-name" enterkeyhint="done"></div>
    </div>

    <div class="section-h"><h3>Voice</h3></div>
    <div class="group">
      <div class="row"><div class="row-ic">${icon('mic', 'sm')}</div><div class="row-txt"><b>Language</b><span>${SR ? 'What you speak to Kimi' : 'Voice input isn\'t supported in this browser'}</span></div>
        <select data-set="lang">${langs.map(([v, l]) => `<option value="${v}" ${st.lang === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row"><div class="row-ic">${icon('volume', 'sm')}</div><div class="row-txt"><b>Talk back</b><span>Kimi reads reminders out loud</span></div>${toggleHTML('speak', st.speak)}</div>
      <div class="row"><div class="row-ic">${icon('check', 'sm')}</div><div class="row-txt"><b>Auto-save after speaking</b><span>Saves in 5 seconds unless you tap to edit</span></div>${toggleHTML('autoSave', st.autoSave)}</div>
    </div>

    <div class="section-h"><h3>Reminders</h3></div>
    <div class="group">
      <div class="row"><div class="row-ic gold">${icon('snooze', 'sm')}</div><div class="row-txt"><b>Default time</b><span>When you give a date but no time</span></div><input type="time" data-set="defaultTime" value="${esc(st.defaultTime)}"></div>
      <div class="row"><div class="row-ic gold">${icon('wallet', 'sm')}</div><div class="row-txt"><b>Currency</b><span>Used when you don't say one</span></div>
        <select data-set="currency">${Object.entries(C.CURRENCIES).map(([k, v]) => `<option value="${k}" ${st.currency === k ? 'selected' : ''}>${v.sym} ${k}</option>`).join('')}</select></div>
      <div class="row"><div class="row-ic gold">${icon('bell', 'sm')}</div><div class="row-txt"><b>Alarm sound</b><span>Chime when a reminder is due</span></div>${toggleHTML('sound', st.sound)}</div>
      <div class="row"><div class="row-ic gold">${icon('phone', 'sm')}</div><div class="row-txt"><b>Vibration</b><span>Taps and buzzes</span></div>${toggleHTML('haptics', st.haptics)}</div>
    </div>

    <div class="section-h"><h3>Alerts</h3></div>
    <div class="group">
      ${window.Notification && Notification.permission === 'granted'
        ? `<div class="row"><div class="row-ic violet">${icon('bell', 'sm')}</div><div class="row-txt"><b>Notifications</b><span><i class="status-dot ${ns}"></i>${nt}</span></div>${toggleHTML('notifications', st.notifications)}</div>`
        : `<button class="row" data-act="enable-notif"><div class="row-ic violet">${icon('bell', 'sm')}</div><div class="row-txt"><b>Notifications</b><span><i class="status-dot ${ns}"></i>${nt}</span></div>${icon('chev', 'sm chev')}</button>`}
      <button class="row" data-act="test-alert"><div class="row-ic violet">${icon('sparkle', 'sm')}</div><div class="row-txt"><b>Test an alert</b><span>Rings in 10 seconds. Try locking your phone</span></div>${icon('chev', 'sm chev')}</button>
      <button class="row" data-act="ics-all"><div class="row-ic violet">${icon('calendar', 'sm')}</div><div class="row-txt"><b>Add all to phone calendar</b><span>Back-up alarms that ring even when Kimi is closed</span></div>${icon('chev', 'sm chev')}</button>
    </div>
    <div class="info-card" style="margin-top:10px"><b>How alerts work:</b> Kimi rings while it's open, and checks in the background when your phone allows it (works best when installed on Android). For can't-miss reminders, tap <b>Add to calendar</b> on a reminder. Your Calendar app will alert you even if Kimi is closed.</div>

    <div class="section-h"><h3>App</h3></div>
    <div class="group">
      <button class="row" data-act="install"><div class="row-ic">${icon('phone', 'sm')}</div><div class="row-txt"><b>${isStandalone() ? 'Installed ✓' : 'Install on home screen'}</b><span>${isStandalone() ? 'Kimi runs like a native app' : 'Opens full-screen, works offline'}</span></div>${isStandalone() ? '' : icon('chev', 'sm chev')}</button>
      <div class="row"><div class="row-ic">${icon('moon', 'sm')}</div><div class="row-txt"><b>Appearance</b></div>
        <select data-set="theme">${[['auto', 'Match phone'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<option value="${v}" ${st.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>

    <div class="section-h"><h3>Backup</h3></div>
    <div class="group">
      <button class="row" data-act="export"><div class="row-ic">${icon('download', 'sm')}</div><div class="row-txt"><b>Save a backup file</b><span>Last backup: ${lb}</span></div>${icon('chev', 'sm chev')}</button>
      ${navigator.share ? `<button class="row" data-act="export-share"><div class="row-ic">${icon('share', 'sm')}</div><div class="row-txt"><b>Send backup to…</b><span>Google Drive, email, Messenger…</span></div>${icon('chev', 'sm chev')}</button>` : ''}
      <button class="row" data-act="import"><div class="row-ic">${icon('upload', 'sm')}</div><div class="row-txt"><b>Restore from backup</b><span>Merge or replace from a Kimi backup file</span></div>${icon('chev', 'sm chev')}</button>
      ${S.legacyNotes.length ? `<button class="row" data-act="export-notes"><div class="row-ic gold">${icon('edit', 'sm')}</div><div class="row-txt"><b>Old Kimi notes (${S.legacyNotes.length})</b><span>Save your notes from the previous version as a text file</span></div>${icon('chev', 'sm chev')}</button>` : ''}
    </div>

    <div class="section-h danger"><h3>Danger zone</h3></div>
    <div class="group">
      <button class="row" data-act="clear-done"><div class="row-ic red">${icon('check', 'sm')}</div><div class="row-txt"><b>Clear completed</b><span>${plural(S.reminders.filter(r => r.done).length, 'finished reminder')}</span></div></button>
      <button class="row" data-act="erase"><div class="row-ic red">${icon('trash', 'sm')}</div><div class="row-txt"><b>Erase everything</b><span>Deletes all reminders on this phone</span></div></button>
    </div>
    <p class="foot-note">${icon('shield', 'xs')} Private by design. Your reminders never leave this phone.<br>Voice is converted to text by your phone's browser.<br>Kimi v${APP_VERSION}</p>
  `;
}

function renderNav() {
  $$('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const now = new Date();
  const over = activeReminders().filter(r => C.fromLocal(r.due) < now).length;
  const dot = $('#nav-dot-list');
  dot.textContent = over > 9 ? '9+' : over;
  dot.classList.toggle('show', over > 0);
}
function renderAll() {
  renderNav();
  if (ui.tab === 'home') renderHome();
  else if (ui.tab === 'list') renderList();
  else if (ui.tab === 'bills') renderBills();
  else renderSettings();
}
function switchTab(tab) {
  if (ui.tab === tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = tab;
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === tab));
  try { sessionStorage.setItem('kimi_tab', tab); } catch { /* ignore */ }
  window.scrollTo(0, 0);
  renderAll();
  haptic(6);
}
function flashCard(id) {
  requestAnimationFrame(() => {
    const el = $(`.screen.active .swipe[data-id="${id}"] .card`);
    if (el) { el.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
}

/* ───────── Reminder actions ───────── */
function complete(id, fromEl) {
  const r = find(id); if (!r || r.done || isTest(r)) return;
  const snapshot = clone(r);
  const res = C.completeReminder(r, new Date());
  logAction(r, 'done');
  save();
  haptic([10, 40, 18]);
  if (fromEl) {
    const rect = fromEl.getBoundingClientRect();
    confetti(rect.left + rect.width / 2, rect.top + rect.height / 2, 14);
  }
  const wrap = $(`.screen.active .swipe[data-id="${id}"]`);
  if (wrap) {
    $('.check', wrap)?.classList.add('done');
    setTimeout(() => wrap.classList.add('collapse'), 260);
    setTimeout(renderAll, 640);
  } else renderAll();
  const word = r.type === 'task' ? 'Done' : 'Paid';
  const msg = res.next ? `${word}! Next one: ${esc(C.whenLabel(res.next))}` : r.type === 'task' ? 'Nice, done! ✓' : `Marked as paid ✓`;
  toast(msg, {
    action: 'Undo', onAction: () => {
      const i = S.reminders.findIndex(x => x.id === id);
      if (i > -1) S.reminders[i] = snapshot;
      const li = S.log.findIndex(l => l.id === id && l.action === 'done');
      if (li > -1) S.log.splice(li, 1);
      save(); renderAll(); haptic(8);
    }
  });
  const now = new Date();
  const leftToday = activeReminders().filter(x => C.fromLocal(x.due) < C.addDays(C.dateOnly(now), 1)).length;
  if (leftToday === 0 && S.reminders.length > 1) setTimeout(() => { confetti(innerWidth / 2, innerHeight / 3, 40); speak('All done for today. Nice work!'); }, 500);
}
function restore(id) {
  const r = find(id); if (!r) return;
  r.done = false; r.doneAt = null;
  if (C.fromLocal(r.due) < new Date()) r.alertedFor = r.due;
  save(); renderAll(); haptic(8);
  toast('Brought it back', { icon: 'undo' });
}
function snooze(id, until) {
  const r = find(id); if (!r || isTest(r)) return;
  const snapshot = clone(r);
  C.snoozeReminder(r, until);
  logAction(r, 'snooze');
  save(); renderAll(); haptic(10);
  toast(`Snoozed until ${esc(C.whenLabel(r.due))}`, {
    icon: 'snooze', action: 'Undo', onAction: () => {
      const i = S.reminders.findIndex(x => x.id === id);
      if (i > -1) S.reminders[i] = snapshot;
      save(); renderAll();
    }
  });
}
async function removeReminder(id) {
  const r = find(id); if (!r) return;
  const ok = await confirmSheet({ title: 'Delete reminder?', msg: `“${esc(r.title)}” will be removed${r.repeat ? ', including all future repeats' : ''}.`, ok: 'Delete', danger: true, icon: 'trash' });
  if (!ok) return;
  const i = S.reminders.indexOf(r);
  S.reminders.splice(i, 1);
  save(); renderAll(); haptic(15);
  toast('Deleted', { icon: 'trash', action: 'Undo', onAction: () => { S.reminders.splice(i, 0, r); save(); renderAll(); } });
}

function snoozeOptions(now = new Date()) {
  const [dh, dm] = C.parseHM(S.settings.defaultTime);
  const opts = [
    { label: '10 minutes', at: new Date(now.getTime() + 10 * 60000) },
    { label: '1 hour', at: new Date(now.getTime() + 3600000) },
    { label: '3 hours', at: new Date(now.getTime() + 3 * 3600000) }
  ];
  if (now.getHours() < 19) opts.push({ label: 'Tonight', at: C.setTime(now, 20, 0) });
  else opts.push({ label: 'Tomorrow evening', at: C.setTime(C.addDays(now, 1), 18, 0) });
  opts.push({ label: 'Tomorrow', at: C.setTime(C.addDays(C.dateOnly(now), 1), dh, dm) });
  const t = C.dateOnly(now);
  opts.push({ label: 'Next week', at: C.setTime(C.addDays(t, ((1 - t.getDay() + 7) % 7) || 7), dh, dm) });
  return opts;
}
function openSnooze(id) {
  const r = find(id); if (!r) return;
  const now = new Date();
  const opts = snoozeOptions(now);
  const sh = openSheet({
    title: 'Snooze until…',
    body: `<p class="page-sub" style="margin:-4px 0 14px">${esc(r.title)}</p>
      <div class="snooze-grid">${opts.map((o, i) => `<button class="snooze-opt" data-act="snooze-pick" data-id="${id}" data-i="${i}"><b>${o.label}</b><span>${esc(C.whenLabel(C.toLocal(o.at), now))}</span></button>`).join('')}</div>
      <div class="field" style="margin-top:18px"><label>Pick a time</label><div class="two"><input type="date" class="input" id="sn-date" value="${C.toLocal(opts[4].at).slice(0, 10)}"><input type="time" class="input" id="sn-time" value="${S.settings.defaultTime}"></div></div>
      <button class="btn soft block" data-act="snooze-custom" data-id="${id}">${icon('snooze', 'sm')} Snooze to this time</button>`
  });
  sh._snoozeOpts = opts;
}

function openDetail(id) {
  const r = find(id); if (!r) return;
  const now = new Date();
  const over = !r.done && C.fromLocal(r.due) < now;
  const word = r.type === 'task' ? 'done' : 'paid';
  openSheet({
    title: TYPE_LABEL[r.type],
    body: `
      <div class="detail-title">${esc(r.title)}</div>
      <div class="detail-meta">
        <span class="tag ${r.type}">${icon(TYPE_ICON[r.type], 'xs')} ${TYPE_LABEL[r.type]}</span>
        ${r.amount != null ? `<span class="tag bill">${esc(C.money(r.amount, r.currency))}</span>` : ''}
      </div>
      <div class="group" style="margin-bottom:14px">
        <div class="row"><div class="row-ic ${over ? 'red' : ''}">${icon('calendar', 'sm')}</div><div class="row-txt"><b>${esc(C.whenLabel(r.due, now))}</b><span>${r.done ? 'Completed' : esc(C.relative(r.due, now))}</span></div></div>
        <div class="row"><div class="row-ic violet">${icon('repeat', 'sm')}</div><div class="row-txt"><b>${esc(C.repeatLabel(r.repeat, r.base || r.due))}</b><span>${r.repeat ? 'Next one is scheduled when you mark it ' + word : 'Doesn\'t repeat'}</span></div></div>
        ${r.notes ? `<div class="row"><div class="row-ic gold">${icon('edit', 'sm')}</div><div class="row-txt"><span style="color:var(--ink);font-size:15px;white-space:pre-wrap">${esc(r.notes)}</span></div></div>` : ''}
      </div>
      <div class="actions">
        ${r.done
          ? `<button class="act green" data-act="restore" data-id="${id}">${icon('undo')} Bring it back</button>`
          : `<button class="act green" data-act="complete" data-id="${id}">${icon('check')} Mark as ${word}</button>
             <button class="act" data-act="snooze" data-id="${id}">${icon('snooze')} Snooze…</button>`}
        <button class="act" data-act="edit" data-id="${id}">${icon('edit')} Edit</button>
        <button class="act" data-act="ics" data-id="${id}">${icon('calendar')} Add to phone calendar</button>
        <button class="act red" data-act="delete" data-id="${id}">${icon('trash')} Delete</button>
      </div>
      ${r.heard ? `<p class="heard" style="margin-top:16px">You said: “${esc(r.heard)}”</p>` : ''}
      ${r.history && r.history.length ? `<div class="history"><div class="field-label">History</div><ul>${r.history.slice(0, 8).map(h => `<li><span>${r.type === 'task' ? 'Done' : 'Paid'}</span><span>${esc(C.whenLabel(h.at, now))}</span></li>`).join('')}</ul></div>` : ''}
    `
  });
}

/* ───────── Reminder form (shared by voice confirm + editor) ───────── */
let formCtx = { repeat: null };
const REPEAT_CHIPS = [['none', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['biweekly', 'Every 2 wks'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
function whenQuick(now = new Date()) {
  const [dh, dm] = C.parseHM(S.settings.defaultTime);
  const t = C.dateOnly(now);
  const list = [['In 1 hour', new Date(Math.ceil((now.getTime() + 3600000) / 300000) * 300000)]];
  if (now.getHours() < 19) list.push(['Tonight', C.setTime(t, 20, 0)]);
  list.push(['Tomorrow', C.setTime(C.addDays(t, 1), dh, dm)]);
  list.push(['This weekend', C.setTime(C.addDays(t, ((6 - t.getDay() + 7) % 7) || 7), 10, 0)]);
  list.push(['Next week', C.setTime(C.addDays(t, ((1 - t.getDay() + 7) % 7) || 7), dh, dm)]);
  list.push(['In a month', C.setTime(C.addMonths(t, 1), dh, dm)]);
  return list;
}
function formHTML(d, { ask = false } = {}) {
  formCtx = { repeat: d.repeat ? clone(d.repeat) : null, quick: whenQuick() };
  const rk = C.repeatKey(d.repeat);
  const [date, time] = (d.due || C.toLocal(new Date())).split('T');
  return `
    <div class="field"><label for="f-title">What</label><input class="input title-input" id="f-title" value="${esc(d.title)}" maxlength="140" autocomplete="off" enterkeyhint="done" placeholder="e.g. Pay internet bill"></div>
    <div class="field"><div class="seg" id="f-type">${['task', 'bill', 'subscription'].map(t => `<button type="button" class="${d.type === t ? 'on' : ''}" data-act="f-type" data-v="${t}">${icon(TYPE_ICON[t], 'xs')} ${TYPE_LABEL[t]}</button>`).join('')}</div></div>
    <div class="field${ask ? ' ask' : ''}" id="f-when"><label>${icon('calendar', 'xs')} When ${ask ? '<span class="ask-note">I guessed. Tap to change</span>' : ''}</label>
      <div class="two"><input type="date" class="input" id="f-date" value="${date}" required><input type="time" class="input" id="f-time" value="${time}"></div>
      <div class="when-quick">${formCtx.quick.map(([l], i) => `<button type="button" class="chip" data-act="f-when" data-i="${i}">${l}</button>`).join('')}</div>
    </div>
    <div class="field"><label>${icon('repeat', 'xs')} Repeat</label>
      <div class="chips" id="f-repeat">${REPEAT_CHIPS.map(([k, l]) => `<button type="button" class="chip${rk === k ? ' on' : ''}" data-act="f-repeat" data-v="${k}">${l}</button>`).join('')}${rk === 'custom' ? `<button type="button" class="chip on" data-act="f-repeat" data-v="custom">${esc(C.repeatLabel(d.repeat, d.due))}</button>` : ''}</div>
    </div>
    <div class="field" id="f-money" ${d.type === 'task' ? 'hidden' : ''}><label>${icon('wallet', 'xs')} Amount</label>
      <div class="money-input"><input class="input" id="f-amount" inputmode="decimal" placeholder="Optional" value="${d.amount != null ? d.amount : ''}" autocomplete="off">
      <select class="input" id="f-cur">${Object.entries(C.CURRENCIES).map(([k, v]) => `<option value="${k}" ${(d.currency || S.settings.currency) === k ? 'selected' : ''}>${v.sym} ${k}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="f-notes">Notes</label><textarea class="input" id="f-notes" rows="2" placeholder="Optional details">${esc(d.notes || '')}</textarea></div>`;
}
function readForm(root) {
  const title = $('#f-title', root).value.trim();
  const date = $('#f-date', root).value || C.toLocal(new Date()).slice(0, 10);
  const time = $('#f-time', root).value || S.settings.defaultTime;
  const type = ($('#f-type .on', root) || {}).dataset?.v || 'task';
  let repeat = formCtx.repeat ? clone(formCtx.repeat) : null;
  const day = parseInt(date.slice(8, 10), 10);
  if (repeat && (repeat.freq === 'month' || repeat.freq === 'year')) { if (day > 28) repeat.day = day; else delete repeat.day; }
  const amtRaw = type === 'task' ? '' : $('#f-amount', root).value.replace(/[^\d.]/g, '');
  const amount = amtRaw ? parseFloat(amtRaw) : null;
  return { title, type, due: date + 'T' + time, repeat, amount: isNaN(amount) ? null : amount, currency: $('#f-cur', root).value, notes: $('#f-notes', root).value.trim() };
}
function shake(el) { el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 320 }); }

function openEditor(id, preset = {}) {
  const r = id ? find(id) : null;
  const d = r ? clone(r) : { title: '', type: preset.type || 'task', due: C.toLocal(whenQuick().find(q => q[0] === 'Tomorrow')[1]), repeat: null, amount: null, currency: S.settings.currency, notes: '' };
  const sh = openSheet({
    title: r ? 'Edit reminder' : 'New reminder',
    body: formHTML(d),
    foot: `<div class="btn-row">${r ? `<button class="btn danger" data-act="delete" data-id="${r.id}" style="flex:0 0 auto">${icon('trash', 'sm')}</button>` : ''}<button class="btn primary" data-act="editor-save" data-id="${r ? r.id : ''}">${icon('check', 'sm')} Save</button></div>`,
    full: true
  });
  if (!r) setTimeout(() => $('#f-title', sh)?.focus(), 350);
}
function saveEditor(id) {
  const sh = $('.sheet', sheetEl);
  const f = readForm(sh);
  if (!f.title) { shake($('#f-title', sh)); $('#f-title', sh).focus(); return; }
  let r = id ? find(id) : null;
  if (r) {
    Object.assign(r, f);
    r.base = r.due; r.alertedFor = null;
    if (r.done && C.fromLocal(r.due) > new Date()) { r.done = false; r.doneAt = null; }
  } else {
    r = newReminder(f);
    S.reminders.push(r);
  }
  save(); closeSheet(); renderAll(); flashCard(r.id); haptic([8, 30, 8]);
  toast(id ? 'Updated ✓' : `Saved: ${esc(C.whenLabel(r.due))}`);
}
function newReminder(f) {
  return {
    id: uid(), title: f.title, type: f.type, due: f.due, base: f.due, repeat: f.repeat || null,
    amount: f.amount ?? null, currency: f.currency || S.settings.currency, notes: f.notes || '', heard: f.heard || '',
    done: false, createdAt: Date.now(), history: [], alertedFor: null
  };
}

/* ───────── Voice capture ───────── */
const Cap = { rec: null, final: '', interim: '', error: null, timer: null, draft: null, active: false, retriedLang: false };

function openCapture(opts = {}) {
  unlockAudio();
  stopSpeaking();
  openSheet({ title: 'Talk to Kimi', body: '<div class="capture" id="cap"></div>', full: true, onClose: endCapture });
  Cap.active = true;
  if (opts.text) return showConfirm(opts.text, { demo: !!opts.demo });
  if (opts.mode === 'type' || !SR) return showType(SR ? '' : 'Voice input isn\'t available in this browser. Type below. Your keyboard\'s 🎤 button works too!');
  startListening();
}
function endCapture() {
  Cap.active = false;
  clearTimeout(Cap.timer);
  if (Cap.rec) { try { Cap.rec.abort(); } catch { /* ignore */ } Cap.rec = null; }
}
function capEl() { return Cap.active ? $('#cap') : null; }

function startListening() {
  const el = capEl(); if (!el) return;
  clearTimeout(Cap.timer);
  Cap.final = ''; Cap.interim = ''; Cap.error = null;
  el.className = 'capture listening';
  el.innerHTML = `
    <div class="cap-stage">
      <div class="cap-status"><span class="live"></span> Listening</div>
      <div class="orb-wrap"><div class="halo"></div><button class="orb" data-act="cap-stop" aria-label="Stop listening">${icon('mic')}</button></div>
      <div class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="transcript placeholder" id="cap-text">Go ahead, I'm listening…</div>
    <div class="live-chips" id="cap-chips"></div>
    <p class="cap-hint">Talk like you'd tell a friend:<br>“Pay the internet bill on the 20th”</p>
    <div style="margin-top:auto;padding-top:20px" class="btn-row">
      <button class="btn" data-act="capture-type-switch">${icon('keyboard', 'sm')} Type</button>
      <button class="btn primary" data-act="cap-stop">${icon('check', 'sm')} I'm done</button>
    </div>`;
  let rec;
  try {
    rec = new SR();
  } catch { return showType('Voice input couldn\'t start. Type below instead.'); }
  rec.lang = S.settings.lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => { haptic(15); };
  rec.onspeechstart = () => capEl()?.classList.add('hearing');
  rec.onresult = e => {
    let fin = '', int = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) fin += t; else int += t;
    }
    Cap.final = fin; Cap.interim = int;
    updateTranscript();
  };
  rec.onerror = e => { Cap.error = e.error; };
  rec.onend = () => {
    if (Cap.rec !== rec) return;
    Cap.rec = null;
    if (!Cap.active) return;
    const text = (Cap.final + ' ' + Cap.interim).replace(/\s+/g, ' ').trim();
    blip(false);
    if (text) return showConfirm(text);
    handleVoiceError(Cap.error);
  };
  Cap.rec = rec;
  try { rec.start(); blip(true); } catch { Cap.rec = null; showType('Voice input couldn\'t start. Type below instead.'); }
}
function updateTranscript() {
  const t = $('#cap-text'); if (!t) return;
  const text = (Cap.final + ' ' + Cap.interim).trim();
  if (!text) return;
  t.classList.remove('placeholder');
  t.innerHTML = esc(Cap.final) + (Cap.interim ? ` <span class="interim">${esc(Cap.interim)}</span>` : '');
  renderLiveChips(text);
}
function renderLiveChips(text) {
  const box = $('#cap-chips'); if (!box) return;
  if (!text.trim()) { box.innerHTML = ''; return; }
  const p = C.parse(text, { currency: S.settings.currency, defaultTime: S.settings.defaultTime });
  const chips = [];
  if (!p.guessed) chips.push(`<span class="lchip">${icon('calendar')} ${esc(C.whenLabel(p.due))}</span>`);
  if (p.repeat) chips.push(`<span class="lchip">${icon('repeat')} ${esc(C.repeatLabel(p.repeat, p.due))}</span>`);
  if (p.amount != null) chips.push(`<span class="lchip">${icon('wallet')} ${esc(C.money(p.amount, p.currency))}</span>`);
  if (p.type !== 'task') chips.push(`<span class="lchip">${icon(TYPE_ICON[p.type])} ${TYPE_LABEL[p.type]}</span>`);
  box.innerHTML = chips.join('');
}
function handleVoiceError(err) {
  if (err === 'language-not-supported' && !Cap.retriedLang && S.settings.lang !== 'en-US') {
    Cap.retriedLang = true; S.settings.lang = 'en-US'; save();
    toast('Switched voice language to English (US)', { icon: 'mic' });
    return startListening();
  }
  const msgs = {
    'not-allowed': 'Microphone access is blocked. Allow the mic for this site in your browser settings, or type below. Your keyboard\'s 🎤 works too.',
    'service-not-allowed': 'Voice isn\'t allowed here. On iPhone, open Kimi in Safari, or type below using your keyboard\'s 🎤.',
    'network': 'Voice needs an internet connection on this browser. Type below instead. Your keyboard\'s 🎤 often works offline.',
    'audio-capture': 'I couldn\'t find a microphone. Type below instead.'
  };
  if (msgs[err]) return showType(msgs[err]);
  showRetry();
}
function showRetry() {
  const el = capEl(); if (!el) return;
  el.className = 'capture';
  el.innerHTML = `
    <div class="cap-stage">
      <div class="cap-status" style="color:var(--sub)">Didn't catch that</div>
      <div class="orb-wrap"><button class="orb" data-act="cap-retry" aria-label="Try again">${icon('mic')}</button></div>
    </div>
    <p class="cap-hint">Tap the mic and speak right after the beep.<br>Tip: hold your phone a little closer.</p>
    <div style="margin-top:auto;padding-top:20px" class="btn-row">
      <button class="btn" data-act="capture-type-switch">${icon('keyboard', 'sm')} Type instead</button>
      <button class="btn primary" data-act="cap-retry">${icon('mic', 'sm')} Try again</button>
    </div>`;
}
function showType(reason = '', prefill = '') {
  const el = capEl(); if (!el) return;
  if (Cap.rec) { try { Cap.rec.abort(); } catch { /* ignore */ } Cap.rec = null; }
  el.className = 'capture';
  el.innerHTML = `
    ${reason ? `<p class="cap-hint err" style="margin:0 0 14px;text-align:left">${esc(reason)}</p>` : ''}
    <div class="field type-box"><label for="type-text">Tell me what to remember</label>
      <textarea class="input" id="type-text" placeholder="e.g. Pay Meralco 2,350 on the 20th" enterkeyhint="done">${esc(prefill)}</textarea></div>
    <div class="live-chips" id="cap-chips" style="justify-content:flex-start"></div>
    <p class="cap-hint" style="text-align:left">💡 Hate typing? Tap the 🎤 on your keyboard to dictate.</p>
    <div style="margin-top:auto;padding-top:20px" class="btn-row">
      ${SR ? `<button class="btn" data-act="cap-retry">${icon('mic', 'sm')} Speak</button>` : ''}
      <button class="btn primary" data-act="type-next">Next ${icon('chev', 'sm')}</button>
    </div>`;
  const ta = $('#type-text');
  ta.addEventListener('input', () => renderLiveChips(ta.value));
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); typeNext(); } });
  if (prefill) renderLiveChips(prefill);
  setTimeout(() => ta.focus(), 300);
}
function typeNext() {
  const ta = $('#type-text'); if (!ta) return;
  const v = ta.value.trim();
  if (!v) { shake(ta); ta.focus(); return; }
  showConfirm(v);
}
function confirmSentence(p) {
  const lcFirst = t => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
  const spoken = C.speakWhen(p.due);
  const shown = spoken.replace(' a.m.', ' AM').replace(' p.m.', ' PM');
  const rep = p.repeat ? C.repeatLabel(p.repeat, p.due).replace(/^./, c => c.toLowerCase()) : '';
  const amt = p.amount != null ? ` (${C.money(p.amount, p.currency)})` : '';
  const what = p.type === 'task' ? `to <b>${esc(lcFirst(p.title))}</b>` : `about <b>${esc(p.title)}</b>${esc(amt)}`;
  if (p.guessed) return { html: `Got it: <b>${esc(p.title)}</b>${esc(amt)}. <span style="color:var(--amber);font-weight:700">When should I remind you?</span>`, say: 'Got it. When should I remind you?' };
  return {
    html: `Okay! I'll remind you ${what} ${rep ? `<b>${esc(rep)}</b>, starting ` : ''}<b>${esc(shown)}</b>.`,
    say: `Okay. ${p.title}${rep ? ', ' + rep + ', starting' : ','} ${spoken.replace(/\.$/, '')}.`
  };
}
function showConfirm(text, { demo = false } = {}) {
  const el = capEl(); if (!el) return;
  const p = C.parse(text, { currency: S.settings.currency, defaultTime: S.settings.defaultTime });
  Cap.draft = p;
  const sent = confirmSentence(p);
  const auto = S.settings.autoSave && !p.guessed && !demo;
  el.className = 'capture';
  el.innerHTML = `
    <div class="confirm-say"><div class="kimi-avatar" aria-hidden="true">K</div><div class="bubble">${sent.html}</div></div>
    <div id="cap-form">${formHTML(p, { ask: p.guessed })}</div>
    <p class="heard">Heard: “${esc(text)}”</p>
    <div style="margin-top:auto;padding-top:18px;position:sticky;bottom:0;background:var(--bg)" class="btn-row">
      <button class="btn" data-act="cap-retry" style="flex:0 0 auto">${icon('mic', 'sm')}</button>
      <button class="btn primary" data-act="cap-save" id="cap-save">${icon('check', 'sm')} ${auto ? 'Saving…' : 'Save reminder'}${auto ? '<span class="ring" style="--dur:5s"></span>' : ''}</button>
    </div>`;
  haptic(10);
  speak(sent.say);
  if (auto) {
    Cap.timer = setTimeout(saveCapture, 5000);
    const cancel = e => {
      if (e.target.closest && e.target.closest('#cap-save')) return;
      cancelAutoSave();
    };
    el.addEventListener('pointerdown', cancel, { once: true, capture: true });
    el.addEventListener('focusin', cancel, { once: true });
  }
}
function cancelAutoSave() {
  if (!Cap.timer) return;
  clearTimeout(Cap.timer); Cap.timer = null;
  const b = $('#cap-save');
  if (b) b.innerHTML = `${icon('check', 'sm')} Save reminder`;
}
function saveCapture() {
  clearTimeout(Cap.timer); Cap.timer = null;
  const el = capEl(); if (!el) return;
  const f = readForm(el);
  if (!f.title) { shake($('#f-title', el)); $('#f-title', el).focus(); return; }
  const r = newReminder({ ...f, heard: Cap.draft ? Cap.draft.heard : '' });
  S.reminders.push(r);
  save();
  closeSheet();
  if (ui.tab === 'settings') switchTab('home'); else renderAll();
  flashCard(r.id);
  haptic([8, 30, 8]);
  toast(`Saved! ${esc(C.whenLabel(r.due))}`, {
    icon: 'check', action: 'Undo', onAction: () => {
      S.reminders = S.reminders.filter(x => x.id !== r.id); save(); renderAll();
    }
  });
}

/* ───────── Alerts ───────── */
let alarmQueue = [], alarmOpen = null, alarmLoop = null, firstTick = true;
function tick() {
  const now = new Date();
  const due = C.dueReminders(S, now);
  if (due.length) {
    const missed = [];
    for (const r of due) {
      const lateMin = (now - C.fromLocal(r.due)) / 60000;
      r.alertedFor = r.due;
      if (firstTick && lateMin > 10) missed.push(r);
      else fireAlert(r);
    }
    save();
    if (missed.length) {
      ui.awayCount = missed.length;
      toast(`While you were away, ${plural(missed.length, 'reminder')} came due.`, { icon: 'bell', ms: 6000 });
    }
    if (!sheetEl && !isTyping()) renderAll();
  }
  firstTick = false;
}
function isTyping() { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); }
function fireAlert(r) {
  if (document.visibilityState === 'visible') {
    alarmQueue.push(r.id);
    if (!alarmOpen) showNextAlarm();
  } else systemNotify(r);
}
async function systemNotify(r) {
  if (!S.settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = (r.type === 'task' ? '⏰ ' : r.type === 'bill' ? '🧾 ' : '🔁 ') + r.title;
  const body = [r.amount != null ? C.money(r.amount, r.currency) : '', C.whenLabel(r.due)].filter(Boolean).join(' · ');
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      await reg.showNotification(title, {
        body, tag: 'kimi-' + r.id, renotify: true, requireInteraction: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
        vibrate: [200, 100, 200, 100, 300], data: { id: r.id },
        actions: [{ action: 'done', title: r.type === 'task' ? '✓ Done' : '✓ Paid' }, { action: 'snooze', title: '⏰ 1 hour' }]
      });
      return;
    }
  } catch { /* fall back */ }
  try { new Notification(title, { body, tag: 'kimi-' + r.id, icon: 'icons/icon-192.png' }); } catch { /* ignore */ }
}
function showNextAlarm() {
  const id = alarmQueue.shift();
  if (!id) { alarmOpen = null; return; }
  const r = find(id);
  if (!r || r.done) return showNextAlarm();
  alarmOpen = id;
  const word = r.type === 'task' ? 'Done' : 'Paid';
  $('#alarm-root').innerHTML = `
    <div class="alarm-backdrop" role="alertdialog" aria-label="Reminder">
      <div class="alarm">
        <div class="alarm-bell">${icon('bell')}</div>
        <div class="alarm-kicker">${TYPE_LABEL[r.type]} · ${esc(C.fmtTime(C.fromLocal(r.due)))}</div>
        <div class="alarm-title">${esc(r.title)}</div>
        <div class="alarm-sub">${[r.amount != null ? C.money(r.amount, r.currency) : '', r.repeat ? C.repeatLabel(r.repeat, r.base || r.due) : ''].filter(Boolean).map(esc).join(' · ') || 'It\'s time!'}</div>
        <button class="btn primary" data-act="alarm-done">${icon('check', 'sm')} ${word}</button>
        <div class="snz">
          <button class="btn" data-act="alarm-snooze" data-min="10">10 min</button>
          <button class="btn" data-act="alarm-snooze" data-min="60">1 hour</button>
          <button class="btn" data-act="alarm-snooze" data-min="tomorrow">Tomorrow</button>
        </div>
        <button class="btn ghost" data-act="alarm-dismiss">Dismiss</button>
      </div>
    </div>`;
  let rings = 0;
  const ring = () => { chime(); haptic([300, 120, 300]); if (++rings >= 4) clearInterval(alarmLoop); };
  ring();
  clearInterval(alarmLoop);
  alarmLoop = setInterval(ring, 3200);
  setTimeout(() => speak(`Reminder: ${r.title}`), 900);
}
function closeAlarm() {
  clearInterval(alarmLoop);
  stopSpeaking();
  const bd = $('#alarm-root .alarm-backdrop');
  if (bd) { bd.style.transition = 'opacity .2s'; bd.style.opacity = '0'; }
  setTimeout(() => { $('#alarm-root').innerHTML = ''; alarmOpen = null; showNextAlarm(); }, 200);
}
async function enableNotifications() {
  if (!('Notification' in window)) { toast('This browser can\'t show notifications. Use Add to calendar instead.', { icon: 'alert' }); return; }
  if (Notification.permission === 'denied') {
    toast('Notifications are blocked. Open your browser\'s site settings for Kimi to allow them.', { icon: 'alert', ms: 7000 });
    return;
  }
  if (Notification.permission === 'granted') return;
  const p = await Notification.requestPermission();
  if (p === 'granted') {
    S.settings.notifications = true; save();
    toast('Alerts are on. I\'ll nudge you on time 🔔', { icon: 'bell' });
    registerPeriodicSync();
  }
  renderAll();
}
async function registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !('periodicSync' in reg)) return;
    const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (st.state === 'granted') await reg.periodicSync.register('kimi-due-check', { minInterval: 15 * 60 * 1000 });
  } catch { /* not supported */ }
}
function updateBadge() {
  if (!navigator.setAppBadge) return;
  const now = new Date();
  const n = activeReminders().filter(r => C.fromLocal(r.due) <= now).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
function testAlert() {
  unlockAudio();
  testRem = newReminder({ title: 'Test alert from Kimi 👋', type: 'task', due: C.toLocal(new Date()), notes: '' });
  testRem._test = true;
  toast('Test alert in 10 seconds… try locking your phone', { icon: 'bell' });
  setTimeout(() => fireAlert(testRem), 10000);
}
function isTest(r) {
  if (!r || !r._test) return false;
  toast('Alerts are working! 🎉', { icon: 'bell' });
  testRem = null;
  return true;
}

/* ───────── Calendar, backup & restore ───────── */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function addToCalendar(list, name) {
  if (!list.length) { toast('No upcoming reminders to add', { icon: 'calendar' }); return; }
  const ics = C.buildICS(list);
  download(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), name);
  toast(list.length === 1 ? 'Open the downloaded file to add it to your calendar' : `Calendar file with ${list.length} reminders downloaded. Open it to import`, { icon: 'calendar', ms: 6000 });
}
async function exportBackup(share = false) {
  const data = { app: 'kimi', version: 5, exportedAt: new Date().toISOString(), state: S };
  const json = JSON.stringify(data, null, 2);
  const stamp = C.toLocal(new Date()).slice(0, 10);
  if (share && navigator.share) {
    const file = new File([json], `kimi-backup-${stamp}.txt`, { type: 'text/plain' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Kimi backup' });
      else await navigator.share({ title: 'Kimi backup', text: json });
    } catch (e) { if (e && e.name === 'AbortError') return; download(new Blob([json], { type: 'application/json' }), `kimi-backup-${stamp}.json`); }
  } else {
    download(new Blob([json], { type: 'application/json' }), `kimi-backup-${stamp}.json`);
  }
  S.settings.lastBackup = Date.now();
  save(); renderAll();
  toast(`Backup saved with ${plural(S.reminders.length, 'reminder')}`, { icon: 'shield' });
}
function importBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(reader.result); } catch { toast('That file isn\'t a Kimi backup', { icon: 'alert' }); return; }
    const st = data && (data.state || (Array.isArray(data.reminders) ? data : null));
    if (!st || !Array.isArray(st.reminders)) { toast('That file isn\'t a Kimi backup', { icon: 'alert' }); return; }
    const when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'an unknown date';
    openSheet({
      title: 'Restore backup',
      body: `<div class="empty" style="box-shadow:none;background:transparent;padding:6px"><div class="empty-art">${icon('upload')}</div><h4>${plural(st.reminders.length, 'reminder')}</h4><p>From a backup made on ${esc(when)}.<br><br><b>Merge</b> adds anything missing and keeps what's on this phone. <b>Replace</b> wipes this phone first.</p></div>`,
      foot: `<div class="btn-row"><button class="btn danger" data-act="restore-replace">Replace</button><button class="btn primary" data-act="restore-merge">Merge</button></div>`
    });
    pendingRestore = st;
  };
  reader.readAsText(file);
}
let pendingRestore = null;
function applyRestore(mode) {
  const st = pendingRestore; pendingRestore = null;
  if (!st) return;
  const now = new Date();
  const incoming = st.reminders.filter(r => r && r.id && r.due).map(r => ({ ...r, alertedFor: C.fromLocal(r.due) < now ? r.due : r.alertedFor || null }));
  if (mode === 'replace') {
    const keepSettings = S.settings;
    S = normalize({ ...st, reminders: incoming });
    S.settings = { ...keepSettings, ...st.settings, onboarded: true };
  } else {
    const ids = new Set(S.reminders.map(r => r.id));
    let added = 0;
    incoming.forEach(r => { if (!ids.has(r.id)) { S.reminders.push(r); added++; } });
    S.log = [...S.log, ...(st.log || [])].slice(0, 300);
    toast(`Merged: ${plural(added, 'new reminder')} added`, { icon: 'upload' });
  }
  save(); closeSheet(); applyTheme(); renderAll();
  if (mode === 'replace') toast(`Restored ${plural(S.reminders.length, 'reminder')}`, { icon: 'upload' });
}
function exportLegacyNotes() {
  const txt = S.legacyNotes.map(n => `# ${n.title}\n${n.date ? '(' + n.date + ')\n' : ''}${n.body}\n`).join('\n');
  download(new Blob([txt], { type: 'text/plain' }), 'kimi-old-notes.txt');
}

/* ───────── Install ───────── */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (ui.tab === 'home' || ui.tab === 'settings') renderAll(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; toast('Kimi is on your home screen 🎉', { icon: 'phone' }); renderAll(); });
async function install() {
  if (isStandalone()) return;
  if (deferredInstall) {
    deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice.catch(() => ({}));
    deferredInstall = null;
    if (outcome === 'accepted') haptic([10, 40, 10]);
    renderAll();
    return;
  }
  const steps = isIOS
    ? [['share', 'Tap the <b>Share</b> button', 'At the bottom of Safari (or top on iPad)'], ['plus', 'Choose <b>Add to Home Screen</b>', 'Scroll down the share menu if you don\'t see it'], ['check', 'Tap <b>Add</b>', 'Kimi now opens like an app']]
    : [['sliders', 'Open your browser menu', 'The ⋮ button, usually top-right in Chrome'], ['phone', 'Tap <b>Install app</b> or <b>Add to Home screen</b>', ''], ['check', 'Confirm', 'Kimi now opens like an app']];
  openSheet({
    title: 'Install Kimi',
    body: `<div class="onb-steps" style="margin-top:6px">${steps.map(([ic, b, s]) => `<div class="onb-step"><div class="row-ic">${icon(ic, 'sm')}</div><div><b>${b}</b>${s ? `<span>${s}</span>` : ''}</div></div>`).join('')}</div>`
  });
}

/* ───────── Onboarding ───────── */
function showOnboarding() {
  const root = $('#onboarding-root');
  root.innerHTML = `
    <div class="onb">
      <div class="onb-art">K</div>
      <h1>Hi, I'm Kimi.</h1>
      <p class="lead">Your forget-proof memory. Just talk, and I'll turn it into reminders.</p>
      <div class="onb-steps">
        <div class="onb-step"><div class="row-ic">${icon('mic', 'sm')}</div><div><b>Tap & talk</b><span>“Pay rent on the 5th every month”</span></div></div>
        <div class="onb-step"><div class="row-ic gold">${icon('calendar', 'sm')}</div><div><b>I work out the details</b><span>Dates, times, repeats and amounts</span></div></div>
        <div class="onb-step"><div class="row-ic violet">${icon('bell', 'sm')}</div><div><b>I nudge you on time</b><span>Snooze or mark it done in one tap</span></div></div>
      </div>
      <div class="field"><label for="onb-name">What should I call you?</label><input class="input" id="onb-name" placeholder="Your name (optional)" autocomplete="given-name" enterkeyhint="go"></div>
      <div class="spacer"></div>
      <button class="btn primary block" data-act="onb-go">Let's go ${icon('chev', 'sm')}</button>
      <p class="foot-note" style="margin-top:14px">${icon('shield', 'xs')} No account. Your reminders stay on this phone.</p>
    </div>`;
  $('#onb-name').addEventListener('keydown', e => { if (e.key === 'Enter') finishOnboarding(); });
}
async function finishOnboarding() {
  unlockAudio();
  const name = ($('#onb-name')?.value || '').trim();
  S.settings.name = name.slice(0, 30);
  S.settings.onboarded = true;
  if (/^en-?PH|fil/i.test(navigator.language || '')) { S.settings.lang = 'en-PH'; S.settings.currency = 'PHP'; }
  else if (/AU/i.test(navigator.language || '')) { S.settings.lang = 'en-AU'; S.settings.currency = 'AUD'; }
  save();
  const o = $('.onb');
  o.style.transition = 'opacity .3s, transform .3s'; o.style.opacity = '0'; o.style.transform = 'scale(1.03)';
  setTimeout(() => { $('#onboarding-root').innerHTML = ''; }, 300);
  renderAll();
  try { navigator.storage?.persist?.(); } catch { /* ignore */ }
  speak(`Nice to meet you${name ? ', ' + name : ''}! Tap the microphone whenever you want me to remember something.`);
}

/* ───────── Gestures: swipe right = done, swipe left = snooze ───────── */
let drag = null, suppressClick = false;
document.addEventListener('pointerdown', e => {
  const card = e.target.closest('.swipe .card');
  if (!card || e.target.closest('.check') || card.classList.contains('is-done')) return;
  drag = { card, wrap: card.parentElement, x0: e.clientX, y0: e.clientY, dx: 0, locked: null, id: card.dataset.id, pid: e.pointerId, armed: false };
}, { passive: true });
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
  if (drag.locked === null) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      drag.locked = 'x'; drag.card.classList.add('dragging');
      try { drag.card.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    } else if (Math.abs(dy) > 10) { drag = null; return; } else return;
  }
  drag.dx = dx;
  const lim = 150;
  const damp = Math.abs(dx) < lim ? dx : Math.sign(dx) * (lim + (Math.abs(dx) - lim) * 0.25);
  drag.card.style.transform = `translateX(${damp}px)`;
  drag.wrap.classList.toggle('dir-right', dx > 0);
  drag.wrap.classList.toggle('dir-left', dx < 0);
  const armed = Math.abs(dx) > 90;
  if (armed !== drag.armed) { drag.armed = armed; drag.wrap.classList.toggle('armed', armed); if (armed) haptic(8); }
});
function endDrag() {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.locked !== 'x') return;
  suppressClick = true; setTimeout(() => { suppressClick = false; }, 80);
  d.card.classList.remove('dragging'); d.card.classList.add('settle');
  if (d.armed && d.dx > 0) {
    d.card.style.transform = 'translateX(110%)';
    complete(d.id, null);
  } else {
    d.card.style.transform = '';
    setTimeout(() => { d.wrap.classList.remove('dir-left', 'dir-right', 'armed'); d.card.classList.remove('settle'); }, 320);
    if (d.armed && d.dx < 0) openSnooze(d.id);
  }
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

/* ───────── Event delegation ───────── */
const ACTIONS = {
  'capture': () => openCapture(),
  'capture-type': () => openCapture({ mode: 'type' }),
  'capture-type-switch': () => showType(),
  'try': el => openCapture({ text: el.dataset.text, demo: true }),
  'cap-stop': () => { if (Cap.rec) { try { Cap.rec.stop(); } catch { /* ignore */ } } },
  'cap-retry': () => { cancelAutoSave(); stopSpeaking(); startListening(); },
  'cap-save': () => saveCapture(),
  'type-next': () => typeNext(),
  'close-sheet': () => closeSheet(),
  'confirm-yes': () => confirmResolver && confirmResolver(true),
  'confirm-no': () => confirmResolver && confirmResolver(false),
  'open': el => openDetail(el.dataset.id),
  'complete': (el, e) => { const fromSheet = !!el.closest('.sheet'); if (fromSheet) closeSheet(); complete(el.dataset.id, fromSheet ? null : el); e.stopPropagation(); },
  'restore': el => { if (el.closest('.sheet')) closeSheet(); restore(el.dataset.id); },
  'snooze': el => openSnooze(el.dataset.id),
  'snooze-pick': el => { const opts = $('.sheet', sheetEl)._snoozeOpts; const o = opts && opts[+el.dataset.i]; closeSheet(); if (o) snooze(el.dataset.id, o.at); },
  'snooze-custom': el => {
    const d = $('#sn-date').value, t = $('#sn-time').value || S.settings.defaultTime;
    if (!d) return;
    const at = C.fromLocal(d + 'T' + t);
    if (at <= new Date()) { shake($('#sn-time')); return; }
    closeSheet(); snooze(el.dataset.id, at);
  },
  'edit': el => openEditor(el.dataset.id),
  'new': el => openEditor(null, { type: el.dataset.type }),
  'editor-save': el => saveEditor(el.dataset.id || null),
  'delete': el => removeReminder(el.dataset.id),
  'ics': el => { const r = find(el.dataset.id); if (r) addToCalendar([r], `kimi-${r.title.replace(/[^\w]+/g, '-').slice(0, 30).toLowerCase() || 'reminder'}.ics`); },
  'ics-all': () => addToCalendar(activeReminders().filter(r => !r._test), 'kimi-reminders.ics'),
  'seg': el => { ui.listSeg = el.dataset.v; renderList(); haptic(5); },
  'f-type': el => {
    $$('#f-type button').forEach(b => b.classList.toggle('on', b === el));
    $('#f-money').hidden = el.dataset.v === 'task';
    haptic(5);
  },
  'f-repeat': el => {
    if (el.dataset.v === 'custom') return;
    $$('#f-repeat .chip').forEach(b => b.classList.toggle('on', b === el));
    formCtx.repeat = C.REPEAT_PRESETS[el.dataset.v] ? clone(C.REPEAT_PRESETS[el.dataset.v]) : null;
    $('#f-repeat [data-v="custom"]')?.remove();
    haptic(5);
  },
  'f-when': el => {
    const q = formCtx.quick[+el.dataset.i]; if (!q) return;
    const s = C.toLocal(q[1]);
    $('#f-date').value = s.slice(0, 10); $('#f-time').value = s.slice(11);
    $$('.when-quick .chip').forEach(b => b.classList.toggle('on', b === el));
    $('#f-when').classList.remove('ask');
    const note = $('#f-when .ask-note'); if (note) note.remove();
    haptic(5);
  },
  'alarm-done': () => { const id = alarmOpen; closeAlarm(); complete(id, null); },
  'alarm-snooze': el => {
    const id = alarmOpen, m = el.dataset.min;
    const [dh, dm] = C.parseHM(S.settings.defaultTime);
    const at = m === 'tomorrow' ? C.setTime(C.addDays(C.dateOnly(new Date()), 1), dh, dm) : new Date(Date.now() + (+m) * 60000);
    closeAlarm(); snooze(id, at);
  },
  'alarm-dismiss': () => closeAlarm(),
  'enable-notif': () => enableNotifications(),
  'dismiss': el => { S.settings.dismissed[el.dataset.k] = Date.now(); save(); renderAll(); },
  'install': () => install(),
  'test-alert': () => testAlert(),
  'export': () => exportBackup(false),
  'export-share': () => exportBackup(true),
  'export-notes': () => exportLegacyNotes(),
  'import': () => $('#import-file').click(),
  'restore-merge': () => applyRestore('merge'),
  'restore-replace': async () => {
    const st = pendingRestore;
    const ok = await confirmSheet({ title: 'Replace everything?', msg: 'All reminders on this phone will be replaced by the backup. This can\'t be undone.', ok: 'Replace', danger: true });
    if (ok) { pendingRestore = st; applyRestore('replace'); }
  },
  'clear-done': async () => {
    const n = S.reminders.filter(r => r.done).length;
    if (!n) { toast('Nothing to clear', { icon: 'check' }); return; }
    const ok = await confirmSheet({ title: 'Clear completed?', msg: `Remove ${plural(n, 'finished reminder')} for good?`, ok: 'Clear', danger: true, icon: 'trash' });
    if (!ok) return;
    S.reminders = S.reminders.filter(r => !r.done); save(); renderAll(); toast('Cleared', { icon: 'trash' });
  },
  'erase': async () => {
    const ok = await confirmSheet({ title: 'Erase everything?', msg: `This deletes all ${plural(S.reminders.length, 'reminder')} and settings on this phone. Consider saving a backup first.`, ok: 'Erase all', danger: true, icon: 'trash' });
    if (!ok) return;
    const name = S.settings.name;
    S = clone(DEFAULTS); S.settings.onboarded = true; S.settings.name = name;
    save(); renderAll(); toast('All cleared. Fresh start ✨', { icon: 'sparkle' });
  },
  'onb-go': () => finishOnboarding()
};
document.addEventListener('click', e => {
  if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; }
  unlockAudio();
  const tab = e.target.closest('[data-tab]');
  if (tab) { if (sheetEl) closeSheet(); switchTab(tab.dataset.tab); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
}, true);

document.addEventListener('change', e => {
  const k = e.target.dataset && e.target.dataset.set;
  if (k) {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    S.settings[k] = k === 'name' ? String(v).trim().slice(0, 30) : v;
    save();
    if (k === 'theme') applyTheme();
    if (k === 'speak' && v) speak('Okay, I\'ll talk back.');
    if (k === 'haptics' && v) haptic(20);
    if (k === 'notifications') renderSettings();
    toast('Saved', { icon: 'check', ms: 1400 });
    return;
  }
  if (e.target.id === 'import-file' && e.target.files[0]) { importBackup(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('input', e => {
  if (e.target.id === 'list-q') { ui.q = e.target.value; renderListBody(); }
  if (e.target.id === 'f-date' || e.target.id === 'f-time') { $('#f-when')?.classList.remove('ask'); $('#f-when .ask-note')?.remove(); }
});

/* ───────── Service worker ───────── */
let updateRequested = false;
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of Kimi is ready', { icon: 'sparkle', action: 'Update', ms: 20000, onAction: () => { updateRequested = true; nw.postMessage('skipWaiting'); } });
        }
      });
    });
    if (window.Notification && Notification.permission === 'granted') registerPeriodicSync();
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); });
  navigator.serviceWorker.addEventListener('message', async e => {
    const m = e.data || {};
    if (m.type === 'state-changed') {
      try { const fresh = await DB.get('state'); if (fresh) { S = normalize(fresh); localStorage.setItem('kimi_v5', JSON.stringify(S)); renderAll(); } } catch { /* ignore */ }
    } else if (m.type === 'open-reminder' && m.id) openDetail(m.id);
  });
}

/* ───────── Boot ───────── */
async function boot() {
  await loadState();
  applyTheme();
  let tab = 'home';
  try { tab = sessionStorage.getItem('kimi_tab') || 'home'; } catch { /* ignore */ }
  const params = new URLSearchParams(location.search);
  if (params.get('tab')) tab = params.get('tab');
  if (!['home', 'list', 'bills', 'settings'].includes(tab)) tab = 'home';
  ui.tab = tab;
  $$('.screen').forEach(s => s.classList.toggle('active', s.dataset.screen === tab));
  renderAll();
  if (S.migratedCount) {
    toast(`Welcome back! I brought over ${plural(S.migratedCount, 'reminder')} from the old Kimi.`, { icon: 'sparkle', ms: 7000 });
    delete S.migratedCount; S.settings.onboarded = true; save();
  }
  if (!S.settings.onboarded) showOnboarding();

  // Deep links: shortcuts, share target, notification taps
  const shared = [params.get('share_title'), params.get('share_text'), params.get('share_url')].filter(Boolean).join(' ').trim();
  if (params.toString()) history.replaceState(null, '', location.pathname);
  if (S.settings.onboarded) {
    if (shared) openCapture({ text: shared });
    else if (params.get('action') === 'voice') openCapture();
    else if (params.get('open')) openDetail(params.get('open'));
  }

  tick();
  setInterval(tick, 10000);
  let lastMinute = new Date().getMinutes();
  setInterval(() => {
    const m = new Date().getMinutes();
    if (m !== lastMinute && !sheetEl && !drag && !isTyping() && document.visibilityState === 'visible') { lastMinute = m; renderAll(); }
  }, 15000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const fresh = await DB.get('state');
      if (fresh && (fresh.updatedAt || 0) > (S.updatedAt || 0)) S = normalize(fresh);
    } catch { /* ignore */ }
    firstTick = true;
    tick();
    if (!sheetEl && !isTyping()) renderAll();
  });
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
  updateBadge();
  registerSW();
}
boot();
