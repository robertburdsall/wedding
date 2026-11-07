/**
 * Stephanie & Robert — invitations & RSVPs
 *
 * Google Apps Script attached to the guest-list Google Sheet. It:
 *   - adds a "Wedding" menu to the sheet (set up, generate codes, check the list, send invites/reminders)
 *   - serves a small JSON web API the website calls to show an invitation and save an RSVP
 *   - writes every RSVP back into the guest's row on the "Guests" sheet
 *   - saves photos guests share from the reception tables to a Google Drive folder
 *
 * See SETUP.md in the website repo for installation steps.
 */

// Bump this with every change; "?action=ping" on the web app URL shows which version is live.
var VERSION = '2.0.0';

var SHEET_NAMES = { guests: 'Guests', settings: 'Settings', summary: 'Summary', log: 'RSVP Log', photos: 'Photos' };

// Guest sheet columns are found by header text, so they can be reordered and extra columns added.
var COL = {
  code: 'Code',
  names: 'Guest Names',
  email: 'Email',
  type: 'Invite Type',
  plusOne: 'Plus One',
  status: 'RSVP Status',
  ceremony: 'Ceremony Attending',
  reception: 'Reception Attending',
  ceremonyDeclined: 'Ceremony Declined',
  receptionDeclined: 'Reception Declined',
  plusOneName: 'Plus One Name',
  plusOneStatus: 'Plus One Status',
  respondedAt: 'Responded At',
  sentAt: 'Invite Sent At',
  openedAt: 'Invite Opened At',
  reminderAt: 'Reminder Sent At',
  link: 'Invite Link',
  text: 'Text Message',
  mealChoices: 'Meal Choices',
  dietary: 'Dietary Notes',
  mealsAt: 'Meals Chosen At',
  mealLink: 'Meal Link',
  mealText: 'Meal Text Message',
  partySize: 'Party Size',
  notes: 'Notes'
};
var GUEST_HEADERS = [COL.code, COL.names, COL.email, COL.type, COL.plusOne, COL.status, COL.ceremony,
  COL.reception, COL.ceremonyDeclined, COL.receptionDeclined, COL.plusOneName, COL.plusOneStatus, COL.respondedAt, COL.sentAt, COL.openedAt, COL.reminderAt, COL.link, COL.text, COL.partySize,
  COL.mealChoices, COL.dietary, COL.mealsAt, COL.mealLink, COL.mealText, COL.notes];
var AUTO_HEADERS = [COL.code, COL.status, COL.ceremony, COL.reception, COL.ceremonyDeclined, COL.receptionDeclined, COL.plusOneName, COL.plusOneStatus, COL.respondedAt,
  COL.sentAt, COL.openedAt, COL.reminderAt, COL.link, COL.text, COL.partySize,
  COL.mealChoices, COL.dietary, COL.mealsAt, COL.mealLink, COL.mealText];
var GUEST_HEADER_NOTES = {
  'Code': 'Filled in automatically. Each household gets a unique code for its personal invite link.',
  'Guest Names': 'Everyone on this invitation, written the way it goes on the envelope. "Mr. & Mrs. John Smith" counts as two people (Mr. John Smith and Mrs. John Smith). Separate other people with commas: "Mr. & Mrs. John Smith, Miss Emma Smith".',
  'Party Size': 'Filled in automatically: how many people are on this invitation (not counting a plus one).',
  'Email': 'Where the invitation is emailed. Separate multiple addresses with commas.',
  'Invite Type': '"Wedding + Reception" or "Ceremony Only".',
  'Plus One': 'Yes = this household may bring one extra guest.',
  'RSVP Status': 'Filled in automatically when the guest RSVPs.',
  'Ceremony Attending': 'Filled in automatically: who is coming to the ceremony.',
  'Reception Attending': 'Filled in automatically: who is coming to the reception.',
  'Ceremony Declined': 'Filled in automatically: who on this invitation said no to the ceremony. Plus ones are not counted.',
  'Reception Declined': 'Filled in automatically: who on this invitation said no to the reception. Plus ones are not counted.',
  'Plus One Name': 'Filled in automatically from the RSVP form, only when their guest is coming.',
  'Plus One Status': 'Filled in automatically for households offered a plus one: Waiting for RSVP, Bringing a guest, or Not bringing a guest. Blank = no plus one offered.',
  'Invite Link': 'Filled in automatically. The personal link for this household.',
  'Text Message': 'Filled in automatically: a ready-to-send text with their link. Copy it into your phone. Change the wording on the Settings tab.',
  'Meal Choices': 'Filled in automatically from the meal page: what each reception guest is eating.',
  'Dietary Notes': 'Filled in automatically: dietary restrictions or allergies the guest typed on the meal page.',
  'Meals Chosen At': 'Filled in automatically when the household saves its meal choices.',
  'Meal Link': 'Filled in automatically for Wedding + Reception households: their personal meal page.',
  'Meal Text Message': 'Filled in automatically: a ready-to-send text with their meal link. Change the wording on the Settings tab.',
  'Invite Sent At': 'Filled in when the invite is emailed, or when you use Wedding → Mark selected rows as invited (texted).',
  'Invite Opened At': 'Filled in automatically the first time this household taps open the envelope on their invitation (or RSVPs). Blank = not opened yet. Link previews in texts and emails do not count. Opening it yourself to test does, so clear the cell afterwards.'
};

// The "Photos" tab: one row per shared photo.
var PHOTO_COL = {
  uploadedAt: 'Uploaded At',
  takenAt: 'Taken At',
  from: 'From',
  caption: 'Caption',
  table: 'Table',
  hidden: 'Hidden',
  preview: 'Preview',
  link: 'Photo',
  fileId: 'File ID',
  width: 'Width',
  height: 'Height',
  uploadId: 'Upload ID'
};
var PHOTO_HEADERS = Object.keys(PHOTO_COL).map(function (k) { return PHOTO_COL[k]; });
var PHOTO_HEADER_NOTES = {
  'Hidden': 'Tick to take this photo off the timeline and slideshow. The file stays in your Drive folder.',
  'Taken At': 'When the photo was taken, according to the guest\'s phone. The timeline is in this order.',
  'Table': 'Which table card the guest scanned.',
  'Photo': 'The photo in your Google Drive folder.'
};
// Phones shrink photos before uploading (see site/js/photos.js), so these are generous.
var PHOTO_MAX_BASE64 = 14 * 1024 * 1024; // about 10 MB of JPEG
var MAX_BODY_LENGTH = PHOTO_MAX_BASE64 + 20000;

var TYPE_FULL = 'Wedding + Reception';
var TYPE_CEREMONY = 'Ceremony Only';
var STATUS = { none: 'Not responded', attending: 'Attending', declined: 'Declined' };
var PLUS_ONE_STATUS = { waiting: 'Waiting for RSVP', bringing: 'Bringing a guest', notBringing: 'Not bringing a guest' };

var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
var CODE_LENGTH = 8; // 31^8 ≈ 850 billion possible codes
var MAX_NAME_LENGTH = 80;

// Brute-force protection: after this many wrong codes in a 10-minute window (from anyone),
// all lookups pause until the window ends. Legitimate typos come nowhere near this.
var LOOKUP_LIMIT = 60;
var LOOKUP_WINDOW_MS = 10 * 60 * 1000;

// At most one confirmation/notification email per household in this many seconds.
var EMAIL_COOLDOWN_SECONDS = 10 * 60;

var MEAL_TEXT_DEFAULT = 'Hi {first names}! Please choose your dinner for our reception{meal deadline}: {meal link}';

var TEXT_TEMPLATE_DEFAULT = "Hi {first names}! We're getting married and would love for you to join us for {events}. " +
  "{plus one}Here's your invitation, where you can RSVP{deadline}: {link}";

// [setting, default value, help text]
var SETTINGS_DEFAULTS = [
  ['Site URL', 'https://example.com', 'Your website address, no slash at the end. Invite links are built from this.'],
  ['RSVP Deadline', '', 'Last day guests can RSVP or change their answer. Leave blank for no deadline.'],
  ['Ceremony Date', '', 'For example: Saturday, June 6, 2099. Shown under the invitation, in emails and as {date} in texts.'],
  ['Ceremony Time', '', 'For example: 2:00 PM'],
  ['Ceremony Venue', '', ''],
  ['Ceremony Address', '', 'Adds a "Get directions" link under the invitation.'],
  ['Reception Time', '', 'Only shown to Wedding + Reception guests.'],
  ['Reception Venue', '', 'Only shown to Wedding + Reception guests.'],
  ['Reception Address', '', 'Only shown to Wedding + Reception guests.'],
  ['Invitation Date & Time', '', 'Both invitation cards: the date and time in words. Type normally (the card shows capitals) and put " / " where each new line starts.'],
  ['Invitation Location', '', 'Both invitation cards: the bottom line. For two lines, put " / " or \\n between them.'],
  ['Full Invite: Hosts', 'Together with their families', 'Wedding + Reception card: the top line.'],
  ['Full Invite: Request', '', 'Wedding + Reception card: the line(s) under the hosts. Use " / " between lines.'],
  ['Full Invite: First Name', 'Stephanie', 'Wedding + Reception card: the first name, in script.'],
  ['Full Invite: Joiner', 'and', 'Wedding + Reception card: the small script word between the names.'],
  ['Full Invite: Second Name', 'Robert', 'Wedding + Reception card: the second name, in script.'],
  ['Full Invite: Under Names', '', 'Wedding + Reception card: an optional line under the names. Leave it blank to leave it off; the request lines and names then center themselves between the hosts and the date.'],
  ['Full Invite: Closing Line', 'Reception to follow', 'Wedding + Reception card: a line under the address. Blank = none.'],
  ['Ceremony Invite: Intro', 'You are invited to', 'Ceremony Only card: the top line.'],
  ['Ceremony Invite: Names', "Stephanie & Robert's", 'Ceremony Only card: the names, in script. Keep the " & " to get the decorative ampersand.'],
  ['Ceremony Invite: Title', 'Wedding', 'Ceremony Only card: the large word under the names.'],
  ['Sender Name', 'Stephanie & Robert', 'The "from" name on emails.'],
  ['Reply-To Email', '', 'Where guest replies go. Blank = the Gmail account that owns this sheet.'],
  ['Invite Email Subject', "You're invited! Stephanie & Robert", ''],
  ['Reminder Email Subject', "Reminder: please RSVP for Stephanie & Robert's wedding", ''],
  ['Send RSVP Confirmations', 'Yes', 'Yes = email guests a copy of their RSVP.'],
  ['Notify Email', '', 'Get an email here every time someone RSVPs. Blank = off.'],
  ['Text Message', TEXT_TEMPLATE_DEFAULT, 'Wording for the "Text Message" column on the Guests tab. You can use: {first names} {names} {date} {events} {plus one} {deadline} {link} {code}'],
  ['Meal Options', 'North Atlantic Salmon / Filet Mignon', 'The dinner choices for reception guests, separated by " / ". After changing them, run Wedding → Set up sheets so the Summary counts them.'],
  ['Meal Deadline', '', 'Last day reception guests can choose or change their meals. Blank = no deadline.'],
  ['Meal Text Message', MEAL_TEXT_DEFAULT, 'Wording for the "Meal Text Message" column. You can use: {first names} {names} {meal link} {meal deadline} {code}'],
  ['Photo Code', '', 'The secret code on the table QR cards that lets guests share and see photos. Filled in automatically. Clear it to get a new one (old cards then stop working).'],
  ['Photo Uploads Until', '', 'Last day guests can add photos. Blank = no end. The timeline stays viewable either way.'],
  ['Photo Moments', '', 'Optional: names parts of the wedding day on the photo timeline by start time, for example: 3:00 PM Getting ready / 4:00 PM Ceremony / 5:00 PM Cocktail hour / 7:00 PM Dinner / 8:30 PM Dancing. Uses the Ceremony Date as the day.'],
  ['Photo Folder', '', 'Filled in automatically: the Google Drive folder photos are saved to. You can paste the link to a different folder of yours instead.'],
  ['Photo Page Link', '', 'Filled in automatically: the link in the table QR codes.'],
  ['Photo Slideshow Link', '', 'Filled in automatically: open this on a TV or projector for a live slideshow of the photos.'],
  ['Photo Table Cards Link', '', 'Filled in automatically: open this on a computer to print the table QR cards.']
];

