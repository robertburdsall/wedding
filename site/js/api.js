// Talks to the Google Apps Script web app (apps-script/Code.gs).
//
// Apps Script can't answer CORS preflight requests, so POSTs are sent as text/plain
// (a "simple" request that doesn't need one). Apps Script replies with a redirect to
// googleusercontent.com, which fetch() follows automatically.
window.WeddingAPI = (function () {
  'use strict';

  const TIMEOUT_MS = 25000;

  class ApiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function apiUrl() {
    const url = (window.WEDDING_CONFIG && window.WEDDING_CONFIG.apiUrl) || '';
    if (!/^https?:\/\//.test(url)) {
      throw new ApiError('not_configured', "Invitations aren't open yet. Please check back soon!");
    }
    return url;
  }

  async function request(url, options, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow', credentials: 'omit' });
    } catch (err) {
      throw new ApiError('network', 'We couldn\'t reach the RSVP service. Please check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new ApiError('network', 'The RSVP service sent an unexpected reply. Please try again in a minute.');
    }
    if (!body || body.ok !== true) {
      const err = new ApiError((body && body.error) || 'server_error', (body && body.message) || 'Something went wrong. Please try again.');
      err.detail = (body && body.detail) || ''; // what actually went wrong, for unexpected errors
      throw err;
    }
    return body.data;
  }

  async function getInvite(code) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'invite');
    url.searchParams.set('code', code);
    return request(url.toString(), { method: 'GET' });
  }

  // Tells the Sheet the guest has opened their envelope (fills in "Invite Opened At").
  async function markOpened(code) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'opened');
    url.searchParams.set('code', code);
    return request(url.toString(), { method: 'GET' });
  }

  // The reception dinner menu: who's choosing, the options, and any saved choices.
  async function getMeals(code) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'meal');
    url.searchParams.set('code', code);
    return request(url.toString(), { method: 'GET' });
  }

  async function saveMeals(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'meal', ...payload }),
    });
  }

  async function submitRsvp(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'rsvp', ...payload }),
    });
  }

  // The shared photo timeline (needs the photo code from the table cards).
  // `who` is { me, device }: whose camera this is, so the page can show how many photos are left.
  async function getPhotos(code, who = {}) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'photos');
    url.searchParams.set('t', code);
    if (who.me) url.searchParams.set('me', who.me);
    if (who.device) url.searchParams.set('device', who.device);
    return request(url.toString(), { method: 'GET' });
  }

  // Uploads one photo ({ code, data: base64 JPEG, from, caption, table, takenAt, width, height, uploadId }).
  // Photos are big and venue signal can be slow, so this waits longer than other requests.
  async function uploadPhoto(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'photo', ...payload }),
    }, 180000);
  }

  // One step of a video upload: { step: 'start' | 'chunk' | 'finish', uploadId, ... }.
  // Guests send their photo `code`; the highlight builder sends its review code as `k`.
  async function videoStep(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'video', ...payload }),
    }, 120000);
  }

  // Removes a photo or video this camera shared ({ code, id, me, device }).
  async function deleteUpload(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'delete', ...payload }),
    });
  }

  // The highlight builder: everything guests shared (needs the review code).
  async function getReview(k) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'review');
    url.searchParams.set('k', k);
    return request(url.toString(), { method: 'GET' });
  }

  // Part of one shared photo or video, base64 ({ size, offset, mime, data }).
  async function getMedia(k, id, offset) {
    const url = new URL(apiUrl());
    url.searchParams.set('action', 'media');
    url.searchParams.set('k', k);
    url.searchParams.set('id', id);
    url.searchParams.set('offset', String(offset || 0));
    return request(url.toString(), { method: 'GET' }, 120000);
  }

  return { getInvite, markOpened, submitRsvp, getMeals, saveMeals, getPhotos, uploadPhoto, videoStep, deleteUpload, getReview, getMedia, ApiError };
})();
