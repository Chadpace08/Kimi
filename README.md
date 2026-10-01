# Kimi: voice-first reminders

**Tap. Talk. Done.** Kimi is a personal reminder assistant for people who forget things and hate typing. Tap the mic, say it the way you'd tell a friend, and Kimi turns it into a reminder with the right date, time, repeat and amount.

> “Remind me to pay my bill on October 15.”
> “My Canva subscription is 1,299 pesos monthly, remind me every month.”
> “Remind me tomorrow morning to send the invoice.”
> “I need to renew my domain in December.”
> “Remind me every Friday to check my bookkeeping.”

No account, no backend, no paid APIs. Everything stays on your phone.

## Features

- **Voice capture**: one big mic button on every screen, a live transcript, and live chips (📅 date · 🔁 repeat · ₱ amount) that update while you speak.
- **"Got it" confirmation**: Kimi repeats back what it understood (out loud, too) and **auto-saves in 5 seconds**. Tap anything to change it. If you didn't say *when*, it asks you with one-tap options.
- **Understands natural speech**: dates (*Oct 15, the 20th, next Tuesday, in December, end of the month*), times (*at 3, tomorrow morning, tonight, in 20 minutes*), repeats (*every Friday, every weekday, monthly, on the 5th of every month, every other week, yearly*), amounts (*1,299 pesos, ₱549, $11.99, 2.5k*), and a little Taglish (*bukas, mamaya, kada buwan, bayaran*).
- **Tasks, bills and subscriptions**: detected automatically. The Bills tab shows your monthly recurring total, what's due in 30 days, and what you've paid this month.
- **Alerts**: an in-app alarm with chime, vibration and spoken reminder; system notifications with **Done** and **Snooze** buttons; an app icon badge; and a "while you were away" catch-up.
- **Snooze & done**: swipe a reminder right to finish it, left to snooze it, or tap the circle. Every action has **Undo**.
- **Add to phone calendar (.ics)**: back-up alarms that ring even when Kimi is closed.
- **PWA**: install to your home screen, works offline, has app shortcuts, and you can share text from other apps (e.g. a bill SMS) straight into Kimi.
- **Backup**: export/import a JSON file (merge or replace), or send it to Google Drive or email via the share sheet.
- Light/dark mode, big touch targets, haptics, reduced-motion support.
- Upgrading from the old Kimi? Your reminders come across automatically. Old notes can be exported from Settings.

## Put it on your phone

Kimi is a static site, so any free static host works. The easiest is **GitHub Pages**:

1. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`, then save.
2. Open the URL it gives you (e.g. `https://<you>.github.io/Kimi/`) on your phone.
3. **Android (Chrome):** tap **Install** on the home screen card, or ⋮ → *Install app*.
   **iPhone (Safari):** Share → *Add to Home Screen*.

HTTPS is required for the mic, notifications and offline mode (GitHub Pages provides it).

## What works where (honest notes)

| Feature | Android Chrome | iPhone Safari |
|---|---|---|
| Voice input | ✅ Best experience | ⚠️ Works in Safari; flaky once installed. Falls back to typing (keyboard 🎤 dictation works great) |
| Alerts while Kimi is open | ✅ | ✅ |
| Alerts while closed | ⚠️ Background checks when Chrome allows (installed app) | ❌ Use **Add to phone calendar** |
| Done/Snooze from notification | ✅ | Limited |
| Install + offline | ✅ | ✅ |

Browsers don't let a web app schedule exact alarms while it's closed without a push server. That's why every reminder has a one-tap **Add to phone calendar** for anything you can't afford to miss.

Voice is converted to text by the browser's built-in speech service (on Chrome this uses Google's servers). Kimi itself never sends your data anywhere.

## Project layout

```
index.html            App shell + inline icon set
styles.css            All styling (light/dark)
core.js               Pure logic: speech parser, dates, repeats, .ics (shared with the service worker)
app.js                UI: screens, voice capture, alerts, gestures, backup
sw.js                 Offline cache, notification actions, background checks
manifest.webmanifest  PWA install, shortcuts, share target
icons/                App icons
tests/                Parser tests
tools/try-parser.js   Quick CLI to see how a phrase is understood
```

## Development

No build step. Serve the folder and open it:

```bash
npx http-server -c-1 .           # then open http://localhost:8080
node --test tests/*.test.js       # parser tests
node tools/try-parser.js "pay rent on the 5th every month 15000 pesos"
```

When you change any app file, bump `VERSION` in `sw.js` so installed phones pick up the update. They'll see an "Update" button.
