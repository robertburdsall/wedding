# Stephanie & Robert

Wedding website with personal e-vite invitations and RSVPs.

- **Main page:** photos, registry, FAQ. The date, time and place are deliberately left off; they only appear on personal invitations.
- **Personal invitations:** each household gets its own link. *Wedding + Reception* and *Ceremony Only* guests see different invitations, and plus ones are allowed per household.
- **RSVPs go straight into a Google Sheet,** with live totals for the ceremony and the reception.
- **Each household gets a ready-to-send text message** with its personal link. Invitations can also be emailed from the Sheet's "💌 Wedding" menu.

**Start here → [SETUP.md](SETUP.md)**

## Layout

```
site/                 the public website (deployed to GitHub Pages)
  index.html          main page
  invite/index.html   personal invitation (envelope + card) and RSVP page
  js/invitation-card.js  draws the two invitation designs; the wording comes from the Sheet
  css/theme.css       all colors & fonts
  js/config.js        Apps Script URL + countdown date
apps-script/          paste into the Google Sheet's Apps Script editor
  Code.gs             guest list, codes, emails, RSVP API, self-test
tests/                automated tests (npm test)
tools/                local dev server, fake Google services, photo resizer
```

## Commands

| | |
|---|---|
| `npm run dev` | Preview everything locally with a fake Google Sheet |
| `npm test` | Run the test suite |
| `npm run photos -- "<folder>"` | Resize photos for the web (removes GPS data) |