/* =====================================================================
 * Context: which spreadsheet and sheet names to use (the self-test swaps these).
 * ===================================================================== */

var CTX_OVERRIDE_ = null;

function ctx_() {
  if (CTX_OVERRIDE_) return CTX_OVERRIDE_;
  return { ss: SpreadsheetApp.getActiveSpreadsheet(), names: SHEET_NAMES };
}

function sheet_(c, key) {
  return c.ss.getSheetByName(c.names[key]);
}

function AppError_(code, message) {
  this.code = code;
  this.message = message;
}

function fail_(code, message) {
  throw new AppError_(code, message);
}

/* =====================================================================
 * Web API (called by the website)
 * ===================================================================== */

function doGet(e) {
  return respond_(function () {
    return handleGet_(ctx_(), (e && e.parameter) || {}, new Date());
  });
}

function doPost(e) {
  return respond_(function () {
    return handlePost_(ctx_(), parseBody_(e), new Date());
  });
}

function respond_(fn) {
  var out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    if (err instanceof AppError_) {
      out = { ok: false, error: err.code, message: err.message };
    } else {
      console.error(err && err.stack ? err.stack : err);
      out = { ok: false, error: 'server_error', message: 'Something went wrong on our end. Please try again in a minute.' };
    }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) fail_('bad_request', 'Missing request body.');
  if (raw.length > MAX_BODY_LENGTH) fail_('too_large', 'That photo is too large to share. Please try a different one.');
  var body;
  try {
    body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch (err) {
    fail_('bad_request', 'Request was not valid JSON.');
  }
  // Only photo uploads may be big.
  if (raw.length > 10000 && body.action !== 'photo') fail_('bad_request', 'Request is too large.');
  return body;
}

function handleGet_(c, params, now) {
  var action = String(params.action || 'invite');
  if (action === 'ping') return { version: VERSION };
  if (action === 'photos') {
    var photoSettings = readSettings_(c);
    checkPhotoCode_(photoSettings, params.t || params.code, now);
    return photosPayload_(c, photoSettings, now);
  }
  if (action !== 'invite' && action !== 'opened' && action !== 'meal') fail_('bad_request', 'Unknown action.');

  var settings = readSettings_(c);
  var table = readGuests_(c);
  var guest = lookupGuest_(table, params.code, now);
  // "opened" is sent when the guest taps the envelope open. Merely loading the page doesn't
  // count, because link previews and email scanners load pages without anyone looking.
  if (action === 'opened') {
    markOpened_(table, guest, now);
    return { opened: true };
  }
  if (action === 'meal') return mealPayload_(guest, settings, now);
  return invitePayload_(guest, settings, now);
}

function handlePost_(c, body, now) {
  if (body.action === 'rsvp') return submitRsvp_(c, body, now);
  if (body.action === 'meal') return submitMeals_(c, body, now);
  if (body.action === 'photo') return submitPhoto_(c, body, now);
  fail_('bad_request', 'Unknown action.');
}

/* =====================================================================
 * Reading the sheets
 * ===================================================================== */

function readGuests_(c) {
  var sh = sheet_(c, 'guests');
  if (!sh) fail_('setup', 'The "' + c.names.guests + '" sheet is missing. Use Wedding → Set up sheets.');
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var lastRow = sh.getLastRow();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });

  var cols = {};
  Object.keys(COL).forEach(function (key) { cols[key] = header.indexOf(COL[key]); });
  ['code', 'names', 'type', 'plusOne', 'status', 'ceremony', 'reception', 'plusOneName', 'respondedAt'].forEach(function (key) {
    if (cols[key] < 0) fail_('setup', 'The guest sheet is missing the "' + COL[key] + '" column. Use Wedding → Set up sheets.');
  });

  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var guests = rows.map(function (row, i) { return guestFromRow_(row, cols, i + 2); });
  return { sheet: sh, cols: cols, guests: guests };
}

function guestFromRow_(row, cols, rowNumber) {
  function get(key) { return cols[key] >= 0 ? row[cols[key]] : ''; }
  return {
    row: rowNumber,
    code: normalizeCode_(get('code')),
    entries: splitList_(get('names')),
    names: peopleIn_(splitList_(get('names'))),
    namesRaw: String(get('names')),
    partySizeRaw: get('partySize'),
    emails: splitEmails_(get('email')),
    emailRaw: String(get('email')).trim(),
    typeRaw: String(get('type')).trim(),
    type: parseType_(get('type')),
    plusOneRaw: String(get('plusOne')).trim(),
    plusOneAllowed: parseYes_(get('plusOne')) || hasPlusGuest_(splitList_(get('names'))),
    status: String(get('status')).trim(),
    ceremony: splitList_(get('ceremony')),
    reception: splitList_(get('reception')),
    ceremonyDeclined: String(get('ceremonyDeclined')).trim(),
    receptionDeclined: String(get('receptionDeclined')).trim(),
    plusOneName: String(get('plusOneName')).trim(),
    plusOneStatus: String(get('plusOneStatus')).trim(),
    respondedAt: get('respondedAt'),
    sentAt: get('sentAt'),
    openedAt: get('openedAt'),
    reminderAt: get('reminderAt'),
    link: String(get('link')).trim(),
    text: String(get('text')),
    mealChoicesRaw: String(get('mealChoices')).trim(),
    dietary: String(get('dietary')).trim(),
    mealsAt: get('mealsAt'),
    mealLink: String(get('mealLink')).trim(),
    mealText: String(get('mealText'))
  };
}

function findGuest_(table, code) {
  code = normalizeCode_(code);
  if (!code) fail_('bad_request', 'Please enter your invitation code.');
  for (var i = 0; i < table.guests.length; i++) {
    if (table.guests[i].code === code) {
      var g = table.guests[i];
      if (!g.names.length || !g.type) {
        fail_('not_ready', "This invitation isn't quite ready yet. Please check back soon or contact Stephanie or Robert.");
      }
      return g;
    }
  }
  fail_('not_found', "We couldn't find that invitation. Please double-check the link or code on your invitation.");
}

// findGuest_ plus brute-force protection (see LOOKUP_LIMIT).
function lookupGuest_(table, code, now) {
  var guard = codeGuard_(now);
  try {
    return findGuest_(table, code);
  } catch (err) {
    if (err instanceof AppError_ && err.code === 'not_found') guard.miss();
    throw err;
  }
}

// Stops lookups for the rest of the window once there have been too many wrong codes.
function codeGuard_(now) {
  var cache = CacheService.getScriptCache();
  var key = 'badcodes:' + Math.floor(now.getTime() / LOOKUP_WINDOW_MS);
  var misses = Number(cache.get(key) || 0);
  if (misses >= LOOKUP_LIMIT) {
    fail_('rate_limited', 'Too many attempts right now. Please wait a few minutes and try again.');
  }
  return { miss: function () { cache.put(key, String(misses + 1), 2 * LOOKUP_WINDOW_MS / 1000); } };
}

// Records the first time a household opens its invitation. Never blocks the invitation itself.
function markOpened_(table, g, now) {
  if (table.cols.openedAt < 0 || (g.openedAt !== '' && g.openedAt !== null && g.openedAt !== undefined)) return;
  try {
    writeRow_(table, g.row, { openedAt: now });
    g.openedAt = now;
  } catch (err) {
    console.error('Could not record invite opened: ' + (err && err.message ? err.message : err));
  }
}

function readSettings_(c) {
  var settings = {};
  SETTINGS_DEFAULTS.forEach(function (d) { settings[d[0]] = d[1]; });
  var sh = sheet_(c, 'settings');
  if (sh && sh.getLastRow() > 0) {
    sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function (r) {
      var key = String(r[0]).trim();
      if (key && Object.prototype.hasOwnProperty.call(settings, key)) settings[key] = r[1];
    });
  }
  return settings;
}

// Google Sheets turns typed dates/times into Date objects; this turns them back into readable text.
function setting_(settings, key) {
  var v = settings[key];
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    var tz = Session.getScriptTimeZone();
    return v.getFullYear() < 1900 ? Utilities.formatDate(v, tz, 'h:mm a') : Utilities.formatDate(v, tz, 'EEEE, MMMM d, yyyy');
  }
  return String(v).trim();
}

/* =====================================================================
 * Parsing helpers
 * ===================================================================== */

function normalizeCode_(v) {
  return String(v === null || v === undefined ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function splitList_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/[,\n]/)
    .map(function (s) { return s.replace(/\s+/g, ' ').trim(); })
    .filter(function (s) { return s.length > 0; });
}

function splitEmails_(v) {
  return String(v || '').split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
}

function isEmail_(s) {
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
}

function parseType_(v) {
  var s = String(v || '').toLowerCase();
  if (/recep/.test(s)) return 'full';
  if (/ceremon|wedding/.test(s)) return 'ceremony';
  return null;
}

function parseYes_(v) {
  if (v === true) return true;
  return /^(y|yes|true|1|x|✓)$/i.test(String(v || '').trim());
}

