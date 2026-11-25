// The couple's highlight builder (photos/highlight.html?k=REVIEWCODE).
//
// Lists every photo and video guests shared. You add the ones you want, trim each clip, pick
// or turn off its filter, put them in order, and add an opening title, closing words and
// music. "Make the video" plays the whole thing once on a canvas and records it right in the
// browser (nothing is uploaded until you choose "Save & get a link"). The guests' originals
// are never changed: filters are only drawn on the way into the highlight.
//
// Files come through the Apps Script (action "media", in pieces) rather than straight from
// Drive, because Drive's links can't be drawn onto a canvas and recorded.
(function () {
  'use strict';

  const T = window.PhotoTools;
  const API = window.WeddingAPI;
  const Fun = window.Fun; // silly filters (js/fun.js)
  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  const SIZES = { wide: [1280, 720], tall: [720, 1280] };
  const TITLE_SECONDS = 4;
  const END_SECONDS = 3.5;
  const FADE = 0.45;
  const STORE_KEY = 'wedding.highlight';

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  const store = {
    get(key) { try { return localStorage.getItem(key) || ''; } catch (err) { return ''; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (err) { /* private browsing */ } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (s) => T.formatSeconds(s);
  const round1 = (n) => Math.round(n * 10) / 10;

  /* ---------- the review code ---------- */

  let k = (() => {
    const params = new URLSearchParams(location.search);
    const fromLink = T.normalizeCode(params.get('k'));
    if (fromLink) {
      store.set('wedding.reviewCode', fromLink);
      params.delete('k');
      history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
    }
    return fromLink || T.normalizeCode(store.get('wedding.reviewCode'));
  })();

  /* ---------- state ---------- */

  let library = [];        // everything guests shared (from the server)
  const byId = new Map();
  let show = 'all';
  let timeline = [];       // [{ uid, id, start, end, seconds, filter }]
  let selected = -1;
  let playing = null;      // the preview or export in progress
  let musicFile = null;
  const settings = { shape: 'wide', title1: '', title2: '', endText: '', credits: false, fades: true, clipVolume: 1, musicVolume: 0.6 };

  function save() {
    store.set(STORE_KEY, JSON.stringify({ timeline, settings }));
  }
  function restore() {
    try {
      const saved = JSON.parse(store.get(STORE_KEY) || '{}');
      Object.assign(settings, saved.settings || {});
      timeline = (saved.timeline || []).filter((it) => byId.has(it.id));
    } catch (err) { /* start fresh */ }
  }

  /* ---------- loading ---------- */

  function setState(s) { app.dataset.state = s; }

  function showError(err) {
    const titles = { not_found: "That review code didn't work", not_ready: 'Almost ready!', network: 'Connection problem', rate_limited: 'Please try again in a few minutes', no_code: 'Open the highlight builder' };
    const code = err && err.code ? err.code : 'unknown';
    $('#error-title').textContent = titles[code] || "We couldn't open the builder";
    $('#error-message').textContent = code === 'no_code' ? '' : (err && err.message) || 'Something went wrong. Please try again.';
    setState('error');
  }

  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = T.normalizeCode($('#code-input').value);
    if (!typed) return;
    k = typed;
    store.set('wedding.reviewCode', k);
    load();
  });

  async function load() {
    if (!k) { showError({ code: 'no_code' }); return; }
    setState('loading');
    try {
      const d = await API.getReview(k);
      library = d.items || [];
      library.forEach((it) => byId.set(it.id, it));
      if (d.highlight) showSaved(d.highlight);
      restore();
      timeline.forEach((item) => loadMedia(item.id).catch(() => {}));
      applySettingsToForm();
      renderLibrary();
      renderTimeline();
      setState('ready');
      const ctx = document.createElement('canvas').getContext('2d');
      $('#hl-browser').hidden = !!(window.MediaRecorder && 'filter' in ctx && HTMLCanvasElement.prototype.captureStream);
    } catch (err) {
      showError(err);
    }
  }

  // Each file, fetched once in 3 MB pieces and kept for this visit.
  const media = new Map(); // id -> { progress, promise, url, blob }
  function loadMedia(id) {
    if (media.has(id)) return media.get(id).promise;
    const entry = { progress: 0, url: '', blob: null };
    entry.promise = (async () => {
      const parts = [];
      let offset = 0, size = Infinity, mime = '';
      while (offset < size) {
        let r;
        for (let attempt = 0; ; attempt++) {
          try { r = await API.getMedia(k, id, offset); break; } catch (err) {
            if (attempt >= 3 || (err && ['not_found', 'bad_request'].includes(err.code))) throw err;
            await sleep(2000 * (attempt + 1));
          }
        }
        size = r.size;
        mime = r.mime;
        if (!r.data) break;
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        offset += bytes.length;
        entry.progress = size ? offset / size : 1;
        mediaChanged(id);
      }
      entry.blob = new Blob(parts, { type: mime });
      entry.url = URL.createObjectURL(entry.blob);
      entry.progress = 1;
      mediaChanged(id);
      return entry;
    })();
    entry.promise.catch(() => { media.delete(id); mediaChanged(id); });
    media.set(id, entry);
    return entry.promise;
  }
  function mediaChanged(id) {
    document.querySelectorAll(`[data-media="${CSS.escape(id)}"]`).forEach((el) => {
      const e = media.get(id);
      el.textContent = !e ? 'Couldn\'t load. It will try again.' : e.url ? '' : `Loading ${Math.round(e.progress * 100)}%`;
    });
    updateButtons();
  }

  /* ---------- the library ---------- */

  const stillId = (it) => (it.kind === 'video' ? it.poster || it.id : it.id);
  const who = (it) => (it.from ? it.from : 'A guest');

  function renderLibrary() {
    const showHidden = $('#show-hidden').checked;
    const items = library.filter((it) => (show === 'all' || it.kind === show) && (showHidden || !it.hidden));
    const grid = $('#library');
    grid.textContent = '';
    items.forEach((it) => {
      const used = timeline.filter((t) => t.id === it.id).length;
      const img = h('img', { src: T.photoUrl(stillId(it), 400), alt: '', loading: 'lazy' });
      img.style.filter = T.filterCss(it.filter);
      const meta = [who(it), T.takenTime(it)].filter(Boolean).join(' · ');
      grid.append(h('div', { class: `hl-card${it.hidden ? ' hl-card--hidden' : ''}` },
        h('button', { type: 'button', class: 'hl-card__thumb', title: 'Preview', onclick: () => previewLibraryItem(it) }, img,
          it.kind === 'video' ? h('span', { class: 'tile__badge' }, h('span', { class: 'tile__play' }), it.seconds ? fmt(it.seconds) : '') : null,
          it.hidden ? h('span', { class: 'hl-card__flag', text: 'Hidden' }) : null),
        h('p', { class: 'hl-card__meta', text: meta }),
        it.caption ? h('p', { class: 'hl-card__note', text: it.caption }) : null,
        h('button', { type: 'button', class: 'hl-card__add', onclick: () => addItem(it) }, used ? `+ Add again (${used})` : '+ Add')));
    });
    $('#library-empty').hidden = items.length > 0;
    const nv = library.filter((it) => it.kind === 'video').length;
    $('#library-count').textContent = `${nv} video${nv === 1 ? '' : 's'}, ${library.length - nv} photo${library.length - nv === 1 ? '' : 's'}`;
  }

  document.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
    show = b.dataset.show;
    document.querySelectorAll('[data-show]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderLibrary();
  }));
  $('#show-hidden').addEventListener('change', renderLibrary);

  async function previewLibraryItem(it) {
    selected = -1;
    renderTimeline();
    await showInPlayer(it, null);
  }

  /* ---------- the running order ---------- */

  let uidCounter = 0;
  function addItem(it) {
    const item = { uid: `${Date.now()}-${uidCounter++}`, id: it.id, filter: it.filter || '' };
    if (it.kind === 'video') {
      item.start = 0;
      item.end = round1(it.seconds || 10);
    } else {
      item.seconds = 4;
    }
    timeline.push(item);
    loadMedia(it.id).catch(() => {});
    select(timeline.length - 1);
    save();
    renderLibrary();
  }

  function itemLength(item) {
    const it = byId.get(item.id);
    if (!it) return 0;
    return it.kind === 'video' ? Math.max(0.2, (item.end || 0) - (item.start || 0)) : item.seconds || 4;
  }
  function totalLength() {
    return timeline.reduce((n, item) => n + itemLength(item), 0)
      + (settings.title1 || settings.title2 ? TITLE_SECONDS : 0) + (settings.endText ? END_SECONDS : 0);
  }

  function renderTimeline() {
    const list = $('#timeline');
    list.textContent = '';
    timeline.forEach((item, i) => {
      const it = byId.get(item.id);
      const img = h('img', { src: T.photoUrl(stillId(it), 200), alt: '' });
      img.style.filter = T.filterCss(item.filter);
      const e = media.get(item.id);
      const row = h('li', { class: `hl-row${i === selected ? ' is-selected' : ''}`, draggable: 'true', 'data-index': String(i) },
        h('span', { class: 'hl-row__grip', 'aria-hidden': 'true', text: '⋮⋮' }),
        h('button', { type: 'button', class: 'hl-row__main', onclick: () => select(i) },
          h('span', { class: 'hl-row__thumb' }, img),
          h('span', { class: 'hl-row__text' },
            h('span', { class: 'hl-row__title', text: `${i + 1}. ${it.kind === 'video' ? 'Video' : 'Photo'} by ${who(it)}` }),
            h('span', { class: 'hl-row__meta', text: [fmt(itemLength(item)), item.filter ? item.filter : 'No filter', it.kind === 'video' && (item.start > 0 || item.end < (it.seconds || item.end)) ? 'trimmed' : ''].filter(Boolean).join(' · ') }),
            h('span', { class: 'hl-row__loading', 'data-media': item.id, text: e && !e.url ? `Loading ${Math.round(e.progress * 100)}%` : '' }))),
        h('span', { class: 'hl-row__tools' },
          h('button', { type: 'button', class: 'hl-icon', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(i, i - 1), text: '↑' }),
          h('button', { type: 'button', class: 'hl-icon', 'aria-label': 'Move down', disabled: i === timeline.length - 1, onclick: () => move(i, i + 1), text: '↓' }),
          h('button', { type: 'button', class: 'hl-icon', 'aria-label': 'Remove', onclick: () => removeItem(i), text: '✕' })));
      row.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', String(i)); row.classList.add('is-dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
      row.addEventListener('dragover', (ev) => { ev.preventDefault(); row.classList.add('is-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('is-over'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('is-over');
        const from = Number(ev.dataTransfer.getData('text/plain'));
        if (!Number.isNaN(from)) move(from, i);
      });
      list.append(row);
    });
    $('#timeline-empty').hidden = timeline.length > 0;
    $('#clear-all').hidden = timeline.length === 0;
    $('#total').textContent = timeline.length ? `Total: ${fmt(totalLength())}` : '';
    updateButtons();
  }

  function move(from, to) {
    if (to < 0 || to >= timeline.length || from === to) return;
    const [item] = timeline.splice(from, 1);
    timeline.splice(to, 0, item);
    if (selected === from) selected = to;
    else if (selected > from && selected <= to) selected--;
    else if (selected < from && selected >= to) selected++;
    save();
    renderTimeline();
  }

  function removeItem(i) {
    timeline.splice(i, 1);
    if (selected === i) { selected = -1; showEdit(); clearPlayer(); }
    else if (selected > i) selected--;
    save();
    renderTimeline();
    renderLibrary();
  }

  $('#clear-all').addEventListener('click', () => {
    if (!confirm('Remove everything from the running order?')) return;
    timeline = [];
    selected = -1;
    showEdit();
    clearPlayer();
    save();
    renderTimeline();
    renderLibrary();
  });

  function updateButtons() {
    const ready = timeline.length > 0 && timeline.every((item) => media.get(item.id) && media.get(item.id).url);
    $('#play-all').disabled = !timeline.length || !!playing;
    $('#export').disabled = !ready || !!playing;
    if (timeline.length && !ready && !playing) $('#export-status').textContent = 'Waiting for every clip to finish loading…';
    else if (!playing && !$('#export-status').dataset.locked) $('#export-status').textContent = 'It plays through once while it records, so it takes as long as the video. Keep this tab open and in front until it\'s done.';
  }

  /* ---------- editing one item ---------- */

  function select(i) {
    selected = i;
    renderTimeline();
    showEdit();
    const item = timeline[i];
    if (item) showInPlayer(byId.get(item.id), item);
  }

  let chips = null;
  function showEdit() {
    const item = timeline[selected];
    $('#edit').hidden = !item;
    if (!item) return;
    const it = byId.get(item.id);
    $('#edit-title').textContent = `${selected + 1}. ${it.kind === 'video' ? 'Video' : 'Photo'} by ${who(it)}${it.caption ? `: "${it.caption}"` : ''}`;
    $('#edit-trim').hidden = it.kind !== 'video';
    $('#edit-photo').hidden = it.kind === 'video';
    $('#edit-start').value = item.start || 0;
    $('#edit-end').value = item.end || 0;
    $('#edit-start').max = $('#edit-end').max = it.seconds || 120;
    $('#edit-seconds').value = item.seconds || 4;
    chips = T.filterChips($('#edit-filters'), item.filter, (f) => {
      item.filter = f;
      $('#clip-player').style.filter = $('#photo-player').style.filter = T.filterCss(f);
      save();
      renderTimeline();
    });
  }

  function clampTrim(item) {
    const it = byId.get(item.id);
    const max = it.seconds || 600;
    item.start = Math.max(0, Math.min(round1(item.start || 0), max - 0.2));
    item.end = Math.max(item.start + 0.2, Math.min(round1(item.end || max), max));
  }
  $('#edit-start').addEventListener('change', () => { const item = timeline[selected]; item.start = Number($('#edit-start').value); clampTrim(item); showEdit(); save(); renderTimeline(); seekPlayer(item.start); });
  $('#edit-end').addEventListener('change', () => { const item = timeline[selected]; item.end = Number($('#edit-end').value); clampTrim(item); showEdit(); save(); renderTimeline(); seekPlayer(item.end); });
  $('#edit-start-now').addEventListener('click', () => { const item = timeline[selected]; item.start = $('#clip-player').currentTime; clampTrim(item); showEdit(); save(); renderTimeline(); });
  $('#edit-end-now').addEventListener('click', () => { const item = timeline[selected]; item.end = $('#clip-player').currentTime; clampTrim(item); showEdit(); save(); renderTimeline(); });
  $('#edit-seconds').addEventListener('change', () => {
    const item = timeline[selected];
    item.seconds = Math.max(1, Math.min(20, Number($('#edit-seconds').value) || 4));
    showEdit();
    save();
    renderTimeline();
  });

  /* ---------- the player (one clip at a time) ---------- */

  function clearPlayer() {
    const v = $('#clip-player');
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.hidden = true;
    $('#photo-player').hidden = true;
    $('#photo-player').removeAttribute('src');
    $('#stage').hidden = false;
    $('#stage-note').hidden = false;
  }

  function seekPlayer(t) {
    const v = $('#clip-player');
    if (!v.hidden) { v.pause(); v.currentTime = t; }
  }

  async function showInPlayer(it, item) {
    if (playing) return;
    clearPlayer();
    $('#stage-note').textContent = 'Loading…';
    let e;
    try { e = await loadMedia(it.id); } catch (err) { $('#stage-note').textContent = "This one couldn't be loaded. Try again in a minute."; return; }
    // Still the one they want?
    if (item ? timeline[selected] !== item : selected !== -1) return;
    $('#stage').hidden = true;
    $('#stage-note').hidden = true;
    const filter = T.filterCss(item ? item.filter : it.filter);
    if (it.kind === 'video') {
      const v = $('#clip-player');
      v.src = e.url;
      v.style.filter = filter;
      v.hidden = false;
      await waitFor(v, 'loadedmetadata');
      await fixDuration(v, it);
      if (item) v.currentTime = item.start || 0;
    } else {
      const img = $('#photo-player');
      img.src = e.url;
      img.style.filter = filter;
      img.hidden = false;
    }
  }

  function waitFor(el, event, ms = 8000) {
    return new Promise((resolve) => {
      if (event === 'loadedmetadata' && el.readyState >= 1) return resolve(true);
      if (event === 'canplay' && el.readyState >= 3) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      el.addEventListener(event, () => { clearTimeout(t); resolve(true); }, { once: true });
    });
  }

  // Videos recorded in the browser (WebM) often don't say how long they are until they've
  // been read to the end. This makes the browser work it out.
  async function fixDuration(v, it) {
    if (Number.isFinite(v.duration) && v.duration > 0) { if (it && !it.seconds) it.seconds = round1(v.duration); return; }
    v.currentTime = 1e7;
    await waitFor(v, 'durationchange', 4000);
    v.currentTime = 0;
    await waitFor(v, 'seeked', 2000);
    if (it && Number.isFinite(v.duration) && !it.seconds) it.seconds = round1(v.duration);
  }

  /* ---------- look & sound ---------- */

  function applySettingsToForm() {
    document.querySelectorAll('input[name="shape"]').forEach((r) => { r.checked = r.value === settings.shape; });
    $('#title-1').value = settings.title1;
    $('#title-2').value = settings.title2;
    $('#end-text').value = settings.endText;
    $('#credits').checked = settings.credits;
    $('#fades').checked = settings.fades;
    $('#clip-volume').value = settings.clipVolume;
    $('#music-volume').value = settings.musicVolume;
    sizeStage();
    drawTitleCard(0.999);
  }
  function readSettings() {
    settings.shape = document.querySelector('input[name="shape"]:checked').value;
    settings.title1 = $('#title-1').value.trim();
    settings.title2 = $('#title-2').value.trim();
    settings.endText = $('#end-text').value.trim();
    settings.credits = $('#credits').checked;
    settings.fades = $('#fades').checked;
    settings.clipVolume = Number($('#clip-volume').value);
    settings.musicVolume = Number($('#music-volume').value);
    save();
    sizeStage();
    if (!playing && selected === -1) { clearPlayer(); drawTitleCard(0.999); }
    renderTimeline();
  }
  ['#title-1', '#title-2', '#end-text', '#credits', '#fades', '#clip-volume', '#music-volume'].forEach((s) => $(s).addEventListener('input', readSettings));
  document.querySelectorAll('input[name="shape"]').forEach((r) => r.addEventListener('change', readSettings));
  $('#music').addEventListener('change', () => {
    musicFile = $('#music').files[0] || null;
    $('#music-name').textContent = musicFile ? `${musicFile.name}. It starts with the video and fades out at the end.` : '';
  });

  /* ---------- drawing ---------- */

  const canvas = $('#stage');
  const ctx = canvas.getContext('2d');
  function sizeStage() {
    const [w, hgt] = SIZES[settings.shape] || SIZES.wide;
    canvas.width = w;
    canvas.height = hgt;
    $('#stage-box').dataset.shape = settings.shape;
  }

  // One frame: the picture fitted inside, over a blurred, darker copy that fills the edges
  // (so tall phone videos look good in a wide video, and the other way round).
  function drawFrame(source, sw, sh, filter, { alpha = 1, zoom = 1, credit = '', t = 0 } = {}) {
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (source && sw && sh) {
      const css = T.filterCss(filter);
      const cover = Math.max(W / sw, H / sh) * 1.08;
      ctx.filter = `blur(${Math.round(W / 40)}px) brightness(0.5)${css !== 'none' ? ` ${css}` : ''}`;
      ctx.drawImage(source, (W - sw * cover) / 2, (H - sh * cover) / 2, sw * cover, sh * cover);
      const fit = Math.min(W / sw, H / sh) * zoom;
      ctx.filter = css;
      ctx.drawImage(source, (W - sw * fit) / 2, (H - sh * fit) / 2, sw * fit, sh * fit);
      ctx.filter = 'none';
      if (Fun && Fun.isSilly(filter)) Fun.draw(ctx, filter, { x: (W - sw * fit) / 2, y: (H - sh * fit) / 2, w: sw * fit, h: sh * fit }, t);
    }
    if (credit) {
      const size = Math.round(Math.min(W, H) / 26);
      ctx.font = `italic ${size}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = size / 2;
      ctx.textBaseline = 'bottom';
      ctx.fillText(credit, size, H - size * 0.9);
      ctx.shadowBlur = 0;
    }
    if (alpha < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - Math.max(0, alpha)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  function drawCard(lines, alpha) {
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.filter = 'none';
    ctx.fillStyle = '#15322a';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const unit = Math.min(W, H);
    let y = H / 2 - (lines.length - 1) * unit * 0.07;
    lines.forEach(([text, style], i) => {
      if (style === 'script') ctx.font = `${Math.round(unit / 7)}px "Pinyon Script", cursive`;
      else ctx.font = `${Math.round(unit / 18)}px "Cormorant Garamond", Georgia, serif`;
      ctx.fillStyle = style === 'script' ? '#f9e9eb' : 'rgba(249,233,235,0.85)';
      // Long lines shrink to fit.
      let size = parseFloat(ctx.font);
      while (ctx.measureText(text).width > W * 0.86 && size > 10) { size -= 2; ctx.font = ctx.font.replace(/\d+(\.\d+)?px/, `${size}px`); }
      ctx.fillText(text, W / 2, y);
      y += i === 0 ? unit * 0.16 : unit * 0.1;
    });
    if (alpha < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - Math.max(0, alpha)})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  function titleLines() {
    const lines = [];
    if (settings.title1) lines.push([settings.title1, 'script']);
    if (settings.title2) lines.push([settings.title2, 'serif']);
    return lines;
  }
  function drawTitleCard(alpha) {
    const lines = titleLines();
    drawCard(lines.length ? lines : [['Stephanie & Robert', 'script'], ['Your highlight video will play here', 'serif']], alpha);
  }

  /* ---------- playing it through (preview or recording) ---------- */

  // Plays the whole highlight on the canvas. With `record`, also records it and resolves to
  // the finished video (a Blob). Stopping early resolves to null.
  async function run({ record }) {
    if (playing) return null;
    clearPlayer();
    $('#stage-note').hidden = true;
    sizeStage();
    await document.fonts.load(`40px "Pinyon Script"`).catch(() => {});
    await document.fonts.load(`40px "Cormorant Garamond"`).catch(() => {});
    const job = { stopped: false };
    playing = job;
    updateButtons();
    $('#stop').hidden = false;

    const ac = new AudioContext();
    const out = ac.createMediaStreamDestination();
    const master = ac.createGain();
    master.connect(out);
    master.connect(ac.destination);

    let music = null, musicGain = null;
    if (musicFile) {
      music = new Audio(URL.createObjectURL(musicFile));
      music.loop = true;
      musicGain = ac.createGain();
      musicGain.gain.value = settings.musicVolume;
      ac.createMediaElementSource(music).connect(musicGain).connect(master);
    }

    let recorder = null;
    const pieces = [];
    let type = '';
    if (record) {
      const stream = canvas.captureStream(30);
      out.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      type = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (err) { return false; } }) || '';
      recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 6000000, audioBitsPerSecond: 160000 });
      recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) pieces.push(e.data); });
      recorder.start(1000);
    }
    if (music) music.play().catch(() => {});

    const total = totalLength();
    let done = 0;
    const progress = (sec) => {
      const text = `${record ? 'Recording' : 'Playing'} ${fmt(done + sec)} of ${fmt(total)}`;
      $('#export-status').textContent = record ? `${text}. Keep this tab open and in front.` : text;
    };
    const fade = (t, len) => (settings.fades ? Math.min(1, t / FADE, (len - t) / FADE) : 1);

    // A still card (title / closing words) or a photo, for `len` seconds.
    function hold(len, draw) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        (function frame() {
          const t = (performance.now() - t0) / 1000;
          if (job.stopped || t >= len) { resolve(); return; }
          draw(t, len);
          progress(t);
          requestAnimationFrame(frame);
        })();
      });
    }

    let blob = null;
    try {
      const title = titleLines();
      if (title.length) {
        await hold(TITLE_SECONDS, (t, len) => drawCard(title, fade(t, len)));
        done += TITLE_SECONDS;
      }
      for (const item of timeline) {
        if (job.stopped) break;
        const it = byId.get(item.id);
        const e = await loadMedia(item.id);
        const credit = settings.credits && it.from ? `${it.kind === 'video' ? 'Filmed' : 'Photo'} by ${it.from}` : '';
        if (it.kind === 'photo') {
          const img = new Image();
          img.src = e.url;
          await img.decode().catch(() => {});
          const len = itemLength(item);
          await hold(len, (t) => drawFrame(img, img.naturalWidth, img.naturalHeight, item.filter, { alpha: fade(t, len), zoom: 1 + 0.06 * (t / len), credit, t: t + 1 }));
          done += len;
          continue;
        }
        // A video clip, from its start to its end, with its own sound.
        const v = document.createElement('video');
        v.src = e.url;
        v.playsInline = true;
        v.preload = 'auto';
        await waitFor(v, 'loadedmetadata');
        await fixDuration(v, it);
        const start = item.start || 0;
        const end = Math.min(item.end || v.duration, Number.isFinite(v.duration) ? v.duration : item.end);
        const len = Math.max(0.2, end - start);
        v.currentTime = start;
        await waitFor(v, 'seeked', 4000);
        const gain = ac.createGain();
        gain.gain.value = settings.clipVolume;
        const src = ac.createMediaElementSource(v);
        src.connect(gain).connect(master);
        if (musicGain) musicGain.gain.setTargetAtTime(settings.musicVolume * (settings.clipVolume > 0 ? 0.55 : 1), ac.currentTime, 0.3);
        await v.play().catch(() => {});
        await new Promise((resolve) => {
          (function frame() {
            const t = v.currentTime - start;
            if (job.stopped || v.ended || t >= len) { resolve(); return; }
            gain.gain.value = settings.clipVolume * (settings.fades ? Math.max(0, Math.min(1, t / FADE, (len - t) / FADE)) : 1);
            drawFrame(v, v.videoWidth, v.videoHeight, item.filter, { alpha: fade(t, len), credit, t: v.currentTime });
            progress(t);
            requestAnimationFrame(frame);
          })();
        });
        v.pause();
        src.disconnect();
        v.removeAttribute('src');
        v.load();
        if (musicGain) musicGain.gain.setTargetAtTime(settings.musicVolume, ac.currentTime, 0.3);
        done += len;
      }
      if (settings.endText && !job.stopped) {
        const lines = [[settings.endText, 'serif'], ['Stephanie & Robert', 'script']];
        if (musicGain) musicGain.gain.setTargetAtTime(0, ac.currentTime + END_SECONDS - 1.6, 0.5);
        await hold(END_SECONDS, (t, len) => drawCard(lines, fade(t, len)));
      } else if (musicGain) {
        musicGain.gain.setTargetAtTime(0, ac.currentTime, 0.3);
        await sleep(900);
      }
    } finally {
      if (music) { music.pause(); URL.revokeObjectURL(music.src); }
      if (recorder) {
        await new Promise((resolve) => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
        if (!job.stopped) blob = new Blob(pieces, { type: (recorder.mimeType || type || 'video/webm').split(';')[0] });
      }
      ac.close().catch(() => {});
      playing = null;
      $('#stop').hidden = true;
      updateButtons();
      drawTitleCard(0.999);
    }
    return blob;
  }

  $('#stop').addEventListener('click', () => { if (playing) playing.stopped = true; });
  $('#play-all').addEventListener('click', async () => {
    if (!timeline.length) return;
    // Start loading everything first so the preview doesn't stop to wait.
    await Promise.all(timeline.map((item) => loadMedia(item.id))).catch(() => {});
    run({ record: false });
  });

  /* ---------- making and saving the video ---------- */

  let made = null; // { blob, url }
  $('#export').addEventListener('click', async () => {
    if (made) { URL.revokeObjectURL(made.url); made = null; }
    $('#result').hidden = true;
    $('#export-status').dataset.locked = '1';
    const blob = await run({ record: true });
    delete $('#export-status').dataset.locked;
    if (!blob) { $('#export-status').textContent = 'Stopped. Nothing was saved.'; return; }
    made = { blob, url: URL.createObjectURL(blob) };
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    $('#result-video').src = made.url;
    $('#download').href = made.url;
    $('#download').download = `Highlight video.${ext}`;
    $('#result').hidden = false;
    $('#save-status').textContent = '';
    $('#export-status').textContent = `Done! ${fmt(totalLength())}, ${(blob.size / 1048576).toFixed(0)} MB. Watch it below, then download it or save it to get a link to send.`;
  });

  $('#save-drive').addEventListener('click', async () => {
    if (!made) return;
    const btn = $('#save-drive');
    btn.disabled = true;
    const status = $('#save-status');
    const blob = made.blob;
    const uploadId = `highlight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    async function step(payload) {
      for (let attempt = 0; ; attempt++) {
        try { return await API.videoStep({ k, uploadId, ...payload }); } catch (err) {
          if (attempt >= 3 || !(err && ['network', 'upload_failed', 'server_error'].includes(err.code))) throw err;
          await sleep(2500 * (attempt + 1));
        }
      }
    }
    try {
      status.textContent = 'Saving… 0%';
      let r = await step({ step: 'start', mime: blob.type, size: blob.size });
      let offset = r.received || 0;
      const piece = r.chunkSize || 2 * 1024 * 1024;
      while (offset < blob.size) {
        const data = await T.blobToBase64(blob.slice(offset, offset + piece));
        r = await step({ step: 'chunk', offset, data });
        offset = r.received;
        status.textContent = `Saving… ${Math.round((offset / blob.size) * 100)}%`;
      }
      r = await step({ step: 'finish' });
      showSaved(r.highlight.url);
      status.textContent = 'Saved to your Google Drive photo folder.';
    } catch (err) {
      status.textContent = `It didn't save: ${(err && err.message) || 'please try again'}. You can still download it.`;
    } finally {
      btn.disabled = false;
    }
  });

  function showSaved(url) {
    if (!/^https:\/\//.test(String(url || ''))) return;
    $('#saved').hidden = false;
    $('#saved-link').value = url;
  }
  $('#copy-link').addEventListener('click', async () => {
    const input = $('#saved-link');
    try { await navigator.clipboard.writeText(input.value); } catch (err) { input.select(); document.execCommand('copy'); }
    $('#copy-link').textContent = 'Copied!';
    setTimeout(() => { $('#copy-link').textContent = 'Copy'; }, 1800);
  });

  window.addEventListener('beforeunload', (e) => {
    if (playing || (made && !$('#saved-link').value)) { e.preventDefault(); e.returnValue = ''; }
  });

  load();
})();
