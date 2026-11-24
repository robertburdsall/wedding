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
   - It asks permission to edit **this** spreadsheet, send email as you, show menus, and use Google Drive. Drive is only used to save photos guests share at the reception into one folder it creates (see "Photo sharing at the reception").
7. Choose **💌 Wedding → Run self-test**. You should see **"✅ All N checks passed."** It works in temporary tabs, sends no emails, and cleans up after itself.

You now have five tabs:

| Tab | What it's for |
|---|---|
| **Guests** | One row per household/invitation. White columns are yours to fill in. Grey columns are filled in automatically. |
| **Summary** | Live totals: invites sent and opened, and households responded. Then the **ceremony** and the **reception** each get their own section: households and people invited, plus ones offered, the most possible, who's attending or declined, who you're still waiting on, and the total if everyone still waiting says yes. Then plus ones, meals, photos and emails. |
| **Settings** | Times, venues, RSVP deadline, email options. |
| **Photos** | One row per photo shared at the reception. Tick **Hidden** to leave one out of the album. |
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
- **RSVP Deadline (Ceremony Only)**: optional. A different last day for "Ceremony Only" households, for example a week later than the reception guests (who need an earlier count for the caterer). Their invitation, text message and emails all show this date instead. Leave it blank and they use **RSVP Deadline**.
- **Ceremony Date / Time / Venue / Address** and **Reception Time / Venue / Address**: shown in the details under the invitation card (with a "Get directions" link), in emails, and as `{date}` in texts. Reception details are only ever sent to *Wedding + Reception* guests. To show a time over several lines, for example `Mocktails & Appetizers 6:00 PM` and then `Dinner Reception 7:00 PM`, put ` / ` between them or press Ctrl+Enter (⌘+Enter on a Mac) inside the cell.
- **The invitation cards.** Each guest sees the card for their invite type, wrapped in an envelope they tap to open. Type the wording normally; the cards add the capitals and script lettering. Put ` / ` (space, slash, space) wherever a new line should start.
  - Both cards: **Invitation Date & Time** (the date and time in words, as three lines) and **Invitation Location**.
  - The *Wedding + Reception* card: **Full Invite: Hosts**, **Request**, **First Name**, **Joiner** (the small word between the names), **Second Name**, **Closing Line** (shown under the address, e.g. "Reception to follow"; blank = none) and **Under Names** (optional: leave it blank and the card switches to a centered layout, with the request lines a little smaller just above the names).
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

## Reception dinner choices

Every *Wedding + Reception* household also gets a **Meal Link** (`yourdomain.com/meal/?code=…`, using the same personal code) and a ready-to-send **Meal Text Message**.

- The meal page lists everyone in the household who accepted the reception, including a plus one who's coming. Each person picks a meal, and there's one box for dietary restrictions or allergies.
- If they haven't RSVP'd for the reception yet, the page asks them to do that first and links to their invitation. Guests who just RSVP'd for the reception also see a **Choose your dinner** button on their invitation.
- Their choices fill in **Meal Choices** (for example `Mr. John Smith: Filet Mignon; Mrs. John Smith: North Atlantic Salmon`), **Dietary Notes** and **Meals Chosen At**. They can reopen the link and change their choices until the **Meal Deadline**, if you set one.
- If someone later drops the reception on their RSVP, their meal is removed automatically. Someone newly added to the reception shows up on the meal page without a choice, so they'll be asked again.
- The **Summary** shows a count for each meal and how many reception guests still need to choose.
- The choices come from **Meal Options** on the Settings tab (`North Atlantic Salmon / Filet Mignon`). If the caterer changes the menu, edit that cell and run **💌 Wedding → Set up sheets** so the Summary counts the new options.
- Ceremony-only guests can't open the meal page.

## Photo sharing at the reception

Reception guests tap **Take photos & videos** on their camera link (emailed to them) or the QR code on their table. It opens a camera right on the page, like the iPhone's: **Photo** / **Video** under the picture (or swipe) switches between them, the last shot sits bottom left, and the switch-camera button bottom right. No app needed. Photos save as soon as they're taken; videos get a quick **Retake** / **Use this video** first. They can also pick photos they already took.

Guests can add a filter: color looks (Warm, Film, B&W, Soft, Vivid, Cool, Vintage) or silly ones (Mustache, Sombrero, Top Hat, Puppy, Shades, Party Hat, Taco Rain, Hearts). The face ones follow faces live, for up to 4 people. **The file saved is always the original**, with no filter: only the filter's name is kept, plus, for the face filters, where the faces were (a few times a second for videos). The filter is drawn on top wherever it's shown, so you can change it or clear it later. **Nobody sees anyone else's photos until you publish the album.** Until then each guest only sees the photos they took themselves. You review everything on the Photos tab, hide what you don't want, and publish. Then everyone gets the album.

