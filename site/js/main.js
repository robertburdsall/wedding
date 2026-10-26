// Home page behavior: navigation, registry, photo gallery + lightbox, and "find my invitation".
(function () {
  'use strict';

  /* ---------- Navigation ---------- */
  const nav = document.getElementById('nav');
  const toggle = document.getElementById('nav-toggle');

  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 40);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('#nav-links a').forEach((link) =>
    link.addEventListener('click', () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    })
  );

  /* ---------- Registry ---------- */
  (function registry() {
    const cfg = window.WEDDING_CONFIG || {};
    const embed = document.getElementById('registry-embed');
    const links = document.getElementById('registry-links');
    const safeUrl = (u) => (/^https:\/\//i.test(String(u || '').trim()) ? String(u).trim() : '');
    const embedUrl = safeUrl(cfg.registryEmbedUrl);
    const linkUrl = safeUrl(cfg.registryUrl);
    const pasted = embed.querySelector('*:not(script)') || embed.querySelector('script');

    if (embedUrl && !pasted) {
      const frame = document.createElement('iframe');
      frame.src = embedUrl;
      frame.title = 'Registry';
      frame.loading = 'lazy';
      frame.referrerPolicy = 'no-referrer-when-downgrade';
      embed.appendChild(frame);
    }
    embed.hidden = !(embedUrl || pasted);

    if (linkUrl) {
      const a = document.createElement('a');
      a.className = 'btn';
      a.href = linkUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `View ${cfg.registryName || 'our registry'}`;
      links.replaceChildren(a);
    } else if (embedUrl || pasted) {
      links.hidden = true;
    }
  })();

  /* ---------- Gallery ---------- */
  const gallery = document.getElementById('gallery');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  let photos = [];
  let current = 0;

  fetch('images/photos/photos.json')
    .then((r) => r.json())
    .then((list) => {
      photos = list;
      list.forEach((photo, i) => {
        const btn = document.createElement('button');
        btn.className = 'gallery__item';
        btn.type = 'button';
        btn.setAttribute('aria-label', `Open photo ${i + 1} of ${list.length}`);
        const img = document.createElement('img');
        img.src = photo.thumb;
        img.alt = 'Stephanie and Robert';
        img.loading = 'lazy';
        img.width = photo.width;
        img.height = photo.height;
        btn.appendChild(img);
        btn.addEventListener('click', () => openLightbox(i));
        gallery.appendChild(btn);
      });
    })
    .catch(() => { gallery.textContent = ''; });

  function show(i) {
    current = (i + photos.length) % photos.length;
    lightboxImg.src = photos[current].src;
    lightboxImg.alt = `Photo ${current + 1} of ${photos.length}`;
  }
  function openLightbox(i) {
    show(i);
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    lightbox.querySelector('[data-action="close"]').focus();
  }
  function closeLightbox() {
    lightbox.hidden = true;
    document.body.style.overflow = '';
    gallery.children[current] && gallery.children[current].focus();
  }

  lightbox.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'close' || e.target === lightbox) closeLightbox();
    else if (action === 'prev') show(current - 1);
    else if (action === 'next') show(current + 1);
  });
  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') show(current - 1);
    else if (e.key === 'ArrowRight') show(current + 1);
  });
  let touchX = null;
  lightbox.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) show(current + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  /* ---------- Find my invitation ---------- */
  const form = document.getElementById('find-invite');
  const input = document.getElementById('invite-code');
  const error = document.getElementById('find-invite-error');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      error.textContent = 'Please enter the code from your invitation.';
      error.hidden = false;
      input.focus();
      return;
    }
    window.location.href = `invite/?code=${encodeURIComponent(code)}`;
  });
})();
