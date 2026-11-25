// Silly filters (falling tacos and floating hearts) for the camera page, the album, the slideshow
// and the highlight builder.
//
// Like the color filters, these never change the photo or video itself: only the filter's name
// is saved, and the tacos or hearts are drawn on top wherever it's shown, so they can be swapped
// or turned off later. (Face filters like a mustache were tried and taken out: phone cameras
// couldn't follow faces well enough at a party.)
window.Fun = (function () {
  'use strict';

  // Names must match SILLY_FILTERS in apps-script/Code.gs.
  const NAMES = ['Taco Rain', 'Hearts'];
  const isSilly = (name) => NAMES.indexOf(name || '') >= 0;

  // Draws filter `name` onto ctx, where the picture fills box {x, y, w, h} (which can run past
  // the canvas, for "cover" layouts). `t` (seconds) moves the tacos and hearts.
  function draw(ctx, name, box, t = 0) {
    if (!isSilly(name)) return;
    ctx.save();
    ctx.filter = 'none';
    if (name === 'Taco Rain') rain(ctx, box, t, drawTaco, 16, 0.11);
    else rain(ctx, box, t, drawHeart, 18, 0.07, true);
    ctx.restore();
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

  // A little preview of a silly filter, for the filter buttons.
  function drawChip(canvas, name) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2c6cf';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    draw(ctx, name, { x: 0, y: 0, w: canvas.width, h: canvas.height }, 1.3);
  }

  return { NAMES, isSilly, draw, drawChip };
})();