**Where things go**

- Photos are saved to a Google Drive folder, made automatically the first time you run **Set up sheets** (called *Stephanie & Robert — Wedding Photos*). After the wedding, right-click the folder → **Download** to keep them all.
- Each photo and video gets a row on the **Photos** tab: when it was taken, who shared it (if they typed a name), their note, their table, a small preview, **Type** (Photo or Video), **Filter** and, for videos, **Seconds**.
- **To leave one out of the album,** tick **Hidden** on its row. The file stays in your folder until you publish, when it moves to a separate private folder.
- **To change a filter,** pick a different one in the **Filter** column's dropdown, or clear it to show the original. A different face filter is drawn on the same faces. Turning on a face filter for something that was taken without one only works in the highlight builder (the album doesn't know where the faces are).
- The silly face filters use Google's free face detector, which phones download (about 9 MB, once) only when someone picks one. It works best on faces within a few steps of the camera.
- The album download (the Drive folder) has the originals, without filters.
- Phones shrink photos to 3000 pixels on the long side before uploading, which keeps uploads quick on venue signal and is still plenty for prints. This also strips location data.
- **Videos are recorded right on the page**, up to **Video Seconds** (30) each at 720p, about 10 MB. Photos taken on the page use the camera's full picture size where the phone allows. They go up in 2 MB pieces, so a weak signal only resends the piece that dropped. iPhones save MP4; some Android phones save WebM, which Google Drive plays in its own player. Each video also gets a still for the album grid, kept in a separate "(video stills)" folder so it isn't in the album download.
- Videos from the camera roll can't be added (they're often huge and in 4K). Guests are told to record one on the page instead.

**Who can see the photos**

Before you publish the album: only the two of you (on the Photos tab, in the Drive folder, and in the highlight builder) and the guest who took each photo or video. The camera page never sends a guest anyone else's photos, and the slideshow stays on a waiting screen. Each file is shared as "anyone with the link" so the Photos tab can show its preview, but those links are only ever handed to the guest who took it.

After you publish: everyone with the **Photo Code** (printed on the table cards) or an album email, minus the photos you hid. The photo pages aren't linked from the main website and search engines are told to ignore them. To shut out an old code (say, a test card you printed), clear **Photo Code** on Settings and a new one is made. Then print the cards again.

**Settings**

| Setting | What it does |
|---|---|
| Photo Code | The secret code on the cards. Filled in automatically. |
| Photo Uploads Until | Last day guests can add photos, for example two weeks after the wedding. Blank = no end (sharing also closes when you publish the album). |
| Photo Folder | Filled in automatically. Paste a link to a different Drive folder of yours if you'd rather use your own. |
| Photos Per Person | How many photos each camera can share (50). Blank = no limit. |
| Videos Per Person | How many videos each camera can record (10). 0 = no videos; blank = no limit. |
| Video Seconds | The longest a video can be (30 seconds; 5 to 120). |
| Review Code, Highlight Builder Link | Filled in automatically. The builder link is just for you two; don't share it. Clear **Review Code** to get a new one. |
| Highlight Video | Filled in when you save a highlight from the builder: the link to send. |
| Video Stills Folder | Filled in automatically. |
| Camera Email Days Before | When to email reception guests their camera links: this many days before the Ceremony Date (3). Blank = only when you use the menu. |
| Camera Email Subject, Album Email Subject | The subject lines of those emails. |
| Photo Album Published, Photos Left Out Folder | Filled in when you publish the album. |
| Photo Page Link, Photo Slideshow Link, Photo Table Cards Link | Filled in automatically. Also shown by **💌 Wedding → Show photo sharing links**. |

The slideshow shows photos only.

**Before the wedding**

1. Open the **Photo Table Cards Link** on a computer. Set the number of tables and print (two 5×7 cards per letter page, landscape). Cut along the dashed lines.
2. Test it: scan a card with your phone, share a couple of photos and record a short video, and check they show on your phone under "from you" and on the Photos tab. Try it on an iPhone and an Android phone if you can. Then tick **Hidden** on the test ones.
3. The **Photo Slideshow Link** shows the album on a TV or projector, but only after you publish it (handy for a get-together after the wedding). Click once for full screen.

### Personal cameras for reception guests

