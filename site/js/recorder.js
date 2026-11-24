// The video camera on the photo page (photos/index.html): records right in the browser, so
// every guest's clip is the same size and length no matter what phone they have. The live
// picture shows the filter they picked, but the recording itself is always the original,
// unfiltered camera; only the filter's name is saved with it (see PhotoTools.FILTERS).
//
// VideoRecorder.open({ maxSeconds, filter, onDone }) shows the camera. When the guest taps
// "Use this video", onDone gets { blob, mime, seconds, width, height, filter, poster, takenAt }.
window.VideoRecorder = (function () {
  'use strict';

  const T = window.PhotoTools;
  const $ = (sel) => document.querySelector(sel);

  // MP4 first: it plays everywhere (iPhones and video editors included). Chrome on Android
  // and computers falls back to WebM where it can't record MP4.
  const TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  const VIDEO_BITS = 2500000; // about 10 MB for 30 seconds at 720p
  const MIN_SECONDS = 1;

  function recordingType() {
    if (!window.MediaRecorder) return null;
    for (const t of TYPES) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (err) { /* keep looking */ }
    }
    return '';
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && recordingType() !== null);
  }

  let opts = null;
  let stream = null;
  let recorder = null;
  let pieces = [];
  let startedAt = 0;
  let takenAt = null;
  let tick = null;
  let facing = 'environment';
  let filter = '';
  let result = null; // the recording being reviewed
  let chips = null;
  let busy = false;

  const el = {};
  function grab() {
    if (el.root) return;
    Object.assign(el, {
      root: $('#recorder'), live: $('#rec-live'), replay: $('#rec-replay'), message: $('#rec-message'),
      timer: $('#rec-timer'), flip: $('#rec-flip'), close: $('#rec-close'), shutter: $('#rec-shutter'),
      controls: $('#rec-controls'), review: $('#rec-review'), retake: $('#rec-retake'), use: $('#rec-use'),
      filters: $('#rec-filters'), ring: $('#rec-ring'),
    });
    el.close.addEventListener('click', close);
    el.flip.addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); });
    el.shutter.addEventListener('click', () => (recorder && recorder.state === 'recording' ? stop() : start()));
    el.retake.addEventListener('click', retake);
    el.use.addEventListener('click', use);
    document.addEventListener('keydown', (e) => { if (!el.root.hidden && e.key === 'Escape') close(); });
    // Leaving the page mid-recording (a call, switching apps) ends the clip there.
    document.addEventListener('visibilitychange', () => { if (document.hidden && recorder && recorder.state === 'recording') stop(); });
  }

  function say(text) {
    el.message.textContent = text || '';
    el.message.hidden = !text;
  }

  function setFilter(name) {
    filter = name || '';
    el.live.style.filter = T.filterCss(filter);
    el.replay.style.filter = T.filterCss(filter);
  }

  function open(options) {
    grab();
    opts = options || {};
    result = null;
    setFilter(opts.filter || '');
    chips = T.filterChips(el.filters, filter, setFilter);
    showLive();
    el.root.hidden = false;
    document.body.classList.add('no-scroll');
    startCamera();
  }

  async function startCamera() {
    stopCamera();
    say('Opening the camera…');
    el.shutter.disabled = true;
    const video = { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); // no microphone
      }
    } catch (err) {
      const blocked = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      say(blocked
        ? 'The camera is blocked for this page. Allow camera and microphone access for this site in your browser settings, then try again.'
        : "We couldn't open a camera on this device.");
      return;
    }
    if (el.root.hidden) { stopCamera(); return; } // closed while waiting for permission
    el.live.srcObject = stream;
    el.live.classList.toggle('is-mirrored', facing === 'user');
    el.live.play().catch(() => {});
    el.flip.hidden = false;
    el.shutter.disabled = false;
    say('');
    showTime(0);
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (el.live) el.live.srcObject = null;
  }

  function showTime(sec) {
    const max = opts.maxSeconds || 30;
    el.timer.textContent = `${T.formatSeconds(sec)} / ${T.formatSeconds(max)}`;
    el.ring.style.setProperty('--done', String(Math.min(1, sec / max)));
  }

  function start() {
    if (!stream || busy) return;
    const type = recordingType();
    pieces = [];
    try {
      recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: VIDEO_BITS, audioBitsPerSecond: 128000 });
    } catch (err) {
      recorder = new MediaRecorder(stream);
    }
    recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) pieces.push(e.data); });
    recorder.addEventListener('stop', finished, { once: true });
    recorder.start(1000);
    startedAt = performance.now();
    takenAt = new Date();
    el.root.classList.add('is-recording');
    el.shutter.setAttribute('aria-label', 'Stop recording');
    el.flip.disabled = true;
    const max = opts.maxSeconds || 30;
    tick = setInterval(() => {
      const sec = (performance.now() - startedAt) / 1000;
      showTime(sec);
      if (sec >= max) stop();
    }, 200);
  }

  function stop() {
    clearInterval(tick);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function finished() {
    const seconds = Math.min(opts.maxSeconds || 30, Math.round((performance.now() - startedAt) / 100) / 10);
    el.root.classList.remove('is-recording');
    el.shutter.setAttribute('aria-label', 'Start recording');
    el.flip.disabled = false;
    const type = (recorder && recorder.mimeType) || recordingType() || 'video/webm';
    recorder = null;
    const blob = new Blob(pieces, { type: type.split(';')[0] });
    pieces = [];
    if (seconds < MIN_SECONDS || !blob.size) {
      say('That was too quick. Tap the button to start, and again to stop.');
      setTimeout(() => say(''), 2500);
      showTime(0);
      return;
    }
    busy = true;
    say('Getting it ready…');
    const still = await T.videoStill(blob);
    busy = false;
    say('');
    result = { blob, mime: blob.type, seconds, width: still.width, height: still.height, poster: still.poster, takenAt };
    // Review it with the camera paused (saves battery while they decide).
    stopCamera();
    el.replay.src = URL.createObjectURL(blob);
    el.replay.muted = false;
    el.replay.play().catch(() => { el.replay.muted = true; el.replay.play().catch(() => {}); });
    el.live.hidden = true;
    el.replay.hidden = false;
    el.controls.hidden = true;
    el.review.hidden = false;
    el.flip.hidden = true;
    el.timer.textContent = T.formatSeconds(seconds);
  }

  function showLive() {
    if (el.replay.src) { URL.revokeObjectURL(el.replay.src); el.replay.removeAttribute('src'); el.replay.load(); }
    el.live.hidden = false;
    el.replay.hidden = true;
    el.controls.hidden = false;
    el.review.hidden = true;
    el.root.classList.remove('is-recording');
    say('');
  }

  function retake() {
    result = null;
    showLive();
    startCamera();
  }

  function use() {
    if (!result) return;
    const out = { ...result, filter };
    result = null;
    hide();
    if (opts.onDone) opts.onDone(out);
  }

  function close() {
    if (recorder && recorder.state === 'recording') {
      if (!confirm('Stop recording and throw this video away?')) return;
      recorder.removeEventListener('stop', finished);
      stop();
    }
    if (result && !confirm('Throw this video away?')) return;
    result = null;
    hide();
  }

  function hide() {
    clearInterval(tick);
    stopCamera();
    showLive();
    el.root.hidden = true;
    document.body.classList.remove('no-scroll');
    if (opts && opts.onClose) opts.onClose();
  }

  return { open, supported, recordingType };
})();
