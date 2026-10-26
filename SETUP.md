# Setup guide

This takes about 30–45 minutes the first time. Do the steps in order.

**How it fits together**

- **Website** (`site/`): public, hosted free on GitHub Pages. It holds the main page and the invitation/RSVP page. It contains **no guest data**.
- **Google Sheet + Apps Script** (`apps-script/Code.gs`): private. It holds the guest list, gives each household a code and a ready-to-send text message, and records every RSVP.
- Each household gets a personal link like `https://yourdomain.com/invite/?code=K7M2QX9P`, which you text them from your phone (or email from the Sheet). The page asks the Sheet for that code, then shows that household's invitation (Wedding + Reception, or Ceremony Only) and saves the RSVP back to their row.

---

## 1. Create the guest sheet and install the script

1. Sign in to the Gmail account the invitations should come **from**. Create a new Google Sheet and name it something like *Wedding Guest List*.
2. In the sheet, open **Extensions → Apps Script**.
3. Delete everything in `Code.gs`, then paste in the whole contents of [`apps-script/Code.gs`](apps-script/Code.gs).
4. Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**. Go back to the editor, open `appsscript.json`, and replace it with [`apps-script/appsscript.json`](apps-script/appsscript.json).
   - The time zone there is `America/New_York`. It decides exactly when the RSVP deadline ends. Change it if the wedding is in another time zone (for example `America/Chicago`).
5. Click **Save**, then go back to the sheet tab and **reload the page**. A **💌 Wedding** menu appears after a few seconds.
6. Choose **💌 Wedding → Set up sheets**. Google asks you to authorize the script:
   - Choose your account. You'll see *"Google hasn't verified this app"*. That's expected, because it's your own script. Click **Advanced → Go to (project name) (unsafe) → Allow**.
   - It asks permission to edit **this** spreadsheet, send email as you, and show menus. Nothing else.
7. Choose **💌 Wedding → Run self-test**. You should see **"✅ All N checks passed."** It works in temporary tabs, sends no emails, and cleans up after itself.

You now have four tabs:

| Tab | What it's for |
|---|---|
| **Guests** | One row per household/invitation. White columns are yours to fill in. Grey columns are filled in automatically. |
| **Summary** | Live totals: invites sent and opened, households responded, plus how many people are attending or have declined the ceremony, and the same for the reception. |
| **Settings** | Times, venues, RSVP deadline, email options. |
| **RSVP Log** | Every response ever submitted, including changes. Useful if someone says "but I RSVP'd!" |

## 2. Publish the script as a web app

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**. Visitors can't see your sheet; they can only call the two actions in the script ("show the invitation for this code" and "save this RSVP").
4. Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.
5. Paste it into [`site/js/config.js`](site/js/config.js) as `apiUrl`.

> ⚠️ **Whenever you change `Code.gs` later**, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. That keeps the same URL. If you create a *new* deployment instead, you get a new URL and have to update `config.js` again.

## 3. Fill in Settings

On the **Settings** tab:

- **Site URL**: your website address, for example `https://stephanieandrobert.com`. No slash at the end. Use the `https://<username>.github.io/<repo>` address until the domain is set up.
- **RSVP Deadline**: a date like `YYYY-MM-DD`. Guests can RSVP or change their answer through the end of that day. Leave it blank for no deadline.
- **Ceremony Date / Time / Venue / Address** and **Reception Time / Venue / Address**: shown in the details under the invitation card (with a "Get directions" link), in emails, and as `{date}` in texts. Reception details are only ever sent to *Wedding + Reception* guests. To show a time over several lines, for example `Mocktails & Appetizers 6:00 PM` and then `Dinner Reception 7:00 PM`, put ` / ` between them or press Ctrl+Enter (⌘+Enter on a Mac) inside the cell.
- **The invitation cards.** Each guest sees the card for their invite type, wrapped in an envelope they tap to open. Type the wording normally; the cards add the capitals and script lettering. Put ` / ` (space, slash, space) wherever a new line should start.
  - Both cards: **Invitation Date & Time** (the date and time in words, as three lines) and **Invitation Location**.
  - The *Wedding + Reception* card: **Full Invite: Hosts**, **Request**, **First Name**, **Joiner** (the small word between the names), **Second Name** and **Under Names**.
  - The *Ceremony Only* card: **Ceremony Invite: Intro**, **Names** (keep the ` & ` to get the decorative ampersand) and **Title**.
  - Keeping all of this in the Sheet is deliberate. The website's code is public on GitHub, so the date, time and address must never go in it. Guests only see them on their own invitation.
