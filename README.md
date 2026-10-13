# WhatsChat / PingMe

A username-based messaging app with profiles, friend requests, inbox, direct messages, and a mobile-friendly vanilla HTML/CSS/JS frontend.

check out website is live here : https://preetham078.github.io/whatschat/

## Stack

- Node.js 20+
- Express 5
- CommonJS modules
- Static frontend in `public/`
- SQLite for local development
- Postgres/Supabase in production

## Run Locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

By default the app uses `data.sqlite`. To use Postgres, set one of:

```bash
SUPABASE_DB_URL=postgres://...
SUPABASE_DATABASE_URL=postgres://...
DATABASE_URL=postgres://...
```

## Messaging Across Devices

Accounts, friend requests, inboxes, and direct messages are shared only when each phone/browser uses the same backend server.

For local testing on multiple phones on the same Wi-Fi:

1. Start the server on your computer with `npm start`.
2. Find your computer's LAN IP address.
3. Open `http://YOUR_LAN_IP:3000` on each phone.
4. Create separate accounts on each phone, search usernames, send friend requests, accept them, and message.

For production, deploy the backend to Render, Supabase/Postgres, Cloud Run, or another public server. Then open the frontend with:

```text
https://your-site.example/?api=https://your-backend.example
```

The static GitHub Pages frontend also reads `window.PINGME_API_BASE` from `public/config.js`. If no backend is reachable, the app falls back to localStorage mode, but that mode is private to one browser and does not sync between phones.

## Environment

- `PORT`: server port, defaults to `3000`
- `HOST`: bind host, defaults to `0.0.0.0`
- `ALLOWED_ORIGIN`: CORS origin, defaults to `*`

## Frontend Configuration

The frontend reads API base URL in this order:

1. Query string: `?api=https://your-server-url`
2. Same-origin API while running on localhost
3. `window.PINGME_API_BASE` from `public/config.js` for hosted static pages

`public/config.js` is set to:

```js
window.PINGME_API_BASE = "https://recallai-l1be.onrender.com";
```

When hosted without a backend, such as GitHub Pages, the app falls back to browser-only localStorage mode using `pingmeStaticData`. Active sessions use `pingmeAccount`.

## API

- `GET /api/health`
- `POST /api/accounts`
- `POST /api/login`
- `GET /api/profile?accountId=`
- `PATCH /api/profile`
- `GET /api/accounts/search?accountId=&q=`
- `GET /api/friend-requests?accountId=`
- `POST /api/friend-requests`
- `POST /api/friend-requests/:username/accept`
- `GET /api/inbox?accountId=`
- `GET /api/messages/:username?accountId=`
- `POST /api/messages`

## Deployment

- GitHub Pages frontend: `.github/workflows/pages.yml`
- Render: `render.yaml`
- Google App Engine standard: `app.yaml`
- Google Cloud Build and Cloud Run: `cloudbuild.yaml`
- Docker: `Dockerfile`

## Launch On GitHub Pages

1. Push this repository to GitHub with the default branch named `main`.
2. In GitHub, open the repository settings.
3. Go to **Pages**.
4. Set **Build and deployment** to **GitHub Actions**.
5. Push to `main` or run the **Deploy GitHub Pages** workflow manually.

The GitHub Pages site serves only the static frontend from `public/`. The live multi-device messaging backend must be deployed separately and configured through `public/config.js` or the `?api=` query parameter.