function sameName_(a, b) {
  return String(a).replace(/\s+/g, ' ').trim().toLowerCase() === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanName_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[\u0000-\u001f,;<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

// Stops guest-typed text from being treated as a spreadsheet formula.
function safeText_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// "Mr. & Mrs. John Smith" → ["Mr. John Smith", "Mrs. John Smith"]; "John & Jane Smith" →
// ["John Smith", "Jane Smith"]. Anything else is one person. Each person gets their own RSVP row.
var HONORIFIC_ = '(?:mr|mrs|ms|miss|mx|dr|rev|prof|sir|dame|lady|lord|capt|col|maj|gen|judge|hon)\\.?';
var COUPLE_TITLES_ = new RegExp('^(' + HONORIFIC_ + ')(?:\\s*&\\s*|\\s+and\\s+)(' + HONORIFIC_ + ')\\s+(.+)$', 'i');
var COUPLE_FIRST_NAMES_ = /^([A-Za-z][A-Za-z'\-]*)(?:\s*&\s*|\s+and\s+)([A-Za-z][A-Za-z'\-]*)\s+(.+)$/;
var STARTS_WITH_TITLE_ = new RegExp('^' + HONORIFIC_ + '(\\s|$)', 'i');

// "Mr. John Smith & Guest" (or "and Guest", "+ Guest", "+1") means John plus a plus one.
var PLUS_GUEST_ = /\s*(?:(?:&|and|\+)\s*(?:a\s+)?guest|\+\s*1)\s*$/i;

function withoutGuest_(entry) {
  return entry.replace(PLUS_GUEST_, '').trim();
}

function hasPlusGuest_(entries) {
  return entries.some(function (e) { return PLUS_GUEST_.test(e); });
}

function peopleIn_(entries) {
  var people = [];
  entries.forEach(function (raw) {
    var entry = withoutGuest_(raw);
    if (!entry) return;
    var m = entry.match(COUPLE_TITLES_);
    if (m) { people.push(m[1] + ' ' + m[3], m[2] + ' ' + m[3]); return; }
    m = entry.match(COUPLE_FIRST_NAMES_);
    if (m && !STARTS_WITH_TITLE_.test(m[1])) { people.push(m[1] + ' ' + m[3], m[2] + ' ' + m[3]); return; }
    people.push(entry);
  });
  return people;
}

// How a household is addressed (envelope, page title, emails): exactly as typed in Guest Names,
// character for character. Line breaks inside the cell become ", ".
function addressee_(g) {
  var typed = (g.entries || []).join(', ');
  return typed || formatList_(g.names);
}

function formatList_(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' & ' + items[items.length - 1];
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var MONTHS_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Returns 'yyyy-MM-dd' or null.
function dateKey_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US style MM/DD/YYYY
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  m = s.match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/); // "Saturday, June 6, 2099"
  if (m) {
    var month = -1;
    MONTHS_.forEach(function (name, i) { if (name.toLowerCase().indexOf(m[1].toLowerCase()) === 0 && m[1].length >= 3) month = i; });
    if (month >= 0) return m[3] + '-' + ('0' + (month + 1)).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  }
  return null;
}

function dateKeyText_(key) {
  var p = key.split('-');
  return MONTHS_[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
}

function rsvpInfo_(settings, now) {
  return deadlineInfo_(settings, 'RSVP Deadline', now);
}

function deadlineInfo_(settings, setting, now) {
  var key = dateKey_(settings[setting]);
  if (!key) return { deadline: null, deadlineText: '', open: true };
  var today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return { deadline: key, deadlineText: dateKeyText_(key), open: today <= key };
}

/* =====================================================================
 * Invitation payload (what the website receives)
 * ===================================================================== */

function events_(type, settings) {
  var events = [{
    id: 'ceremony',
    title: 'Ceremony',
    date: setting_(settings, 'Ceremony Date'),
    time: setting_(settings, 'Ceremony Time'),
    venue: setting_(settings, 'Ceremony Venue'),
    address: setting_(settings, 'Ceremony Address')
  }];
  if (type === 'full') {
    events.push({
      id: 'reception',
      title: 'Reception',
      date: setting_(settings, 'Ceremony Date'),
      time: setting_(settings, 'Reception Time'),
      venue: setting_(settings, 'Reception Venue'),
      address: setting_(settings, 'Reception Address')
    });
  }
  return events;
}

// Splits a setting into card lines at new lines, " / ", or a typed "\n".
function lines_(v) {
  return String(v === null || v === undefined ? '' : v)
    .split(/\s*(?:\r?\n|\\n|\s\/\s)\s*/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

// The wording of the invitation card. It lives only in the Sheet, so nothing about the
// day is in the public website code. Each invite type gets only its own card's wording.
function invitation_(type, settings) {
  var shared = {
    when: lines_(setting_(settings, 'Invitation Date & Time')),
    where: lines_(setting_(settings, 'Invitation Location'))
  };
  if (type === 'full') {
    return {
      design: 'full',
      hosts: lines_(setting_(settings, 'Full Invite: Hosts')),
      request: lines_(setting_(settings, 'Full Invite: Request')),
      firstName: String(setting_(settings, 'Full Invite: First Name')),
      joiner: String(setting_(settings, 'Full Invite: Joiner')),
      secondName: String(setting_(settings, 'Full Invite: Second Name')),
      underNames: lines_(setting_(settings, 'Full Invite: Under Names')),
      when: shared.when,
      where: shared.where,
      closing: lines_(setting_(settings, 'Full Invite: Closing Line'))
    };
  }
  return {
    design: 'ceremony',
    intro: lines_(setting_(settings, 'Ceremony Invite: Intro')),
    names: String(setting_(settings, 'Ceremony Invite: Names')),
    title: String(setting_(settings, 'Ceremony Invite: Title')),
    when: shared.when,
    where: shared.where
  };
}

// Who on the invitation said no to each event, once the household has responded.
// Plus ones aren't counted: they're optional, not invited guests.
function declined_(g) {
  if (!hasResponded_(g)) return { ceremonyDeclined: '', receptionDeclined: '' };
  function no(list) {
    return g.names.filter(function (n) { return !list.some(function (x) { return sameName_(x, n); }); }).join(', ');
  }
  return { ceremonyDeclined: no(g.ceremony), receptionDeclined: g.type === 'full' ? no(g.reception) : '' };
}

// One clear word on whether a household's plus one is coming. Blank when no plus one was offered.
function plusOneStatus_(g) {
  if (!g.plusOneAllowed) return '';
  if (!hasResponded_(g)) return PLUS_ONE_STATUS.waiting;
  var coming = !!g.plusOneName && g.ceremony.concat(g.reception).some(function (n) { return sameName_(n, g.plusOneName); });
  return coming ? PLUS_ONE_STATUS.bringing : PLUS_ONE_STATUS.notBringing;
}

function pickNames_(list, allowed) {
  return allowed.filter(function (name) {
    return list.some(function (n) { return sameName_(n, name); });
  });
}

function hasResponded_(g) {
  return g.status === STATUS.attending || g.status === STATUS.declined || (g.respondedAt !== '' && g.respondedAt !== null);
}

function invitePayload_(g, settings, now) {
  var plusOne = null;
  if (g.plusOneAllowed) {
    var inList = function (list) { return !!g.plusOneName && list.some(function (n) { return sameName_(n, g.plusOneName); }); };
    plusOne = { name: g.plusOneName, ceremony: inList(g.ceremony) };
    if (g.type === 'full') plusOne.reception = inList(g.reception);
  }
  // Ceremony-only invitations get no reception fields at all.
  var response = { responded: hasResponded_(g), ceremony: pickNames_(g.ceremony, g.names) };
  if (g.type === 'full') response.reception = pickNames_(g.reception, g.names);
  response.plusOne = plusOne;
  return {
    code: g.code,
    guests: g.names,
    addressee: addressee_(g),
    type: g.type,
    plusOneAllowed: g.plusOneAllowed,
    invitation: invitation_(g.type, settings),
    events: events_(g.type, settings),
    response: response,
    rsvp: rsvpInfo_(settings, now)
  };
}

/* =====================================================================
 * Saving an RSVP
 * ===================================================================== */

function validateNames_(list, allowed, eventTitle) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail_('bad_request', 'Invalid ' + eventTitle + ' response.');
  var picked = [];
  list.forEach(function (n) {
    if (typeof n !== 'string') fail_('bad_request', 'Invalid ' + eventTitle + ' response.');
    var match = allowed.filter(function (a) { return sameName_(a, n); })[0];
    if (!match) fail_('unknown_guest', '"' + cleanName_(n) + '" is not on this invitation.');
    if (picked.indexOf(match) < 0) picked.push(match);
  });
  return allowed.filter(function (a) { return picked.indexOf(a) >= 0; }); // keep sheet order
}

function submitRsvp_(c, body, now) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var result;
  try {
    var settings = readSettings_(c);
    var table = readGuests_(c);
    var g = lookupGuest_(table, body.code, now);
    var rsvp = rsvpInfo_(settings, now);
    if (!rsvp.open) {
      fail_('closed', 'RSVPs closed on ' + rsvp.deadlineText + '. Please contact Stephanie or Robert directly.');
    }

    var att = body.attendance || {};
    if (typeof att !== 'object') fail_('bad_request', 'Invalid response.');
    var ceremony = validateNames_(att.ceremony, g.names, 'ceremony');
    var reception = [];
    if (g.type === 'full') {
      reception = validateNames_(att.reception, g.names, 'reception');
    } else if (Array.isArray(att.reception) && att.reception.length) {
      fail_('bad_request', 'This invitation is for the ceremony only.');
    }

    var po = body.plusOne && typeof body.plusOne === 'object' ? body.plusOne : {};
    var poName = cleanName_(po.name);
    var poCeremony = po.ceremony === true;
    var poReception = po.reception === true;
    if ((poCeremony || poReception) && !g.plusOneAllowed) fail_('bad_request', "This invitation doesn't include a plus one.");
    if (poReception && g.type !== 'full') fail_('bad_request', 'This invitation is for the ceremony only.');
    if (poCeremony || poReception) {
      if (!poName) fail_('plus_one_name', "Please enter your guest's name.");
      if (g.names.some(function (n) { return sameName_(n, poName); })) {
        fail_('plus_one_name', "Your guest's name matches someone already on your invitation.");
      }
      if (poCeremony && !ceremony.length) fail_('plus_one_alone', 'Your guest can only attend the ceremony together with someone from your party.');
      if (poReception && !reception.length) fail_('plus_one_alone', 'Your guest can only attend the reception together with someone from your party.');
    } else {
      poName = '';
    }

    var ceremonyList = ceremony.concat(poCeremony ? [poName] : []);
    var receptionList = reception.concat(poReception ? [poName] : []);
    var status = ceremonyList.length || receptionList.length ? STATUS.attending : STATUS.declined;

    var values = {};
    values.status = status;
    values.ceremony = ceremonyList.join(', ');
    values.reception = g.type === 'full' ? receptionList.join(', ') : '';
    values.plusOneName = poName;
    values.respondedAt = now;
    writeRow_(table, g.row, values);

    g.status = status;
    g.ceremony = ceremonyList;
    g.reception = receptionList;
    g.plusOneName = poName;
    g.respondedAt = now;
    writeRow_(table, g.row, declined_(g));
    writeRow_(table, g.row, { plusOneStatus: plusOneStatus_(g) });
    pruneMeals_(table, g);
    markOpened_(table, g, now);

    appendLog_(c, now, g, body);
    SpreadsheetApp.flush();
    result = invitePayload_(g, settings, now);
  } finally {
    lock.releaseLock();
  }

  // Emails are best-effort: a mail problem must never lose an RSVP that's already saved.
  try {
    sendRsvpEmails_(c, g, result, settings);
  } catch (err) {
    console.error('RSVP email failed: ' + (err && err.message ? err.message : err));
  }
  return result;
}

/* =====================================================================
 * Meals (reception guests choose dinner on /meal/?code=…)
 * ===================================================================== */

function mealOptions_(settings) {
  return lines_(setting_(settings, 'Meal Options'));
}

// "Name: Meal; Name: Meal" ↔ list of { name, meal }.
function parseMeals_(raw) {
  var out = [];
  String(raw || '').split(';').forEach(function (part) {
    var i = part.lastIndexOf(':');
    if (i < 0) return;
    var name = part.slice(0, i).trim();
    var meal = part.slice(i + 1).trim();
    if (name && meal) out.push({ name: name, meal: meal });
  });
  return out;
}

function formatMeals_(list) {
  return list.map(function (m) { return m.name + ': ' + m.meal; }).join('; ');
}

// The saved choices that still apply: only people currently coming to the reception, in that order.
function currentMeals_(g) {
  var saved = parseMeals_(g.mealChoicesRaw);
  var out = [];
  g.reception.forEach(function (person) {
    var m = saved.filter(function (s) { return sameName_(s.name, person); })[0];
    if (m) out.push({ name: person, meal: m.meal });
  });
  return out;
}

// After an RSVP change, drop meal choices for anyone no longer coming to the reception.
function pruneMeals_(table, g) {
  if (table.cols.mealChoices < 0 || !g.mealChoicesRaw) return;
  var kept = formatMeals_(currentMeals_(g));
  if (kept !== g.mealChoicesRaw) {
    writeRow_(table, g.row, { mealChoices: kept });
    g.mealChoicesRaw = kept;
  }
}

function mealPayload_(g, settings, now) {
  if (g.type !== 'full') fail_('not_reception', 'This dinner menu is only for guests invited to the reception.');
  var chosen = currentMeals_(g);
  var choices = {};
  chosen.forEach(function (m) { choices[m.name] = m.meal; });
  return {
    code: g.code,
    addressee: addressee_(g),
    responded: hasResponded_(g),
    people: g.reception.slice(),
    options: mealOptions_(settings),
    choices: choices,
    complete: g.reception.length > 0 && chosen.length === g.reception.length,
    notes: g.dietary,
    deadline: deadlineInfo_(settings, 'Meal Deadline', now)
  };
}

function submitMeals_(c, body, now) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var settings = readSettings_(c);
    var table = readGuests_(c);
    var g = lookupGuest_(table, body.code, now);
    if (g.type !== 'full') fail_('not_reception', 'This dinner menu is only for guests invited to the reception.');
    var info = deadlineInfo_(settings, 'Meal Deadline', now);
    if (!info.open) fail_('closed', 'Meal choices closed on ' + info.deadlineText + '. Please contact Stephanie or Robert directly.');
    if (!g.reception.length) fail_('no_reception_guests', 'Please RSVP for the reception first, then choose your meals here.');
    var options = mealOptions_(settings);
    if (!options.length) fail_('setup', 'The dinner menu is not set up yet. Please check back soon.');

    var raw = body.choices;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail_('bad_request', 'Invalid meal choices.');
    var picked = {};
    Object.keys(raw).forEach(function (name) {
      var person = g.reception.filter(function (p) { return sameName_(p, name); })[0];
      if (!person) fail_('unknown_guest', '"' + cleanName_(name) + '" is not coming to the reception on this invitation.');
      var meal = typeof raw[name] === 'string' ? options.filter(function (o) { return sameName_(o, raw[name]); })[0] : null;
      if (!meal) fail_('bad_request', 'Please choose one of the menu options for ' + person + '.');
      picked[person] = meal;
    });
    var missing = g.reception.filter(function (p) { return !picked[p]; });
    if (missing.length) fail_('meal_missing', 'Please choose a meal for ' + formatList_(missing) + '.');

    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') fail_('bad_request', 'Invalid dietary notes.');
    var notes = String(body.notes || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

    var list = g.reception.map(function (p) { return { name: p, meal: picked[p] }; });
    g.mealChoicesRaw = formatMeals_(list);
    g.dietary = notes;
    g.mealsAt = now;
    writeRow_(table, g.row, { mealChoices: g.mealChoicesRaw, dietary: notes, mealsAt: now });
    logMeals_(c, now, g, body);
    SpreadsheetApp.flush();
    return mealPayload_(g, settings, now);
  } finally {
    lock.releaseLock();
  }
}

function logMeals_(c, now, g, body) {
  var sh = sheet_(c, 'log');
  if (!sh) {
    sh = c.ss.insertSheet(c.names.log);
    sh.appendRow(['Time', 'Code', 'Guest Names', 'Status', 'Ceremony', 'Reception', 'Raw Response']);
    sh.setFrozenRows(1);
  }
  sh.appendRow([now, g.code, safeText_(g.names.join(', ')), 'Meal choices', safeText_(g.mealChoicesRaw),
    safeText_(g.dietary), safeText_(JSON.stringify(body).slice(0, 2000))]);
}

/* =====================================================================
 * Photo sharing: guests scan the QR card on their table, add photos, and see
 * everyone's photos on a timeline. Photos are saved to a Google Drive folder
 * and listed on the "Photos" tab, where ticking "Hidden" takes one off the timeline.
 * ===================================================================== */

function photoCode_(settings) {
  return normalizeCode_(setting_(settings, 'Photo Code'));
}

// Wrong photo codes count toward the same brute-force limit as wrong invitation codes.
function checkPhotoCode_(settings, code, now) {
  var guard = codeGuard_(now);
  var given = normalizeCode_(code);
  if (!given) fail_('bad_request', 'Please enter the photo code from your table card.');
  var real = photoCode_(settings);
  if (!real) fail_('not_ready', "Photo sharing isn't open yet. Please check back soon!");
  if (given !== real) {
    guard.miss();
    fail_('not_found', "That photo code didn't work. Please scan the QR code on your table card again.");
  }
}

function photoLinks_(settings, code) {
  var base = String(setting_(settings, 'Site URL')).replace(/\/+$/, '');
  return {
    'Photo Page Link': base + '/photos/?t=' + code,
    'Photo Slideshow Link': base + '/photos/slideshow.html?t=' + code,
    'Photo Table Cards Link': base + '/photos/cards.html?t=' + code
  };
}

// Gives the photo page a secret code (once) and keeps its links on the Settings tab current.
function ensurePhotoSettings_(c, settings) {
  var code = photoCode_(settings);
  if (!code) {
    code = randomCode_();
    if (!writeSetting_(c, 'Photo Code', code)) return;
    settings['Photo Code'] = code;
  }
  var links = photoLinks_(settings, code);
  Object.keys(links).forEach(function (key) {
    if (setting_(settings, key) !== links[key] && writeSetting_(c, key, links[key])) settings[key] = links[key];
  });
}

function writeSetting_(c, key, value) {
  var sh = sheet_(c, 'settings');
  if (!sh || !sh.getLastRow()) return false;
  var keys = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setNumberFormat('@').setValue(value);
      return true;
    }
  }
  return false;
}