- **Send RSVP Confirmations**: `Yes` emails guests a copy of their RSVP.
- **Notify Email**: put your email(s) here to get a message every time someone RSVPs.
- **Text Message**: the wording of the ready-to-send text on each guest row. Placeholders like `{first names}`, `{events}`, `{deadline}` and `{link}` are filled in per household.

Editing the Settings tab updates every invite link and text message automatically. If one ever looks out of date, run **💌 Wedding → Update codes, links & text messages**.

## 4. Add guests

On the **Guests** tab, add one row per invitation:

| Column | Example | Notes |
|---|---|---|
| **Guest Names** | `Mr. & Mrs. John Smith` | Write it the way it goes on the envelope. Couples like `Mr. & Mrs. John Smith` (or `Mr. and Mrs.`, `Dr. & Mr.`, `John & Jane Smith`) count as two people, and each gets their own accept/decline buttons ("Mr. John Smith", "Mrs. John Smith"). Separate anyone else with commas: `Mr. & Mrs. John Smith, Miss Emma Smith`. Ending with `& Guest` (as in `Mr. Colin Smith & Guest`) gives that household a plus one automatically. The envelope and emails use your wording exactly. **Party Size** shows how many people the row counts as. |
| **Email** | `smiths@gmail.com` | **Optional** if you're texting. Used for RSVP confirmation emails, or if you email some invites. Separate several addresses with commas. |
| **Invite Type** | `Wedding + Reception` or `Ceremony Only` | Pick from the dropdown. |
| **Plus One** | `Yes` / `No` | `Yes` lets them add one guest's name when they RSVP. |
| **Notes** | anything | Yours. The script never touches it. You can also add your own columns anywhere. |

A **Code**, **Invite Link** and **Text Message** appear automatically as you type. **Invite Opened At** fills in the first time that household taps open the envelope on their invitation, so a blank cell means they haven't opened it yet. The link previews that texts and emails show don't count. Opening a guest's link yourself does, so clear the cell after testing. Run **💌 Wedding → Check guest list for problems** to catch typos, duplicates and names it couldn't split into people.

If someone RSVPs by phone, you can type their answer straight into the sheet. Set **RSVP Status** to `Attending` or `Declined`, and list who's coming in **Ceremony Attending** / **Reception Attending** with commas. **Ceremony Declined** / **Reception Declined** fill themselves in, the Summary counts it all, and their invite page will show it.

## 5. Put the website on GitHub Pages

1. Create a **public** repository on GitHub (free GitHub Pages needs a public repo). The code is public, but no guest information is in it.
2. Push this folder to it:
   ```bash
   git add -A
   git commit -m "Wedding website"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. The **Test and deploy** workflow (in the **Actions** tab) runs all the tests, then publishes the `site/` folder. It runs again on every push to `main`. If a test fails, nothing is published.

## 6. Connect your domain

1. Buy the domain (Cloudflare, Porkbun and Namecheap all cost about $10–15 a year).
2. On GitHub: **Settings → Pages → Custom domain**. Enter the domain, for example `stephanieandrobert.com`, and save.
3. At your domain registrar, add these DNS records:

   | Type | Name | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | CNAME | `www` | `<your-username>.github.io` |

4. Wait for the DNS check to pass (minutes to a few hours), then tick **Enforce HTTPS**.
5. Recommended: verify the domain under your GitHub **profile Settings → Pages → Add a domain**. This stops anyone else from claiming it on GitHub.
6. Update **Site URL** on the Settings tab. Every invite link and text message updates to the new address.

## 7. Test the real thing before sending to anyone

1. Add two test rows for **yourselves**: one `Wedding + Reception` with Plus One `Yes`, and one `Ceremony Only`. Put your own email in them too.
2. Copy each row's **Text Message** and text it to your own phone.
3. On your phone, tap each link and RSVP. Check that:
   - the Ceremony Only invite shows no reception anywhere
   - the row on the Guests tab fills in, and the Summary counts it
   - you get the confirmation email (and the notify email, if you set one)
4. Open the link again, click **Change my response**, change something, and check the row updates.
5. Delete the test rows when you're done.

## 8. Send the invitations by text

For each household:

1. Copy the **Text Message** cell. It's already personalized ("Hi Dan, Erin & Finn! …") with that household's own link. Paste it into a text from your phone, tweak the wording if you like, and send.
2. Afterwards, select the rows you've texted and choose **💌 Wedding → Mark selected rows as invited (texted)**. This fills in **Invite Sent At**, so the Summary's "Invites sent" count stays right, and you can sort by that column to see who you haven't texted yet.

Tips:

- **Always send each household its own message.** The link *is* their invitation, so a group text would let everyone open (and change) each other's RSVPs.
- Copying on your phone is easiest in the Google Sheets app: tap the cell → **Copy**.
- To nudge people later, filter **RSVP Status** for `Not responded` and text them their message again.
- On iPhone, the link shows a preview card. The site's title is "Stephanie & Robert".

### Or email some of them

The email tools still work for anyone you'd rather email: **Email invites to selected rows**, **Email all unsent invites** and **Email RSVP reminders**. Use **Email a test invite to myself** first to see what it looks like. Free Gmail accounts can send to about 100 recipients a day from scripts. If you hit the limit, it stops cleanly and picks up where it left off the next day.

## Updating the script later

Whenever a new version of `apps-script/Code.gs` comes along:

1. In the Apps Script editor, replace everything in `Code.gs` with the new file and click **Save**.
2. In the sheet, run **💌 Wedding → Set up sheets**. This adds any new Settings rows and never touches your guests, answers or existing settings.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The web app URL stays the same.
4. Check it's live: open your web app URL with `?action=ping` on the end (for example `https://script.google.com/macros/s/…/exec?action=ping`). It should show the `VERSION` from the top of the new `Code.gs`. If it shows an older number, step 3 didn't take, so try it again.

