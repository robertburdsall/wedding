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

  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
      throw new ApiError((body && body.error) || 'server_error', (body && body.message) || 'Something went wrong. Please try again.');
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

  async function submitRsvp(payload) {
    return request(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'rsvp', ...payload }),
    });
  }

  return { getInvite, markOpened, submitRsvp, ApiError };
})();
