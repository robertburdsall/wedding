// The camera on the photo page (photos/index.html): photos and videos in one place, like the
// iPhone camera. "Photo" / "Video" under the picture switches between them (or swipe), the
// last shot sits bottom left, and the switch-camera button bottom right.
//
// Filters are shown live (including the tacos and hearts from js/fun.js), but what's saved is
// always the original, unfiltered picture: only the filter's name goes with it.
//
// Camera.open({ filter, mode, left(), maxSeconds, onCapture, onClose }) shows it. onCapture gets
//   { kind: 'photo', blob, width, height, takenAt, filter } right after each photo, or
//   { kind: 'video', blob, mime, seconds, width, height, poster, takenAt, filter } once a
//   video is accepted. left() returns { photo, video }: how many of each the guest has left.
window.Camera = (function () {
  'use strict';

  const T = window.PhotoTools;
  const Fun = window.Fun;
  const $ = (sel) => document.querySelector(sel);

  // MP4 first: it plays everywhere (iPhones and video editors included). Chrome on Android
  // and computers fall back to WebM where they can't record MP4.
  const TYPES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  const VIDEO_BITS = 2500000; // about 10 MB for 30 seconds
  const MIN_SECONDS = 1;

  function recordingType() {
    if (!window.MediaRecorder) return null;
    for (const t of TYPES) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (err) { /* keep looking */ }
    }
    return '';
  }
  const canPhoto = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const canVideo = () => canPhoto() && !!window.MediaRecorder && recordingType() !== null;

  let opts = {};
  let stream = null;
  let facing = 'environment';
  let mode = 'photo';
  let filter = '';
  let recorder = null;
  let pieces = [];
  let recStart = 0;
  let takenAt = null;
  let tick = null;
  let review = null;    // a recorded video waiting for Use / Retake
  let raf = 0;
  let shots = 0;
  const el = {};

  function grab() {
    if (el.root) return;
    Object.assign(el, {
      root: $('#camera'), stage: $('#cam-stage'), live: $('#cam-live'), replay: $('#cam-replay'), fun: $('#cam-fun'),
      message: $('#cam-message'), status: $('#cam-status'), close: $('#cam-close'), flip: $('#cam-flip'),
      shutter: $('#cam-shutter'), ring: $('#cam-ring'), filters: $('#cam-filters'), modes: $('#cam-modes'),
      last: $('#cam-last'), lastImg: $('#cam-last-img'), lastCount: $('#cam-last-count'), flash: $('#cam-flash'),
      controls: $('#cam-controls'), review: $('#cam-review'), retake: $('#cam-retake'), use: $('#cam-use'),
    });
    el.close.addEventListener('click', close);
    el.last.addEventListener('click', close);
    el.flip.addEventListener('click', () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); });
    el.shutter.addEventListener('click', shutter);
    el.modes.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    el.retake.addEventListener('click', retake);
    el.use.addEventListener('click', useVideo);
    // Swipe left or right on the picture to switch between photo and video, like the iPhone.
    let x0 = null;
    el.stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    el.stage.addEventListener('touchend', (e) => {
      if (x0 === null || recorder || review) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 60) setMode(dx < 0 ? 'video' : 'photo');
    });
    document.addEventListener('keydown', (e) => { if (!el.root.hidden && e.key === 'Escape') close(); });
    // Leaving the page mid-recording (a call, switching apps) ends the clip there.
    document.addEventListener('visibilitychange', () => { if (document.hidden && recorder && recorder.state === 'recording') stopRecording(); });
  }

  function say(text) {
    el.message.textContent = text || '';
    el.message.hidden = !text;
  }

  /* ---------- opening and closing ---------- */

  function open(options) {
    grab();
    opts = options || {};
    shots = 0;
    review = null;
    el.last.hidden = true;
    el.lastCount.textContent = '';
    setFilter(opts.filter || '');
    T.filterChips(el.filters, filter, setFilter);
    el.modes.hidden = !canVideo();
    setMode(opts.mode === 'video' && canVideo() ? 'video' : 'photo');
    showLive();
    el.root.hidden = false;
    document.body.classList.add('no-scroll');
    startCamera();
    loop();
  }

  function close() {
    if (recorder && recorder.state === 'recording') {
      if (!confirm('Stop recording and throw this video away?')) return;
      recorder.removeEventListener('stop', finished);
      stopRecording();
      recorder = null;
    }
    if (review && !confirm('Throw this video away?')) return;
    review = null;
    clearInterval(tick);
    cancelAnimationFrame(raf);
    stopCamera();
    showLive();
    el.root.hidden = true;
    document.body.classList.remove('no-scroll');
    if (opts.onClose) opts.onClose(shots);
  }

  /* ---------- the camera itself ---------- */

  function size() {
    // Photos get as much detail as the camera will give; videos stay at 720p so they upload quickly.
    return mode === 'photo' ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
  }

  async function startCamera() {
    stopCamera();
    say('Opening the camera…');
    el.shutter.disabled = true;
    const video = { facingMode: { ideal: facing }, frameRate: { ideal: 30, max: 30 }, ...size() };
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: canVideo() ? { echoCancellation: true, noiseSuppression: true } : false });
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
    el.root.classList.toggle('is-front', facing === 'user');
    el.live.play().catch(() => {});
    el.shutter.disabled = false;
    say('');
    showStatus();
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (el.live) el.live.srcObject = null;
  }

  async function setMode(next) {
    if (recorder || review) return;
    if (next === 'video' && !canVideo()) next = 'photo';
    const changed = next !== mode;
    mode = next;
    el.root.dataset.mode = mode;
    el.modes.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    el.shutter.setAttribute('aria-label', mode === 'photo' ? 'Take a photo' : 'Start recording');
    showStatus();
    // Photos and videos use different sizes. Changing the size of a running camera can leave
    // recordings blank on some phones, so the camera is reopened instead (a blink).
    if (changed && stream) startCamera();
  }

  function showStatus() {
    const left = opts.left ? opts.left() : {};
    if (recorder) return;
    if (review) { el.status.textContent = T.formatSeconds(review.seconds); return; }
    const n = mode === 'photo' ? left.photo : left.video;
    const word = mode === 'photo' ? 'photo' : 'video';
    el.status.textContent = n === Infinity || n === undefined ? (mode === 'video' ? `Up to ${opts.maxSeconds || 30} seconds` : '') : `${n} ${word}${n === 1 ? '' : 's'} left`;
    el.status.hidden = !el.status.textContent;
    const none = n !== undefined && n !== Infinity && n <= 0;
    el.shutter.disabled = none || !stream;
    if (none) say(`That's all your ${word}s. Thank you!`);
    else if (el.message.textContent.startsWith("That's all")) say('');
  }

  /* ---------- filters ---------- */

  function setFilter(name) {
    filter = name || '';
    const css = T.filterCss(filter);
    el.live.style.filter = css;
    el.replay.style.filter = css;
  }

  // Where the picture actually sits on screen (it's cropped to fill, like a phone camera).
  function coverBox(media, cw, ch, contain) {
    const vw = media.videoWidth || cw, vh = media.videoHeight || ch;
    const s = contain ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
  }

  // Draws the silly filter over the live picture (or the video being reviewed) every frame.
  function loop() {
    cancelAnimationFrame(raf);
    const t0 = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const c = el.fun;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = c.clientWidth, ch = c.clientHeight;
      if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      if (!Fun || !Fun.isSilly(filter)) return;
      ctx.scale(dpr, dpr);
      if (review) {
        Fun.draw(ctx, filter, coverBox(el.replay, cw, ch, true), el.replay.currentTime);
        return;
      }
      if (!stream || !el.live.videoWidth) return;
      Fun.draw(ctx, filter, coverBox(el.live, cw, ch, false), (performance.now() - t0) / 1000);
    };
    raf = requestAnimationFrame(frame);
  }

  /* ---------- taking photos ---------- */

  function shutter() {
    if (review) return;
    if (mode === 'photo') takePhoto();
    else if (recorder && recorder.state === 'recording') stopRecording();
    else startRecording();
  }

  async function takePhoto() {
    const v = el.live;
    if (!stream || !v.videoWidth) return;
    const left = opts.left ? opts.left() : {};
    if (left.photo !== undefined && left.photo <= 0) { showStatus(); return; }
    el.flash.classList.remove('is-on');
    void el.flash.offsetWidth;
    el.flash.classList.add('is-on');
    const width = v.videoWidth, height = v.videoHeight;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    c.getContext('2d').drawImage(v, 0, 0, width, height); // the original: no filter, not mirrored
    const when = new Date();
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) { say("That photo didn't work. Please try again."); return; }
    c.width = c.height = 0;
    shots++;
    showLast(blob, filter);
    if (opts.onCapture) opts.onCapture({ kind: 'photo', blob, width, height, takenAt: when, filter });
    showStatus();
  }

  // The little picture bottom left: the last thing taken, with its filter.
  function showLast(blob, name) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = el.lastImg;
      const size = 96;
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.max(size / img.naturalWidth, size / img.naturalHeight);
      const box = { x: (size - img.naturalWidth * s) / 2, y: (size - img.naturalHeight * s) / 2, w: img.naturalWidth * s, h: img.naturalHeight * s };
      ctx.filter = T.filterCss(name);
      ctx.drawImage(img, box.x, box.y, box.w, box.h);
      ctx.filter = 'none';
      if (Fun) Fun.draw(ctx, name, box, 1.3);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    el.last.hidden = false;
    el.lastCount.textContent = shots > 1 ? String(shots) : '';
  }

  /* ---------- recording videos ---------- */

  function startRecording() {
    if (!stream) return;
    const left = opts.left ? opts.left() : {};
    if (left.video !== undefined && left.video <= 0) { showStatus(); return; }
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
    recStart = performance.now();
    takenAt = new Date();
    el.root.classList.add('is-recording');
    el.shutter.setAttribute('aria-label', 'Stop recording');
    const max = opts.maxSeconds || 30;
    const show = (sec) => {
      el.status.hidden = false;
      el.status.textContent = `${T.formatSeconds(sec)} / ${T.formatSeconds(max)}`;
      el.ring.style.setProperty('--done', String(Math.min(1, sec / max)));
    };
    show(0);
    tick = setInterval(() => {
      const sec = (performance.now() - recStart) / 1000;
      show(sec);
      if (sec >= max) stopRecording();
    }, 200);
  }

  function stopRecording() {
    clearInterval(tick);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function finished() {
    const seconds = Math.min(opts.maxSeconds || 30, Math.round((performance.now() - recStart) / 100) / 10);
    el.root.classList.remove('is-recording');
    el.ring.style.setProperty('--done', '0');
    const type = (recorder && recorder.mimeType) || recordingType() || 'video/webm';
    recorder = null;
    const blob = new Blob(pieces, { type: type.split(';')[0] });
    pieces = [];
    if (seconds < MIN_SECONDS || !blob.size) {
      say('That was too quick. Tap the button to start, and again to stop.');
      setTimeout(() => say(''), 2500);
      showStatus();
      return;
    }
    say('Getting it ready…');
    const still = await T.videoStill(blob);
    say('');
    review = { blob, mime: blob.type, seconds, width: still.width, height: still.height, poster: still.poster, takenAt };
    // Look it over with the camera paused (saves battery while they decide).
    stopCamera();
    el.replay.src = URL.createObjectURL(blob);
    el.replay.muted = false;
    el.replay.play().catch(() => { el.replay.muted = true; el.replay.play().catch(() => {}); });
    el.live.hidden = true;
    el.replay.hidden = false;
    el.controls.hidden = true;
    el.modes.hidden = true;
    el.review.hidden = false;
    el.root.classList.add('is-reviewing');
    showStatus();
  }

  function showLive() {
    if (el.replay.src) { URL.revokeObjectURL(el.replay.src); el.replay.removeAttribute('src'); el.replay.load(); }
    el.live.hidden = false;
    el.replay.hidden = true;
    el.controls.hidden = false;
    el.modes.hidden = !canVideo();
    el.review.hidden = true;
    el.root.classList.remove('is-recording', 'is-reviewing');
    say('');
  }

  function retake() {
    review = null;
    showLive();
    startCamera();
  }

  function useVideo() {
    if (!review) return;
    const out = { kind: 'video', ...review, filter };
    review = null;
    shots++;
    if (out.poster) showLast(out.poster, filter);
    showLive();
    startCamera();
    if (opts.onCapture) opts.onCapture(out);
  }

  return { open, supported: canPhoto, canVideo, recordingType };
})();