## Security notes

- Codes are 8 random characters (about 850 billion possibilities). If someone tries lots of wrong codes (60 in 10 minutes), the site pauses all lookups until that 10-minute window ends, so codes can't be guessed.
- Each household gets at most one confirmation email (and you one notification) every 10 minutes. Someone re-submitting over and over can't flood inboxes or use up your daily email limit. Every RSVP is still saved.
- The **RSVP Log** tab records every submission, including changes.

## Making changes

| To change… | Edit |
|---|---|
| Colors and fonts | [`site/css/theme.css`](site/css/theme.css): one block of variables |
| Main page text (dress code, FAQ) | [`site/index.html`](site/index.html): look for `TODO` comments. Never put the date, time or location on the main page. |
| Registry | Put the registry link in `registryUrl` in [`site/js/config.js`](site/js/config.js). It shows as a button. If the registry site gives you an embed link, put it in `registryEmbedUrl` to show the registry right on the page. If it gives you an embed *code* (a snippet of HTML), paste it in [`site/index.html`](site/index.html) where it says `PASTE REGISTRY EMBED CODE`. |
| Invitation wording | The Settings tab of the Sheet (see step 3) |
| Invitation design (layout, envelope) | [`site/js/invitation-card.js`](site/js/invitation-card.js) and the envelope section of [`site/css/invite.css`](site/css/invite.css) |
| Photos | Put the originals in a folder and run `npm run photos -- "C:\path\to\folder"`. It resizes them and removes location data. |
| Email wording | `buildInviteEmail_` in `Code.gs` (then make a **new version** of the deployment) |

## Previewing and testing locally

You need [Node.js](https://nodejs.org) 22+.

```bash
npm install
```

```bash
npm run dev
```

This opens the whole site at http://localhost:5173 with a **fake Google Sheet** and four sample guests (links are printed in the terminal). You can view the fake sheet at `/__sheet` and the emails it "sent" at `/__emails`.

```bash
npm test
```

This runs about 130 automated tests covering the RSVP backend (in a simulated Google Sheets) and the website-to-script connection.

## Troubleshooting

| Problem | Fix |
|---|---|
| Invite page says *"Your invitation isn't quite ready"* | The web app is running an older `Code.gs`. Follow "Updating the script later", including making a **New version**, then check `?action=ping`. |
| Invite page says *"Invitations aren't open yet"* | `apiUrl` in `site/js/config.js` isn't set, or the push hasn't deployed yet. |
| Changes to `Code.gs` don't show up | Make a **new version** of the existing deployment (step 2). |
| *"We couldn't reach the RSVP service"* | Check the web app access is **Anyone** and the URL ends in `/exec`. |
| *"This invitation isn't quite ready yet"* | That row has no **Invite Type** (or no names). |
| No 💌 Wedding menu | Reload the sheet and wait a few seconds. |
