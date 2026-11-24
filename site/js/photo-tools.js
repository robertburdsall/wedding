// Helpers shared by the photo pages (photos.js, slideshow.js, cards.js, recorder.js, highlight.js):
// reading when a photo was taken, shrinking photos before upload, building image and video
// links, filters, video stills, and drawing QR codes.
(function (root) {
  'use strict';

  /* ---------- When was the photo taken? (EXIF) ---------- */

  // Returns the "date taken" stored in a JPEG's EXIF data as a Date, or null.
  // `buffer` only needs the start of the file (the EXIF block is near the beginning).
  function readExifDate(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda || marker === 0xffd9) return null;
        const size = view.getUint16(offset + 2);
        if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
          return readTiffDate(view, offset + 10);
        }
        offset += 2 + size;
      }
    } catch (err) { /* truncated or unusual file */ }
    return null;
  }

  function readTiffDate(view, start) {
    const order = view.getUint16(start);
    const little = order === 0x4949;
    if (!little && order !== 0x4d4d) return null;
    const u16 = (o) => view.getUint16(start + o, little);
    const u32 = (o) => view.getUint32(start + o, little);
    if (u16(2) !== 42) return null;
    const entries = (ifd) => {
      const out = {};
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return out;
    };
    const text = (tag) => {
      if (!tag || tag.type !== 2) return '';
      const at = tag.count > 4 ? u32(tag.at) : tag.at;
      let s = '';
      for (let i = 0; i < tag.count; i++) {
        const ch = view.getUint8(start + at + i);
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s;
    };
    const ifd0 = entries(u32(4));
    const exif = ifd0[0x8769] ? entries(u32(ifd0[0x8769].at)) : {};
    // DateTimeOriginal, then DateTimeDigitized, then the file's DateTime.
    const stamp = text(exif[0x9003]) || text(exif[0x9004]) || text(ifd0[0x0132]);
    const m = stamp.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    let date;
    const zone = (text(exif[0x9011]) || text(exif[0x9012]) || text(exif[0x9010])).match(/^([+-])(\d{2}):(\d{2})$/);
    if (zone) {
      const minutes = (Number(zone[2]) * 60 + Number(zone[3])) * (zone[1] === '-' ? -1 : 1);
      date = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - minutes * 60000);
    } else {
      date = new Date(y, mo - 1, d, h, mi, s); // no time zone saved: the phone's local time
    }
    return isNaN(date.getTime()) || y < 1990 ? null : date;
  }

  /* ---------- Shrinking photos before upload ---------- */

  const MAX_SIDE = 3000;
  const QUALITY = 0.86;

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  // Turns a picked file into a JPEG no bigger than MAX_SIDE on its long edge. Drawing it on a
  // canvas also drops all the hidden data in the original (like the GPS location).
  // Resolves to { blob, width, height, takenAt, previewUrl }.
  async function preparePhoto(file) {
    let takenAt = null;
    try { takenAt = readExifDate(await file.slice(0, 256 * 1024).arrayBuffer()); } catch (err) { /* ignore */ }
    if (!takenAt && file.lastModified) takenAt = new Date(file.lastModified);
    const { img, url } = await loadImage(file);
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    if (!w0 || !h0) throw new Error('unreadable');
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const width = Math.round(w0 * scale), height = Math.round(h0 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', QUALITY));
    canvas.width = canvas.height = 0; // free the memory right away (matters on phones)
    return { blob, width, height, takenAt, previewUrl: url };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /* ---------- Image links ---------- */

  const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

  // The photo at about `size` pixels wide, served by Google Drive (or the dev server locally).
  function photoUrl(id, size) {
    if (!DRIVE_ID.test(String(id))) return '';
    const cfg = root.WEDDING_CONFIG || {};
    const template = cfg.photoUrl || 'https://drive.google.com/thumbnail?id={id}&sz=w{size}';
    return template.replace('{id}', encodeURIComponent(id)).replace('{size}', String(size));
  }

  // A video, served by Google Drive (or the dev server locally).
  function videoUrl(id) {
    if (!DRIVE_ID.test(String(id))) return '';
    const cfg = root.WEDDING_CONFIG || {};
    const template = cfg.videoUrl || 'https://drive.google.com/uc?export=download&id={id}';
    return template.replace('{id}', encodeURIComponent(id));
  }

  /* ---------- Filters ----------
   * Only the filter's name is saved with a photo or video; the file itself always stays
   * the original. The same CSS filter is used everywhere it's shown (and by the highlight
   * builder when it draws frames), so turning a filter off later is just clearing the name.
   * The names must match PHOTO_FILTERS in apps-script/Code.gs. */
  const FILTERS = {
    Warm: 'sepia(0.22) saturate(1.3) hue-rotate(-6deg) brightness(1.04)',
    Film: 'contrast(1.12) saturate(0.85) sepia(0.15) brightness(1.03)',
    'B&W': 'grayscale(1) contrast(1.12) brightness(1.03)',
    Soft: 'brightness(1.08) saturate(0.9) contrast(0.9)',
    Vivid: 'saturate(1.45) contrast(1.08)',
    Cool: 'saturate(1.05) hue-rotate(10deg) brightness(1.04) contrast(1.02)',
    Vintage: 'sepia(0.45) contrast(0.95) brightness(1.06) saturate(0.85)',
  };
  const FILTER_NAMES = Object.keys(FILTERS);
  const filterCss = (name) => FILTERS[name] || 'none';

  // A row of filter buttons ("Original", "Warm", ..., then the silly ones from js/fun.js when
  // that's on the page). Calls onChange(name) ('' = none).
  function filterChips(container, current, onChange, { silly = true } = {}) {
    container.textContent = '';
    container.setAttribute('role', 'radiogroup');
    const fun = silly && root.Fun ? root.Fun.NAMES : [];
    const names = [''].concat(FILTER_NAMES, fun);
    const buttons = names.map((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'filter-chip';
      b.setAttribute('role', 'radio');
      b.dataset.filter = name;
      let swatch;
      if (fun.includes(name)) {
        swatch = document.createElement('canvas');
        swatch.width = swatch.height = 96;
        root.Fun.drawChip(swatch, name);
        b.classList.add('filter-chip--fun');
      } else {
        swatch = document.createElement('span');
        swatch.style.filter = filterCss(name);
      }
      swatch.className = 'filter-chip__swatch';
      const label = document.createElement('span');
      label.textContent = name || 'Original';
      b.append(swatch, label);
      b.addEventListener('click', () => { set(name); onChange(name); });
      container.append(b);
      return b;
    });
    function set(name) {
      buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.filter === name)));
      // Keep the picked one in view (without scrolling the page).
      const on = buttons.find((b) => b.dataset.filter === name);
      if (on && container.scrollWidth > container.clientWidth) {
        requestAnimationFrame(() => { container.scrollLeft = Math.max(0, on.offsetLeft - container.clientWidth / 2 + on.offsetWidth / 2); });
      }
    }
    set(current || '');
    return { set };
  }

  /* ---------- Videos ---------- */

  // "0:07", "1:30"
  function formatSeconds(s) {
    const n = Math.max(0, Math.round(Number(s) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }

  // A JPEG still from near the start of a recorded video, plus its size. Resolves to
  // { poster (Blob or null), width, height }. Never rejects: a missing still isn't fatal.
  function videoStill(blob, maxSide = 720) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      let done = false;
      const finish = (poster) => {
        if (done) return;
        done = true;
        const out = { poster, width: v.videoWidth || 0, height: v.videoHeight || 0 };
        v.removeAttribute('src');
        v.load();
        URL.revokeObjectURL(url);
        resolve(out);
      };
      const timer = setTimeout(() => finish(null), 6000);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.addEventListener('error', () => { clearTimeout(timer); finish(null); });
      v.addEventListener('loadeddata', async () => {
        try {
          // Some phones only draw a frame once the video has played a moment.
          await v.play().catch(() => {});
          v.pause();
          if (v.currentTime < 0.05) {
            await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 0.1; setTimeout(r, 1500); });
          }
          const w0 = v.videoWidth, h0 = v.videoHeight;
          if (!w0 || !h0) { clearTimeout(timer); return finish(null); }
          const scale = Math.min(1, maxSide / Math.max(w0, h0));
          const c = document.createElement('canvas');
          c.width = Math.round(w0 * scale);
          c.height = Math.round(h0 * scale);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          c.toBlob((b) => { clearTimeout(timer); finish(b); }, 'image/jpeg', 0.82);
        } catch (err) {
          clearTimeout(timer);
          finish(null);
        }
      }, { once: true });
      v.src = url;
    });
  }

  /* ---------- Timeline ---------- */

  function takenTime(photo) {
    const d = new Date(photo.takenAt || photo.uploadedAt);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /* ---------- QR codes (uses js/qrcode.js) ---------- */

  // An <svg> QR code for `text`, drawn as one path so it stays crisp when printed.
  function qrSvg(text, { color = '#15322a', margin = 2, label = 'QR code' } = {}) {
    const qr = root.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
    const size = n + margin * 2;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', color);
    svg.append(bg, path);
    return svg;
  }

  // The link the table QR codes open.
  function photoPageUrl(code, table) {
    const url = new URL('./', root.location.href);
    url.searchParams.set('t', code);
    if (table) url.searchParams.set('table', table);
    return url.toString();
  }

  /* ---------- Small shared bits ---------- */

  const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // The photo code from the link (?t=...), remembered so the page still works when reopened.
  function photoCodeFromPage() {
    const params = new URLSearchParams(root.location.search);
    let code = normalizeCode(params.get('t') || params.get('code'));
    try {
      if (code) root.localStorage.setItem('wedding.photoCode', code);
      else code = normalizeCode(root.localStorage.getItem('wedding.photoCode'));
    } catch (err) { /* private browsing */ }
    return code;
  }

  root.PhotoTools = {
    readExifDate, preparePhoto, blobToBase64, photoUrl, videoUrl, takenTime,
    qrSvg, photoPageUrl, normalizeCode, photoCodeFromPage, MAX_SIDE,
    FILTERS, FILTER_NAMES, filterCss, filterChips, formatSeconds, videoStill,
  };
})(typeof window !== 'undefined' ? window : globalThis);
