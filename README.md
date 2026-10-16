# Stealth

Premium dark + red neon plan site with register/login, NOWPayments live crypto checkout, dashboard, and admin panel.

## Requirements

- Node.js 18+ (`node -v`)

## Local run (Windows PowerShell)

```powershell
cd path\to\stealth
copy .env.example .env
notepad .env
```

Fill at least:

```env
PORT=8787
SITE_URL=http://localhost:8787
NOWPAYMENTS_API_KEY=your_key_from_account.nowpayments.io
ADMIN_EMAIL=admin@stealth.local
ADMIN_PASSWORD=change_this_password
SESSION_SECRET=long_random_string
```

Start:

```powershell
node server\standalone.js
```

Open **http://localhost:8787**

## Local run (Mac / Linux)

```bash
cp .env.example .env
nano .env
node server/standalone.js
```

## Flow

1. Register / Login  
2. Select lifetime plan ($149 / $249 / $549)  
3. Choose crypto → live deposit address + QR  
4. After NOWPayments confirms → Dashboard  
5. Admin login uses `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`

## Important

- Never commit `.env` (it is gitignored).
- `NOWPAYMENTS_API_KEY` is required for real QR addresses.
- Restart the server after any `.env` change.

## Deploy note

Set `SITE_URL` to your public URL (https://yourdomain.com) so payment redirects and IPN work.


## Deploy on Vercel

1. Push repo to GitHub (do **not** commit `.env`).
2. vercel.com → New Project → import repo.
3. Framework Preset: **Other**.
4. Root directory: project root (where `index.html` + `api/` live).
5. Environment Variables (Project Settings → Environment Variables):

| Name | Value |
|------|--------|
| `NOWPAYMENTS_API_KEY` | your key |
| `ADMIN_EMAIL` | admin@stealth.local |
| `ADMIN_PASSWORD` | strong password |
| `SESSION_SECRET` | long random string |
| `SITE_URL` | https://your-app.vercel.app |

6. Deploy.
7. Open `https://your-app.vercel.app` — CSS should load; `/api/health` should return JSON.

### If the site is unstyled (white page)

- Hard refresh, or
- Confirm `styles.css` is in the **same folder** as `index.html` on the repo root.
- In browser DevTools → Network → check if `styles.css` is 404.

### Note on Vercel data storage

User/order data is stored in `/tmp` on serverless and can reset when instances recycle.
For production persistence, later plug in a database (Vercel KV / Postgres). Payments still work via NOWPayments.
