# HayBackup — public website (dev build)

A self-contained marketing + purchase site for HayBackup. **Zero dependencies** (Node built-ins only),
so it runs anywhere Node runs and moves to a public host with no build/install step.

## Run locally (dev)
```
cd C:\HayBackup-Website
node server.js            # serves https://localhost:8090/  (override with PORT / HOST env vars)
```
**HTTPS:** the server serves HTTPS when it finds a cert (searches `.\certs\server.{crt,key}`, then the box's
`C:\cardcloud-local\certs\server.{crt,key}`). On this dev machine it reuses the Card Cloud cert (CN=thecardcloud, already
trusted), so **https://thecardcloud:8090/** loads with no warning. Use the **hostname** (the cert covers `thecardcloud`
and `localhost`, not the current LAN IP). With no cert present it falls back to plain HTTP. For public hosting, terminate
TLS at the host/reverse proxy (or drop a real cert in `.\certs\`).
Port **8090** was chosen because it was free on this machine (80/443 = Apache, 5050 = HayBackup dashboard,
8088/60243 = other node apps, 3306 = MySQL, 5060 = Inventoria, 8080 = SearXNG were all already taken).

Pages:
- `/`                — landing page (hero, features, pricing, FAQ)
- `/checkout.html`   — subscribe / interest form  → `POST /api/checkout`
- `/success.html`    — thank-you page
- `/healthz`         — JSON health check
- `/api/license/check` — **stub** licensing endpoint (returns a demo license) — the desktop app's
  "license server URL" can point here during testing.

Captured checkout leads are appended to `data\leads.jsonl`.

## Admin backend (edit pricing)
- Go to **`/admin`** (e.g. http://localhost:8090/admin). First visit asks you to **create an admin password**.
- The **Pricing** editor changes the plan name, currency, price, period, feature list, button text, and fine print.
  Saving writes `data/pricing.json`; the landing page and checkout read it from **`GET /api/pricing`**, so changes show
  on the public site immediately (no redeploy).

## Software updates (this site is the update server)
The desktop HayBackup app checks this site for new versions and can update itself.
- **Publish a release:** Admin (`/admin`) → "Software updates" → pick the installer `.exe` + version + notes → Publish.
  (Stored in `data/releases/`; `data/release.json` holds version/sha256/notes.)
- **Feed:** `GET /api/update/latest` → `{ version, url, sha256, notes }` (public). `GET /download/installer` serves the exe.
- **Point the app at it:** desktop app → Settings → Software updates → feed URL = `https://<this-site>/api/update/latest`.
  The app checks on boot + daily, shows an "Update available" banner, emails the contact, and applies on "Update now".
- **TLS note (dev):** because this dev site uses the internal Card Cloud cert, the app trusts it via the app's
  `data/update-ca.crt` (the **issuer** CA). On a real public host with a normal cert, nothing extra is needed.

## Keep it running on this dev box
- **Configured now (no admin rights needed):** a hidden launcher in the current user's **Startup folder**
  (`…\Start Menu\Programs\Startup\HayBackup-Website.vbs`) starts the site at **logon**. So after a reboot, it comes back when
  you sign in.
- **Optional upgrade — start at BOOT without anyone logged in** (like the backup app's service): register a SYSTEM
  Scheduled Task (needs elevation). From an **elevated** PowerShell:
  ```powershell
  $a = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "server.js" -WorkingDirectory "C:\HayBackup-Website"
  $t = New-ScheduledTaskTrigger -AtStartup
  $pr = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName "HayBackup Website" -Action $a -Trigger $t -Principal $pr -Settings $s -Force
  Start-ScheduledTask -TaskName "HayBackup Website"
  ```
  (If you use this, delete the Startup-folder `.vbs` so you don't run two copies.)

## Move to a public hosting provider
Because it's plain Node + static files, you have easy options:

1. **Node host (Render / Railway / Fly.io / a VPS):** copy the folder, run `node server.js`. These set a
   `PORT` env var automatically — the server already honors it. Point your domain at the host; put it behind
   the host's HTTPS (or a reverse proxy like Nginx/Caddy) on 443.
2. **Static host (Netlify / Vercel / Cloudflare Pages / S3+CloudFront):** the `public/` folder is a complete
   static site. The two dynamic bits (`/api/checkout`, `/api/license/check`) become serverless functions, or
   point the form at your real payment/CRM provider.

## Wiring the real purchase + licensing flow (later)
- **Payment:** replace the `/api/checkout` stub with a real processor (e.g. Stripe Checkout / Payment Links).
  On success, create the customer's license record and email them.
- **Licensing server:** flesh out `/api/license/check` to look up the customer by `machine`/`key` and return
  `{ valid, plan, expiresAt, message }`. Then set that URL in the desktop app under
  **Settings → License → Licensing server (advanced)**, and set the app's purchase URL to this site's domain.
- The desktop app already speaks this shape (see `license.js` in the backup app), so it's a drop-in once live.

## Files
```
server.js            zero-dep static + tiny API server
package.json         metadata (npm start)
public/              the website (index, checkout, success, 404)
data/leads.jsonl     captured checkout interest (created at runtime; don't commit)
```
