# Stephanie & Robert

Wedding website with personal e-vite invitations and RSVPs.

- **Main page:** photos, registry, FAQ. The date, time and place are deliberately left off; they only appear on personal invitations.
- **Personal invitations:** each household gets its own link. *Wedding + Reception* and *Ceremony Only* guests see different invitations, and plus ones are allowed per household.
- **RSVPs go straight into a Google Sheet,** with live totals for the ceremony and the reception.
- **Reception dinner choices:** reception guests get a personal meal link to choose their dinner and note any dietary restrictions; choices land in their row.
- **Photo and video sharing at the reception:** reception guests get their own camera link by email 3 days before the wedding (50 photos and 10 thirty-second videos each, taken in one iPhone-style camera right on the page, with color and silly face filters like a mustache or sombrero that never change the original), and a QR code on each table opens it too. Guests only see their own photos and videos until you've reviewed them. Photos are saved to a Google Drive folder. Afterwards you hide any you don't want and publish the album, which emails everyone a link to view and download it.
- **Highlight video:** a private builder page where you two pick guests' clips and photos, trim them, choose filters, add a title and music, and record one video in the browser, then save it to Drive for a link to send people who couldn't come.
- **Registry:** a button on the main page and a card on every invitation.
- **Each household gets a ready-to-send text message** with its personal link. Invitations can also be emailed from the Sheet's "💌 Wedding" menu.

**Start here → [SETUP.md](SETUP.md)**

## Layout

```
site/                 the public website (deployed to GitHub Pages)
  index.html          main page
  invite/index.html   personal invitation (envelope + card) and RSVP page
  meal/index.html     reception dinner selection page
  photos/index.html   reception camera (each guest sees only their own photos), then the published album
  photos/slideshow.html  album slideshow for a TV or projector (after the album is published)
  photos/highlight.html  the couple's highlight builder: trim, order and record a highlight video
  photos/cards.html   printable table cards with QR codes
  js/invitation-card.js  draws the two invitation designs; the wording comes from the Sheet
  css/theme.css       all colors & fonts
  js/config.js        Apps Script URL and registry links
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
