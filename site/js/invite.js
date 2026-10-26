// Personal invitation page: loads the household's invitation by code and handles the RSVP form.
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  let invite = null;   // the data returned by the API
  let editing = false; // true while changing an existing response

  /* ---------- helpers ---------- */

  // Creates an element. Text is always set with textContent, so guest data can't inject HTML.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  // A Settings cell can hold several lines: a real line break (Ctrl+Enter), " / ", or a typed "\n".
  const cellLines = (s) => String(s || '').split(/\s*(?:\r?\n|\\n|\s\/\s)\s*/).map((l) => l.trim()).filter(Boolean);

  const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function formatList(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' & ' + items[items.length - 1];
  }

  function setState(state) {
    app.dataset.state = state;
  }

  /* ---------- loading ---------- */

  function load(code) {
    if (!code) {
      showError({ code: 'no_code' });
      return;
    }
    setState('loading');
    window.WeddingAPI.getInvite(code)
      .then(render)
      .catch(showError);
  }

  function showError(err) {
    const titles = {
      no_code: 'Find your invitation',
      not_found: "We couldn't find that invitation",
      not_configured: 'Almost ready!',
      network: 'Connection problem',
      rate_limited: 'Please try again in a few minutes',
      not_ready: "Your invitation isn't quite ready",
    };
    const messages = {
      no_code: 'Enter the code from your invitation to open it.',
      not_found: 'Please double-check the link, or type in the code from your invitation email.',
      not_ready: 'Please check back a little later, or reach out to Stephanie or Robert.',
    };
    // Only show messages that came from the RSVP service, never raw browser errors.
    const known = err && err.code && (err instanceof window.WeddingAPI.ApiError || titles[err.code]);
    if (!known) console.error(err);
    const code = known ? err.code : 'unknown';
    $('#error-title').textContent = titles[code] || "We couldn't open that invitation";
    $('#error-message').textContent = messages[code] || (known && err.message) || 'Something went wrong opening your invitation. Please try again in a minute.';
    const input = $('#code-input');
    if (!input.value) input.value = normalizeCode(new URLSearchParams(location.search).get('code'));
    setState('error');
  }

  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode($('#code-input').value);
    if (!code) { $('#code-input').focus(); return; }
    history.replaceState(null, '', `?code=${encodeURIComponent(code)}`);
    load(code);
  });

  /* ---------- rendering ---------- */

  function render(data) {
    if (!data || !data.invitation || !data.events || !data.response) {
      // The Apps Script web app is an older version than this page expects.
      console.error('Invitation data is missing fields. Publish the latest Code.gs as a New version of the deployment.');
      throw new window.WeddingAPI.ApiError('not_ready', '');
    }
    invite = data;
    editing = false;
    document.title = `For ${data.addressee || formatList(data.guests)} · Stephanie & Robert`;
    renderInvitation(data);
    renderEvents(data);
    buildForm(data);
    renderRsvpPanel();
    setState('invite');
  }

  // The envelope with the invitation card inside. Tapping it plays the opening animation;
  // people who prefer reduced motion get the card straight away.
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function renderInvitation(data) {
    const stage = $('#invitation-stage');
    stage.replaceChildren();
    stage.dataset.stage = 'sealed';

    const card = h('div', { class: 'invitation-holder' });
    const svg = window.InvitationCard.render(data.invitation, '../images/');
    card.append(svg);

    // Envelope pieces are separate layers so the card can sit between the back and the pocket.
    const back = h('div', { class: 'env env-back', 'aria-hidden': 'true' });
    const flap = h('div', { class: 'env env-flap', 'aria-hidden': 'true' },
      h('div', { class: 'env-flap__front' }), h('div', { class: 'env-flap__back' }));
    const pocket = h('div', { class: 'env env-pocket', 'aria-hidden': 'true' },
      h('span', { class: 'env-to script', text: data.addressee || formatList(data.guests) }));
    const folds = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    folds.setAttribute('viewBox', '0 0 100 100');
    folds.setAttribute('preserveAspectRatio', 'none');
    folds.setAttribute('class', 'env-folds');
    folds.innerHTML = '<path d="M0 0 L50 52 L100 0 M0 100 L50 47 L100 100" />'; // static markup
    pocket.prepend(folds);
    const seal = h('div', { class: 'env env-seal', 'aria-hidden': 'true' }, h('span', { class: 'monogram', text: 'S & R' }));

    const open = h('button', { class: 'env envelope-open', type: 'button', 'aria-label': 'Open your invitation' },
      h('span', { class: 'envelope-open__hint', text: 'Tap to open' }));
    open.addEventListener('click', openEnvelope, { once: true });

    stage.append(back, flap, card, pocket, open, seal);
    $('#rsvp-jump').textContent = data.response.responded ? 'View your RSVP' : 'RSVP';
    app.classList.add('is-sealed');

    window.InvitationCard.fontsReady().then(() => window.InvitationCard.fit(svg));
    if (reduceMotion) openEnvelope();
  }

  function openEnvelope() {
    const stage = $('#invitation-stage');
    // Best effort: a hiccup here must never get in the way of the invitation.
    window.WeddingAPI.markOpened(invite.code).catch(() => {});
    const steps = reduceMotion
      ? [['done', 0]]
      : [['opening', 0], ['flap-open', 520], ['rising', 950], ['out', 1900], ['done', 2900]];
    steps.forEach(([name, at]) => setTimeout(() => {
      if (name === 'flap-open') stage.classList.add('is-flap-open');
      else stage.dataset.stage = name;
      if (name === 'out' || name === 'done') app.classList.remove('is-sealed');
    }, at));
  }

  const ICONS = {
    ceremony: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="18" cy="28" r="10"/><circle cx="30" cy="28" r="10"/><path d="M21 12l3-5 3 5-3 4z"/></svg>',
    reception: '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 6h8l-1 12a3 3 0 0 1-6 0zM26 6h8l-1 12a3 3 0 0 1-6 0z"/><path d="M18 21v18M30 21v18M13 39h10M25 39h10"/></svg>',
  };

  function renderEvents(data) {
    const wrap = $('#events');
    wrap.replaceChildren();
    wrap.classList.toggle('events--single', data.events.length === 1);
    data.events.forEach((ev) => {
      const icon = h('div', { class: 'event-card__icon' });
      icon.innerHTML = ICONS[ev.id] || ''; // static markup defined above, not guest data
      // Directions go to the street address only: adding the venue name lets Google
      // match a different place with a similar name.
      const destination = ev.address;
      wrap.append(h('article', { class: 'event-card' },
        icon,
        h('h2', { class: 'event-card__title', text: ev.title }),
        ev.date ? h('p', { class: 'event-card__line', text: ev.date }) : null,
        cellLines(ev.time).map((line) => h('p', { class: 'event-card__line', text: line })),
        ev.venue ? h('p', { class: 'event-card__venue', text: ev.venue }) : null,
        ev.address ? h('p', { class: 'event-card__address', text: ev.address }) : null,
        ev.address ? h('a', {
          class: 'event-card__map', target: '_blank', rel: 'noopener',
          href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`, text: 'Get directions',
        }) : null
      ));
    });
  }

  /* ---------- RSVP panel ---------- */

  function renderRsvpPanel(justSaved) {
    const { rsvp, response } = invite;
    $('#rsvp-deadline').textContent = rsvp.deadline
      ? (rsvp.open ? `Please reply by ${rsvp.deadlineText}.` : `RSVPs closed on ${rsvp.deadlineText}.`)
      : 'Please reply at your earliest convenience.';

    const showForm = rsvp.open && (editing || !response.responded);
    $('#rsvp-form').hidden = !showForm;
    $('#rsvp-summary').hidden = showForm;
    $('#rsvp-cancel').hidden = !(editing && response.responded);
    if (!showForm) renderSummary(justSaved);
  }

  function attendingFor(evId) {
    const { response } = invite;
    const list = response[evId].slice();
    if (response.plusOne && response.plusOne[evId] && response.plusOne.name) list.push(`${response.plusOne.name} (guest)`);
    return list;
  }

  function renderSummary(justSaved) {
    const { response, rsvp } = invite;
    const list = $('#rsvp-summary-list');
    list.replaceChildren();
    const anyone = invite.events.some((ev) => attendingFor(ev.id).length);

    if (!response.responded) {
      $('#rsvp-thanks').textContent = "We didn't receive an RSVP from you.";
    } else if (justSaved) {
      $('#rsvp-thanks').textContent = anyone
        ? "Thank you! We can't wait to celebrate with you."
        : "Thank you for letting us know. You'll be missed!";
    } else {
      $('#rsvp-thanks').textContent = 'We have your RSVP. Thank you!';
    }

    if (response.responded) {
      invite.events.forEach((ev) => {
        const going = attendingFor(ev.id);
        list.append(h('li', {},
          h('span', { class: 'rsvp-summary__event', text: ev.title }),
          h('span', { text: going.length ? `${formatList(going)} attending` : 'Not attending' })));
      });
    }

    $('#rsvp-edit').hidden = !rsvp.open;
    $('#rsvp-closed').hidden = rsvp.open;
    $('#rsvp-closed').textContent = 'RSVPs are closed. If something has changed, please reach out to Stephanie or Robert directly.';
  }

  /* ---------- RSVP form ---------- */

  function choiceRow(name, label, yesText, noText, context) {
    const who = context ? `${label}, ${context}` : label;
    return h('div', { class: 'guest-row', 'data-row': name },
      h('span', { class: 'guest-row__name', text: label }),
      h('div', { class: 'choice-row', role: 'radiogroup', 'aria-label': who },
        h('label', { class: 'choice' }, h('input', { type: 'radio', name, value: 'yes', 'aria-label': `${who}: ${yesText}` }), h('span', { text: yesText })),
        h('label', { class: 'choice' }, h('input', { type: 'radio', name, value: 'no', 'aria-label': `${who}: ${noText}` }), h('span', { text: noText }))));
  }

  const fieldName = (evId, i) => `${evId}-${i}`;

  function buildForm(data) {
    const wrap = $('#rsvp-events');
    wrap.replaceChildren();
    data.events.forEach((ev) => {
      wrap.append(h('fieldset', { class: 'event-choices' },
        h('legend', {}, h('span', { text: ev.title }), h('small', { text: [ev.date, ...cellLines(ev.time)].filter(Boolean).join(' · ') })),
        data.guests.map((name, i) => choiceRow(fieldName(ev.id, i), name, 'Joyfully accepts', 'Regretfully declines', ev.title))));
    });

    const plusOne = $('#plus-one');
    plusOne.hidden = !data.plusOneAllowed;
    const poEvents = $('#plus-one-events');
    poEvents.replaceChildren();
    if (data.plusOneAllowed) {
      data.events.forEach((ev) => poEvents.append(choiceRow(fieldName(ev.id, 'plusone'), ev.title, 'Attending', 'Not attending', 'your guest')));
    }
    prefill(data.response);
  }

  function setRadio(name, value) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => { input.checked = input.value === value; });
  }
  function getRadio(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function prefill(response) {
    document.querySelectorAll('#rsvp-form input[type="radio"]').forEach((r) => { r.checked = false; });
    $('#plus-one-name').value = '';
    if (response.responded) {
      invite.events.forEach((ev) => {
        invite.guests.forEach((name, i) => setRadio(fieldName(ev.id, i), response[ev.id].includes(name) ? 'yes' : 'no'));
      });
      if (invite.plusOneAllowed) {
        const po = response.plusOne || {};
        const bringing = Boolean(po.name) && invite.events.some((ev) => po[ev.id]);
        setRadio('plusone-bringing', bringing ? 'yes' : 'no');
        if (bringing) {
          $('#plus-one-name').value = po.name;
          invite.events.forEach((ev) => setRadio(fieldName(ev.id, 'plusone'), po[ev.id] ? 'yes' : 'no'));
        }
      }
    }
    syncPlusOne();
    clearErrors();
  }

  function syncPlusOne() {
    const bringing = getRadio('plusone-bringing') === 'yes';
    $('#plus-one-details').hidden = !bringing;
  }

  function clearErrors() {
    $('#form-error').hidden = true;
    document.querySelectorAll('.is-missing').forEach((el) => el.classList.remove('is-missing'));
  }

  function formError(message, elements) {
    const box = $('#form-error');
    box.textContent = message;
    box.hidden = false;
    (elements || []).forEach((el) => el && el.classList.add('is-missing'));
    const first = (elements && elements[0]) || box;
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Reads the form. Returns the request payload, or null after showing an error.
  function collect() {
    clearErrors();
    const attendance = {};
    const missing = [];
    invite.events.forEach((ev) => {
      attendance[ev.id] = [];
      invite.guests.forEach((name, i) => {
        const v = getRadio(fieldName(ev.id, i));
        if (!v) missing.push(document.querySelector(`[data-row="${fieldName(ev.id, i)}"]`));
        if (v === 'yes') attendance[ev.id].push(name);
      });
    });
    if (missing.length) {
      formError('Please choose "accepts" or "declines" for everyone on your invitation.', missing);
      return null;
    }

    const plusOne = { name: '', ceremony: false, reception: false };
    if (invite.plusOneAllowed) {
      const bringing = getRadio('plusone-bringing');
      if (!bringing) {
        formError("Please let us know whether you're bringing a guest.", [$('#plus-one')]);
        return null;
      }
      if (bringing === 'yes') {
        const name = $('#plus-one-name').value.replace(/\s+/g, ' ').trim();
        if (!name) {
          formError("Please enter your guest's name.", [$('#plus-one-name')]);
          $('#plus-one-name').focus();
          return null;
        }
        const poMissing = [];
        invite.events.forEach((ev) => {
          const v = getRadio(fieldName(ev.id, 'plusone'));
          if (!v) poMissing.push(document.querySelector(`[data-row="${fieldName(ev.id, 'plusone')}"]`));
          plusOne[ev.id] = v === 'yes';
        });
        if (poMissing.length) {
          formError('Please let us know which events your guest will attend.', poMissing);
          return null;
        }
        for (const ev of invite.events) {
          if (plusOne[ev.id] && !attendance[ev.id].length) {
            formError(`Your guest can only attend the ${ev.title.toLowerCase()} together with someone from your party.`,
              [document.querySelector(`[data-row="${fieldName(ev.id, 'plusone')}"]`)]);
            return null;
          }
        }
        if (plusOne.ceremony || plusOne.reception) plusOne.name = name;
      }
    }
    return { code: invite.code, attendance, plusOne };
  }

  $('#rsvp-form').addEventListener('change', (e) => {
    if (e.target.name === 'plusone-bringing') syncPlusOne();
    $('#form-error').hidden = true;
    const row = e.target.closest('.is-missing');
    if (row) row.classList.remove('is-missing');
  });

  $('#rsvp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const payload = collect();
    if (!payload) return;
    const button = $('#rsvp-submit');
    button.disabled = true;
    button.textContent = 'Sending…';
    window.WeddingAPI.submitRsvp(payload)
      .then((data) => {
        invite = data;
        editing = false;
        $('#rsvp-jump').textContent = 'View your RSVP';
        buildForm(data);
        renderRsvpPanel(true);
        $('#rsvp-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch((err) => formError(err.message || 'Something went wrong. Please try again.'))
      .finally(() => {
        button.disabled = false;
        button.textContent = 'Send RSVP';
      });
  });

  $('#rsvp-edit').addEventListener('click', () => {
    editing = true;
    prefill(invite.response);
    renderRsvpPanel();
    $('#rsvp-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#rsvp-cancel').addEventListener('click', () => {
    editing = false;
    renderRsvpPanel();
  });

  /* ---------- start ---------- */
  load(normalizeCode(new URLSearchParams(location.search).get('code')));
})();