// "4:00 PM Ceremony / 5:00 PM Cocktail hour" → [{ time: '16:00', title: 'Ceremony' }, ...]
function photoMoments_(settings) {
  return lines_(setting_(settings, 'Photo Moments')).map(function (line) {
    var m = line.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*[-–—:]?\s*(.+)$/i);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2] || 0) > 59) return null;
    var hour = Number(m[1]) % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0);
    return { time: ('0' + hour).slice(-2) + ':' + (m[2] || '00'), title: m[4].trim().slice(0, 60) };
  }).filter(function (x) { return x; }).sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
}

function photoSheet_(c) {
  var sh = sheet_(c, 'photos');
  if (!sh) {
    sh = c.ss.insertSheet(c.names.photos);
    sh.appendRow(PHOTO_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function photoCols_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var cols = {};
  Object.keys(PHOTO_COL).forEach(function (key) { cols[key] = header.indexOf(PHOTO_COL[key]); });
  return { cols: cols, width: lastCol };
}

function isTicked_(v) {
  return v === true || /^(true|yes|y|x|hide|hidden)$/i.test(String(v === null || v === undefined ? '' : v).trim());
}

function readPhotos_(c) {
  var sh = sheet_(c, 'photos');
  if (!sh || sh.getLastRow() < 2) return [];
  var info = photoCols_(sh);
  var cols = info.cols;
  function get(row, key) { return cols[key] >= 0 ? row[cols[key]] : ''; }
  return sh.getRange(2, 1, sh.getLastRow() - 1, info.width).getValues().map(function (row) {
    return {
      id: String(get(row, 'fileId')).trim(),
      uploadId: String(get(row, 'uploadId')).trim(),
      uploadedAt: get(row, 'uploadedAt'),
      takenAt: get(row, 'takenAt'),
      from: String(get(row, 'from')).trim(),
      caption: String(get(row, 'caption')).trim(),
      table: String(get(row, 'table')).trim(),
      hidden: isTicked_(get(row, 'hidden')),
      width: Number(get(row, 'width')) || 0,
      height: Number(get(row, 'height')) || 0
    };
  });
}

function isoTime_(v) {
  return v instanceof Date && !isNaN(v.getTime()) ? v.toISOString() : '';
}

function publicPhoto_(p) {
  var taken = isoTime_(p.takenAt) || isoTime_(p.uploadedAt);
  return { id: p.id, w: p.width, h: p.height, takenAt: taken, uploadedAt: isoTime_(p.uploadedAt) || taken, from: p.from, caption: p.caption, table: p.table };
}

var DRIVE_ID_ = /^[A-Za-z0-9_-]{10,200}$/;

function photosPayload_(c, settings, now) {
  var uploads = deadlineInfo_(settings, 'Photo Uploads Until', now);
  var photos = readPhotos_(c)
    .filter(function (p) { return !p.hidden && DRIVE_ID_.test(p.id); })
    .map(publicPhoto_)
    .sort(function (a, b) { return a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : (a.uploadedAt < b.uploadedAt ? -1 : 1); });
  return {
    photos: photos,
    moments: photoMoments_(settings),
    weddingDay: dateKey_(settings['Ceremony Date']),
    uploads: { open: uploads.open, until: uploads.deadline, untilText: uploads.deadlineText }
  };
}

function cleanText_(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanTable_(v) {
  return cleanText_(v, 40).replace(/[^A-Za-z0-9 #&'.\-]/g, '').trim().slice(0, 24);
}

// The time the photo was taken, as reported by the phone. Falls back to now if it's missing or impossible.
function photoTime_(v, now) {
  if (typeof v !== 'string' || !v) return now;
  var d = new Date(v);
  if (isNaN(d.getTime()) || d.getTime() > now.getTime() + 10 * 60 * 1000 || d.getFullYear() < 1990) return now;
  return d;
}

function photoDimension_(v) {
  var n = Math.round(Number(v));
  return n >= 1 && n <= 20000 ? n : '';
}

// The Drive folder photos go into: the one on the Settings tab, or a new one (saved to Settings).
function photoFolderId_(c, settings) {
  var raw = setting_(settings, 'Photo Folder');
  var m = raw.match(/folders\/([A-Za-z0-9_-]+)/) || raw.match(/[?&]id=([A-Za-z0-9_-]+)/) || raw.match(/^([A-Za-z0-9_-]{10,})$/);
  if (m) {
    try {
      return DriveApp.getFolderById(m[1]).getId();
    } catch (err) {
      fail_('setup', 'The Photo Folder on the Settings tab could not be opened. Clear it to have a new folder made.');
    }
  }
  var name = (setting_(settings, 'Sender Name') || 'Wedding') + ' — Wedding Photos';
  var folder = DriveApp.createFolder(name);
  writeSetting_(c, 'Photo Folder', folder.getUrl());
  settings['Photo Folder'] = folder.getUrl();
  return folder.getId();
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function submitPhoto_(c, body, now) {
  var settings = readSettings_(c);
  checkPhotoCode_(settings, body.code, now);
  var uploads = deadlineInfo_(settings, 'Photo Uploads Until', now);
  if (!uploads.open) fail_('closed', 'Photo sharing closed on ' + uploads.deadlineText + '. Thank you for all the photos!');

  var data = typeof body.data === 'string' ? body.data.replace(/^data:image\/jpeg;base64,/, '') : '';
  if (!data) fail_('bad_request', 'Missing photo.');
  if (data.length > PHOTO_MAX_BASE64) fail_('too_large', 'That photo is too large to share. Please try a different one.');
  if (data.slice(0, 4) !== '/9j/' || !/^[A-Za-z0-9+\/]+={0,2}$/.test(data)) fail_('bad_photo', 'Only photos can be shared here.');
  var uploadId = String(body.uploadId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 64);
  function already() {
    if (!uploadId) return null;
    return readPhotos_(c).filter(function (p) { return p.uploadId === uploadId; })[0] || null;
  }
  // A retried upload (the reply got lost) returns the photo that was already saved.
  var dup = already();
  if (dup) return { photo: publicPhoto_(dup), duplicate: true };

  var takenAt = photoTime_(body.takenAt, now);
  var from = cleanText_(body.from, 60);
  var caption = cleanText_(body.caption, 200);
  var table = cleanTable_(body.table);
  var width = photoDimension_(body.width);
  var height = photoDimension_(body.height);

  var folderId = withLock_(function () { return photoFolderId_(c, settings); });
  var fileName = Utilities.formatDate(takenAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH.mm.ss') +
    (from ? ' ' + from.replace(/[\\\/:*?"<>|]/g, '') : '') + '.jpg';
  var file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', fileName));
  if (caption) {
    try { file.setDescription(caption); } catch (err) { /* optional */ }
  }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {
    console.error('Could not share photo ' + file.getId() + ': ' + (err && err.message ? err.message : err));
  }
  var id = file.getId();

  return withLock_(function () {
    var again = already();
    if (again) {
      file.setTrashed(true);
      return { photo: publicPhoto_(again), duplicate: true };
    }
    var sh = photoSheet_(c);
    var info = photoCols_(sh);
    var row = [];
    for (var i = 0; i < info.width; i++) row.push('');
    var values = {
      uploadedAt: now, takenAt: takenAt, from: safeText_(from), caption: safeText_(caption), table: safeText_(table),
      hidden: false, preview: DRIVE_ID_.test(id) ? '=IMAGE("https://drive.google.com/thumbnail?id=' + id + '&sz=w200")' : '',
      link: file.getUrl(), fileId: id, width: width, height: height, uploadId: uploadId
    };
    Object.keys(values).forEach(function (key) { if (info.cols[key] >= 0) row[info.cols[key]] = values[key]; });
    sh.appendRow(row);
    SpreadsheetApp.flush();
    return {
      photo: publicPhoto_({ id: id, uploadedAt: now, takenAt: takenAt, from: from, caption: caption, table: table, width: Number(width) || 0, height: Number(height) || 0 }),
      duplicate: false
    };
  });
}

function writeRow_(table, rowNumber, values) {
  Object.keys(values).forEach(function (key) {
    var col = table.cols[key];
    if (col < 0) return;
    var v = values[key];
    var cell = table.sheet.getRange(rowNumber, col + 1);
    if (key === 'code') cell.setNumberFormat('@'); // keep codes like "2E5ABC" from turning into numbers
    cell.setValue(typeof v === 'string' ? safeText_(v) : v);
  });
}

function appendLog_(c, now, g, body) {
  var sh = sheet_(c, 'log');
  if (!sh) {
    sh = c.ss.insertSheet(c.names.log);
    sh.appendRow(['Time', 'Code', 'Guest Names', 'Status', 'Ceremony', 'Reception', 'Raw Response']);
    sh.setFrozenRows(1);
  }
  sh.appendRow([now, g.code, safeText_(g.names.join(', ')), g.status, safeText_(g.ceremony.join(', ')),
    safeText_(g.type === 'full' ? g.reception.join(', ') : 'n/a'), safeText_(JSON.stringify(body).slice(0, 2000))]);
}

/* =====================================================================
 * Codes & links
 * ===================================================================== */

function randomCode_() {
  var hex = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var code = '';
  for (var i = 0; code.length < CODE_LENGTH; i += 2) {
    code += CODE_ALPHABET.charAt(parseInt(hex.substr(i, 2), 16) % CODE_ALPHABET.length);
  }
  return /^[0-9]+$/.test(code) ? randomCode_() : code;
}

// For texts: "Hi Alice & Bob!", but formal entries stay formal ("Hi Mr. & Mrs. John Smith!").
function firstNames_(entries) {
  return formatList_(entries.map(withoutGuest_).filter(Boolean).map(function (e) {
    if (STARTS_WITH_TITLE_.test(e)) return e;
    var m = e.match(COUPLE_FIRST_NAMES_);
    if (m) return m[1] + ' & ' + m[2];
    return e.split(' ')[0];
  }));
}

// The ready-to-send text for one household, from the "Text Message" setting.
function textMessage_(g, settings) {
  if (!g.code || !g.type || !g.names.length) return '';
  var template = String(setting_(settings, 'Text Message')) || TEXT_TEMPLATE_DEFAULT;
  var deadline = dateKey_(settings['RSVP Deadline']);
  var values = {
    'first names': firstNames_(g.entries && g.entries.length ? g.entries : g.names),
    'names': addressee_(g),
    'date': setting_(settings, 'Ceremony Date'),
    'events': g.type === 'full' ? 'our wedding ceremony and the reception to follow' : 'our wedding ceremony',
    'plus one': g.plusOneAllowed ? "You're welcome to bring a guest! " : '',
    'deadline': deadline ? ' by ' + dateKeyText_(deadline) : '',
    'link': inviteLink_(settings, g.code),
    'code': g.code
  };
  return template.replace(/\{(first names|names|date|events|plus one|deadline|link|code)\}/gi, function (m, key) {
    return values[key.toLowerCase()];
  }).replace(/ {2,}/g, ' ').trim();
}

function mealLink_(settings, code) {
  var base = String(setting_(settings, 'Site URL')).replace(/\/+$/, '');
  return base + '/meal/?code=' + code;
}

// The ready-to-send meal text, for Wedding + Reception households only.
function mealText_(g, settings) {
  if (!g.code || g.type !== 'full' || !g.names.length) return '';
  var template = String(setting_(settings, 'Meal Text Message')) || MEAL_TEXT_DEFAULT;
  var deadline = dateKey_(settings['Meal Deadline']);
  var values = {
    'first names': firstNames_(g.entries && g.entries.length ? g.entries : g.names),
    'names': addressee_(g),
    'meal link': mealLink_(settings, g.code),
    'meal deadline': deadline ? ' by ' + dateKeyText_(deadline) : '',
    'code': g.code
  };
  return template.replace(/\{(first names|names|meal link|meal deadline|code)\}/gi, function (m, key) {
    return values[key.toLowerCase()];
  }).replace(/ {2,}/g, ' ').trim();
}

function inviteLink_(settings, code) {
  var base = String(setting_(settings, 'Site URL')).replace(/\/+$/, '');
  return base + '/invite/?code=' + code;
}

/**
 * Gives every row that has guest names a unique code, and fills in the invite link, text message and RSVP status.
 * Returns the number of new codes created.
 */
function generateCodes_(c, onlyRows) {
  var table = readGuests_(c);
  var settings = readSettings_(c);
  var used = {};
  table.guests.forEach(function (g) { if (g.code) used[g.code] = (used[g.code] || 0) + 1; });

  var created = 0;
  table.guests.forEach(function (g) {
    if (onlyRows && onlyRows.indexOf(g.row) < 0) return;
    if (!g.names.length) return;
    var values = {};
    if (!g.code) {
      var code;
      do { code = randomCode_(); } while (used[code]);
      used[code] = 1;
      g.code = code;
      values.code = code;
      created++;
    }
    var link = inviteLink_(settings, g.code);
    if (table.cols.link >= 0 && g.link !== link) values.link = link;
    if (table.cols.partySize >= 0 && Number(g.partySizeRaw) !== g.names.length) values.partySize = g.names.length;
    var text = textMessage_(g, settings);
    if (table.cols.text >= 0 && g.text !== text) values.text = text;
    var mealLink = g.type === 'full' ? mealLink_(settings, g.code) : '';
    if (table.cols.mealLink >= 0 && g.mealLink !== mealLink) values.mealLink = mealLink;
    var mealText = mealText_(g, settings);
    if (table.cols.mealText >= 0 && g.mealText !== mealText) values.mealText = mealText;
    var meals = formatMeals_(currentMeals_(g));
    if (table.cols.mealChoices >= 0 && g.mealChoicesRaw && g.mealChoicesRaw !== meals) values.mealChoices = meals;
    var dec = declined_(g);
    if (table.cols.ceremonyDeclined >= 0 && g.ceremonyDeclined !== dec.ceremonyDeclined) values.ceremonyDeclined = dec.ceremonyDeclined;
    if (table.cols.receptionDeclined >= 0 && g.receptionDeclined !== dec.receptionDeclined) values.receptionDeclined = dec.receptionDeclined;
    var poStatus = plusOneStatus_(g);
    if (table.cols.plusOneStatus >= 0 && g.plusOneStatus !== poStatus) values.plusOneStatus = poStatus;
    if (!g.status) values.status = STATUS.none;
    if (Object.keys(values).length) writeRow_(table, g.row, values);
  });
  if (!onlyRows) ensurePhotoSettings_(c, settings);
  return created;
}

/** Records that these rows were invited some other way (e.g. by text). Returns how many were marked. */
function markInvited_(c, rowNumbers, now) {
  var table = readGuests_(c);
  var marked = 0;
  table.guests.forEach(function (g) {
    if (rowNumbers.indexOf(g.row) < 0 || !g.names.length) return;
    if (g.sentAt !== '' && g.sentAt !== null) return;
    writeRow_(table, g.row, { sentAt: now });
    marked++;
  });
  return marked;
}

/* =====================================================================
 * Checking the guest list
 * ===================================================================== */

function validateGuestList_(c) {
  var problems = [];
  var table = readGuests_(c);
  var settings = readSettings_(c);
  var codes = {}, emails = {}, people = {};

  table.guests.forEach(function (g) {
    var r = 'Row ' + g.row + ': ';
    var blank = !g.names.length && !g.emailRaw && !g.typeRaw && !g.code;
    if (blank) return;
    if (!g.names.length) { problems.push(r + 'no guest names.'); return; }
    g.names.forEach(function (p) {
      if (/&|\band\b/i.test(p)) problems.push(r + 'separate guest names with commas, or write couples as "Mr. & Mrs. Full Name" (couldn\'t split "' + p + '").');
    });
    if (!g.type) problems.push(r + 'Invite Type should be "' + TYPE_FULL + '" or "' + TYPE_CEREMONY + '"' + (g.typeRaw ? ' (found "' + g.typeRaw + '").' : '.'));
    if (g.plusOneRaw && !parseYes_(g.plusOneRaw) && !/^(n|no|false|0)$/i.test(g.plusOneRaw)) problems.push(r + 'Plus One should be Yes or No (found "' + g.plusOneRaw + '").');
    if (hasPlusGuest_(g.entries) && /^(n|no|false|0)$/i.test(g.plusOneRaw)) problems.push(r + 'the names say "& Guest" but Plus One is "No". They will still be offered a plus one.');
    g.emails.forEach(function (e) {
      if (!isEmail_(e)) problems.push(r + '"' + e + '" does not look like an email address.');
      var k = e.toLowerCase();
      if (emails[k]) problems.push(r + e + ' is also used on row ' + emails[k] + '.');
      else emails[k] = g.row;
    });
    if (g.code) {
      if (codes[g.code]) problems.push(r + 'code ' + g.code + ' is also used on row ' + codes[g.code] + '. Clear one of them and generate codes again.');
      else codes[g.code] = g.row;
    }
    g.names.forEach(function (n) {
      var k = n.toLowerCase();
      if (people[k]) problems.push(r + n + ' is also listed on row ' + people[k] + '.');
      else people[k] = g.row;
    });
  });

  if (/example\.com/.test(String(setting_(settings, 'Site URL')))) problems.push('Settings: "Site URL" is still the example address.');
  var deadline = settings['RSVP Deadline'];
  if (deadline !== '' && deadline !== null && !dateKey_(deadline)) problems.push('Settings: "RSVP Deadline" is not a date (use YYYY-MM-DD, e.g. 2099-01-31).');
  return problems;
}

/* =====================================================================
 * Emails
 * ===================================================================== */

function emailShell_(inner, settings) {
  var date = String(setting_(settings, 'Ceremony Date')).toUpperCase();
  return '<div style="margin:0;padding:24px 12px;background:#f9e9eb;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:560px;background:#fbf8f4;border-radius:14px;overflow:hidden;border:1px solid #f2d3d8;">' +
    '<tr><td style="background:#15322a;padding:34px 24px 26px;text-align:center;">' +
    '<div style="font-family:Georgia,serif;font-style:italic;font-size:34px;color:#f9e9eb;line-height:1.2;">Stephanie &amp; Robert</div>' +
    (date ? '<div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:4px;color:#e8b6be;margin-top:10px;">' + escapeHtml_(date) + '</div>' : '') +
    '</td></tr><tr><td style="padding:32px 28px 36px;font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#26302c;">' +
    inner + '</td></tr></table></div>';
}

function emailButton_(href, label) {
  return '<div style="text-align:center;margin:28px 0;">' +
    '<a href="' + escapeHtml_(href) + '" style="display:inline-block;background:#15322a;color:#f9e9eb;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;letter-spacing:3px;padding:15px 30px;border-radius:999px;">' +
    escapeHtml_(label) + '</a></div>';
}

function buildInviteEmail_(g, settings, kind) {
  var link = inviteLink_(settings, g.code);
  var rsvp = rsvpInfo_(settings, new Date());
  var greeting = addressee_(g);
  var what = g.type === 'full' ? 'our wedding ceremony and the reception to follow' : 'our wedding ceremony';
  var date = setting_(settings, 'Ceremony Date');
  var on = date ? ' on ' + date : '';
  var deadlineLine = rsvp.deadline ? 'Please RSVP by ' + rsvp.deadlineText + '.' : 'Please RSVP at your earliest convenience.';
  var plusOneLine = g.plusOneAllowed ? 'You are welcome to bring a guest. You can add their name when you RSVP.' : '';
  var subject, intro;
  if (kind === 'reminder') {
    subject = setting_(settings, 'Reminder Email Subject');
    intro = "We'd love to know if you can join us for " + what + on + ". We haven't received your RSVP yet.";
  } else {
    subject = setting_(settings, 'Invite Email Subject');
    intro = 'We are getting married! We would be honored to have you join us for ' + what + on + '.';
  }

  var html = emailShell_(
    '<p style="margin:0 0 16px;">Dear ' + escapeHtml_(greeting) + ',</p>' +
    '<p style="margin:0 0 16px;">' + escapeHtml_(intro) + '</p>' +
    (plusOneLine ? '<p style="margin:0 0 16px;">' + escapeHtml_(plusOneLine) + '</p>' : '') +
    '<p style="margin:0 0 16px;">' + escapeHtml_(deadlineLine) + ' Your personal invitation has all the details:</p>' +
    emailButton_(link, kind === 'reminder' ? 'RSVP NOW' : 'OPEN YOUR INVITATION') +
    '<p style="margin:0 0 6px;font-size:14px;color:#5f6b66;text-align:center;">Your invitation code: <strong style="letter-spacing:2px;color:#15322a;">' + escapeHtml_(g.code) + '</strong></p>' +
    '<p style="margin:0 0 24px;font-size:13px;color:#5f6b66;text-align:center;word-break:break-all;">' + escapeHtml_(link) + '</p>' +
    '<p style="margin:0;">With love,<br><span style="font-style:italic;font-size:22px;color:#15322a;">Stephanie &amp; Robert</span></p>',
    settings
  );
  var text = 'Dear ' + greeting + ',\n\n' + intro + '\n\n' + (plusOneLine ? plusOneLine + '\n\n' : '') +
    deadlineLine + ' Open your personal invitation here:\n' + link + '\n\nYour invitation code: ' + g.code +
    '\n\nWith love,\nStephanie & Robert';
  return { subject: subject, htmlBody: html, body: text };
}

function summarizeResponse_(payload) {
  var lines = [];
  var guests = payload.guests;
  var po = payload.response.plusOne;
  payload.events.forEach(function (ev) {
    var going = payload.response[ev.id].slice();
    if (po && po[ev.id] && po.name) going.push(po.name + ' (guest)');
    var notGoing = guests.filter(function (n) { return payload.response[ev.id].indexOf(n) < 0; });
    var line = ev.title + ': ';
    line += going.length ? formatList_(going) + ' attending' : 'no one attending';
    if (going.length && notGoing.length) line += ' (' + formatList_(notGoing) + ' not attending)';
    lines.push(line);
  });
  return lines;
}

function sendRsvpEmails_(c, g, payload, settings) {
  // Someone re-submitting over and over shouldn't flood the guest's inbox or use up the daily quota.
  var cache = CacheService.getScriptCache();
  var cooldownKey = 'rsvpmail:' + g.code;
  if (cache.get(cooldownKey)) return;
  cache.put(cooldownKey, '1', EMAIL_COOLDOWN_SECONDS);

  var lines = summarizeResponse_(payload);
  var sender = setting_(settings, 'Sender Name');
  var replyTo = setting_(settings, 'Reply-To Email');

  if (parseYes_(settings['Send RSVP Confirmations']) && g.emails.length && MailApp.getRemainingDailyQuota() >= g.emails.length) {
    var link = inviteLink_(settings, g.code);
    var html = emailShell_(
      '<p style="margin:0 0 16px;">Dear ' + escapeHtml_(addressee_(g)) + ',</p>' +
      '<p style="margin:0 0 16px;">Thank you for your RSVP! Here is what we received:</p>' +
      '<ul style="margin:0 0 16px;padding-left:20px;">' + lines.map(function (l) { return '<li>' + escapeHtml_(l) + '</li>'; }).join('') + '</ul>' +
      '<p style="margin:0 0 16px;">Need to make a change? Open your invitation again and update your response' +
      (payload.rsvp.deadline ? ' by ' + escapeHtml_(payload.rsvp.deadlineText) : '') + '.</p>' +
      emailButton_(link, 'VIEW YOUR INVITATION') +
      '<p style="margin:0;">With love,<br><span style="font-style:italic;font-size:22px;color:#15322a;">Stephanie &amp; Robert</span></p>',
      settings
    );
    var opts = { to: g.emails.join(','), subject: 'We got your RSVP! Stephanie & Robert', htmlBody: html,
      body: 'Thank you for your RSVP!\n\n' + lines.join('\n') + '\n\nChange it any time: ' + link, name: sender };
    if (replyTo) opts.replyTo = replyTo;
    MailApp.sendEmail(opts);
  }

  var notify = splitEmails_(setting_(settings, 'Notify Email')).filter(isEmail_);
  if (notify.length && MailApp.getRemainingDailyQuota() >= notify.length) {
    MailApp.sendEmail({
      to: notify.join(','),
      subject: 'RSVP: ' + addressee_(g) + ' (' + g.status + ')',
      body: addressee_(g) + ' just RSVP\'d.\n\n' + lines.join('\n') + '\n\nGuest list: ' + c.ss.getUrl(),
      name: 'Wedding RSVPs'
    });
  }
}

/**
 * Sends invitation (kind = 'invite') or reminder (kind = 'reminder') emails to the given guest rows.
 * Stops early, without failing, when the daily Gmail quota runs out.
 */
function sendEmails_(c, rowNumbers, kind) {
  generateCodes_(c, rowNumbers);
  var table = readGuests_(c);
  var settings = readSettings_(c);
  var result = { sent: [], skipped: [], quotaHit: false };

  table.guests.forEach(function (g) {
    if (rowNumbers.indexOf(g.row) < 0) return;
    var label = g.names.length ? addressee_(g) : 'Row ' + g.row;
    if (result.quotaHit) { result.skipped.push(label + ': daily email limit reached'); return; }
    if (!g.names.length) return;
    if (!g.type) { result.skipped.push(label + ': Invite Type is missing'); return; }
    var good = g.emails.filter(isEmail_);
    if (!good.length) { result.skipped.push(label + ': no valid email address'); return; }
    if (kind === 'reminder' && hasResponded_(g)) { result.skipped.push(label + ': already responded'); return; }
    if (MailApp.getRemainingDailyQuota() < good.length) {
      result.quotaHit = true;
      result.skipped.push(label + ': daily email limit reached');
      return;
    }
    var email = buildInviteEmail_(g, settings, kind);
    var opts = { to: good.join(','), subject: email.subject, htmlBody: email.htmlBody, body: email.body, name: setting_(settings, 'Sender Name') };
    var replyTo = setting_(settings, 'Reply-To Email');
    if (replyTo) opts.replyTo = replyTo;
    MailApp.sendEmail(opts);
    var values = {};
    values[kind === 'reminder' ? 'reminderAt' : 'sentAt'] = new Date();
    writeRow_(table, g.row, values);
    result.sent.push(label);
  });
  SpreadsheetApp.flush();
  return result;
}

function unsentRows_(c) {
  return readGuests_(c).guests.filter(function (g) {
    return g.names.length && g.emails.length && (g.sentAt === '' || g.sentAt === null);
  }).map(function (g) { return g.row; });
}

function reminderRows_(c) {
  return readGuests_(c).guests.filter(function (g) {
    return g.names.length && g.emails.length && g.sentAt !== '' && g.sentAt !== null && !hasResponded_(g);
  }).map(function (g) { return g.row; });
}

/* =====================================================================
 * Sheet setup
 * ===================================================================== */

function columnLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function setupSheets_(c) {
  var ss = c.ss;

  // Guests
  var guests = sheet_(c, 'guests') || ss.insertSheet(c.names.guests, 0);
  var lastCol = guests.getLastColumn();
  var header = lastCol ? guests.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  if (!header.some(function (h) { return h; })) header = [];
  GUEST_HEADERS.forEach(function (h) { if (header.indexOf(h) < 0) header.push(h); });
  guests.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#15322a').setFontColor('#f9e9eb').setVerticalAlignment('middle');
  guests.setFrozenRows(1);
  guests.setRowHeight(1, 36);
  if (guests.getMaxRows() < 500) guests.insertRowsAfter(guests.getMaxRows(), 500 - guests.getMaxRows());
  var maxRows = guests.getMaxRows();
  header.forEach(function (h, i) {
    var col = i + 1;
    var cell = guests.getRange(1, col);
    if (GUEST_HEADER_NOTES[h]) cell.setNote(GUEST_HEADER_NOTES[h]);
    if (AUTO_HEADERS.indexOf(h) >= 0) {
      cell.setBackground('#4f7f6c');
      guests.getRange(2, col, maxRows - 1, 1).setBackground('#f4f6f5');
    }
    var widths = { 'Guest Names': 260, 'Email': 220, 'Invite Type': 160, 'Ceremony Attending': 220, 'Reception Attending': 220, 'Ceremony Declined': 200, 'Reception Declined': 200, 'Plus One Status': 170, 'Invite Link': 280, 'Text Message': 420, 'Meal Choices': 360, 'Dietary Notes': 260, 'Meal Link': 280, 'Meal Text Message': 380, 'Notes': 220 };
    guests.setColumnWidth(col, widths[h] || 130);
  });
  var typeCol = header.indexOf(COL.type) + 1;
  var plusCol = header.indexOf(COL.plusOne) + 1;
  guests.getRange(2, typeCol, maxRows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([TYPE_FULL, TYPE_CEREMONY], true).setAllowInvalid(true).build());
  guests.getRange(2, plusCol, maxRows - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Yes', 'No'], true).setAllowInvalid(true).build());
  guests.getRange(2, header.indexOf(COL.code) + 1, maxRows - 1, 1).setNumberFormat('@');
  ['respondedAt', 'sentAt', 'openedAt', 'reminderAt', 'mealsAt'].forEach(function (k) {
    guests.getRange(2, header.indexOf(COL[k]) + 1, maxRows - 1, 1).setNumberFormat('mmm d, yyyy h:mm am/pm');
  });

  var statusRange = guests.getRange(2, header.indexOf(COL.status) + 1, maxRows - 1, 1);
  var plusOneRange = guests.getRange(2, header.indexOf(COL.plusOneStatus) + 1, maxRows - 1, 1);
  guests.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.attending).setBackground('#d6eadf').setFontColor('#1d4437').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.declined).setBackground('#f2d3d8').setFontColor('#7a3b47').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(STATUS.none).setFontColor('#8a948f').setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(PLUS_ONE_STATUS.bringing).setBackground('#d6eadf').setFontColor('#1d4437').setRanges([plusOneRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(PLUS_ONE_STATUS.notBringing).setBackground('#f2d3d8').setFontColor('#7a3b47').setRanges([plusOneRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(PLUS_ONE_STATUS.waiting).setFontColor('#8a948f').setRanges([plusOneRange]).build()
  ]);

  // Settings
  var settingsSheet = sheet_(c, 'settings') || ss.insertSheet(c.names.settings);
  var existing = settingsSheet.getLastRow() ? settingsSheet.getRange(1, 1, settingsSheet.getLastRow(), 1).getValues().map(function (r) { return String(r[0]).trim(); }) : [];
  if (existing.indexOf('Setting') < 0) {
    if (existing.length) settingsSheet.insertRowBefore(1);
    settingsSheet.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'Help']]).setFontWeight('bold').setBackground('#15322a').setFontColor('#f9e9eb');
    existing = ['Setting'].concat(existing);
  }
  SETTINGS_DEFAULTS.forEach(function (d) {
    if (existing.indexOf(d[0]) < 0) {
      settingsSheet.appendRow([d[0], d[1], d[2]]);
      existing.push(d[0]);
    }
  });
  settingsSheet.setFrozenRows(1);
  settingsSheet.setColumnWidth(1, 200);
  settingsSheet.setColumnWidth(2, 360);
  settingsSheet.setColumnWidth(3, 460);

  // Summary (always rebuilt; it's only formulas)
  var summary = sheet_(c, 'summary') || ss.insertSheet(c.names.summary, 1);
  summary.clear();
  var g = "'" + c.names.guests.replace(/'/g, "''") + "'!";
  function col(name) { var L = columnLetter_(header.indexOf(name) + 1); return g + L + '2:' + L; }
  function people(name) {
    var r = col(name);
    return '=SUMPRODUCT((LEN(TRIM(' + r + '))>0)*(LEN(' + r + ')-LEN(SUBSTITUTE(' + r + ',",",""))+1))';
  }
  var rows = [
    ['Wedding Summary', ''],
    ['', ''],
    ['Households invited', '=COUNTA(' + col(COL.names) + ')'],
    ['People invited (not counting plus ones)', '=SUM(' + col(COL.partySize) + ')'],
    ['Plus ones offered', '=COUNTIF(' + col(COL.plusOne) + ',"Yes")'],
    ['"Wedding + Reception" households', '=COUNTIF(' + col(COL.type) + ',"' + TYPE_FULL + '")'],
    ['"Ceremony Only" households', '=COUNTIF(' + col(COL.type) + ',"' + TYPE_CEREMONY + '")'],
    ['Invites sent', '=COUNTA(' + col(COL.sentAt) + ')'],
    ['Invites opened', '=COUNTA(' + col(COL.openedAt) + ')'],
    ['Households responded', '=COUNTIF(' + col(COL.status) + ',"' + STATUS.attending + '")+COUNTIF(' + col(COL.status) + ',"' + STATUS.declined + '")'],
    ['Households waiting on', '=B3-B10'],
    ['Households declined', '=COUNTIF(' + col(COL.status) + ',"' + STATUS.declined + '")'],
    ['', ''],
    ['Ceremony: attending (people, incl. plus ones)', people(COL.ceremony)],
    ['Ceremony: declined (people)', people(COL.ceremonyDeclined)],
    ['Reception: attending (people, incl. plus ones)', people(COL.reception)],
    ['Reception: declined (people)', people(COL.receptionDeclined)],
    ['', ''],
    ['Plus ones coming', '=COUNTIF(' + col(COL.plusOneStatus) + ',"' + PLUS_ONE_STATUS.bringing + '")'],
    ['Plus ones not coming', '=COUNTIF(' + col(COL.plusOneStatus) + ',"' + PLUS_ONE_STATUS.notBringing + '")'],
    ['Plus ones still waiting on an RSVP', '=COUNTIF(' + col(COL.plusOneStatus) + ',"' + PLUS_ONE_STATUS.waiting + '")'],
    ['', '']
  ];
  // One row per meal option, counted from "Name: Meal" entries, then who still has to choose.
  var settingsNow = readSettings_(c);
  mealOptions_(settingsNow).forEach(function (opt) {
    var r = col(COL.mealChoices);
    var needle = '": ' + opt.replace(/"/g, '""') + '"';
    rows.push(['Meals: ' + opt, '=SUMPRODUCT((LEN(' + r + ')-LEN(SUBSTITUTE(' + r + ',' + needle + ',"")))/LEN(' + needle + '))']);
  });
  var mealsRange = col(COL.mealChoices);
  rows.push(['Reception guests who still need to choose a meal',
    people(COL.reception) + '-SUMPRODUCT((LEN(TRIM(' + mealsRange + '))>0)*(LEN(' + mealsRange + ')-LEN(SUBSTITUTE(' + mealsRange + ',";",""))+1))']);
  var photosSheet = setupPhotoSheet_(c);
  var photoInfo = photoCols_(photosSheet);
  function photoCol(key) {
    var L = columnLetter_(photoInfo.cols[key] + 1);
    return "'" + c.names.photos.replace(/'/g, "''") + "'!" + L + '2:' + L;
  }
  rows.push(['', '']);
  rows.push(['Photos shared', '=COUNTA(' + photoCol('fileId') + ')']);
  rows.push(['Photos hidden', '=COUNTIF(' + photoCol('hidden') + ',TRUE)']);
  summary.getRange(1, 1, rows.length, 2).setValues(rows);
  summary.getRange(1, 1).setFontSize(18).setFontWeight('bold').setFontColor('#15322a');
  summary.getRange(14, 1, 4, 2).setFontWeight('bold').setBackground('#f9e9eb');
  summary.setColumnWidth(1, 320);
  summary.setColumnWidth(2, 120);

  // RSVP log
  if (!sheet_(c, 'log')) {
    var log = ss.insertSheet(c.names.log);
    log.appendRow(['Time', 'Code', 'Guest Names', 'Status', 'Ceremony', 'Reception', 'Raw Response']);
    log.getRange(1, 1, 1, 7).setFontWeight('bold');
    log.setFrozenRows(1);
  }

  // Remove the blank default tab if it's still there.
  // (The Photos tab was set up with the Summary above.)
  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
}

/* =====================================================================
 * Spreadsheet menu
 * ===================================================================== */

function setupPhotoSheet_(c) {
  var sh = photoSheet_(c);
  var lastCol = sh.getLastColumn();
  var header = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  if (!header.some(function (h) { return h; })) header = [];
  PHOTO_HEADERS.forEach(function (h) { if (header.indexOf(h) < 0) header.push(h); });
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#15322a').setFontColor('#f9e9eb').setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  if (sh.getMaxRows() < 1000) sh.insertRowsAfter(sh.getMaxRows(), 1000 - sh.getMaxRows());
  var maxRows = sh.getMaxRows();
  var widths = { 'Uploaded At': 150, 'Taken At': 150, 'From': 160, 'Caption': 260, 'Table': 70, 'Hidden': 70, 'Preview': 140, 'Photo': 260, 'File ID': 140, 'Width': 70, 'Height': 70, 'Upload ID': 120 };
  header.forEach(function (h, i) {
    if (PHOTO_HEADER_NOTES[h]) sh.getRange(1, i + 1).setNote(PHOTO_HEADER_NOTES[h]);
    sh.setColumnWidth(i + 1, widths[h] || 120);
  });
  sh.getRange(2, header.indexOf(PHOTO_COL.hidden) + 1, maxRows - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  [PHOTO_COL.uploadedAt, PHOTO_COL.takenAt].forEach(function (h) {
    sh.getRange(2, header.indexOf(h) + 1, maxRows - 1, 1).setNumberFormat('mmm d, yyyy h:mm am/pm');
  });
  return sh;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('💌 Wedding')
    .addItem('Set up sheets', 'menuSetup')
    .addItem('Update codes, links & text messages', 'menuGenerateCodes')
    .addItem('Check guest list for problems', 'menuCheckGuestList')
    .addItem('Show photo sharing links', 'menuPhotoLinks')
    .addSeparator()
    .addItem('Mark selected rows as invited (texted)', 'menuMarkTexted')
    .addSeparator()
    .addItem('Email a test invite to myself', 'menuSendTestInvite')
    .addItem('Email invites to selected rows', 'menuSendSelected')
    .addItem('Email all unsent invites', 'menuSendAllUnsent')
    .addItem('Email RSVP reminders to everyone who hasn\'t replied', 'menuSendReminders')
    .addSeparator()
    .addItem('Run self-test', 'runSelfTest')
    .addToUi();
}

// Keeps codes, links and text messages up to date as you type: new guest rows get theirs
// right away, and editing the Settings tab refreshes every row.
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var c = ctx_();
    var sh = e.range.getSheet();
    if (sh.getName() === c.names.settings) { generateCodes_(c); return; }
    if (sh.getName() !== c.names.guests || e.range.getLastRow() < 2) return;
    var rows = [];
    for (var r = Math.max(2, e.range.getRow()); r <= e.range.getLastRow(); r++) rows.push(r);
    generateCodes_(c, rows);
  } catch (err) {
    console.error(err);
  }
}

function ui_() { return SpreadsheetApp.getUi(); }

function menuSetup() {
  setupSheets_(ctx_());
  generateCodes_(ctx_());
  photoFolderId_(ctx_(), readSettings_(ctx_())); // makes the Drive folder now, so photo sharing is ready
  ui_().alert('All set! Add guests on the "Guests" tab, then fill in the "Settings" tab.');
}

function menuPhotoLinks() {
  var c = ctx_();
  var settings = readSettings_(c);
  ensurePhotoSettings_(c, settings);
  photoFolderId_(c, settings);
  ui_().alert('Photo sharing\n\n' +
    'Table cards (open on a computer and print):\n' + setting_(settings, 'Photo Table Cards Link') + '\n\n' +
    'Slideshow (open on the TV or projector):\n' + setting_(settings, 'Photo Slideshow Link') + '\n\n' +
    'Photo page (what the QR codes open):\n' + setting_(settings, 'Photo Page Link') + '\n\n' +
    'Photos are saved to:\n' + setting_(settings, 'Photo Folder') + '\n\n' +
    'These are also on the Settings tab.');
}

function menuGenerateCodes() {
  var n = generateCodes_(ctx_());
  ui_().alert((n ? 'Created ' + n + ' new code' + (n === 1 ? '' : 's') + '.' : 'Every guest already has a code.') + ' Invite links and text messages are up to date.');
}

function menuMarkTexted() {
  var c = ctx_();
  var rows = selectedGuestRows_(c);
  if (!rows) { ui_().alert('Go to the "' + c.names.guests + '" tab and select the rows you texted first.'); return; }
  var n = markInvited_(c, rows, new Date());
  ui_().alert(n ? 'Marked ' + n + ' household' + (n === 1 ? '' : 's') + ' as invited.' : 'Those rows were already marked as invited.');
}

function menuCheckGuestList() {
  var problems = validateGuestList_(ctx_());
  ui_().alert(problems.length ? 'Found ' + problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' to check:\n\n' + problems.slice(0, 40).join('\n') + (problems.length > 40 ? '\n…and ' + (problems.length - 40) + ' more.' : '') : 'The guest list looks good!');
}

function selectedGuestRows_(c) {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== c.names.guests) return null;
  var rows = [];
  sheet.getActiveRangeList().getRanges().forEach(function (range) {
    for (var r = range.getRow(); r <= range.getLastRow(); r++) if (r >= 2 && rows.indexOf(r) < 0) rows.push(r);
  });
  return rows;
}

function menuSendTestInvite() {
  var c = ctx_();
  var me = Session.getActiveUser().getEmail();
  if (!me) { ui_().alert("Couldn't find your email address."); return; }
  var rows = selectedGuestRows_(c) || [];
  generateCodes_(c, rows.length ? rows : null);
  var guests = readGuests_(c).guests.filter(function (g) { return g.names.length && g.type; });
  var g = guests.filter(function (x) { return rows.indexOf(x.row) >= 0; })[0] || guests[0];
  if (!g) { ui_().alert('Add at least one guest (with names and an Invite Type) first.'); return; }
  var email = buildInviteEmail_(g, readSettings_(c), 'invite');
  MailApp.sendEmail({ to: me, subject: '[TEST] ' + email.subject, htmlBody: email.htmlBody, body: email.body, name: setting_(readSettings_(c), 'Sender Name') });
  ui_().alert('Sent a test of ' + addressee_(g) + "'s invitation to " + me + '. (Their row was not marked as sent.)');
}

function confirmAndSend_(c, rows, kind, what) {
  if (!rows.length) { ui_().alert('There is no one to send to.'); return; }
  var quota = MailApp.getRemainingDailyQuota();
  var answer = ui_().alert('Send ' + what + ' to ' + rows.length + ' household' + (rows.length === 1 ? '' : 's') + '?\n\n(You can send about ' + quota + ' more emails today.)', ui_().ButtonSet.OK_CANCEL);
  if (answer !== ui_().Button.OK) return;
  var result = sendEmails_(c, rows, kind);
  var msg = 'Sent ' + result.sent.length + ' email' + (result.sent.length === 1 ? '' : 's') + '.';
  if (result.skipped.length) msg += '\n\nSkipped:\n' + result.skipped.slice(0, 30).join('\n') + (result.skipped.length > 30 ? '\n…' : '');
  if (result.quotaHit) msg += '\n\nYou reached the daily email limit. Run this again tomorrow to send the rest.';
  ui_().alert(msg);
}

function menuSendSelected() {
  var c = ctx_();
  var rows = selectedGuestRows_(c);
  if (!rows) { ui_().alert('Go to the "' + c.names.guests + '" tab and select the rows to send to first.'); return; }
  confirmAndSend_(c, rows, 'invite', 'invitations');
}

function menuSendAllUnsent() {
  var c = ctx_();
  confirmAndSend_(c, unsentRows_(c), 'invite', 'invitations');
}

function menuSendReminders() {
  var c = ctx_();
  confirmAndSend_(c, reminderRows_(c), 'reminder', 'RSVP reminders');
}

/* =====================================================================
 * Self-test — runs the whole RSVP flow against temporary sheets in this
 * spreadsheet (no emails are sent), then deletes them.
 * ===================================================================== */

function runSelfTest() {
  var results = selfTest_(SpreadsheetApp.getActiveSpreadsheet());
  var failed = results.filter(function (r) { return !r.pass; });
  var msg = (failed.length ? '❌ ' + failed.length + ' of ' + results.length + ' checks FAILED:\n\n' + failed.map(function (r) { return r.name + ' — ' + r.detail; }).join('\n')
    : '✅ All ' + results.length + ' checks passed.');
  console.log(msg);
  try { ui_().alert(msg); } catch (err) { /* running from the editor */ }
  return results;
}

function selfTest_(ss) {
  var names = { guests: '__selftest Guests', settings: '__selftest Settings', summary: '__selftest Summary', log: '__selftest Log', photos: '__selftest Photos' };
  var c = { ss: ss, names: names };
  var results = [];
  function check(name, fn) {
    try { fn(); results.push({ name: name, pass: true }); } catch (err) { results.push({ name: name, pass: false, detail: err && err.message ? err.message : String(err) }); }
  }
  function eq(a, b, label) {
    var A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((label || 'value') + ': expected ' + B + ', got ' + A);
  }
  function expectError(code, fn) {
    try { fn(); } catch (err) {
      if (err instanceof AppError_ && err.code === code) return;
      throw new Error('expected error "' + code + '", got ' + (err.code || err.message));
    }
    throw new Error('expected error "' + code + '", but it succeeded');
  }
  function api(method, payload) {
    var out = method === 'GET' ? doGet({ parameter: payload }) : doPost({ postData: { contents: JSON.stringify(payload) } });
    return JSON.parse(out.getContent());
  }

  Object.keys(names).forEach(function (k) { var s = ss.getSheetByName(names[k]); if (s) ss.deleteSheet(s); });
  var previous = CTX_OVERRIDE_;
  CTX_OVERRIDE_ = c;
  try {
    var now = new Date();
    check('Set up sheets', function () {
      setupSheets_(c);
      if (!sheet_(c, 'guests') || !sheet_(c, 'settings') || !sheet_(c, 'summary') || !sheet_(c, 'log')) throw new Error('a sheet is missing');
      setupSheets_(c); // running twice must be safe
    });

    var gs = sheet_(c, 'guests');
    var header = gs.getRange(1, 1, 1, gs.getLastColumn()).getValues()[0];
    function addRow(obj) {
      var row = header.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
      gs.appendRow(row);
    }
    addRow({ 'Guest Names': 'Test Full One, Test Full Two', 'Email': 'full@example.com', 'Invite Type': TYPE_FULL, 'Plus One': 'Yes' });
    addRow({ 'Guest Names': 'Test Ceremony Only', 'Email': 'cer@example.com', 'Invite Type': TYPE_CEREMONY, 'Plus One': 'No' });
    var st = sheet_(c, 'settings');
    var keys = st.getRange(1, 1, st.getLastRow(), 1).getValues().map(function (r) { return r[0]; });
    st.getRange(keys.indexOf('Send RSVP Confirmations') + 1, 2).setValue('No');
    st.getRange(keys.indexOf('Notify Email') + 1, 2).setValue('');

    var full, cer;
    check('Generate unique codes', function () {
      eq(generateCodes_(c), 2, 'codes created');
      eq(generateCodes_(c), 0, 'second run');
      var t = readGuests_(c);
      full = t.guests[0]; cer = t.guests[1];
      if (!new RegExp('^[A-Z2-9]{' + CODE_LENGTH + '}$').test(full.code) || full.code === cer.code) throw new Error('bad codes ' + full.code + ' ' + cer.code);
    });

    check('Text messages are filled in', function () {
      var t = readGuests_(c);
      if (t.guests[0].text.indexOf(inviteLink_(readSettings_(c), full.code)) < 0) throw new Error('link missing from text: ' + t.guests[0].text);
      if (!/reception/.test(t.guests[0].text)) throw new Error('full invite text should mention the reception');
      if (/reception/i.test(t.guests[1].text)) throw new Error('ceremony-only text mentions the reception');
    });

    check('Look up a Wedding + Reception invite', function () {
      var res = api('GET', { action: 'invite', code: full.code.toLowerCase() });
      eq(res.ok, true, 'ok');
      eq(res.data.type, 'full', 'type');
      eq(res.data.events.map(function (e) { return e.id; }), ['ceremony', 'reception'], 'events');
      eq(res.data.plusOneAllowed, true, 'plus one');
      eq(res.data.response.responded, false, 'responded');
    });

    check('Ceremony Only invite hides the reception', function () {
      var res = api('GET', { action: 'invite', code: cer.code });
      eq(res.data.events.map(function (e) { return e.id; }), ['ceremony'], 'events');
      if (JSON.stringify(res).indexOf('Reception') >= 0) throw new Error('reception details leaked');
    });

    check('Unknown code is rejected', function () {
      eq(api('GET', { action: 'invite', code: 'ZZZZZZ' }).error, 'not_found', 'error');
    });

    check('RSVP with plus one is written to the sheet', function () {
      var res = api('POST', { action: 'rsvp', code: full.code, attendance: { ceremony: ['Test Full One', 'Test Full Two'], reception: ['Test Full One'] }, plusOne: { name: 'Pat Guest', ceremony: true, reception: true } });
      eq(res.ok, true, 'ok (' + res.message + ')');
      var g = readGuests_(c).guests[0];
      eq(g.status, STATUS.attending, 'status');
      eq(g.ceremony, ['Test Full One', 'Test Full Two', 'Pat Guest'], 'ceremony');
      eq(g.reception, ['Test Full One', 'Pat Guest'], 'reception');
      eq(g.plusOneName, 'Pat Guest', 'plus one name');
      eq(res.data.response.plusOne, { name: 'Pat Guest', ceremony: true, reception: true }, 'plus one echoed');
    });

    check('Changing an RSVP overwrites the old answer', function () {
      var res = api('POST', { action: 'rsvp', code: full.code, attendance: { ceremony: [], reception: [] }, plusOne: { name: 'Pat Guest', ceremony: false, reception: false } });
      eq(res.ok, true, 'ok');
      var g = readGuests_(c).guests[0];
      eq(g.status, STATUS.declined, 'status');
      eq(g.ceremony, [], 'ceremony');
      eq(g.plusOneName, '', 'plus one cleared');
    });

    check('Ceremony Only guest cannot RSVP to the reception', function () {
      var res = api('POST', { action: 'rsvp', code: cer.code, attendance: { ceremony: ['Test Ceremony Only'], reception: ['Test Ceremony Only'] } });
      eq(res.error, 'bad_request', 'error');
      var ok = api('POST', { action: 'rsvp', code: cer.code, attendance: { ceremony: ['Test Ceremony Only'] } });
      eq(ok.ok, true, 'ceremony RSVP');
      eq(readGuests_(c).guests[1].reception, [], 'reception stays empty');
    });

    check('Names not on the invitation are rejected', function () {
      eq(api('POST', { action: 'rsvp', code: cer.code, attendance: { ceremony: ['Someone Else'] } }).error, 'unknown_guest', 'error');
    });

    check('Plus one is refused when not offered', function () {
      eq(api('POST', { action: 'rsvp', code: cer.code, attendance: { ceremony: ['Test Ceremony Only'] }, plusOne: { name: 'Sneaky', ceremony: true } }).error, 'bad_request', 'error');
    });

    check('Typed text cannot become a formula', function () {
      api('POST', { action: 'rsvp', code: full.code, attendance: { ceremony: ['Test Full One'] }, plusOne: { name: '=1+1', ceremony: true } });
      var t = readGuests_(c);
      var cell = t.sheet.getRange(2, t.cols.plusOneName + 1);
      if (cell.getFormula()) throw new Error('formula was stored: ' + cell.getFormula());
    });

    check('RSVP log records every response', function () {
      if (sheet_(c, 'log').getLastRow() < 5) throw new Error('only ' + (sheet_(c, 'log').getLastRow() - 1) + ' log rows');
    });

    check('Deadline closes RSVPs', function () {
      st.getRange(keys.indexOf('RSVP Deadline') + 1, 2).setValue('2000-01-01');
      expectError('closed', function () { submitRsvp_(c, { action: 'rsvp', code: cer.code, attendance: { ceremony: [] } }, now); });
      st.getRange(keys.indexOf('RSVP Deadline') + 1, 2).setValue('');
    });

    check('Invitation emails build correctly', function () {
      var t = readGuests_(c);
      var e1 = buildInviteEmail_(t.guests[0], readSettings_(c), 'invite');
      var e2 = buildInviteEmail_(t.guests[1], readSettings_(c), 'invite');
      if (e1.htmlBody.indexOf(t.guests[0].code) < 0) throw new Error('code missing from email');
      if (e1.body.indexOf('reception') < 0) throw new Error('full invite should mention the reception');
      if (e2.body.indexOf('reception') >= 0) throw new Error('ceremony-only invite mentions the reception');
    });

    check('Ping', function () { eq(api('GET', { action: 'ping' }).ok, true, 'ok'); });
  } finally {
    CTX_OVERRIDE_ = previous;
    Object.keys(names).forEach(function (k) { var s = ss.getSheetByName(names[k]); if (s) ss.deleteSheet(s); });
  }
  return results;
}