- **Emails come from the meal page.** Each person picking a dinner can add their email. Addresses fill in the **Guest Emails** column ("Name: email; …"). They're optional, and the meal page nudges anyone who left one out.
- **Each reception guest gets their own camera link** (`…/photos/?t=CODE&me=…`). It greets them by name, puts their name on their photos, and counts their shots against **Photos Per Person** (50) and **Videos Per Person** (10). Opening it once also makes the table QR code open the same camera on that phone. Someone who only scans a table card gets their own 50 and 10, counted per phone.
- **The links are emailed automatically** **Camera Email Days Before** (3) the **Ceremony Date**, around 9 AM. One email goes to each address, so a couple sharing an address gets one email with a button for each of them. Anyone who adds their email after that day gets theirs right away, and no one gets it twice. Sent addresses are listed in **Camera Emails Sent**.
- To check how it looks, use **💌 Wedding → Email a test camera link to myself**, or **💌 Wedding → Email test camera emails to…** and type a few addresses. An address that's in someone's Guest Emails gets exactly the email that guest will get, with their own camera link (photos taken with it count as theirs, so tick **Hidden** or delete those rows afterwards). Test emails aren't marked as sent, so guests still get theirs on the day. To send the real ones early, use **💌 Wedding → Email camera links now**.
- Ceremony-only guests don't get a camera.

### After the wedding: publish the album

1. On the Photos tab, tick **Hidden** on anything you don't want in the album.
2. Choose **💌 Wedding → Publish the photo album (and email it)**. Hidden photos move to a separate private "(left out of the album)" folder. The photo folder becomes downloadable by anyone with its link, photo sharing closes, and the photo page becomes the finished album with a **Download all photos** button.
3. Every reception guest with an email gets the album by email, once. If the daily email limit runs out, the rest go out automatically the next morning.

Hid something else later? Tick it and publish again: it's taken out of the folder, and no one is emailed twice. To reopen photo sharing, clear **Photo Album Published** on Settings.

### The highlight video (for people who couldn't make it)

You put it together yourselves from the guests' clips and photos; nothing is made automatically.

1. Open the **Highlight Builder Link** from the Settings tab, in **Chrome on a computer**. It lists every photo and video guests shared (tick **Show ones you hid** to include those too).
2. Click **+ Add** on the ones you want. Select one in the **Running order** to trim it (type the start and end, or pause the video and use **Start/End where it's paused**), pick a different filter (silly ones too: the builder finds the faces itself if it needs to) or **Original**, or for photos, how many seconds they show. Drag the rows (or use ↑ ↓) to put them in order.
3. Under **Look & sound**: wide (16:9) or tall (9:16), an opening title, closing words, "Filmed by …" credits, fades, the clips' own sound, and an optional song from your computer (it gets quieter under clips with sound and fades out at the end).
4. **Preview the highlight** plays it through. **Make the video** plays it once more while it records, so it takes as long as the video itself: keep the tab open and in front until it's done.
5. Watch the result, then **Download** it, and/or **Save & get a link**. Saving puts it in your photo folder, fills in **Highlight Video** on Settings, and gives you a link anyone can watch without signing in. Once the album is published, the album page shows a **Watch the highlight video** button too.

Your running order is remembered on that computer, so you can come back to it (add the song again after reopening). The guests' original files are never changed.

## Updating the script later

Whenever a new version of `apps-script/Code.gs` comes along:

1. In the Apps Script editor, replace everything in `Code.gs` with the new file and click **Save**.
2. In the sheet, run **💌 Wedding → Set up sheets**. This adds any new Settings rows and never touches your guests, answers or existing settings.
3. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The web app URL stays the same.
4. Check it's live: open your web app URL with `?action=ping` on the end (for example `https://script.google.com/macros/s/…/exec?action=ping`). It should show the `VERSION` from the top of the new `Code.gs`. If it shows an older number, step 3 didn't take, so try it again.

If [`apps-script/appsscript.json`](apps-script/appsscript.json) changed too, replace that file in the editor as well before step 2. **Set up sheets** then asks you to authorize again. Version 2.0.0 added Google Drive access for photo sharing: Google warns that the script can see your Drive files, but it only ever uses its own photo folder. Version 2.1.0 added permission to run on a schedule, which sends the camera emails 3 days before the wedding. **Set up sheets** installs that daily schedule. Version 3.0.0 added permission to "connect to an external service": that's Google Drive's own upload service, which videos go through in pieces (and the highlight builder reads them back the same way).

## Security notes

- The photo pages need the Photo Code. Wrong codes count toward the same 60-in-10-minutes limit as invitation codes. Only JPEG photos are accepted, up to about 10 MB.

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
| Photo page says *"Photo sharing isn't open yet"* | The web app is running a `Code.gs` older than 2.0.0, or **Set up sheets** hasn't been run since updating. |
| A photo on the camera page shows *"Still processing…"* | Google Drive takes a few seconds to make the small version of a new photo. It appears on the next refresh. If it never does, check the file in the Drive folder is shared as "Anyone with the link". |
| *"Exception: You do not have permission to call DriveApp"* | Replace `appsscript.json` with the repo's version and run **Set up sheets** again to authorize Drive. |
