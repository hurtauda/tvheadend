/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Tvheadend contributors
 *
 * Tvheadend mobile UI.
 *
 * A dependency-free single-page app for phones and tablets. It is served at
 * {webroot}/mobile/ (src/webui/mobile.c) and uses only the regular server
 * interfaces, so permissions are enforced exactly as for the other UIs:
 *
 *   api/access/whoami             session rights, UI theme, disk space
 *   api/channel/grid, api/channeltag/list
 *   api/epg/events/grid|load      now/next, channel schedules, search
 *   api/epg/content_type/list     genre filter and names
 *   api/dvr/entry/grid_*          recordings; create_by_event, stop,
 *   api/dvr/autorec/create_by_series             cancel, remove
 *   api/profile/list              stream profiles for the player
 *   comet/poll                    live updates (DVR changes, access updates)
 *   stream/channel/<uuid>, dvrfile/<uuid>, play/ticket/...   playback
 *
 * Routing is hash based (#/now, #/guide/<channel>, #/search,
 * #/dvr/<upcoming|finished|failed>). Event details, the player and
 * confirmations are <dialog>s tied into the browser history, so the phone's
 * back gesture closes them. Server data is only ever inserted as text.
 * UI strings go through _() and the shared tvh_locale catalog, reusing the
 * msgids the other UIs already have wherever possible.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * Basics: server root, i18n, formatting
   * ------------------------------------------------------------------- */

  /* The page lives at {webroot}/mobile/; everything else hangs off {webroot}/. */
  const ROOT = (function () {
    const p = location.pathname;
    const i = p.lastIndexOf('/mobile/');
    return i >= 0 ? p.slice(0, i + 1) : '/';
  })();
  const url = (path) => ROOT + path;

  const CATALOG = (typeof window.tvh_locale === 'object' && window.tvh_locale) || {};

  function _(s) {
    const r = CATALOG[s];
    return typeof r === 'string' && r !== '' ? r : s;
  }

  /* Context-qualified msgids ("New#EPG"): translations keep the qualifier
   * too ("Neu#EPG"), so always cut it off, as the ExtJS UI does. */
  function _ctx(s) {
    return _(s).split('#')[0];
  }

  /* UI strings are English unless a catalog is loaded; dates and numbers use
   * the catalog language when the browser knows it, else the device locale. */
  const UI_LANG = String(window.tvh_locale_lang || '').replace(/_/g, '-');
  const LOCALE = (function () {
    const cands = [];
    if (UI_LANG) cands.push(UI_LANG);
    (navigator.languages || [navigator.language]).forEach((l) => { if (l) cands.push(l); });
    for (let i = 0; i < cands.length; i++) {
      try {
        if (Intl.DateTimeFormat.supportedLocalesOf([cands[i]]).length) return cands[i];
      } catch (e) { /* invalid tag */ }
    }
    return 'en';
  })();
  document.documentElement.lang = UI_LANG || 'en';

  const DF_TIME = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
  const DF_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
  const DF_DAYSHORT = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric' });
  const DF_DATE = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  const DF_DATEYEAR = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

  const RTF = (function () {
    try { return new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }); } catch (e) { return null; }
  })();

  function unitFormat(unit, digits) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: 'unit', unit: unit, unitDisplay: 'short', maximumFractionDigits: digits });
    } catch (e) {
      return null;
    }
  }
  const NF_MIN = unitFormat('minute', 0);

  const nowSec = () => Math.floor(Date.now() / 1000);
  const toDate = (ts) => new Date(ts * 1000);
  const isoOf = (ts) => toDate(ts).toISOString();

  function capitalize(s) {
    return s ? s.charAt(0).toLocaleUpperCase(LOCALE) + s.slice(1) : s;
  }

  function fmtTime(ts) { return DF_TIME.format(toDate(ts)); }

  /* "1:30 – 3:15 PM" / "13:30–15:15" where Intl can do ranges. Across
   * midnight Intl adds full dates, far too long here: keep the times. */
  function fmtRange(a, b) {
    if (typeof DF_TIME.formatRange === 'function' && dayKey(a) === dayKey(b)) {
      try { return DF_TIME.formatRange(toDate(a), toDate(b)); } catch (e) { /* fall through */ }
    }
    return fmtTime(a) + '\u2013' + fmtTime(b);
  }

  /* Row time column: the clock time, with any AM/PM marker set apart. */
  function timeEl(ts) {
    const el = h('time', { class: 'row-time', datetime: isoOf(ts) });
    let period = '';
    let main = fmtTime(ts);
    if (typeof DF_TIME.formatToParts === 'function') {
      const parts = DF_TIME.formatToParts(toDate(ts));
      const dp = parts.filter((p) => p.type === 'dayPeriod');
      if (dp.length) {
        period = dp[0].value;
        main = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
      }
    }
    add(el, [main, period ? h('small', { text: period }) : null]);
    return el;
  }

  function fmtMinutes(min) {
    min = Math.max(0, Math.round(min || 0));
    return NF_MIN ? NF_MIN.format(min) : min + ' min';
  }

  function fmtBytes(b) {
    if (!(b > 0)) return '';
    const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
    const short = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
    const nf = unitFormat(units[i], b < 10 ? 1 : 0);
    return nf ? nf.format(b) : b.toFixed(b < 10 ? 1 : 0) + ' ' + short[i];
  }

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function dayKey(ts) { const d = toDate(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayDiff(ts) { return Math.round((dayStart(toDate(ts)) - dayStart(new Date())) / 86400000); }

  /* "Today" / "Tomorrow" / "Yesterday" (localised by Intl), else a date. */
  function fmtDay(ts) {
    const diff = dayDiff(ts);
    if (diff >= -1 && diff <= 1) {
      if (RTF) return capitalize(RTF.format(diff, 'day'));
      if (diff === 0) return _('Today');
    }
    if (diff < -180 || diff > 180) return capitalize(DF_DATEYEAR.format(toDate(ts)));
    return capitalize(DF_DAY.format(toDate(ts)));
  }

  function fmtDayShort(ts) {
    const diff = dayDiff(ts);
    if (diff === 0) return RTF ? capitalize(RTF.format(0, 'day')) : _('Today');
    if (diff === 1 && RTF) return capitalize(RTF.format(1, 'day'));
    return capitalize(DF_DAYSHORT.format(toDate(ts)));
  }

  function fmtDate(ts) {
    const diff = dayDiff(ts);
    if (diff >= -1 && diff <= 1) return fmtDay(ts);
    return capitalize((diff < -180 || diff > 180 ? DF_DATEYEAR : DF_DATE).format(toDate(ts)));
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  const store = {
    get(k) { try { return localStorage.getItem('tvh.mobile.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('tvh.mobile.' + k, v); } catch (e) { /* storage disabled */ } },
  };

  /* The server root sends phones here unless the tvh_ui cookie says they
   * chose the desktop UI (page_root() in webui.c). A cookie, as the server
   * has to see the choice; it is scoped to the webroot. */
  function preferDesktop(yes) {
    document.cookie = 'tvh_ui=' + (yes ? 'desktop' : '') + '; path=' + ROOT +
      '; max-age=' + (yes ? 400 * 86400 : 0) + '; SameSite=Lax';
  }

  /* ---------------------------------------------------------------------
   * DOM helpers
   * ------------------------------------------------------------------- */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function add(el, c) {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => add(el, x)); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }

  /* h('button', {class: 'btn', onclick: fn}, 'Label', childNode, ...) */
  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        const v = props[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') Object.assign(el.style, v); /* CSSOM: CSP-safe */
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'icon');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-' + name);
    u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name);
    s.appendChild(u);
    return s;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function spinner() {
    return h('div', { class: 'spinner', role: 'progressbar', 'aria-label': _('Loading...') });
  }

  function emptyState(text, iconName) {
    return h('div', { class: 'empty' }, iconName ? icon(iconName) : null, text);
  }

  function errorState(err, retry) {
    return h('div', { class: 'error-box', role: 'alert' },
      h('p', { text: errorText(err) }),
      retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, icon('refresh'), _('Refresh')) : null);
  }

  /* Accept only images the server hands out (imagecache/<n>) or web URLs. */
  function imgUrl(u) {
    if (typeof u !== 'string' || !u) return null;
    if (/^imagecache\/\d+$/.test(u)) return url(u);
    if (/^https?:\/\//i.test(u)) return u;
    return null;
  }

  function initials(name) {
    const w = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return '?';
    return (w.length === 1 ? w[0].slice(0, 3) : w[0].charAt(0) + w[1].charAt(0)).toUpperCase();
  }

  /* Channel logo, falling back to initials when missing or broken. */
  function logoEl(icn, name, size) {
    const cls = 'logo' + (size ? ' ' + size : '');
    const ph = h('span', { class: cls, 'aria-hidden': 'true', text: initials(name) });
    const src = imgUrl(icn);
    if (!src) return ph;
    const img = h('img', { class: cls, src: src, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => { if (img.parentNode) img.parentNode.replaceChild(ph, img); });
    return img;
  }

  function progressEl(start, stop) {
    const el = h('span', { class: 'progress', 'aria-hidden': 'true', 'data-start': start, 'data-stop': stop }, h('span'));
    updateProgress(el);
    return el;
  }

  function updateProgress(el) {
    const a = Number(el.getAttribute('data-start'));
    const b = Number(el.getAttribute('data-stop'));
    const pct = b > a ? Math.min(100, Math.max(0, ((nowSec() - a) * 100) / (b - a))) : 0;
    el.firstChild.style.width = pct.toFixed(1) + '%';
  }

  /* REC badge for an EPG event's dvrState / a DVR entry's sched_status;
   * "recordingError" (e.g. no input available) gets the error style. */
  function recBadge(st) {
    let cls, label;
    if (!st) return null;
    if (st === 'recordingError') {
      cls = 'rec-error';
      label = _('Recording') + ' (' + _('Error') + ')';
    } else if (st.indexOf('recording') === 0) {
      cls = 'recording';
      label = _('Recording');
    } else if (st === 'scheduled') {
      cls = 'scheduled';
      label = _('Scheduled');
    } else {
      return null;
    }
    return h('span', { class: 'badge title-badge ' + cls, title: label },
      h('span', { 'aria-hidden': 'true', text: st === 'recordingError' ? 'REC !' : 'REC' }),
      h('span', { class: 'sr-only', text: label }));
  }

  function badge(text, cls) {
    return h('span', { class: 'badge' + (cls ? ' ' + cls : ''), text: text });
  }

  /* ---------------------------------------------------------------------
   * Server access
   * ------------------------------------------------------------------- */

  const GRID_ALL = 999999999; /* the grids' "everything" page size */
  const PAGE = 50;

  function ApiError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  function errorText(err) {
    if (!err) return _('Error');
    if (err.status === 401 || err.status === 403) return _('No verified access');
    return err.message || String(err);
  }

  function post(path, params) {
    const body = new URLSearchParams();
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null) return;
      body.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    });
    return fetch(url(path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).then((res) => {
      if (!res.ok) throw ApiError(res.status, _('Error') + ' ' + res.status);
      return res.json();
    }, () => {
      throw ApiError(0, _('Please check Tvheadend is running and try again.'));
    });
  }

  /* POST api/<endpoint>: form-encoded in, JSON out. Non-string values are
   * JSON encoded, which is how the API takes lists (e.g. uuid=["..."]). */
  const api = (endpoint, params) => post('api/' + endpoint, params);

  const state = {
    access: {},       /* api/access/whoami, then comet accessUpdate */
    channels: null,   /* { list, byUuid, tags } */
    genres: null,     /* { <major genre code>: name } */
    profiles: null,   /* stream profile names */
  };

  const canDvr = () => !!Number(state.access.dvr);

  /* Channel numbers come as 12 or "12.1"; unnumbered channels sort last. */
  function chSortKey(n) {
    const parts = String(n === undefined || n === null ? '' : n).split('.');
    const v = (parseInt(parts[0], 10) || 0) * 100000 + (parseInt(parts[1], 10) || 0);
    return v > 0 ? v : Infinity;
  }

  function loadChannels(force) {
    if (state.channels && !force) return Promise.resolve(state.channels);
    return Promise.all([
      api('channel/grid', { start: 0, limit: GRID_ALL, list: 'enabled,name,number,icon_public_url,tags' }),
      api('channeltag/list', {}).catch(() => ({ entries: [] })),
    ]).then((r) => {
      const list = (r[0].entries || []).filter((c) => c.enabled !== false).map((c) => ({
        uuid: c.uuid,
        name: c.name || '',
        number: chSortKey(c.number) === Infinity ? '' : String(c.number),
        key: chSortKey(c.number),
        icon: c.icon_public_url,
        tags: Array.isArray(c.tags) ? c.tags : [],
      }));
      list.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1)
        : a.name.localeCompare(b.name, LOCALE, { numeric: true, sensitivity: 'base' })));
      const byUuid = {};
      const used = {};
      list.forEach((c) => {
        byUuid[c.uuid] = c;
        c.tags.forEach((t) => { used[t] = true; });
      });
      /* Disabled tags come back as "{name}"; hide them and unused ones. */
      const tags = (r[1].entries || [])
        .filter((t) => used[t.key] && String(t.val).charAt(0) !== '{')
        .map((t) => ({ uuid: t.key, name: String(t.val) }));
      state.channels = { list: list, byUuid: byUuid, tags: tags };
      return state.channels;
    });
  }

  function loadGenres() {
    if (state.genres) return Promise.resolve(state.genres);
    return api('epg/content_type/list', {}).then((r) => {
      const g = {};
      (r.entries || []).forEach((e) => { g[e.key] = e.val; });
      state.genres = g;
      return g;
    }, () => ({}));
  }

  function loadProfiles() {
    if (state.profiles) return Promise.resolve(state.profiles);
    return api('profile/list', {}).then((r) => {
      state.profiles = (r.entries || []).map((e) => String(e.val)).sort((a, b) => a.localeCompare(b));
      return state.profiles;
    }, () => []);
  }

  function chLabel(num, name) { return num ? num + ' \u00b7 ' + (name || '') : (name || ''); }

  /* ---------------------------------------------------------------------
   * Access, theme
   * ------------------------------------------------------------------- */

  const THEME_COLORS = { light: '#ffffff', dark: '#181c21', access: '#000000' };

  function applyAccess(a) {
    const prevDvr = canDvr();
    state.access = Object.assign({}, state.access, a || {});
    const theme = state.access.theme;
    const color = Object.prototype.hasOwnProperty.call(THEME_COLORS, theme) ? THEME_COLORS[theme] : null;
    const root = document.documentElement;
    if (color) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme'); /* "auto": follow the device */
    $$('meta[name="theme-color"]').forEach((m) => {
      if (!m.hasAttribute('data-default')) m.setAttribute('data-default', m.getAttribute('content'));
      m.setAttribute('content', color || m.getAttribute('data-default'));
    });
    $('.tabbar a[data-tab="dvr"]').hidden = !canDvr();
    if (current) {
      /* Rights changed while on (or bounced off) the recordings tab. */
      if (prevDvr !== canDvr() && location.hash.indexOf('#/dvr') === 0) route();
      else if (current.access) current.access();
    }
  }

  /* ---------------------------------------------------------------------
   * Toast
   * ------------------------------------------------------------------- */

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 6000 : 3000);
  }

  /* ---------------------------------------------------------------------
   * Dialogs, tied to the history so that "back" closes them
   *
   * Every open dialog owns one history entry ({tvhDlg: depth}). Closing
   * from the UI goes through history.go(), and the popstate handler does
   * the actual closing, so the close button, Esc, the backdrop and the
   * phone's back gesture all end up in the same place.
   * ------------------------------------------------------------------- */

  const HAS_DIALOG = typeof window.HTMLDialogElement === 'function' &&
    typeof document.createElement('dialog').showModal === 'function';
  const dlgStack = [];
  let wantDepth = null;   /* requested stack depth while closing */
  let traversing = false; /* a history.go() is in flight */
  let traverseTimer = null;
  let pendingNav = null;  /* route to open once all dialogs are closed */

  function syncModalClass() {
    document.documentElement.classList.toggle('modal-open', dlgStack.length > 0);
  }

  function openDialog(dlg, onClose) {
    if (dlgStack.indexOf(dlg) >= 0) return;
    dlg.tvhOnClose = onClose || null;
    dlg.tvhReturnFocus = document.activeElement;
    if (HAS_DIALOG) {
      dlg.showModal();
    } else {
      dlg.classList.add('fallback', 'open');
      dlg.tvhBackdrop = h('div', { class: 'fallback-backdrop', onclick: () => closeDialog(dlg) });
      document.body.appendChild(dlg.tvhBackdrop);
      const f = dlg.querySelector('[autofocus]') || dlg.querySelector('button, [href], select, input');
      if (f) f.focus();
    }
    dlgStack.push(dlg);
    syncModalClass();
    history.pushState({ tvhDlg: dlgStack.length }, '');
  }

  function stepHistory() {
    if (traversing) return;
    if (wantDepth === null || wantDepth >= dlgStack.length) { wantDepth = null; return; }
    traversing = true;
    history.go(wantDepth - dlgStack.length);
    /* Should the browser never report the traversal, close the dialogs
     * anyway rather than leave one stuck open. */
    clearTimeout(traverseTimer);
    traverseTimer = setTimeout(() => {
      if (!traversing) return;
      traversing = false;
      while (dlgStack.length > (wantDepth || 0)) finishClose(dlgStack.pop());
      wantDepth = null;
      syncModalClass();
      flushPendingNav();
    }, 2000);
  }

  function flushPendingNav() {
    if (traversing || dlgStack.length || !pendingNav) return;
    const target = pendingNav;
    pendingNav = null;
    location.hash = target;
  }

  function closeDialog(dlg) {
    const i = dlgStack.indexOf(dlg);
    if (i < 0) return;
    wantDepth = wantDepth === null ? i : Math.min(wantDepth, i);
    stepHistory();
  }

  function finishClose(dlg) {
    if (HAS_DIALOG) {
      if (dlg.open) dlg.close();
    } else {
      dlg.classList.remove('open');
      if (dlg.tvhBackdrop) dlg.tvhBackdrop.remove();
      dlg.tvhBackdrop = null;
    }
    const cb = dlg.tvhOnClose;
    const rf = dlg.tvhReturnFocus;
    dlg.tvhOnClose = null;
    dlg.tvhReturnFocus = null;
    if (cb) cb();
    if (rf && rf.focus && document.contains(rf)) rf.focus({ preventScroll: true });
  }

  /* Go to a route, closing any open dialogs first. */
  function navigate(hash) {
    if (!dlgStack.length) {
      location.hash = hash;
      return;
    }
    pendingNav = hash;
    wantDepth = 0;
    stepHistory();
  }

  window.addEventListener('popstate', (e) => {
    clearTimeout(traverseTimer);
    traversing = false;
    const depth = (e.state && e.state.tvhDlg) || 0;
    while (dlgStack.length > depth) finishClose(dlgStack.pop());
    syncModalClass();
    if (wantDepth !== null) stepHistory();
    flushPendingNav();
  });

  function initDialog(dlg, closeOnBackdrop) {
    /* Esc and Android's back gesture (close watcher): keep history in step. */
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(dlg); });
    dlg.addEventListener('close', () => { if (dlgStack.indexOf(dlg) >= 0) closeDialog(dlg); });
    if (closeOnBackdrop) {
      dlg.addEventListener('click', (e) => {
        if (e.target !== dlg) return;
        const r = dlg.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          closeDialog(dlg);
      });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!HAS_DIALOG && e.key === 'Escape' && dlgStack.length) closeDialog(dlgStack[dlgStack.length - 1]);
  });

  function closeButton(dlg) {
    return h('button', { type: 'button', class: 'icon-btn', 'aria-label': _('Close'), onclick: () => closeDialog(dlg) }, icon('close'));
  }

  /* Yes/no question for destructive actions; resolves to true when confirmed. */
  function ask(text, okLabel) {
    const dlg = $('#confirm');
    return new Promise((resolve) => {
      let ok = false;
      add(clear(dlg), [
        h('p', { id: 'confirm-text', text: text }),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => closeDialog(dlg) }, _('Cancel')),
          h('button', { type: 'button', class: 'btn rec', onclick: () => { ok = true; closeDialog(dlg); } }, okLabel)),
      ]);
      openDialog(dlg, () => resolve(ok));
    });
  }

  /* ---------------------------------------------------------------------
   * Router and views
   *
   * A view is a function (container, args) returning optional hooks:
   * refresh(soft) for the refresh button (hard) and live updates (soft),
   * tick() every 30 s while visible, access() after an access update and
   * destroy() when navigating away. Views render their last data from a
   * cache first, so switching tabs (or going back) is instant and keeps the
   * scroll position; fresh data then replaces it.
   * ------------------------------------------------------------------- */

  const views = Object.create(null); /* no inherited names as routes */
  const cache = {};       /* per-view data, see the views */
  const scrollMemo = {};  /* route -> scroll position */
  let routeKey = '';
  let current = null;
  let busyCount = 0;

  function busy(delta) {
    busyCount = Math.max(0, busyCount + delta);
    $('#btn-refresh').classList.toggle('spinning', busyCount > 0);
    $('#main').setAttribute('aria-busy', busyCount > 0 ? 'true' : 'false');
  }

  function setTitle(text) {
    $('#title').textContent = text;
    document.title = text + ' \u2013 Tvheadend';
  }

  function parseHash() {
    const hs = location.hash;
    if (hs.indexOf('#/') !== 0) return { name: 'now', args: [] };
    const parts = hs.slice(2).split('/').map((p) => {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    return { name: parts[0], args: parts.slice(1) };
  }

  function route() {
    let r = parseHash();
    if (!views[r.name] || (r.name === 'dvr' && !canDvr())) r = { name: 'now', args: [] };
    const fromTabbar = document.activeElement && document.activeElement.closest &&
      document.activeElement.closest('.tabbar');
    if (current) {
      scrollMemo[routeKey] = window.scrollY;
      if (current.destroy) current.destroy();
    }
    const main = clear($('#main'));
    $$('.tabbar a').forEach((a) => {
      if (a.getAttribute('data-tab') === r.name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    routeKey = location.hash || '#/now';
    window.scrollTo(0, 0);
    current = views[r.name](main, r.args) || {};
    if (fromTabbar) main.focus({ preventScroll: true });
  }

  /* Called by a view once its content is in place. */
  function restoreScroll() {
    const y = scrollMemo[routeKey];
    if (y) window.scrollTo(0, y);
  }

  /* Soft-refresh the current view. Requests coalesce into the earliest one
   * pending; minGap spaces refreshes out (running recordings report a
   * change every few seconds, which would otherwise mean constant reloads). */
  let refreshTimer = null;
  let refreshAt = 0;
  let lastRefresh = 0;
  function scheduleRefresh(delay, minGap) {
    let at = Date.now() + (delay === undefined ? 1200 : delay);
    if (minGap) at = Math.max(at, lastRefresh + minGap);
    if (refreshTimer && refreshAt <= at) return;
    clearTimeout(refreshTimer);
    refreshAt = at;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastRefresh = Date.now();
      if (!document.hidden && current && current.refresh) current.refresh(true);
    }, Math.max(0, at - Date.now()));
  }

  function groupByDay(items, tsOf) {
    const groups = [];
    let g = null;
    items.forEach((it) => {
      const k = dayKey(tsOf(it));
      if (!g || g.key !== k) {
        g = { key: k, ts: tsOf(it), items: [] };
        groups.push(g);
      }
      g.items.push(it);
    });
    return groups;
  }

  /* Day-grouped rows under sticky day headings. */
  function renderGroups(groups, rowFn) {
    return h('ul', { class: 'groups' }, groups.map((g) => h('li', { class: 'group', 'data-day': g.key },
      h('h2', { class: 'group-head', text: fmtDay(g.ts) }),
      h('ul', { class: 'rows' }, g.items.map(rowFn)))));
  }

  function moreButton(onMore) {
    const btn = h('button', { type: 'button', class: 'btn', onclick: () => onMore(btn) }, _('Load more'));
    return h('div', { class: 'more-wrap' }, btn);
  }

  /* Refreshes arrive often (live updates); only rebuild the DOM when what
   * is shown actually changed, so scroll position, focus and the row under
   * the user's finger stay put. `drop` lists keys to leave out. */
  function signature(value, drop) {
    return JSON.stringify(value, drop ? (k, v) => (drop.indexOf(k) >= 0 ? undefined : v) : undefined);
  }

  /* An EPG event row (Guide, Search). */
  function eventRow(ev, showChannel) {
    const t = nowSec();
    const live = ev.start <= t && ev.stop > t;
    const sub = ev.subtitle || ev.episodeOnscreen || '';
    return h('li', null, h('button', {
      type: 'button',
      class: 'row' + (live ? ' now' : ''),
      onclick: () => openEvent(ev, showChannel),
    },
    timeEl(ev.start),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title ellipsis' }, recBadge(ev.dvrState), ev.title || '\u2014'),
      sub ? h('span', { class: 'row-sub ellipsis', text: sub }) : null,
      showChannel ? h('span', { class: 'row-meta' },
        logoEl(ev.channelIcon, ev.channelName, 'sm'),
        h('span', { class: 'ellipsis', text: chLabel(ev.channelNumber, ev.channelName) })) : null,
      live ? progressEl(ev.start, ev.stop) : null),
    h('span', { class: 'row-side' }, h('span', { class: 'times', text: fmtMinutes((ev.stop - ev.start) / 60) }))));
  }

  /* ----- Now: every channel with its current and next programme ----- */

  views.now = function (main) {
    let alive = true;
    let seq = 0;
    let data = cache.now || null;
    let restored = false;
    setTitle(_('Now'));
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': _('Channel Tags'), hidden: true });
    const body = h('div', null, data ? null : spinner());
    add(main, [chips, body]);

    function load(hard) {
      const my = ++seq;
      busy(1);
      return Promise.all([
        loadChannels(hard),
        api('epg/events/grid', { mode: 'now', start: 0, limit: GRID_ALL }),
      ]).then((r) => {
        if (my !== seq) return null;
        const nowBy = {};
        const next = [];
        (r[1].entries || []).forEach((e) => {
          if (nowBy[e.channelUuid]) return;
          nowBy[e.channelUuid] = e;
          if (e.nextEventId) next.push(e.nextEventId);
        });
        const nx = next.length ? api('epg/events/load', { eventId: next }) : Promise.resolve({ entries: [] });
        return nx.then((n) => {
          if (my !== seq) return;
          const nextBy = {};
          (n.entries || []).forEach((e) => { nextBy[e.channelUuid] = e; });
          const sig = signature([r[0].list, r[0].tags, nowBy, nextBy]);
          const same = data && sig === data.sig;
          data = cache.now = { chs: r[0], nowBy: nowBy, nextBy: nextBy, sig: sig };
          if (!alive) return;
          if (same) $$('.progress', body).forEach(updateProgress);
          else render();
        });
      }).catch((e) => {
        if (!alive || my !== seq) return;
        if (!data) clear(body).appendChild(errorState(e, () => { clear(body).appendChild(spinner()); load(true); }));
        else toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function render() {
      const chs = data.chs;
      let tag = store.get('tag') || '';
      if (tag && !chs.tags.some((t) => t.uuid === tag)) tag = '';

      clear(chips);
      chips.hidden = chs.tags.length === 0;
      [{ uuid: '', name: _('All') }].concat(chs.tags).forEach((t) => {
        chips.appendChild(h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': t.uuid === tag ? 'true' : 'false',
          onclick: () => { store.set('tag', t.uuid); render(); },
        }, t.name));
      });

      const list = chs.list.filter((c) => !tag || c.tags.indexOf(tag) >= 0);
      clear(body);
      if (!list.length) body.appendChild(emptyState(_('No data to display'), 'now'));
      else body.appendChild(h('ul', { class: 'chlist' }, list.map((c) => card(c, data.nowBy[c.uuid], data.nextBy[c.uuid]))));
      if (!restored) { restored = true; restoreScroll(); }
    }

    function card(c, now, next) {
      return h('li', { class: 'chcard' },
        h('a', { class: 'chmain', href: '#/guide/' + encodeURIComponent(c.uuid) },
          logoEl(c.icon || (now && now.channelIcon), c.name),
          h('span', { class: 'chname' },
            c.number ? h('span', { class: 'num', text: c.number }) : null,
            h('span', { class: 'ellipsis', text: c.name })),
          now ? [
            h('span', { class: 'chtitle ellipsis' }, recBadge(now.dvrState), now.title || '\u2014'),
            h('span', { class: 'chprog' }, progressEl(now.start, now.stop),
              h('span', { class: 'times', text: fmtRange(now.start, now.stop) })),
          ] : h('span', { class: 'chtitle muted', text: _('No data to display') }),
          next ? h('span', { class: 'chnext ellipsis' },
            h('span', { class: 'sr-only', text: _('Next') + ': ' }),
            h('time', { datetime: isoOf(next.start), text: fmtTime(next.start) }),
            next.title || '') : null),
        h('button', {
          type: 'button',
          class: 'chplay',
          'aria-label': _('Play') + ': ' + c.name,
          onclick: () => openPlayer({ kind: 'channel', uuid: c.uuid, title: c.name }),
        }, icon('play')));
    }

    if (data) render();
    load(false);
    return {
      refresh: (soft) => load(!soft),
      tick: () => {
        if (!data) return;
        const t = nowSec();
        if (Object.keys(data.nowBy).some((k) => data.nowBy[k].stop <= t)) load(false);
        else $$('.progress', body).forEach(updateProgress);
      },
      destroy: () => { alive = false; },
    };
  };

  /* ----- Guide: the schedule of one channel ----- */

  views.guide = function (main, args) {
    let alive = true;
    let seq = 0;
    let chs = null;
    let uuid = args[0] || store.get('channel') || '';
    let events = cache.guide && cache.guide.uuid === uuid ? cache.guide.events : null;
    let restored = false;
    setTitle(_('Guide'));
    const bar = h('div', { class: 'toolbar', hidden: true });
    const days = h('div', { class: 'chips', role: 'group', 'aria-label': _('Day'), hidden: true });
    const body = h('div', null, events ? null : spinner());
    add(main, [bar, days, body]);
    let logoSlot = null;
    let sel = null;
    let prevBtn = null;
    let nextBtn = null;

    const indexOf = () => chs.list.findIndex((c) => c.uuid === uuid);

    function setHash() {
      const hs = '#/guide/' + encodeURIComponent(uuid);
      if (location.hash !== hs) history.replaceState(history.state, '', hs);
      routeKey = hs;
    }

    /* The Guide tab links to #/guide; name the channel right away so the
     * remembered scroll position of its schedule is found. */
    if (uuid) setHash();

    function buildBar() {
      sel = h('select', { 'aria-label': _('Channel'), onchange: () => select(sel.value) },
        chs.list.map((c) => h('option', { value: c.uuid }, chLabel(c.number, c.name))));
      prevBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': _('Go to previous channel'), onclick: () => stepChannel(-1) }, icon('prev'));
      nextBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': _('Go to next channel'), onclick: () => stepChannel(1) }, icon('next'));
      logoSlot = h('span');
      add(clear(bar), [logoSlot, prevBtn, h('span', { class: 'select-wrap' }, sel), nextBtn]);
      bar.hidden = false;
    }

    function syncBar() {
      const i = indexOf();
      const ch = chs.list[i];
      sel.value = uuid;
      prevBtn.disabled = i <= 0;
      nextBtn.disabled = i >= chs.list.length - 1;
      const lg = logoEl(ch.icon, ch.name);
      logoSlot.parentNode.replaceChild(lg, logoSlot);
      logoSlot = lg;
      setTitle(ch.name);
    }

    function stepChannel(d) {
      const c = chs.list[indexOf() + d];
      if (c) select(c.uuid);
    }

    /* Switch channel in place (no re-route), so focus stays on the control. */
    function select(u) {
      if (!chs.byUuid[u] || u === uuid) return;
      uuid = u;
      setHash();
      events = null;
      clear(days).hidden = true;
      clear(body).appendChild(spinner());
      syncBar();
      window.scrollTo(0, 0);
      loadEvents();
    }

    function loadEvents() {
      const my = ++seq;
      store.set('channel', uuid);
      busy(1);
      return api('epg/events/grid', { channel: uuid, start: 0, limit: GRID_ALL, sort: 'start', dir: 'ASC' }).then((r) => {
        if (!alive || my !== seq) return;
        const t = nowSec();
        const fresh = (r.entries || []).filter((e) => e.stop > t);
        const same = events && body.querySelector('.groups') && signature(fresh) === signature(events);
        events = fresh;
        cache.guide = { uuid: uuid, events: events };
        if (same) $$('.progress', body).forEach(updateProgress);
        else render();
      }).catch((e) => {
        if (!alive || my !== seq) return;
        if (!events) clear(body).appendChild(errorState(e, () => { clear(body).appendChild(spinner()); loadEvents(); }));
        else toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function load(hard) {
      busy(1);
      return loadChannels(hard).then((c) => {
        if (!alive) return null;
        chs = c;
        if (!chs.byUuid[uuid]) uuid = chs.list.length ? chs.list[0].uuid : '';
        if (!uuid) {
          bar.hidden = true;
          clear(body).appendChild(emptyState(_('No data to display'), 'guide'));
          return null;
        }
        setHash();
        buildBar();
        syncBar();
        return loadEvents();
      }).catch((e) => {
        if (!alive) return;
        if (!events) clear(body).appendChild(errorState(e, () => { clear(body).appendChild(spinner()); load(true); }));
        else toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function render() {
      clear(body);
      clear(days);
      if (!events.length) {
        days.hidden = true;
        body.appendChild(emptyState(_('No data to display'), 'guide'));
        return;
      }
      const groups = groupByDay(events, (e) => e.start);
      body.appendChild(renderGroups(groups, (e) => eventRow(e, false)));
      days.hidden = groups.length < 2;
      groups.forEach((g, i) => {
        days.appendChild(h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': i === 0 ? 'true' : 'false',
          onclick: (e) => {
            $$('.chip', days).forEach((c) => c.setAttribute('aria-pressed', c === e.currentTarget ? 'true' : 'false'));
            const target = $('[data-day="' + g.key + '"]', body);
            if (target) target.scrollIntoView({ block: 'start' });
          },
        }, fmtDayShort(g.ts)));
      });
      if (!restored) { restored = true; restoreScroll(); }
    }

    if (events) render();
    load(false);
    return {
      refresh: (soft) => (chs && soft ? loadEvents() : load(true)),
      tick: () => {
        if (!events) return;
        if (events.length && events[0].stop <= nowSec()) loadEvents();
        else $$('.progress', body).forEach(updateProgress);
      },
      destroy: () => { alive = false; },
    };
  };

  /* ----- Search: by title or full text, optionally by genre ----- */

  const search = { q: '', genre: '', fulltext: false, results: null };

  views.search = function (main) {
    let alive = true;
    let seq = 0;
    let timer = null;
    setTitle(_('Search'));

    const input = h('input', {
      type: 'search',
      value: search.q,
      placeholder: _('Search title…'),
      'aria-label': _('Search'),
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    });
    const genre = h('select', { 'aria-label': _('Genre') }, h('option', { value: '' }, _('Genre') + ': ' + _('All')));
    const fulltext = h('input', { type: 'checkbox', checked: search.fulltext });
    const form = h('form', { class: 'search-form', role: 'search', action: '#' },
      h('div', { class: 'search-field' }, icon('search'), input),
      h('div', { class: 'search-opts' }, genre, h('label', { class: 'check' }, fulltext, _('Fulltext'))));
    const body = h('div');
    add(main, [form, body]);

    let genresReady = false;
    function fillGenres(g) {
      Object.keys(g).map(Number).sort((a, b) => a - b).forEach((k) => {
        genre.appendChild(h('option', { value: k, selected: String(k) === search.genre }, g[k]));
      });
      genresReady = true;
    }
    if (state.genres) fillGenres(state.genres);
    else loadGenres().then((g) => { if (alive) fillGenres(g); });

    /* Until its options are in, the select cannot hold the remembered genre. */
    const genreValue = () => (genresReady ? genre.value : search.genre);

    function params(start, limit) {
      return {
        title: search.q ? escapeRegex(search.q) : undefined,
        fulltext: search.fulltext ? 1 : 0,
        contentType: search.genre ? Number(search.genre) : undefined,
        start: start,
        limit: limit,
        sort: 'start',
        dir: 'ASC',
      };
    }

    function run(keep) {
      clearTimeout(timer);
      const q = input.value.trim();
      const g = genreValue();
      const changed = q !== search.q || g !== search.genre || fulltext.checked !== search.fulltext;
      search.q = q;
      search.genre = g;
      search.fulltext = fulltext.checked;
      if (!search.q && !search.genre) {
        search.results = null;
        clear(body).appendChild(emptyState(_('Search title…'), 'search'));
        return Promise.resolve();
      }
      const my = ++seq;
      const prev = !changed && search.results;
      if (!keep || !prev) clear(body).appendChild(spinner());
      busy(1);
      return api('epg/events/grid', params(0, prev ? Math.max(PAGE, prev.entries.length) : PAGE)).then((r) => {
        if (!alive || my !== seq) return;
        const res = { entries: r.entries || [], total: r.totalCount || 0 };
        const same = prev && body.querySelector('.groups') && signature(res) === signature(prev);
        search.results = res;
        if (!same) render();
      }).catch((e) => {
        if (alive && my === seq) clear(body).appendChild(errorState(e, () => run(false)));
      }).then(() => busy(-1));
    }

    function more(btn) {
      const res = search.results;
      const my = seq;
      btn.disabled = true;
      busy(1);
      api('epg/events/grid', params(res.entries.length, PAGE)).then((r) => {
        if (!alive || my !== seq) return;
        /* EPG updates between pages shift the offsets: skip repeats. */
        const seen = {};
        res.entries.forEach((x) => { seen[x.eventId] = true; });
        res.entries = res.entries.concat((r.entries || []).filter((x) => !seen[x.eventId]));
        res.total = r.totalCount || res.total;
        render();
      }).catch((e) => {
        btn.disabled = false;
        toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function render() {
      const res = search.results;
      clear(body);
      if (!res.entries.length) {
        body.appendChild(emptyState(_('No data to display'), 'search'));
        return;
      }
      body.appendChild(renderGroups(groupByDay(res.entries, (e) => e.start), (e) => eventRow(e, true)));
      if (res.entries.length < res.total) body.appendChild(moreButton(more));
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(false), 400);
    });
    genre.addEventListener('change', () => run(false));
    fulltext.addEventListener('change', () => { if (input.value.trim()) run(false); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      input.blur(); /* hides the on-screen keyboard */
      run(false);
    });

    if (search.results) {
      render();
      restoreScroll();
      run(true);
    } else {
      run(false);
      if (!search.q && !search.genre) setTimeout(() => { if (alive) input.focus(); }, 0);
    }
    return {
      refresh: (soft) => run(soft),
      destroy: () => { alive = false; clearTimeout(timer); },
    };
  };

  /* ----- Recordings: upcoming / finished / failed ----- */

  const DVR_TABS = ['upcoming', 'finished', 'failed'];
  const DVR_FIELDS = 'disp_title,disp_subtitle,disp_extratext,episode_disp,channel,channelname,channel_icon,' +
    'image,start,stop,duration,filesize,status,sched_status,disp_summary,disp_description,errors,data_errors,comment';

  views.dvr = function (main, args) {
    let alive = true;
    let seq = 0;
    const saved = store.get('dvrtab');
    const sub = DVR_TABS.indexOf(args[0]) >= 0 ? args[0] : (DVR_TABS.indexOf(saved) >= 0 ? saved : 'upcoming');
    const ckey = 'dvr/' + sub;
    let data = cache[ckey] || null;
    let restored = false;
    store.set('dvrtab', sub);
    setTitle(_('Recordings'));

    const labels = { upcoming: _('Upcoming'), finished: _('Finished'), failed: _('Failed') };
    const seg = h('nav', { class: 'segmented', 'aria-label': _('Recordings') }, DVR_TABS.map((t) => h('a', {
      href: '#/dvr/' + t,
      'aria-current': t === sub ? 'page' : null,
      onclick: (e) => { e.preventDefault(); if (t !== sub) location.replace('#/dvr/' + t); },
    }, labels[t])));
    const disk = h('div', { class: 'disk', hidden: true });
    const body = h('div', null, data ? null : spinner());
    add(main, [seg, disk, body]);

    function renderDisk() {
      const a = state.access;
      const free = Number(a.freediskspace);
      const total = Number(a.totaldiskspace);
      disk.hidden = !(total > 0 && free >= 0);
      if (disk.hidden) return;
      add(clear(disk), [
        _('Free') + ': ' + fmtBytes(free) + ' / ' + _('Total') + ': ' + fmtBytes(total),
        h('span', { class: 'progress', 'aria-hidden': 'true' },
          h('span', { style: { width: Math.min(100, 100 - (free * 100) / total).toFixed(1) + '%' } })),
      ]);
    }

    function params(start, limit) {
      return { start: start, limit: limit, sort: 'start', dir: sub === 'upcoming' ? 'ASC' : 'DESC', list: DVR_FIELDS };
    }

    function load(keep) {
      const my = ++seq;
      busy(1);
      const limit = keep && data ? Math.max(PAGE, data.entries.length) : PAGE;
      return api('dvr/entry/grid_' + sub, params(0, limit)).then((r) => {
        if (!alive || my !== seq) return;
        const fresh = { entries: r.entries || [], total: r.total || 0 };
        /* Running recordings grow all the time; that alone is not news. */
        const drop = sub === 'upcoming' ? ['filesize', 'errors', 'data_errors'] : null;
        const same = data && body.querySelector('.groups') && signature(fresh, drop) === signature(data, drop);
        data = cache[ckey] = fresh;
        if (same) {
          renderDisk();
          $$('.progress', body).forEach(updateProgress);
        } else {
          render();
        }
      }).catch((e) => {
        if (!alive || my !== seq) return;
        if (!data) clear(body).appendChild(errorState(e, () => { clear(body).appendChild(spinner()); load(false); }));
        else toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function more(btn) {
      const my = seq;
      btn.disabled = true;
      busy(1);
      api('dvr/entry/grid_' + sub, params(data.entries.length, PAGE)).then((r) => {
        if (!alive || my !== seq) return;
        const seen = {};
        data.entries.forEach((x) => { seen[x.uuid] = true; });
        data.entries = data.entries.concat((r.entries || []).filter((x) => !seen[x.uuid]));
        data.total = r.total || data.total;
        render();
      }).catch((e) => {
        btn.disabled = false;
        toast(errorText(e), true);
      }).then(() => busy(-1));
    }

    function row(e) {
      const st = e.sched_status || '';
      const recording = st.indexOf('recording') === 0;
      const subt = e.disp_subtitle || e.episode_disp || '';
      /* Say why, for failed entries and for recordings that are failing. */
      const why = sub === 'failed' || st === 'recordingError';
      const meta = why ? [e.channelname, e.status].filter(Boolean).join(' \u00b7 ') : (e.channelname || '');
      const side = sub === 'finished' ? (fmtBytes(e.filesize) || fmtMinutes(e.duration / 60))
        : fmtMinutes((e.duration || (e.stop - e.start)) / 60);
      return h('li', null, h('button', {
        type: 'button',
        class: 'row' + (recording ? ' now' : ''),
        /* The row may predate the latest (unrendered) refresh. */
        onclick: () => openDvr(data.entries.find((x) => x.uuid === e.uuid) || e),
      },
        timeEl(e.start),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title ellipsis' }, recording ? recBadge(st) : null, e.disp_title || '\u2014'),
          subt ? h('span', { class: 'row-sub ellipsis', text: subt }) : null,
          h('span', { class: 'row-meta' }, logoEl(e.channel_icon, e.channelname, 'sm'), h('span', { class: 'ellipsis', text: meta })),
          recording ? progressEl(e.start, e.stop) : null),
        h('span', { class: 'row-side' }, h('span', { class: 'times', text: side }))));
    }

    function render() {
      renderDisk();
      clear(body);
      if (!data.entries.length) {
        body.appendChild(emptyState(_('No data to display'), 'rec'));
      } else {
        body.appendChild(renderGroups(groupByDay(data.entries, (e) => e.start), row));
        if (data.entries.length < data.total) body.appendChild(moreButton(more));
      }
      if (!restored) { restored = true; restoreScroll(); }
    }

    if (data) render();
    load(!!data);
    return {
      refresh: (soft) => load(soft),
      tick: () => $$('.progress', body).forEach(updateProgress),
      access: renderDisk,
      destroy: () => { alive = false; },
    };
  };

  /* ---------------------------------------------------------------------
   * Detail sheets
   * ------------------------------------------------------------------- */

  function sheetShell(kicker) {
    const dlg = $('#sheet');
    const body = h('div', { class: 'sheet-body' });
    const actions = h('div', { class: 'sheet-actions' });
    const err = h('p', { class: 'error-box', role: 'alert', hidden: true });
    add(clear(dlg), [
      h('div', { class: 'sheet-head' }, h('span', { class: 'sheet-kicker muted', text: kicker }), closeButton(dlg)),
      body,
      actions,
    ]);
    return {
      dlg: dlg,
      body: body,
      actions: actions,
      err: err,
      open: () => {
        body.appendChild(err);
        actions.hidden = !actions.firstChild;
        /* Start at the heading (read first by screen readers) rather than
         * on the close button. */
        const title = $('#sheet-title', body);
        if (title) {
          title.setAttribute('tabindex', '-1');
          title.setAttribute('autofocus', '');
        }
        openDialog(dlg);
        body.scrollTop = 0;
      },
    };
  }

  function actionButton(iconName, label, cls, fn) {
    const btn = h('button', { type: 'button', class: 'btn' + (cls ? ' ' + cls : '') }, icon(iconName), label);
    btn.addEventListener('click', () => fn(btn));
    return btn;
  }

  /* Run an API call from a sheet: close (and toast) on success, report
   * failures inside the sheet. Destructive calls ask first. */
  function sheetAction(sheet, question, call, okText) {
    return (btn) => {
      (question ? ask(question, btn.textContent) : Promise.resolve(true)).then((yes) => {
        if (!yes) return;
        btn.disabled = true;
        sheet.err.hidden = true;
        call().then(() => {
          closeDialog(sheet.dlg);
          if (okText) toast(okText);
          scheduleRefresh(400);
        }, (e) => {
          btn.disabled = false;
          sheet.err.textContent = errorText(e);
          sheet.err.hidden = false;
          sheet.err.scrollIntoView({ block: 'nearest' });
        });
      });
    };
  }

  /* create_by_event / create_by_series answer {uuid: [...]} when they did. */
  function created(r) {
    if (!r || !Array.isArray(r.uuid) || !r.uuid.length) throw new Error(_('Failed to schedule recording'));
    return r;
  }

  function namesOf(credits, types) {
    if (!credits || typeof credits !== 'object') return '';
    return Object.keys(credits).filter((n) => types.indexOf(credits[n]) >= 0).join(', ');
  }

  function facts(rows) {
    const list = rows.filter((r) => r[1]);
    if (!list.length) return null;
    return h('dl', { class: 'ev-facts' }, list.map((r) => h('div', null, h('dt', { text: r[0] }), h('dd', { text: String(r[1]) }))));
  }

  function descriptionOf(summary, desc) {
    summary = summary || '';
    desc = desc || '';
    if (summary && desc && desc.indexOf(summary) < 0) return summary + '\n\n' + desc;
    return desc || summary;
  }

  function channelRow(uuid, number, name, iconUrl, asLink) {
    const content = [
      logoEl(iconUrl, name),
      number ? h('span', { class: 'num', text: number }) : null,
      h('span', { class: 'ellipsis', text: name || '' }),
    ];
    if (!asLink || !uuid) return h('div', { class: 'ev-channel' }, content);
    const target = '#/guide/' + encodeURIComponent(uuid);
    return h('a', { class: 'ev-channel', href: target, onclick: (e) => { e.preventDefault(); navigate(target); } },
      content, icon('next'));
  }

  function heroImage(src) {
    const u = imgUrl(src);
    if (!u) return null;
    const img = h('img', { class: 'ev-image', src: u, alt: '', decoding: 'async' });
    img.addEventListener('error', () => img.remove());
    return img;
  }

  /* EPG event details: Play / Record / Record series / Stop / Delete. */
  function openEvent(ev, channelLink) {
    const t = nowSec();
    const live = ev.start <= t && ev.stop > t;
    const s = sheetShell(_('Broadcast details'));
    const genres = state.genres || {};
    const genreNames = (ev.genre || []).map((g) => genres[g & 0xf0]).filter((g, i, a) => g && a.indexOf(g) === i);
    const badges = [
      recBadge(ev.dvrState),
      ev.hd ? badge(ev.hd > 1 ? 'UHD' : 'HD') : null,
      ev.widescreen ? badge(_('Widescreen')) : null,
      ev.subtitled ? badge(_ctx('Subtitled#EPG')) : null,
      ev.audiodesc ? badge(_ctx('Audio description#EPG')) : null,
      ev.deafsigned ? badge(_ctx('Deaf signed#EPG')) : null,
      ev.new ? badge(_ctx('New#EPG'), 'ok') : null,
      ev.repeat ? badge(_ctx('Repeat#EPG')) : null,
      ev.ratingLabel ? badge(ev.ratingLabel) : (ev.ageRating ? badge(ev.ageRating + '+') : null),
    ].concat(genreNames.map((g) => badge(g))).filter(Boolean);

    add(s.body, [
      heroImage(ev.image),
      h('h2', { id: 'sheet-title', class: 'ev-title', text: ev.title || '\u2014' }),
      ev.subtitle ? h('p', { class: 'ev-sub', text: ev.subtitle }) : null,
      channelRow(ev.channelUuid, ev.channelNumber, ev.channelName, ev.channelIcon, channelLink),
      h('div', { class: 'ev-when' },
        fmtDate(ev.start) + ' \u00b7 ' + fmtRange(ev.start, ev.stop) + ' \u00b7 ' + fmtMinutes((ev.stop - ev.start) / 60),
        live ? progressEl(ev.start, ev.stop) : null),
      badges.length ? h('div', { class: 'ev-badges' }, badges) : null,
      h('p', { class: 'ev-desc', text: descriptionOf(ev.summary, ev.description) }),
      facts([
        [_('Episode'), ev.episodeOnscreen],
        [_('Starring'), namesOf(ev.credits, ['actor', 'guest'])],
        [_('Director'), namesOf(ev.credits, ['director'])],
        [_('Writer'), namesOf(ev.credits, ['writer'])],
        [_('Star Rating'), ev.starRating ? '\u2605 ' + Math.round(ev.starRating / 10) + '/10' : ''],
        [_('Year'), ev.copyright_year],
      ]),
    ]);

    if (live) {
      s.actions.appendChild(actionButton('play', _('Play'), 'primary', () =>
        openPlayer({ kind: 'channel', uuid: ev.channelUuid, title: ev.channelName })));
    }
    if (canDvr()) {
      const st = ev.dvrState || '';
      const uuids = [ev.dvrUuid];
      if (!ev.dvrUuid) {
        s.actions.appendChild(actionButton('rec', _('Record'), live ? '' : 'rec', sheetAction(s, null,
          () => api('dvr/entry/create_by_event', { event_id: ev.eventId, config_uuid: '' }).then(created),
          _('Recording scheduled'))));
        if (ev.serieslinkUri) {
          s.actions.appendChild(actionButton('series', _('Record series'), '', sheetAction(s, null,
            () => api('dvr/autorec/create_by_series', { event_id: ev.eventId, config_uuid: '' }).then(created),
            _('Series recording scheduled'))));
        }
      } else if (st.indexOf('recording') === 0) {
        s.actions.appendChild(actionButton('stop', _('Stop recording'), 'danger', sheetAction(s,
          _('Do you really want to gracefully stop/unschedule this recording?'),
          () => api('dvr/entry/stop', { uuid: uuids }))));
      } else if (st === 'scheduled') {
        s.actions.appendChild(actionButton('trash', _('Delete recording'), 'danger', sheetAction(s,
          _('Do you really want to remove this recording?'),
          () => api('dvr/entry/cancel', { uuid: uuids }))));
      }
    }
    s.open();
  }

  /* Recording details: Play / Download / Stop / Delete / Remove. */
  function openDvr(e) {
    const st = e.sched_status || '';
    const recording = st.indexOf('recording') === 0;
    const s = sheetShell(_('Recording details'));
    const title = e.disp_title || '\u2014';
    const errs = (Number(e.errors) || 0) + (Number(e.data_errors) || 0);
    const subt = e.disp_subtitle || '';

    add(s.body, [
      heroImage(e.image),
      h('h2', { id: 'sheet-title', class: 'ev-title', text: title }),
      subt ? h('p', { class: 'ev-sub', text: subt }) : null,
      channelRow(e.channel, '', e.channelname, e.channel_icon, false),
      h('div', { class: 'ev-when' },
        fmtDate(e.start) + ' \u00b7 ' + fmtRange(e.start, e.stop) + ' \u00b7 ' + fmtMinutes((e.duration || (e.stop - e.start)) / 60),
        recording ? progressEl(e.start, e.stop) : null),
      h('div', { class: 'ev-badges' },
        recording ? recBadge(st) : null,
        e.status ? badge(e.status, /Error|Rerecord/.test(st) ? 'error' : '') : null),
      h('p', { class: 'ev-desc', text: descriptionOf(e.disp_summary, e.disp_description) }),
      facts([
        [_('Episode'), e.episode_disp],
        [_('File size'), fmtBytes(e.filesize)],
        [_('Errors'), errs || ''],
        [_('Comment'), e.comment],
      ]),
    ]);

    const uuids = [e.uuid];
    if (st === 'scheduled') {
      s.actions.appendChild(actionButton('trash', _('Delete recording'), 'danger', sheetAction(s,
        _('Do you really want to remove this recording?'),
        () => api('dvr/entry/cancel', { uuid: uuids }))));
    } else if (recording) {
      s.actions.appendChild(actionButton('stop', _('Stop recording'), 'danger', sheetAction(s,
        _('Do you really want to gracefully stop/unschedule this recording?'),
        () => api('dvr/entry/stop', { uuid: uuids }))));
    } else {
      if (e.filesize > 0) {
        s.actions.appendChild(actionButton('play', _('Play'), 'primary', () => openPlayer({ kind: 'dvr', uuid: e.uuid, title: title })));
        s.actions.appendChild(h('a', { class: 'btn', href: url('dvrfile/' + encodeURIComponent(e.uuid)), download: '' }, icon('download'), _('Download')));
      }
      s.actions.appendChild(actionButton('trash', _('Remove'), 'danger', sheetAction(s,
        _('Do you really want to remove this recording?'),
        () => api('dvr/entry/remove', { uuid: uuids }))));
    }
    s.open();
  }

  /* Log in by fetching the server's /login: an anonymous session gets the
   * HTTP auth challenge, so the browser asks for credentials and caches
   * them for the whole server (a challenge below /mobile/ would only cover
   * that path, leaving api/ calls anonymous). Reload to pick up the rights. */
  function login(btn) {
    btn.disabled = true;
    fetch(url('login'), { credentials: 'same-origin', cache: 'no-store' }).then((r) => {
      if (r.ok) location.reload();
      else btn.disabled = false;
    }, () => { btn.disabled = false; });
  }

  /* Session info and the way to the other interfaces. */
  function openMenu() {
    const a = state.access;
    const s = sheetShell(_('Settings'));
    const acl = Object.prototype.hasOwnProperty.call(a, 'username'); /* absent with --noacl */
    const items = [];
    /* Login makes no sense for an anonymous admin (wide-open ACL). */
    if (acl && !a.username && !Number(a.admin))
      items.push(h('button', { type: 'button', onclick: (e) => login(e.currentTarget) }, icon('login'), _('Login')));
    /* ?ui=desktop works even without cookies (or in a new tab); the cookie
     * makes the server root keep opening the desktop UI. */
    items.push(h('a', { href: url('?ui=desktop'), onclick: () => preferDesktop(true) }, icon('external'), _('Desktop version')));
    if (acl && a.username) items.push(h('a', { href: url('logout') }, icon('logout'), _('Logout')));
    const version = h('p', { class: 'menu-note' });
    add(s.body, [
      h('h2', { id: 'sheet-title', class: 'sr-only', text: _('Settings') }),
      acl && a.username ? h('p', { class: 'menu-note', text: _('Logged in as') + ' ' + a.username }) : null,
      h('ul', { class: 'menu-list' }, items.map((it) => h('li', null, it))),
      version,
    ]);
    s.open();
    api('serverinfo', {}).then((r) => {
      if (r && r.sw_version) version.textContent = (r.name || 'Tvheadend') + ' ' + r.sw_version;
    }, () => null);
  }

  /* ---------------------------------------------------------------------
   * Player
   *
   * Live channels stream through a stream profile (?profile=); what a
   * browser can decode depends on that profile, so the player offers the
   * profile list and the external-player playlist (play/ticket/...).
   * ------------------------------------------------------------------- */

  const PREFERRED_PROFILES = ['webtv-vp8-vorbis-webm', 'webtv-h264-aac-matroska', 'webtv-h264-aac-mpegts', 'matroska', 'pass'];

  function pickProfile(names) {
    const saved = store.get('profile');
    if (saved && names.indexOf(saved) >= 0) return saved;
    for (let i = 0; i < PREFERRED_PROFILES.length; i++)
      if (names.indexOf(PREFERRED_PROFILES[i]) >= 0) return PREFERRED_PROFILES[i];
    return names[0] || '';
  }

  function openPlayer(target) {
    const dlg = $('#player');
    const video = h('video', { controls: true, autoplay: true, playsinline: true, 'webkit-playsinline': true, preload: 'auto' });
    const msg = h('p', { class: 'player-msg', role: 'alert', hidden: true });
    const bar = h('div', { class: 'player-bar' });
    const ext = h('a', { class: 'btn', target: '_blank', rel: 'noopener' }, icon('external'), _('External player'));
    let profile = '';
    let stallTimer = null;

    function srcUrl() {
      if (target.kind === 'dvr') return url('dvrfile/' + encodeURIComponent(target.uuid));
      return url('stream/channel/' + encodeURIComponent(target.uuid) + (profile ? '?profile=' + encodeURIComponent(profile) : ''));
    }

    function extUrl() {
      const q = '?title=' + encodeURIComponent(target.title || '') + (profile ? '&profile=' + encodeURIComponent(profile) : '');
      if (target.kind === 'dvr') return url('play/ticket/dvrfile/' + encodeURIComponent(target.uuid) + q);
      return url('play/ticket/stream/channel/' + encodeURIComponent(target.uuid) + q);
    }

    function start() {
      msg.hidden = true;
      ext.setAttribute('href', extUrl());
      video.setAttribute('src', srcUrl());
      const p = video.play();
      if (p && p.catch) p.catch(() => { /* autoplay refused: the controls remain */ });
      /* Browsers often just keep buffering a live stream they cannot
       * decode instead of failing, so give a hint when nothing shows up. */
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { if (video.readyState < 2) showHint(); }, 15000);
    }

    function stop() {
      clearTimeout(stallTimer);
      video.pause();
      video.removeAttribute('src');
      video.load(); /* drops the connection and so the server-side subscription */
    }

    function showHint() {
      msg.textContent = target.kind === 'dvr'
        ? _('This recording cannot be played in the browser. Try an external player or download it.')
        : _('This stream cannot be played in the browser. Try another profile or an external player.');
      msg.hidden = false;
    }

    video.addEventListener('error', () => { if (video.getAttribute('src')) showHint(); });
    video.addEventListener('loadeddata', () => { clearTimeout(stallTimer); msg.hidden = true; });
    video.addEventListener('playing', () => { msg.hidden = true; });

    add(clear(dlg), [
      h('div', { class: 'sheet-head' }, h('h2', { id: 'player-title', tabindex: '-1', autofocus: true, text: target.title || '' }), closeButton(dlg)),
      h('div', { class: 'player-stage' }, video, msg),
      bar,
    ]);
    openDialog(dlg, stop);

    function setup(names) {
      if (target.kind === 'channel') {
        profile = pickProfile(names);
        if (names.length > 1) {
          const sel = h('select', {
            onchange: () => { profile = sel.value; store.set('profile', profile); stop(); start(); },
          }, names.map((n) => h('option', { value: n, selected: n === profile }, n)));
          bar.appendChild(h('label', null, _('Stream Profile'), sel));
        }
        bar.appendChild(ext);
      } else {
        bar.appendChild(ext);
        bar.appendChild(h('a', { class: 'btn', href: srcUrl(), download: '' }, icon('download'), _('Download')));
      }
      start();
    }

    /* Start within the tap when possible: some browsers only autoplay then. */
    if (target.kind !== 'channel' || state.profiles) setup(state.profiles || []);
    else loadProfiles().then((names) => { if (dlgStack.indexOf(dlg) >= 0) setup(names); });
  }

  /* ---------------------------------------------------------------------
   * Comet: live notifications (long-poll, paused while the page is hidden)
   * ------------------------------------------------------------------- */

  const comet = { boxid: null, running: false, failures: 0 };

  function onNotification(m) {
    switch (m.notificationClass) {
      case 'accessUpdate':
        applyAccess(m);
        break;
      case 'dvrentry':
      case 'dvrautorec':
        /* New/removed entries show up quickly; mere changes (a running
         * recording reports one every few seconds) at most every 15 s. */
        if (m.create || m.delete) scheduleRefresh();
        else scheduleRefresh(1200, 15000);
        break;
      case 'channel':
      case 'channeltag':
        state.channels = null; /* picked up by the next load */
        break;
      default:
        break;
    }
  }

  function cometPoll() {
    if (document.hidden) { comet.running = false; return; }
    comet.running = true;
    post('comet/poll', { boxid: comet.boxid || undefined, immediate: '0' }).then((env) => {
      comet.failures = 0;
      if (env && env.boxid) comet.boxid = env.boxid;
      ((env && env.messages) || []).forEach((m) => {
        try { onNotification(m); } catch (e) { /* keep polling */ }
      });
      cometPoll();
    }, () => {
      comet.failures++;
      setTimeout(cometPoll, Math.min(30000, 1000 * Math.pow(2, comet.failures)));
    });
  }

  /* ---------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------- */

  function localize() {
    /* Strings that only appear in index.html, listed for xgettext (-kN_). */
    const N_ = (s) => s;
    void [N_('Main navigation')];
    $$('[data-i18n]').forEach((el) => { el.textContent = _(el.getAttribute('data-i18n')); });
    $$('[data-i18n-label]').forEach((el) => { el.setAttribute('aria-label', _(el.getAttribute('data-i18n-label'))); });
  }

  function boot() {
    localize();
    initDialog($('#sheet'), true);
    initDialog($('#confirm'), true);
    initDialog($('#player'), false);
    if (history.state && history.state.tvhDlg) history.replaceState(null, '');
    /* Opened through a desktop UI's "Mobile UI" link: the user chose this
     * UI again, so let the server root open it on this phone. */
    if (/(^\?|&)ui=mobile(&|$)/.test(location.search)) {
      preferDesktop(false);
      history.replaceState(null, '', location.pathname + location.hash);
    }

    $('#btn-refresh').addEventListener('click', () => { if (current && current.refresh) current.refresh(false); });
    $('#btn-menu').addEventListener('click', openMenu);
    window.addEventListener('hashchange', route);
    /* Tapping the active tab again scrolls back to the top. */
    $$('.tabbar a').forEach((a) => a.addEventListener('click', () => {
      if (a.getAttribute('aria-current') === 'page') window.scrollTo(0, 0);
    }));

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (!comet.running) cometPoll();
      if (Date.now() - hiddenAt > 30000) scheduleRefresh(0);
      else if (current && current.tick) current.tick();
    });
    setInterval(() => { if (!document.hidden && current && current.tick) current.tick(); }, 30000);

    api('access/whoami', {}).then(applyAccess, () => applyAccess({})).then(() => {
      route();
      cometPoll();
      loadGenres();
      loadProfiles();
    });
  }

  boot();
})();
