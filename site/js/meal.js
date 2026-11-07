// Dinner selection page: each reception guest in the household picks a meal, plus one note
// for dietary restrictions. Choices are saved to the household's row in the Google Sheet.
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  let menu = null;     // data returned by the API
  let editing = false;

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

  const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const setState = (state) => { app.dataset.state = state; };

  /* ---------- loading ---------- */

  function load(code) {
    if (!code) { showError({ code: 'no_code' }); return; }
    setState('loading');
    window.WeddingAPI.getMeals(code).then(render).catch(showError);
  }

  function showError(err) {
    const titles = {
      no_code: 'Find your dinner menu',
      not_found: "We couldn't find that invitation",
      not_reception: 'No dinner selection needed',
      not_configured: 'Almost ready!',
      network: 'Connection problem',
      rate_limited: 'Please try again in a few minutes',
    };
    const messages = {
      no_code: 'Enter the code from your invitation to choose your meals.',
      not_found: 'Please double-check the link, or type in the code from your invitation.',
    };
    const known = err && err.code && (err instanceof window.WeddingAPI.ApiError || titles[err.code]);
    if (!known) console.error(err);
    const code = known ? err.code : 'unknown';
    $('#error-title').textContent = titles[code] || "We couldn't open the menu";
    $('#error-message').textContent = messages[code] || (known && err.message) || 'Something went wrong. Please try again in a minute.';
    $('#code-form').hidden = code === 'not_reception';
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
    if (!data || !Array.isArray(data.people) || !Array.isArray(data.options)) {
      throw new window.WeddingAPI.ApiError('not_ready', "The dinner menu isn't quite ready. Please check back soon.");
    }
    menu = data;
    editing = false;
    document.title = `Dinner Selection · ${data.addressee || 'Stephanie & Robert'}`;
    $('#meal-for').textContent = data.addressee ? `For ${data.addressee}` : '';
    const d = data.deadline || {};
    $('#meal-deadline').textContent = d.deadline
      ? (d.open ? `Please choose by ${d.deadlineText}.` : `Meal choices closed on ${d.deadlineText}.`)
      : '';
    buildForm();
    renderPanel();
    setState('meal');
  }

  function renderPanel(justSaved) {
    const noOne = !menu.people.length;
    $('#meal-empty').hidden = !noOne;
    if (noOne) {
      $('#meal-empty-text').textContent = menu.responded
        ? "Your RSVP doesn't include anyone coming to the reception, so there's nothing to choose. If that's changed, update your RSVP first."
        : 'Please RSVP for the reception first. Then come back here to choose your meals.';
      $('#meal-rsvp-link').href = `../invite/?code=${encodeURIComponent(menu.code)}`;
      $('#meal-form').hidden = true;
      $('#meal-summary').hidden = true;
      return;
    }
    const open = !menu.deadline || menu.deadline.open !== false;
    const showForm = open && (editing || !menu.complete);
    $('#meal-form').hidden = !showForm;
    $('#meal-summary').hidden = showForm;
    $('#meal-cancel').hidden = !(editing && menu.complete);
    if (!showForm) renderSummary(justSaved, open);
  }

  function renderSummary(justSaved, open) {
    $('#meal-thanks').textContent = justSaved ? 'Thank you! Your meals are saved.' : 'Here are your meal choices.';
    const list = $('#meal-summary-list');
    list.replaceChildren(...menu.people.map((p) =>
      h('li', {}, h('span', { class: 'rsvp-summary__event', text: p }), h('span', { text: menu.choices[p] || 'Not chosen yet' }))));
    const notes = $('#meal-summary-notes');
    notes.hidden = !menu.notes;
    notes.textContent = menu.notes ? `Dietary notes: ${menu.notes}` : '';
    $('#meal-edit').hidden = !open;
    $('#meal-closed').hidden = open;
    $('#meal-closed').textContent = 'Meal choices are closed. If something has changed, please reach out to Stephanie or Robert.';
  }

  /* ---------- the form ---------- */

  const fieldName = (i) => `meal-${i}`;

  function buildForm() {
    const wrap = $('#meal-people');
    wrap.replaceChildren(...menu.people.map((person, i) =>
      h('div', { class: 'guest-row meal-row', 'data-row': fieldName(i) },
        h('span', { class: 'guest-row__name', text: person }),
        h('div', { class: 'choice-row', role: 'radiogroup', 'aria-label': `${person}'s meal` },
          menu.options.map((opt) => h('label', { class: 'choice' },
            h('input', { type: 'radio', name: fieldName(i), value: opt, 'aria-label': `${person}: ${opt}` }),
            h('span', { text: opt })))))));
    menu.people.forEach((person, i) => {
      const saved = menu.choices[person];
      document.querySelectorAll(`input[name="${fieldName(i)}"]`).forEach((r) => { r.checked = r.value === saved; });
    });
    $('#meal-notes').value = menu.notes || '';
    clearError();
  }

  function clearError() {
    $('#meal-error').hidden = true;
    document.querySelectorAll('.is-missing').forEach((el) => el.classList.remove('is-missing'));
  }

  $('#meal-form').addEventListener('change', (e) => {
    $('#meal-error').hidden = true;
    const row = e.target.closest('.is-missing');
    if (row) row.classList.remove('is-missing');
  });

  $('#meal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    clearError();
    const choices = {};
    const missing = [];
    menu.people.forEach((person, i) => {
      const checked = document.querySelector(`input[name="${fieldName(i)}"]:checked`);
      if (checked) choices[person] = checked.value;
      else missing.push(document.querySelector(`[data-row="${fieldName(i)}"]`));
    });
    if (missing.length) {
      const box = $('#meal-error');
      box.textContent = 'Please choose a meal for everyone.';
      box.hidden = false;
      missing.forEach((el) => el.classList.add('is-missing'));
      missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const button = $('#meal-submit');
    button.disabled = true;
    button.textContent = 'Saving…';
    window.WeddingAPI.saveMeals({ code: menu.code, choices, notes: $('#meal-notes').value })
      .then((data) => {
        menu = data;
        editing = false;
        buildForm();
        renderPanel(true);
        $('.meal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch((err) => {
        const box = $('#meal-error');
        box.textContent = (err && err.message) || 'Something went wrong. Please try again.';
        box.hidden = false;
      })
      .finally(() => {
        button.disabled = false;
        button.textContent = 'Save meals';
      });
  });

  $('#meal-edit').addEventListener('click', () => {
    editing = true;
    buildForm();
    renderPanel();
  });
  $('#meal-cancel').addEventListener('click', () => {
    editing = false;
    renderPanel();
  });

  load(normalizeCode(new URLSearchParams(location.search).get('code')));
})();
