// The shared photo album: guests scan the QR code on their table, add photos from their
// phone, and see everyone's photos on a timeline. Photos are saved to Google Drive through
// the Apps Script (apps-script/Code.gs) and listed on the "Photos" tab of the Sheet.
(function () {
  'use strict';

  const T = window.PhotoTools;
  const API = window.WeddingAPI;
  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  const params = new URLSearchParams(location.search);
  const table = (params.get('table') || '').replace(/[^A-Za-z0-9 #&'.-]/g, '').trim().slice(0, 24);
  let code = T.photoCodeFromPage();

  let data = null;          // the last reply from the server
  let photos = [];          // what's on the timeline, in the order taken
  let shown = [];           // the same photos in the order on screen (for the lightbox)
  let waiting = null;       // a newer list held back until the guest taps "new photos"
  let order = 'oldest';
  const local = new Map();  // photo id → preview of a photo shared from this phone (shows instantly)

  const MAX_PER_PICK = 60;
  const CONCURRENT_UPLOADS = 2;
  const POLL_MS = 45000;
  const uploads = [];
  let running = 0;

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
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const setState = (state) => { app.dataset.state = state; };

  /* ---------- loading ---------- */

  function load() {
    if (!code) { showError({ code: 'no_code' }); return; }
    setState('loading');
    API.getPhotos(code).then((d) => {
      if (!d || !Array.isArray(d.photos)) throw new API.ApiError('not_ready', "Photo sharing isn't open yet. Please check back soon!");
      data = d;
      photos = d.photos.slice();
      render();
      setState('photos');
      startPolling();
    }).catch(showError);
  }

  function showError(err) {
    const titles = {
      no_code: 'Find the photo album',
      not_found: "That code didn't work",
      not_ready: 'Almost ready!',
      not_configured: 'Almost ready!',
      network: 'Connection problem',
      rate_limited: 'Please try again in a few minutes',
    };
    const messages = {
      no_code: 'Scan the QR code on your table card, or type in the code printed under it.',
      not_found: 'Please scan the QR code on your table card again, or type in the code printed under it.',
    };
    const known = err && err.code && (err instanceof API.ApiError || titles[err.code]);
    if (!known) console.error(err);
    const c = known ? err.code : 'unknown';
    $('#error-title').textContent = titles[c] || "We couldn't open the photos";
    $('#error-message').textContent = messages[c] || (known && err.message) || 'Something went wrong. Please try again in a minute.';
    const input = $('#code-input');
    if (!input.value && c !== 'not_found') input.value = code;
    setState('error');
  }

  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = T.normalizeCode($('#code-input').value);
    if (!typed) { $('#code-input').focus(); return; }
    code = typed;
    store.set('wedding.photoCode', code);
    const q = new URLSearchParams({ t: code });
    if (table) q.set('table', table);
    history.replaceState(null, '', `?${q}`);
    load();
  });

  /* ---------- page ---------- */

  function render() {
    if (table) $('#photos-eyebrow').textContent = `Table ${table}`;
    const up = data.uploads || {};
    $('#add-area').hidden = up.open === false;
    const closed = $('#photos-closed');
    closed.hidden = up.open !== false;
    if (up.open === false) {
      $('#photos-intro').textContent = 'Here are all the photos everyone shared.';
      closed.textContent = `Photo sharing closed${up.untilText ? ` on ${up.untilText}` : ''}. Thank you for all the photos!`;
    }
    renderTimeline();
  }

  function byTime(a, b) {
    const x = a.takenAt || a.uploadedAt, y = b.takenAt || b.uploadedAt;
    if (x !== y) return x < y ? -1 : 1;
    return (a.uploadedAt || '') < (b.uploadedAt || '') ? -1 : 1;
  }

  function imageFor(photo, size) {
    return local.get(photo.id) || T.photoUrl(photo.id, size);
  }

  // Google Drive sometimes needs a few seconds to make the small version of a new photo.
  function retryingImage(img, photo, size) {
    let tries = 0;
    img.addEventListener('error', () => {
      if (tries >= 3) { img.closest('.tile') && img.closest('.tile').classList.add('tile--broken'); return; }
      tries++;
      setTimeout(() => { img.src = `${T.photoUrl(photo.id, size)}&retry=${tries}`; }, 2500 * tries);
    });
  }

  function renderTimeline() {
    // One grid, in the order the photos were taken (or the reverse).
    shown = order === 'newest' ? photos.slice().reverse() : photos.slice();
    const grid = $('#timeline-grid');
    grid.textContent = '';
    shown.forEach((photo, i) => {
      const img = h('img', { src: imageFor(photo, 600), alt: photo.caption || (photo.from ? `Photo by ${photo.from}` : 'Wedding photo'), loading: 'lazy', decoding: 'async' });
      retryingImage(img, photo, 600);
      grid.append(h('button', { type: 'button', class: 'tile', 'data-id': photo.id, onclick: () => openLightbox(i) }, img));
    });
    $('#timeline-count').textContent = photos.length ? plural(photos.length, 'photo') : '';
    $('#timeline-empty').hidden = photos.length > 0;
    $('.timeline__bar').hidden = photos.length < 2;
  }

  document.querySelectorAll('[data-sort]').forEach((btn) => {
    btn.addEventListener('click', () => {
      order = btn.dataset.sort;
      store.set('wedding.photoOrder', order);
      document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderTimeline();
    });
  });
  if (store.get('wedding.photoOrder') === 'newest') order = 'newest';
  document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === order)));

  /* ---------- keeping up with other guests ---------- */

  function startPolling() {
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }

  let refreshing = false;
  let lastRefresh = Date.now();
  function refresh() {
    if (refreshing || Date.now() - lastRefresh < 15000 || !$('#lightbox').hidden) return;
    refreshing = true;
    lastRefresh = Date.now();
    API.getPhotos(code).then((d) => {
      if (!d || !Array.isArray(d.photos)) return;
      const known = new Set(photos.map((p) => p.id));
      const fresh = d.photos.filter((p) => !known.has(p.id));
      data = d;
      // Show new photos right away unless the guest is partway down the page, where the
      // page jumping around would be annoying. Then offer a button instead.
      if (!fresh.length || !photos.length || window.scrollY < 300) {
        photos = d.photos.slice();
        waiting = null;
        $('#new-photos').hidden = true;
        render();
      } else {
        waiting = { photos: d.photos.slice(), fresh };
        const btn = $('#new-photos');
        btn.textContent = `${plural(fresh.length, 'new photo')} · tap to see`;
        btn.hidden = false;
      }
    }).catch(() => { /* try again next time */ }).finally(() => { refreshing = false; });
  }

  $('#new-photos').addEventListener('click', () => {
    if (!waiting) return;
    const first = waiting.fresh.slice().sort(byTime)[order === 'newest' ? waiting.fresh.length - 1 : 0];
    photos = waiting.photos;
    waiting = null;
    $('#new-photos').hidden = true;
    render();
    const tile = first && document.querySelector(`.tile[data-id="${CSS.escape(first.id)}"]`);
    if (tile) tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  /* ---------- choosing photos ---------- */

  let picked = [];
  const sheet = $('#share-sheet');

  // Phones and tablets get a "Take a photo" button that opens the camera straight away
  // (the `capture` attribute). Computers just get the file chooser, which is all `capture`
  // would give them anyway.
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (touch) {
    $('#camera-button').hidden = false;
    $('#choose-button').classList.add('btn--ghost');
    $('#choose-label').textContent = 'Choose photos';
    $('#photos-hint').textContent = 'No app needed. Take one now, or pick some from your camera roll.';
  }

  $('#camera-input').addEventListener('change', onPicked);
  $('#photo-input').addEventListener('change', onPicked);

  function onPicked(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const images = files.filter((f) => !f.type || f.type.startsWith('image/'));
    const skipped = files.length - images.length;
    if (!images.length) {
      if (skipped) alert('Only photos can be shared here (not videos).');
      return;
    }
    picked = images.slice(0, MAX_PER_PICK);
    let note = '';
    if (skipped) note = `${plural(skipped, 'video')} left out: only photos can be shared here.`;
    if (images.length > MAX_PER_PICK) note = `You can share up to ${MAX_PER_PICK} at a time, so we'll start with the first ${MAX_PER_PICK}.`;
    openSheet(note);
  }

  function openSheet(note) {
    $('#share-title').textContent = `Share ${plural(picked.length, 'photo')}`;
    const previews = $('#share-previews');
    previews.textContent = '';
    picked.slice(0, 12).forEach((f) => {
      const url = URL.createObjectURL(f);
      const img = h('img', { src: url, alt: '' });
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      img.addEventListener('error', () => { URL.revokeObjectURL(url); img.replaceWith(h('span', { class: 'share-sheet__blank' })); }, { once: true });
      previews.append(img);
    });
    if (picked.length > 12) previews.append(h('span', { class: 'share-sheet__more', text: `+${picked.length - 12}` }));
    const old = sheet.querySelector('.share-sheet__note');
    if (old) old.remove();
    if (note) previews.after(h('p', { class: 'share-sheet__note', text: note }));
    $('#share-from').value = store.get('wedding.photoFrom');
    $('#share-caption').value = '';
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    $('#share-submit').focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  $('#share-cancel').addEventListener('click', () => { picked = []; closeSheet(); });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) { picked = []; closeSheet(); } });

  $('#share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = $('#share-from').value.trim().slice(0, 60);
    const caption = $('#share-caption').value.trim().slice(0, 200);
    store.set('wedding.photoFrom', from);
    picked.forEach((file) => addUpload(file, from, caption));
    picked = [];
    closeSheet();
    pump();
    $('#upload-queue').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  /* ---------- uploading ---------- */

  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function addUpload(file, from, caption) {
    const item = { file, from, caption, id: newId(), state: 'waiting', message: '' };
    const thumb = h('span', { class: 'upload__thumb' });
    const status = h('span', { class: 'upload__status' });
    const retry = h('button', { type: 'button', class: 'upload__retry', hidden: true, text: 'Try again', onclick: () => { item.state = 'waiting'; update(item); pump(); } });
    item.el = h('li', { class: 'upload' }, thumb, h('span', { class: 'upload__body' }, status, h('span', { class: 'upload__bar' })), retry);
    item.parts = { thumb, status, retry };
    const url = URL.createObjectURL(file);
    const img = h('img', { src: url, alt: '' });
    img.addEventListener('error', () => img.remove(), { once: true });
    thumb.append(img);
    uploads.push(item);
    $('#upload-list').append(item.el);
    $('#upload-queue').hidden = false;
    update(item);
  }

  const LABELS = { waiting: 'Waiting…', preparing: 'Getting it ready…', uploading: 'Sharing…', done: 'Shared', failed: '' };

  function update(item) {
    item.el.dataset.state = item.state;
    item.parts.status.textContent = item.state === 'failed' ? item.message : LABELS[item.state];
    item.parts.retry.hidden = !(item.state === 'failed' && item.canRetry);
    const total = uploads.length;
    const done = uploads.filter((u) => u.state === 'done').length;
    const failed = uploads.filter((u) => u.state === 'failed').length;
    const busy = total - done - failed;
    const line = $('#upload-status');
    if (busy) line.textContent = `Sharing ${done + 1 > total ? total : done + 1} of ${total}… Please keep this page open until it's done.`;
    else if (failed) line.textContent = `${plural(done, 'photo')} shared. ${plural(failed, 'photo')} didn't make it. Tap "Try again", or try again later if the signal is weak.`;
    else line.textContent = `${total === 1 ? 'Your photo is' : `All ${total} photos are`} shared. Thank you!`;
    if (!busy && !failed) {
      clearTimeout(update.hideTimer);
      update.hideTimer = setTimeout(() => {
        if (uploads.some((u) => u.state !== 'done')) return;
        uploads.length = 0;
        $('#upload-list').textContent = '';
        $('#upload-queue').hidden = true;
      }, 6000);
    }
  }

  function pump() {
    while (running < CONCURRENT_UPLOADS) {
      const next = uploads.find((u) => u.state === 'waiting');
      if (!next) return;
      running++;
      send(next).finally(() => { running--; pump(); });
    }
  }

  const NO_RETRY = new Set(['closed', 'bad_photo', 'too_large', 'not_found', 'bad_request', 'not_ready']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function send(item) {
    item.state = 'preparing';
    update(item);
    let prepared;
    try {
      prepared = item.prepared || await T.preparePhoto(item.file);
      item.prepared = prepared;
    } catch (err) {
      return fail(item, "This photo couldn't be opened on this phone. Try a different one.", false);
    }
    item.state = 'uploading';
    update(item);
    let base64;
    try { base64 = await T.blobToBase64(prepared.blob); } catch (err) { return fail(item, "This photo couldn't be read.", true); }
    const payload = {
      code, data: base64, from: item.from, caption: item.caption, table,
      takenAt: prepared.takenAt ? prepared.takenAt.toISOString() : '',
      width: prepared.width, height: prepared.height, uploadId: item.id,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await API.uploadPhoto(payload);
        item.state = 'done';
        update(item);
        if (res && res.photo && res.photo.id) addToTimeline(res.photo, prepared.previewUrl);
        item.prepared = null; // let the phone free the memory
        return;
      } catch (err) {
        if (err && NO_RETRY.has(err.code)) return fail(item, err.message || 'This photo could not be shared.', false);
        if (attempt < 2) await sleep(3000 * (attempt + 1));
        else return fail(item, 'The connection dropped.', true);
      }
    }
  }

  function fail(item, message, canRetry) {
    item.state = 'failed';
    item.message = message;
    item.canRetry = canRetry;
    update(item);
  }

  function addToTimeline(photo, previewUrl) {
    if (previewUrl) local.set(photo.id, previewUrl);
    if (!photos.some((p) => p.id === photo.id)) {
      photos.push(photo);
      photos.sort(byTime);
    }
    if (waiting && !waiting.photos.some((p) => p.id === photo.id)) waiting.photos.push(photo);
    renderTimeline();
  }

  window.addEventListener('beforeunload', (e) => {
    if (uploads.some((u) => u.state === 'waiting' || u.state === 'preparing' || u.state === 'uploading')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------- full-screen photo ---------- */

  const lightbox = $('#lightbox');
  const lightboxImg = $('#lightbox-img');
  let current = 0;

  function showPhoto(i) {
    if (!shown.length) return;
    current = (i + shown.length) % shown.length;
    const p = shown[current];
    // Show the small version (already loaded) at once, then swap in the full-size one.
    const small = imageFor(p, 600);
    const big = imageFor(p, 2000);
    lightboxImg.src = small;
    if (big !== small) {
      const full = new Image();
      full.onload = () => { if (shown[current] === p) lightboxImg.src = big; };
      full.src = big;
    }
    lightboxImg.alt = p.caption || (p.from ? `Photo by ${p.from}` : 'Wedding photo');
    const meta = [p.from ? `Photo by ${p.from}` : '', p.table ? `Table ${p.table}` : '', T.takenTime(p)].filter(Boolean).join(' · ');
    const caption = $('#lightbox-caption');
    caption.textContent = '';
    if (p.caption) caption.append(h('span', { class: 'photo-lightbox__note', text: p.caption }));
    if (meta) caption.append(h('span', { class: 'photo-lightbox__meta', text: meta }));
  }
  function openLightbox(i) {
    showPhoto(i);
    lightbox.hidden = false;
    document.body.classList.add('no-scroll');
    lightbox.querySelector('[data-action="close"]').focus();
  }
  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute('src');
    document.body.classList.remove('no-scroll');
    const tile = shown[current] && document.querySelector(`.tile[data-id="${CSS.escape(shown[current].id)}"]`);
    if (tile) tile.focus({ preventScroll: true });
  }
  lightbox.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'close' || e.target === lightbox) closeLightbox();
    else if (action === 'prev') showPhoto(current - 1);
    else if (action === 'next') showPhoto(current + 1);
  });
  document.addEventListener('keydown', (e) => {
    if (!sheet.hidden && e.key === 'Escape') { picked = []; closeSheet(); return; }
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') showPhoto(current - 1);
    else if (e.key === 'ArrowRight') showPhoto(current + 1);
  });
  let touchX = null;
  lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) showPhoto(current + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  load();
})();
