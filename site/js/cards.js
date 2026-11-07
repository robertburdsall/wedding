// Printable table cards with a QR code to the photo album (photos/cards.html?t=PHOTOCODE).
(function () {
  'use strict';

  const T = window.PhotoTools;
  const $ = (sel) => document.querySelector(sel);
  const code = T.photoCodeFromPage();

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
    children.flat().forEach((c) => c && el.append(c));
    return el;
  }

  function warn(text) {
    const el = $('#warning');
    el.textContent = text;
    el.hidden = !text;
  }

  function card(table) {
    const url = T.photoPageUrl(code, table);
    const fallback = `${new URL('./', location.href).host}${new URL('./', location.href).pathname} · code ${code}`;
    return h('div', { class: 'card' },
      h('img', { class: 'card__floral card__floral--top', src: '../images/floral-top-right.png', alt: '' }),
      h('img', { class: 'card__floral card__floral--bottom', src: '../images/floral-bottom-left.png', alt: '' }),
      table ? h('p', { class: 'card__table', text: `Table ${table}` }) : null,
      h('p', { class: 'card__title', text: 'Share the moments' }),
      h('p', { class: 'card__text', text: "Scan to add your photos and see the day through everyone’s eyes." }),
      h('div', { class: 'card__qr' }, T.qrSvg(url, { label: table ? `QR code for table ${table}` : 'QR code' })),
      h('p', { class: 'card__how', text: "Open your phone’s camera · no app needed" }),
      h('p', { class: 'card__fallback', text: fallback }),
      h('p', { class: 'card__monogram', text: 'S & R' }));
  }

  function render() {
    const root = $('#sheets');
    root.textContent = '';
    if (!code) {
      warn('This page needs the photo code. Open the "Photo Table Cards Link" from the Settings tab of the guest list sheet.');
      return;
    }
    const count = Math.max(1, Math.min(80, Math.round(Number($('#tables').value) || 1)));
    const numbered = $('#numbered').checked;
    const cards = [];
    for (let i = 1; i <= count; i++) cards.push(card(numbered ? String(i) : ''));
    for (let i = 0; i < cards.length; i += 2) root.append(h('div', { class: 'sheet' }, cards[i], cards[i + 1] || null));
  }

  $('#tables').addEventListener('input', render);
  $('#numbered').addEventListener('change', render);
  $('#print').addEventListener('click', () => window.print());
  render();

  // Make sure the code on the cards actually works before anyone prints 20 of them.
  if (code) {
    window.WeddingAPI.getPhotos(code).catch((err) => {
      if (err && err.code === 'not_found') warn("This photo code doesn't match the one on the Settings tab. Open the \"Photo Table Cards Link\" from Settings again before printing.");
      else warn(`Couldn't check the photo code (${err && err.message ? err.message : 'no connection'}). The cards will still work if the code is right.`);
    });
  }
})();
