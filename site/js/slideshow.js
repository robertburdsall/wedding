// Live slideshow for a TV or projector at the reception (photos/slideshow.html?t=PHOTOCODE).
// Shows every shared photo in a shuffled loop, and jumps to new photos as soon as they come in.
(function () {
  'use strict';

  const T = window.PhotoTools;
  const API = window.WeddingAPI;
  const $ = (sel) => document.querySelector(sel);

  const SLIDE_MS = 8000;
  const POLL_MS = 20000;
  const code = T.photoCodeFromPage();

  let all = [];
  let deck = [];       // shuffled photos still to show this round
  let fresh = [];      // photos that arrived since the slideshow started: shown next
  const seen = new Set();
  let started = false;
  let timer = null;
  let lastId = null;
  const slides = [$('#slide-a'), $('#slide-b')];
  let front = 0;

  function showError(text) {
    const el = $('#error');
    el.textContent = text;
    el.hidden = false;
  }

  if (!code) {
    showError('Open the "Photo Slideshow Link" from the Settings tab of the guest list sheet.');
    return;
  }

  const qrFor = (el) => {
    el.textContent = '';
    el.append(T.qrSvg(T.photoPageUrl(code), { label: 'QR code to share your photos' }));
  };
  qrFor($('#qr-code'));
  qrFor($('#qr-big'));

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  async function poll() {
    try {
      const d = await API.getPhotos(code);
      const ids = new Set(d.photos.map((p) => p.id));
      for (const p of d.photos) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        if (started) fresh.push(p);
      }
      all = d.photos;
      // Photos ticked "Hidden" on the sheet disappear from the loop too.
      fresh = fresh.filter((p) => ids.has(p.id));
      deck = deck.filter((p) => ids.has(p.id));
      started = true;
      $('#error').hidden = true;
      $('#empty').hidden = all.length > 0;
      $('#qr').hidden = all.length === 0;
      if (!all.length) { slides.forEach((s) => s.classList.remove('is-on')); $('#caption').style.opacity = 0; }
      if (all.length && !timer) next();
    } catch (err) {
      if (!started) showError(err && err.message ? err.message : "Couldn't load the photos. Check the internet connection.");
    }
  }

  function pick() {
    if (fresh.length) return fresh.shift();
    if (!deck.length) {
      deck = shuffle(all.slice());
      if (deck.length > 1 && deck[0].id === lastId) deck.push(deck.shift());
    }
    return deck.shift();
  }

  function preload(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const t = setTimeout(() => resolve(false), 15000);
      img.onload = () => { clearTimeout(t); resolve(true); };
      img.onerror = () => { clearTimeout(t); resolve(false); };
      img.src = url;
    });
  }

  async function next() {
    clearTimeout(timer);
    timer = 'loading';
    const p = pick();
    if (!p) { timer = null; return; }
    const url = T.photoUrl(p.id, 2048);
    if (!(await preload(url))) { timer = setTimeout(next, 2000); return; }
    const back = slides[1 - front];
    back.querySelector('img').src = url;
    back.querySelector('.slide__bg').style.backgroundImage = `url("${url}")`;
    back.classList.add('is-on');
    slides[front].classList.remove('is-on');
    front = 1 - front;
    lastId = p.id;
    $('#caption-note').textContent = p.caption || '';
    $('#caption-meta').textContent = [p.from ? `Photo by ${p.from}` : '', T.takenTime(p)].filter(Boolean).join(' · ');
    $('#caption').style.opacity = p.caption || p.from ? 1 : 0;
    timer = setTimeout(next, SLIDE_MS);
  }

  // Click for full screen; hide the mouse pointer when it isn't moving.
  document.addEventListener('click', () => {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  });
  let idle;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  document.addEventListener('mousemove', wake);
  wake();

  // Keep the screen from going to sleep.
  async function keepAwake() {
    try { if (navigator.wakeLock && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch (err) { /* not supported */ }
  }
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  poll();
  setInterval(poll, POLL_MS);
})();
