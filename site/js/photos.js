// The reception camera and, once it's published, the photo album. Guests open their emailed
// camera link (or scan the QR code on their table), add photos from their phone and record
// short videos right on the page (js/recorder.js), with an optional filter. Everything is saved
// to Google Drive through the Apps Script (apps-script/Code.gs) and listed on the "Photos" tab
// of the Sheet; filters are saved by name, and the files stay the unfiltered originals.
// Until the couple publishes the album, each guest only sees their own photos and videos.
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
  const localVideo = new Map(); // video id → the recording itself, for videos shared from this phone

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

  function uuid() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  // Whose camera this is: a guest's personal link (?me=… from their email), remembered on this
  // phone so the table QR code opens the same camera. Otherwise each phone counts on its own.
  const me = (() => {
    const fromLink = (params.get('me') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
    if (fromLink) store.set('wedding.photoMe', fromLink);
    return fromLink || store.get('wedding.photoMe');
  })();
  let device = store.get('wedding.photoDevice');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) {
    device = uuid();
    store.set('wedding.photoDevice', device);
  }
  const who = { me, device };
  if (params.get('me')) {
    // Keep the personal part out of the address bar (and out of screenshots people share).
    const clean = new URLSearchParams(location.search);
    clean.delete('me');
    history.replaceState(null, '', `?${clean}`);
  }

  /* ---------- loading ---------- */

  function load() {
    if (!code) { showError({ code: 'no_code' }); return; }
    setState('loading');
    API.getPhotos(code, who).then((d) => {
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

  function firstName(name) {
    return /^(mr|mrs|ms|miss|mx|dr)\.?\s/i.test(name) ? name : name.split(' ')[0];
  }

  function render() {
    if (table) $('#photos-eyebrow').textContent = `Table ${table}`;
    const up = data.uploads || {};
    const album = data.album || {};
    const you = data.you || {};
    $('#add-area').hidden = up.open === false;
    const closed = $('#photos-closed');
    closed.hidden = up.open !== false || album.published;
    const download = $('#album-download');
    download.hidden = !(album.published && album.url);
    const highlight = $('#album-highlight');
    highlight.hidden = !(album.published && album.highlight);
    if (album.highlight) highlight.href = album.highlight;
    if (album.published) {
      // The finished album: no more uploads, and a link to download everything.
      $('#photos-eyebrow').textContent = 'Stephanie & Robert';
      $('#photos-title').textContent = 'Our wedding album';
      $('#photos-intro').textContent = 'Thank you for capturing the celebration with us!';
      if (album.url) download.href = album.url;
    } else if (up.open === false) {
      $('#photos-intro').textContent = "We'll send everyone the album once we've looked through all the photos.";
      closed.textContent = `Photo sharing closed${up.untilText ? ` on ${up.untilText}` : ''}. Thank you for all the photos!`;
    } else if (you.name) {
      $('#photos-intro').textContent = `Hi ${firstName(you.name)}! This is your camera for the reception. Snap photos and record videos! They come straight to us, and we'll send everyone the album after the wedding.`;
    }
    $('#timeline-note').hidden = !!album.published || !photos.length;
    renderAllowance();
    renderTimeline();
  }

  // Photos and videos this camera still has, minus any waiting to upload.
  const queuedOf = (kind) => uploads.filter((u) => u.kind === kind && u.state !== 'done' && u.state !== 'failed').length;
  function photosLeft() {
    const you = data.you || {};
    if (!you.limit) return Infinity;
    return Math.max(0, you.left - queuedOf('photo'));
  }
  function videoInfo() { return (data.you && data.you.videos) || {}; }
  function videosLeft() {
    const v = videoInfo();
    if (v.limit === 0) return 0;
    if (!v.limit) return Infinity;
    return Math.max(0, v.left - queuedOf('video'));
  }
  const canRecord = !!(window.VideoRecorder && window.VideoRecorder.supported());

  function renderAllowance() {
    const you = data.you || {};
    const v = videoInfo();
    const el = $('#photos-left');
    const open = !(data.uploads && data.uploads.open === false);
    const pLeft = photosLeft();
    const vLeft = canRecord ? videosLeft() : 0;
    $('#camera-button').hidden = !touch || pLeft <= 0;
    $('#choose-button').hidden = pLeft <= 0;
    $('#video-button').hidden = vLeft <= 0;
    const nothingLeft = pLeft <= 0 && vLeft <= 0;
    $('.photos-actions').hidden = nothingLeft;
    $('#photos-hint').hidden = nothingLeft;
    const parts = [];
    if (you.limit) parts.push(`${Math.min(pLeft, you.limit)} of ${plural(you.limit, 'photo')}`);
    if (canRecord && v.limit) parts.push(`${Math.min(vLeft, v.limit)} of ${plural(v.limit, 'video')}`);
    el.hidden = !open || !parts.length;
    if (el.hidden) return;
    el.textContent = nothingLeft ? "That's everything for your camera. Thank you for sharing!" : `${parts.join(' and ')} left`;
  }

  function byTime(a, b) {
    const x = a.takenAt || a.uploadedAt, y = b.takenAt || b.uploadedAt;
    if (x !== y) return x < y ? -1 : 1;
    return (a.uploadedAt || '') < (b.uploadedAt || '') ? -1 : 1;
  }

  const isVideo = (p) => p.kind === 'video';
  // Videos show their still (or Drive's own thumbnail of the video if there isn't one).
  const stillId = (p) => (isVideo(p) ? p.poster || p.id : p.id);
  function imageFor(photo, size) {
    return local.get(photo.id) || T.photoUrl(stillId(photo), size);
  }

  // Google Drive sometimes needs a few seconds to make the small version of a new photo.
  function retryingImage(img, photo, size) {
    let tries = 0;
    img.addEventListener('error', () => {
      if (tries >= 3) { img.closest('.tile') && img.closest('.tile').classList.add('tile--broken'); return; }
      tries++;
      setTimeout(() => { img.src = `${T.photoUrl(stillId(photo), size)}&retry=${tries}`; }, 2500 * tries);
    });
  }

  function renderTimeline() {
    // One grid, in the order the photos were taken (or the reverse).
    shown = order === 'newest' ? photos.slice().reverse() : photos.slice();
    const grid = $('#timeline-grid');
    grid.textContent = '';
    shown.forEach((photo, i) => {
      const what = isVideo(photo) ? 'Video' : 'Photo';
      const img = h('img', { src: imageFor(photo, 600), alt: photo.caption || (photo.from ? `${what} by ${photo.from}` : `Wedding ${what.toLowerCase()}`), loading: 'lazy', decoding: 'async' });
      img.style.filter = T.filterCss(photo.filter);
      retryingImage(img, photo, 600);
      const badge = isVideo(photo) ? h('span', { class: 'tile__badge', 'aria-hidden': 'true' },
        h('span', { class: 'tile__play' }), photo.seconds ? T.formatSeconds(photo.seconds) : '') : null;
      grid.append(h('button', { type: 'button', class: `tile${isVideo(photo) ? ' tile--video' : ''}`, 'data-id': photo.id, onclick: () => openLightbox(i) }, img, badge));
    });
    const published = !!(data && data.album && data.album.published);
    const nVideos = photos.filter(isVideo).length;
    const counted = nVideos && nVideos < photos.length
      ? `${plural(photos.length - nVideos, 'photo')} and ${plural(nVideos, 'video')}`
      : plural(photos.length, nVideos ? 'video' : 'photo');
    $('#timeline-count').textContent = photos.length ? (published ? counted : `${counted} from you`) : '';
    $('#timeline-empty').textContent = published ? 'There are no photos in the album yet.' : "The photos and videos you share will show up here. Only you can see them.";
    $('#timeline-empty').hidden = photos.length > 0;
    $('#timeline-note').hidden = published || !photos.length;
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
    API.getPhotos(code, who).then((d) => {
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
  let pickedVideo = null; // a recording waiting for its name and note
  let sheetFilter = '';
  const sheet = $('#share-sheet');

  // Phones and tablets get a "Take a photo" button that opens the camera straight away
  // (the `capture` attribute). Computers just get the file chooser, which is all `capture`
  // would give them anyway.
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (touch) {
    $('#camera-button').hidden = false;
    $('#choose-button').classList.add('btn--ghost');
    $('#choose-label').textContent = 'Choose photos';
    $('#photos-hint').textContent = canRecord
      ? 'No app needed. Take photos or short videos, or pick photos from your camera roll.'
      : 'No app needed. Take one now, or pick some from your camera roll.';
  }

  $('#video-button').addEventListener('click', () => {
    if (videosLeft() <= 0) { renderAllowance(); return; }
    window.VideoRecorder.open({
      maxSeconds: videoInfo().seconds || 30,
      filter: store.get('wedding.photoFilter'),
      onDone: (clip) => { picked = []; pickedVideo = clip; openSheet(''); },
    });
  });

  $('#camera-input').addEventListener('change', onPicked);
  $('#photo-input').addEventListener('change', onPicked);

  function onPicked(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const images = files.filter((f) => !f.type || f.type.startsWith('image/'));
    const skipped = files.length - images.length;
    if (!images.length) {
      if (skipped) alert(canRecord ? 'Videos from your camera roll can\'t be shared here. Tap "Record a video" to record one on this page instead.' : 'Only photos can be shared here.');
      return;
    }
    const left = photosLeft();
    if (left <= 0) { renderAllowance(); return; }
    const most = Math.min(MAX_PER_PICK, left);
    picked = images.slice(0, most);
    pickedVideo = null;
    let note = '';
    if (skipped) note = `${plural(skipped, 'video')} left out: tap "Record a video" to record one here instead.`;
    if (images.length > most) {
      note = most === left
        ? `You have ${plural(left, 'photo')} left, so we'll share the first ${left}.`
        : `You can share up to ${MAX_PER_PICK} at a time, so we'll start with the first ${MAX_PER_PICK}.`;
    }
    openSheet(note);
  }

  function openSheet(note) {
    $('#share-title').textContent = pickedVideo ? 'Share your video' : `Share ${plural(picked.length, 'photo')}`;
    const previews = $('#share-previews');
    previews.textContent = '';
    previews.classList.toggle('share-sheet__previews--video', !!pickedVideo);
    if (pickedVideo) {
      const url = URL.createObjectURL(pickedVideo.blob);
      const v = h('video', { src: url, playsinline: true, muted: true, loop: true, autoplay: true, class: 'share-sheet__video' });
      v.muted = true;
      v.play().catch(() => {});
      previews.append(v);
    }
    picked.slice(0, 12).forEach((f) => {
      const url = URL.createObjectURL(f);
      const img = h('img', { src: url, alt: '' });
      img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      img.addEventListener('error', () => { URL.revokeObjectURL(url); img.replaceWith(h('span', { class: 'share-sheet__blank' })); }, { once: true });
      previews.append(img);
    });
    if (picked.length > 12) previews.append(h('span', { class: 'share-sheet__more', text: `+${picked.length - 12}` }));
    sheetFilter = pickedVideo ? pickedVideo.filter : store.get('wedding.photoFilter');
    const showFilter = () => previews.querySelectorAll('img, video').forEach((m) => { m.style.filter = T.filterCss(sheetFilter); });
    T.filterChips($('#share-filters'), sheetFilter, (f) => { sheetFilter = f; showFilter(); });
    showFilter();
    const old = sheet.querySelector('.share-sheet__note');
    if (old) old.remove();
    if (note) previews.after(h('p', { class: 'share-sheet__note', text: note }));
    $('#share-from').value = store.get('wedding.photoFrom') || (data.you && data.you.name) || '';
    $('#share-caption').value = '';
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    $('#share-submit').focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    document.body.classList.remove('no-scroll');
    const v = $('#share-previews video');
    if (v) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
  }

  function cancelSheet() {
    if (pickedVideo && !confirm('Throw this video away?')) return;
    picked = [];
    pickedVideo = null;
    closeSheet();
  }
  $('#share-cancel').addEventListener('click', cancelSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) cancelSheet(); });

  $('#share-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = $('#share-from').value.trim().slice(0, 60);
    const caption = $('#share-caption').value.trim().slice(0, 200);
    store.set('wedding.photoFrom', from);
    store.set('wedding.photoFilter', sheetFilter);
    if (pickedVideo) addUpload({ kind: 'video', video: pickedVideo }, from, caption, sheetFilter);
    picked.forEach((file) => addUpload({ kind: 'photo', file }, from, caption, sheetFilter));
    picked = [];
    pickedVideo = null;
    closeSheet();
    renderAllowance();
    pump();
    $('#upload-queue').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  /* ---------- uploading ---------- */

  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // `what` is { kind: 'photo', file } or { kind: 'video', video } (from the recorder).
  function addUpload(what, from, caption, filter) {
    const item = { ...what, from, caption, filter: filter || '', id: newId(), state: 'waiting', message: '', progress: 0 };
    const thumb = h('span', { class: 'upload__thumb' });
    const status = h('span', { class: 'upload__status' });
    const bar = h('span', { class: 'upload__bar' });
    const retry = h('button', { type: 'button', class: 'upload__retry', hidden: true, text: 'Try again', onclick: () => { item.state = 'waiting'; update(item); pump(); } });
    item.el = h('li', { class: 'upload', 'data-kind': item.kind }, thumb, h('span', { class: 'upload__body' }, status, bar), retry);
    item.parts = { thumb, status, retry, bar };
    const source = item.kind === 'video' ? item.video.poster : item.file;
    if (source) {
      const url = URL.createObjectURL(source);
      const img = h('img', { src: url, alt: '' });
      img.style.filter = T.filterCss(item.filter);
      img.addEventListener('error', () => img.remove(), { once: true });
      thumb.append(img);
    }
    uploads.push(item);
    $('#upload-list').append(item.el);
    $('#upload-queue').hidden = false;
    update(item);
  }

  const LABELS = { waiting: 'Waiting…', preparing: 'Getting it ready…', uploading: 'Sharing…', done: 'Shared', failed: '' };

  function update(item) {
    item.el.dataset.state = item.state;
    let label = item.state === 'failed' ? item.message : LABELS[item.state];
    if (item.kind === 'video' && item.state === 'uploading') label = `Sharing your video… ${Math.round(item.progress * 100)}%`;
    item.parts.status.textContent = label;
    item.parts.bar.style.setProperty('--progress', String(item.progress || 0));
    item.parts.retry.hidden = !(item.state === 'failed' && item.canRetry);
    const total = uploads.length;
    const done = uploads.filter((u) => u.state === 'done').length;
    const failed = uploads.filter((u) => u.state === 'failed').length;
    const busy = total - done - failed;
    const line = $('#upload-status');
    const one = total === 1 ? (uploads[0].kind === 'video' ? 'Your video is' : 'Your photo is') : `All ${total} are`;
    if (busy) line.textContent = `Sharing ${done + 1 > total ? total : done + 1} of ${total}… Please keep this page open until it's done.`;
    else if (failed) line.textContent = `${done} shared. ${failed} didn't make it. Tap "Try again", or try again later if the signal is weak.`;
    else line.textContent = `${one} shared. Thank you!`;
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

  const NO_RETRY = new Set(['closed', 'bad_photo', 'bad_video', 'too_large', 'too_long', 'no_videos', 'not_found', 'bad_request', 'not_ready', 'limit_reached', 'rate_limited']);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function send(item) {
    if (item.kind === 'video') return sendVideo(item);
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
      width: prepared.width, height: prepared.height, uploadId: item.id, me, device, filter: item.filter,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await API.uploadPhoto(payload);
        item.state = 'done';
        if (res && res.you) data.you = res.you;
        update(item);
        renderAllowance();
        if (res && res.photo && res.photo.id) addToTimeline(res.photo, prepared.previewUrl);
        item.prepared = null; // let the phone free the memory
        return;
      } catch (err) {
        if (err && err.code === 'limit_reached' && data.you) data.you.left = 0;
        if (err && NO_RETRY.has(err.code)) return fail(item, err.message || 'This photo could not be shared.', false);
        if (attempt < 2) await sleep(3000 * (attempt + 1));
        else return fail(item, 'The connection dropped.', true);
      }
    }
  }

  // Videos go up in 2 MB pieces (start, pieces, finish), so a weak signal only has to resend
  // the piece that dropped, not the whole video.
  async function sendVideo(item) {
    const v = item.video;
    item.state = 'uploading';
    update(item);
    let poster = '';
    try { poster = v.poster ? await T.blobToBase64(v.poster) : ''; } catch (err) { /* no still is fine */ }
    const base = { code, uploadId: item.id };
    const meta = {
      ...base, mime: v.mime, size: v.blob.size, seconds: v.seconds, width: v.width, height: v.height, filter: item.filter,
      takenAt: v.takenAt ? v.takenAt.toISOString() : '', from: item.from, caption: item.caption, table, me, device,
    };
    // Retries one step a few times when the connection hiccups.
    async function step(payload) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await API.videoStep(payload);
        } catch (err) {
          const again = err && ['network', 'upload_failed', 'server_error'].includes(err.code);
          if (!again || attempt >= 3) throw err;
          await sleep(2500 * (attempt + 1));
        }
      }
    }
    for (let round = 0; round < 3; round++) {
      try {
        let r = await step({ step: 'start', ...meta });
        if (!r.complete) {
          const size = v.blob.size;
          const piece = r.chunkSize || 2 * 1024 * 1024;
          let offset = r.received || 0;
          while (offset < size) {
            const data = await T.blobToBase64(v.blob.slice(offset, offset + piece));
            r = await step({ step: 'chunk', ...base, offset, data });
            offset = r.received;
            item.progress = Math.min(0.97, offset / size);
            update(item);
          }
          r = await step({ step: 'finish', ...base, poster });
        }
        item.state = 'done';
        item.progress = 1;
        if (r.you) data.you = r.you;
        update(item);
        renderAllowance();
        if (r.photo && r.photo.id) {
          const posterUrl = v.poster ? URL.createObjectURL(v.poster) : '';
          localVideo.set(r.photo.id, URL.createObjectURL(v.blob));
          addToTimeline(r.photo, posterUrl);
        }
        item.video = { ...v, blob: null, poster: null }; // let the phone free the memory
        return;
      } catch (err) {
        if (err && err.code === 'limit_reached' && data.you && data.you.videos) data.you.videos.left = 0;
        if (err && NO_RETRY.has(err.code)) return fail(item, err.message || 'This video could not be shared.', false);
        if (err && (err.code === 'upload_expired' || err.code === 'upload_incomplete')) { item.progress = 0; continue; } // start over
        return fail(item, 'The connection dropped.', true);
      }
    }
    return fail(item, 'The connection dropped.', true);
  }

  function fail(item, message, canRetry) {
    item.state = 'failed';
    item.message = message;
    item.canRetry = canRetry;
    update(item);
    renderAllowance();
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
  const lightboxVideo = $('#lightbox-video');
  let current = 0;

  function clearVideo() {
    const v = lightboxVideo.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    lightboxVideo.textContent = '';
    lightboxVideo.hidden = true;
  }

  // Plays a video in the lightbox, with its filter. If the browser can't play Drive's file
  // directly (still processing, or a WebM on an iPhone), Google Drive's own player takes over.
  function showVideo(p) {
    clearVideo();
    lightboxImg.hidden = true;
    lightboxImg.removeAttribute('src');
    const mine = localVideo.get(p.id);
    const v = h('video', { controls: true, playsinline: true, autoplay: true, preload: 'metadata', poster: imageFor(p, 1200), class: 'lightbox__img' });
    v.style.filter = T.filterCss(p.filter);
    v.addEventListener('error', () => {
      if (mine || !/^[A-Za-z0-9_-]{10,}$/.test(p.id)) return;
      lightboxVideo.textContent = '';
      lightboxVideo.append(h('iframe', { src: `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/preview`, allow: 'autoplay; fullscreen', title: 'Video', class: 'photo-lightbox__frame' }));
    }, { once: true });
    v.src = mine || T.videoUrl(p.id);
    lightboxVideo.append(v);
    lightboxVideo.hidden = false;
  }

  function showPhoto(i) {
    if (!shown.length) return;
    current = (i + shown.length) % shown.length;
    const p = shown[current];
    const what = isVideo(p) ? 'Video' : 'Photo';
    if (isVideo(p)) {
      showVideo(p);
    } else {
      clearVideo();
      lightboxImg.hidden = false;
      lightboxImg.style.filter = T.filterCss(p.filter);
    }
    // Show the small version (already loaded) at once, then swap in the full-size one.
    if (!isVideo(p)) {
      const small = imageFor(p, 600);
      const big = imageFor(p, 2000);
      lightboxImg.src = small;
      if (big !== small) {
        const full = new Image();
        full.onload = () => { if (shown[current] === p) lightboxImg.src = big; };
        full.src = big;
      }
      lightboxImg.alt = p.caption || (p.from ? `Photo by ${p.from}` : 'Wedding photo');
    }
    const meta = [p.from ? `${what} by ${p.from}` : '', p.table ? `Table ${p.table}` : '', T.takenTime(p)].filter(Boolean).join(' · ');
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
    clearVideo();
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
    if (!sheet.hidden && e.key === 'Escape') { cancelSheet(); return; }
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
