// Draws the invitation card as an SVG on the template's own 1429×2000 grid, so it matches the
// printed design at any size. The wording always comes from the Google Sheet (never from this
// public file); only the layout lives here.
window.InvitationCard = (function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const W = 1429;
  const H = 2000;
  const CX = W / 2;
  const INK = '#2e2e2e';
  const SERIF = "'EB Garamond', Garamond, 'Times New Roman', serif";
  const SCRIPT = "'Monsieur La Doulaise', 'Pinyon Script', cursive";

  // Positions measured from the templates (template pixels).
  const FRAME = [
    [75, 68, 559, 68], [76, 67, 76, 1394],           // top-left corner
    [1352, 605, 1352, 1932], [869, 1931, 1353, 1931], // bottom-right corner
  ];
  const FLORALS = [
    { href: 'floral-top-right.png', x: 700, y: 0, w: 729, h: 412 },
    { href: 'floral-bottom-left.png', x: 0, y: 1580, w: 722, h: 420 },
  ];
  // Sizes and baselines measured from the templates; letter-spacing comes out at ~0 throughout.
  const SMALL = { font: SERIF, fs: 46.2, ls: -0.5, maxW: 1150, filter: 'url(#ic-soft)' };
  const BIG = { ...SMALL, fs: 49.2, ls: 0.3 };
  const EMBOSS = 'url(#ic-emboss)';

  const LAYOUTS = {
    full: [
      { key: 'hosts', ...BIG, y: 356, pitch: 57, dx: -7 },
      { key: 'request', ...SMALL, y: 419, pitch: 53 },
      { key: 'firstName', script: true, fs: 119.2, y: 703, dx: 2, maxW: 1150, filter: EMBOSS },
      { key: 'joiner', script: true, fs: 110.5, y: 840, dx: 3, maxW: 400, filter: EMBOSS },
      { key: 'secondName', script: true, fs: 110.5, y: 993, dx: 3.5, maxW: 1150, filter: EMBOSS },
      { key: 'underNames', ...BIG, y: 1162, pitch: 57 },
      { key: 'when', ...SMALL, y: 1322, pitch: 59.5, dx: 18 },
      { key: 'where', ...SMALL, y: 1627, pitch: 55, dx: 4 },
    ],
    ceremony: [
      { key: 'intro', ...SMALL, fs: 61.4, ls: 0.4, y: 466, pitch: 70, dx: -2 },
      { key: 'names', ampersand: true, leftFs: 130.2, rightFs: 117.3, y: 767 },
      { key: 'title', ...SMALL, fs: 79.5, ls: 2.2, y: 974, dx: -15.5, filter: 'url(#ic-lift)' },
      { key: 'ornament', image: { href: 'ornament-blossoms.png', x: 538, y: 1026, w: 354, h: 112 } },
      { key: 'when', ...SMALL, fs: 45.5, ls: 0.1, y: 1330, pitch: 59.5, dx: 3.5 },
      { key: 'where', ...SMALL, y: 1627, pitch: 55, dx: 4 },
    ],
  };
  // The ceremony card's decorative ampersand, cut from the template, and the spacing around it.
  const AMP = { href: 'ampersand.png', w: 136, h: 166, y: 686, gapBefore: 29, gapAfter: -8, center: 719 };

  function el(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Typographic apostrophes and quotes, like the printed card.
  const curly = (s) => String(s).replace(/'/g, '’');

  function defs() {
    const d = el('defs');
    // Light engraved shadow under the script names.
    const emboss = el('filter', { id: 'ic-emboss', x: '-5%', y: '-10%', width: '115%', height: '130%' });
    emboss.append(el('feDropShadow', { dx: 4, dy: 4, stdDeviation: 1.4, 'flood-color': '#000', 'flood-opacity': 0.3 }));
    // Barely-there shadow under the capitals.
    const soft = el('filter', { id: 'ic-soft', x: '-5%', y: '-20%', width: '110%', height: '160%' });
    soft.append(el('feDropShadow', { dx: 1.5, dy: 2, stdDeviation: 1.6, 'flood-color': '#000', 'flood-opacity': 0.16 }));
    // A little more lift under the large "WEDDING".
    const lift = el('filter', { id: 'ic-lift', x: '-5%', y: '-20%', width: '110%', height: '160%' });
    lift.append(el('feDropShadow', { dx: 1, dy: 3, stdDeviation: 2.5, 'flood-color': '#000', 'flood-opacity': 0.2 }));
    d.append(emboss, soft, lift);
    return d;
  }

  function textLine(spec, content, y) {
    return el('text', {
      x: CX + (spec.dx || 0),
      y,
      'text-anchor': 'middle',
      'font-family': spec.script ? SCRIPT : spec.font,
      'font-size': spec.fs,
      'letter-spacing': spec.script ? undefined : spec.ls,
      fill: INK,
      filter: spec.filter,
      style: spec.script ? undefined : 'font-variant-numeric: lining-nums',
      'data-maxw': spec.maxW,
    }, spec.script ? curly(content) : curly(content).toUpperCase());
  }

  function render(invitation, imageBase) {
    const layout = LAYOUTS[invitation.design] || LAYOUTS.ceremony;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'invitation-svg', role: 'img' });
    svg.append(defs());
    svg.append(el('rect', { width: W, height: H, fill: '#fff' }));
    for (const f of FLORALS) svg.append(el('image', { href: imageBase + f.href, x: f.x, y: f.y, width: f.w, height: f.h }));
    for (const [x1, y1, x2, y2] of FRAME) svg.append(el('line', { x1, y1, x2, y2, stroke: '#333', 'stroke-width': 3 }));

    const spoken = [];
    for (const spec of layout) {
      if (spec.image) {
        const i = spec.image;
        svg.append(el('image', { href: imageBase + i.href, x: i.x, y: i.y, width: i.w, height: i.h }));
        continue;
      }
      const value = invitation[spec.key];
      if (spec.ampersand) {
        spoken.push(String(value || ''));
        svg.append(namesWithAmpersand(spec, String(value || ''), imageBase));
        continue;
      }
      const lines = Array.isArray(value) ? value : (value ? [value] : []);
      lines.forEach((line, i) => svg.append(textLine(spec, line, spec.y + i * (spec.pitch || 0))));
      spoken.push(lines.join(', '));
    }
    svg.setAttribute('aria-label', spoken.filter(Boolean).join('. '));
    return svg;
  }

  // "Stephanie & Robert's" → two script words around the template's own ampersand.
  function namesWithAmpersand(spec, value, imageBase) {
    const g = el('g', { class: 'ic-names', 'aria-hidden': 'true' });
    const parts = value.split(/\s+&\s+/);
    const base = { script: true, filter: undefined, maxW: 1150 };
    if (parts.length !== 2) {
      g.append(textLine({ ...base, fs: spec.rightFs }, value, spec.y));
      return g;
    }
    const left = textLine({ ...base, fs: spec.leftFs, maxW: 560 }, parts[0], spec.y);
    const right = textLine({ ...base, fs: spec.rightFs, maxW: 560 }, parts[1], spec.y);
    left.setAttribute('text-anchor', 'end');
    right.setAttribute('text-anchor', 'start');
    const amp = el('image', { href: imageBase + AMP.href, y: AMP.y, width: AMP.w, height: AMP.h });
    g.append(left, amp, right);
    g._layoutAmpersand = () => {
      const wl = left.getComputedTextLength();
      const wr = right.getComputedTextLength();
      const total = wl + AMP.gapBefore + AMP.w + AMP.gapAfter + wr;
      const start = AMP.center - total / 2;
      left.setAttribute('x', start + wl);
      amp.setAttribute('x', start + wl + AMP.gapBefore);
      right.setAttribute('x', start + wl + AMP.gapBefore + AMP.w + AMP.gapAfter);
    };
    return g;
  }

  // Shrinks any line that is longer than its slot, and places the ampersand. Call once the
  // card is in the page and the fonts have loaded.
  function fit(svg) {
    svg.querySelectorAll('text[data-maxw]').forEach((t) => {
      const maxW = Number(t.getAttribute('data-maxw'));
      const w = t.getComputedTextLength();
      if (w > maxW) t.setAttribute('font-size', (Number(t.getAttribute('font-size')) * maxW / w).toFixed(2));
    });
    svg.querySelectorAll('.ic-names').forEach((g) => g._layoutAmpersand && g._layoutAmpersand());
  }

  function fontsReady() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load(`400 50px 'EB Garamond'`),
      document.fonts.load(`100px 'Monsieur La Doulaise'`),
    ]).catch(() => {});
  }

  return { render, fit, fontsReady, LAYOUTS };
})();
