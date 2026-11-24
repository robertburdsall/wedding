// Silly filters (a mustache, a sombrero, a top hat, a puppy, shades, a party hat, falling tacos,
// floating hearts) for the camera page, the album and the highlight builder.
//
// Like the color filters, these never change the photo or video itself. The camera finds the
// faces (with Google's MediaPipe face detector, loaded only when someone picks a silly filter)
// and saves just their positions next to the original: one set for a photo, a few per second
// for a video. The sticker is drawn on top wherever it's shown, so it can be swapped or turned
// off later. Each face is 8 numbers from 0 to 1000: right eye, left eye, nose tip and mouth
// (x then y, as a share of the picture's width and height).
window.Fun = (function () {
  'use strict';

  const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  const TRACK_FPS = 5;
  const MAX_FACES = 4;

  // Name -> { face: needs faces, label for the button }. Names must match PHOTO_FILTERS in Code.gs.
  const SILLY = {
    Mustache: { face: true },
    Sombrero: { face: true },
    'Top Hat': { face: true },
    Puppy: { face: true },
    Shades: { face: true },
    'Party Hat': { face: true },
    'Taco Rain': { face: false },
    Hearts: { face: false },
  };
  const NAMES = Object.keys(SILLY);
  const isSilly = (name) => Object.prototype.hasOwnProperty.call(SILLY, name || '');
  const needsFaces = (name) => isSilly(name) && SILLY[name].face;

  /* ---------- finding faces ---------- */

  let loading = null;
  // Loads the face detector once. Resolves to { video, image } detectors (or rejects).
  function loadDetector() {
    if (loading) return loading;
    loading = (async () => {
      const vision = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
      // iPhones are happier on the CPU; elsewhere the GPU is faster.
      const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      async function make(mode) {
        const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: mode, minDetectionConfidence: 0.5 });
        try {
          return await vision.FaceDetector.createFromOptions(files, opts(ios ? 'CPU' : 'GPU'));
        } catch (err) {
          return vision.FaceDetector.createFromOptions(files, opts('CPU'));
        }
      }
      return { video: await make('VIDEO'), image: await make('IMAGE') };
    })();
    loading.catch(() => { loading = null; });
    return loading;
  }

  function toFaces(result) {
    const out = [];
    for (const d of (result && result.detections) || []) {
      const k = d.keypoints || [];
      if (k.length < 4) continue;
      const n = (v) => Math.max(-500, Math.min(1500, Math.round(v * 1000)));
      out.push([n(k[0].x), n(k[0].y), n(k[1].x), n(k[1].y), n(k[2].x), n(k[2].y), n(k[3].x), n(k[3].y)]);
      if (out.length >= MAX_FACES) break;
    }
    return out;
  }

  let lastStamp = 0;
  // Faces in the current frame of a playing <video> (needs loadDetector() first).
  async function detectVideo(video) {
    const d = await loadDetector();
    let stamp = performance.now();
    if (stamp <= lastStamp) stamp = lastStamp + 1; // must always go forward
    lastStamp = stamp;
    return toFaces(d.video.detectForVideo(video, stamp));
  }

  // Faces in a picture (an <img>, a canvas or an ImageBitmap).
  async function detectImage(source) {
    const d = await loadDetector();
    return toFaces(d.image.detect(source));
  }

  // A track is { fps, f: [faces at 0s, faces at 1/fps s, ...] }. Faces at time t, smoothly.
  function facesAt(track, t) {
    if (!track || !Array.isArray(track.f) || !track.f.length) return [];
    const pos = Math.max(0, t) * (track.fps || TRACK_FPS);
    const i = Math.min(track.f.length - 1, Math.floor(pos));
    const a = track.f[i] || [], b = track.f[Math.min(track.f.length - 1, i + 1)] || [];
    const mix = pos - i;
    if (!b.length || b.length !== a.length || mix <= 0) return a;
    return a.map((fa, j) => fa.map((v, q) => Math.round(v + (b[j][q] - v) * mix)));
  }

  // Records faces a few times a second while a video is being made.
  function tracker() {
    const frames = [];
    return {
      fps: TRACK_FPS,
      add(seconds, faces) {
        const i = Math.round(seconds * TRACK_FPS);
        while (frames.length < i) frames.push(frames.length ? frames[frames.length - 1] : []);
        frames[i] = faces;
      },
      done(seconds) {
        const n = Math.max(1, Math.round(seconds * TRACK_FPS) + 1);
        while (frames.length < n) frames.push(frames.length ? frames[frames.length - 1] : []);
        return { fps: TRACK_FPS, f: frames.slice(0, n) };
      },
    };
  }

  /* ---------- drawing ---------- */

  // Draws filter `name` for `faces` onto ctx, where the picture fills box {x, y, w, h}
  // (which can run past the canvas, for "cover" layouts). `t` (seconds) moves the tacos and hearts.
  function draw(ctx, name, faces, box, t = 0) {
    if (!isSilly(name)) return;
    ctx.save();
    ctx.filter = 'none';
    if (name === 'Taco Rain') rain(ctx, box, t, drawTaco, 16, 0.11);
    else if (name === 'Hearts') rain(ctx, box, t, drawHeart, 18, 0.07, true);
    else (faces || []).slice(0, MAX_FACES).forEach((f) => face(ctx, name, f, box));
    ctx.restore();
  }

  function face(ctx, name, f, box) {
    const P = (i) => ({ x: box.x + (f[i] / 1000) * box.w, y: box.y + (f[i + 1] / 1000) * box.h });
    const re = P(0), le = P(2), nose = P(4), mouth = P(6);
    const mid = { x: (re.x + le.x) / 2, y: (re.y + le.y) / 2 };
    const d = Math.hypot(le.x - re.x, le.y - re.y);
    if (d < 4) return;
    const a = Math.atan2(le.y - re.y, le.x - re.x);
    // Points in the face's own frame: origin between the eyes, 1 unit = eye distance, y down.
    const local = (p) => {
      const dx = (p.x - mid.x) / d, dy = (p.y - mid.y) / d;
      return { x: dx * Math.cos(-a) - dy * Math.sin(-a), y: dx * Math.sin(-a) + dy * Math.cos(-a) };
    };
    const n = local(nose), m = local(mouth);
    ctx.save();
    ctx.translate(mid.x, mid.y);
    ctx.rotate(a);
    ctx.scale(d, d);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ({ Mustache: mustache, Sombrero: sombrero, 'Top Hat': topHat, Puppy: puppy, Shades: shades, 'Party Hat': partyHat })[name](ctx, n, m);
    ctx.restore();
  }

  function mustache(ctx, n, m) {
    const cx = n.x + (m.x - n.x) * 0.5, cy = n.y + (m.y - n.y) * 0.45;
    ctx.translate(cx, cy);
    ctx.fillStyle = '#3a2416';
    ctx.strokeStyle = '#24150c';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(0, -0.08);
    ctx.bezierCurveTo(0.18, -0.2, 0.42, -0.14, 0.5, -0.02);
    ctx.bezierCurveTo(0.58, 0.08, 0.72, 0.06, 0.78, -0.08); // curly tip
    ctx.bezierCurveTo(0.8, 0.12, 0.6, 0.22, 0.42, 0.14);
    ctx.bezierCurveTo(0.28, 0.08, 0.12, 0.1, 0, 0.06);
    ctx.bezierCurveTo(-0.12, 0.1, -0.28, 0.08, -0.42, 0.14);
    ctx.bezierCurveTo(-0.6, 0.22, -0.8, 0.12, -0.78, -0.08);
    ctx.bezierCurveTo(-0.72, 0.06, -0.58, 0.08, -0.5, -0.02);
    ctx.bezierCurveTo(-0.42, -0.14, -0.18, -0.2, 0, -0.08);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function shades(ctx) {
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 0.07;
    const lens = (x) => {
      ctx.beginPath();
      ctx.moveTo(x - 0.46, -0.2);
      ctx.lineTo(x + 0.46, -0.2);
      ctx.quadraticCurveTo(x + 0.46, 0.3, x, 0.32);
      ctx.quadraticCurveTo(x - 0.46, 0.3, x - 0.46, -0.2);
      ctx.closePath();
      ctx.fill();
    };
    lens(-0.52);
    lens(0.52);
    ctx.beginPath();
    ctx.moveTo(-0.08, -0.12);
    ctx.quadraticCurveTo(0, -0.2, 0.08, -0.12);
    ctx.moveTo(-0.98, -0.18);
    ctx.lineTo(-1.15, -0.25);
    ctx.moveTo(0.98, -0.18);
    ctx.lineTo(1.15, -0.25);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    [-0.52, 0.52].forEach((x) => {
      ctx.beginPath();
      ctx.ellipse(x - 0.18, -0.06, 0.1, 0.05, -0.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function topHat(ctx) {
    const base = -1.05;
    ctx.fillStyle = '#151515';
    ctx.beginPath();
    ctx.ellipse(0, base, 1.15, 0.2, 0, 0, Math.PI * 2); // brim
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-0.72, base);
    ctx.lineTo(-0.66, base - 1.5);
    ctx.quadraticCurveTo(0, base - 1.62, 0.66, base - 1.5);
    ctx.lineTo(0.72, base);
    ctx.quadraticCurveTo(0, base + 0.12, -0.72, base);
    ctx.fill();
    ctx.fillStyle = '#b46a79'; // a band in the wedding pink
    ctx.beginPath();
    ctx.moveTo(-0.71, base - 0.1);
    ctx.lineTo(-0.69, base - 0.4);
    ctx.quadraticCurveTo(0, base - 0.3, 0.69, base - 0.4);
    ctx.lineTo(0.71, base - 0.1);
    ctx.quadraticCurveTo(0, base, -0.71, base - 0.1);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(-0.5, base - 1.45, 0.14, 1.0);
  }

  function sombrero(ctx) {
    const base = -0.95;
    ctx.fillStyle = '#e3b04b';
    ctx.strokeStyle = '#a8742a';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.ellipse(0, base, 2.2, 0.45, 0, 0, Math.PI * 2); // big brim
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d29a35';
    ctx.beginPath();
    ctx.ellipse(0, base - 0.05, 1.55, 0.28, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8bb5c';
    ctx.beginPath(); // crown
    ctx.moveTo(-0.72, base - 0.05);
    ctx.bezierCurveTo(-0.7, base - 1.25, 0.7, base - 1.25, 0.72, base - 0.05);
    ctx.quadraticCurveTo(0, base + 0.12, -0.72, base - 0.05);
    ctx.fill();
    ctx.stroke();
    // A zigzag band in red and green.
    const colors = ['#c0392b', '#2e8b57'];
    for (let i = 0; i < 8; i++) {
      const x0 = -0.7 + i * 0.175;
      ctx.fillStyle = colors[i % 2];
      ctx.beginPath();
      ctx.moveTo(x0, base - 0.18);
      ctx.lineTo(x0 + 0.0875, base - 0.38);
      ctx.lineTo(x0 + 0.175, base - 0.18);
      ctx.closePath();
      ctx.fill();
    }
    // Little pom-poms around the brim.
    for (let i = 0; i < 9; i++) {
      const ang = Math.PI * (0.08 + (0.84 * i) / 8);
      ctx.fillStyle = colors[i % 2];
      ctx.beginPath();
      ctx.arc(Math.cos(ang) * 2.15, base + Math.sin(ang) * 0.45, 0.08, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function partyHat(ctx) {
    const base = -1.05;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-0.62, base);
    ctx.lineTo(0, base - 1.75);
    ctx.lineTo(0.62, base);
    ctx.closePath();
    ctx.clip();
    const stripes = ['#f2c6cf', '#15322a', '#e8a7b4', '#f7e7b4'];
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = stripes[i % stripes.length];
      ctx.beginPath();
      ctx.moveTo(-1, base - i * 0.22);
      ctx.lineTo(1, base - i * 0.22 - 0.35);
      ctx.lineTo(1, base - i * 0.22 - 0.57);
      ctx.lineTo(-1, base - i * 0.22 - 0.22);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#f7e7b4';
    ctx.beginPath();
    ctx.arc(0, base - 1.78, 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b46a79';
    ctx.beginPath();
    ctx.ellipse(0, base, 0.66, 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function puppy(ctx, n, m) {
    // Floppy ears.
    [-1, 1].forEach((side) => {
      ctx.save();
      ctx.translate(side * 1.2, -1.35);
      ctx.rotate(side * 0.22);
      ctx.fillStyle = '#7a4a2a';
      ctx.beginPath();
      ctx.ellipse(0, 0.55, 0.36, 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b07a52';
      ctx.beginPath();
      ctx.ellipse(0, 0.6, 0.2, 0.56, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    // Nose.
    ctx.fillStyle = '#1b1b1b';
    ctx.beginPath();
    ctx.moveTo(n.x - 0.24, n.y - 0.08);
    ctx.quadraticCurveTo(n.x, n.y - 0.2, n.x + 0.24, n.y - 0.08);
    ctx.quadraticCurveTo(n.x + 0.2, n.y + 0.16, n.x, n.y + 0.18);
    ctx.quadraticCurveTo(n.x - 0.2, n.y + 0.16, n.x - 0.24, n.y - 0.08);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.ellipse(n.x - 0.08, n.y - 0.06, 0.06, 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
    // Tongue.
    ctx.fillStyle = '#f06a8a';
    ctx.strokeStyle = '#c94a6a';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(m.x - 0.17, m.y + 0.02);
    ctx.lineTo(m.x + 0.17, m.y + 0.02);
    ctx.lineTo(m.x + 0.17, m.y + 0.3);
    ctx.quadraticCurveTo(m.x, m.y + 0.52, m.x - 0.17, m.y + 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x, m.y + 0.06);
    ctx.lineTo(m.x, m.y + 0.26);
    ctx.stroke();
  }

  // A pseudo-random number in [0, 1) for item i (the same every time, so a photo's tacos stay put).
  const rnd = (i, s) => { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); };

  function rain(ctx, box, t, drawOne, count, size, rising) {
    const unit = Math.min(box.w, box.h) * size;
    for (let i = 0; i < count; i++) {
      const speed = 0.12 + rnd(i, 1) * 0.18; // screens per second
      let p = (rnd(i, 2) + t * speed) % 1.25;
      if (rising) p = 1.25 - p;
      const x = box.x + rnd(i, 3) * box.w;
      const y = box.y + (p - 0.12) * box.h;
      const s = unit * (0.7 + rnd(i, 4) * 0.6);
      ctx.save();
      ctx.translate(x + Math.sin(t * 1.5 + i) * unit * 0.3, y);
      ctx.rotate((rnd(i, 5) - 0.5) * 1.2 + Math.sin(t + i) * 0.4);
      ctx.scale(s, s);
      drawOne(ctx, i);
      ctx.restore();
    }
  }

  function drawTaco(ctx) {
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#4caf50'; // lettuce
    ctx.beginPath();
    for (let k = 0; k <= 6; k++) ctx.arc(-0.42 + k * 0.14, -0.08 - Math.sin((k / 6) * Math.PI) * 0.28, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e74c3c'; // tomato
    [[-0.2, -0.28], [0.12, -0.32], [0.32, -0.16]].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 0.07, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = '#f1c40f'; // shell
    ctx.strokeStyle = '#c99a0c';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(-0.55, 0);
    ctx.bezierCurveTo(-0.5, 0.45, 0.5, 0.45, 0.55, 0);
    ctx.quadraticCurveTo(0, -0.12, -0.55, 0);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(201,154,12,0.6)';
    [[-0.25, 0.15], [0.05, 0.2], [0.3, 0.12]].forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 0.035, 0, Math.PI * 2); ctx.fill(); });
  }

  function drawHeart(ctx, i) {
    ctx.fillStyle = ['#e8a7b4', '#f2c6cf', '#d9667f', '#ffffff'][i % 4];
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(0, 0.3);
    ctx.bezierCurveTo(-0.55, -0.05, -0.3, -0.55, 0, -0.22);
    ctx.bezierCurveTo(0.3, -0.55, 0.55, -0.05, 0, 0.3);
    ctx.fill();
  }

  // A little preview of a silly filter on a cartoon face, for the filter buttons.
  function drawChip(canvas, name) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#f2c6cf';
    ctx.fillRect(0, 0, w, h);
    if (needsFaces(name)) {
      ctx.fillStyle = '#f5d3b5';
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.62, w * 0.26, h * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a2a20';
      [0.42, 0.58].forEach((x) => { ctx.beginPath(); ctx.arc(w * x, h * 0.56, w * 0.025, 0, Math.PI * 2); ctx.fill(); });
      const big = name === 'Sombrero' || name === 'Top Hat' || name === 'Party Hat' || name === 'Puppy';
      const face = [420, 560, 580, 560, 500, 660, 500, 760].map((v, i) => (i % 2 ? v : v));
      const shrink = big ? 0.82 : 1.6;
      const box = { x: (w - w * shrink) / 2, y: big ? h * 0.12 : (h - h * shrink) / 2 - h * 0.08, w: w * shrink, h: h * shrink };
      draw(ctx, name, [face], box, 0);
    } else {
      draw(ctx, name, [], { x: 0, y: 0, w, h }, 1.3);
    }
  }

  return { NAMES, isSilly, needsFaces, loadDetector, detectVideo, detectImage, facesAt, tracker, draw, drawChip, TRACK_FPS };
})();
