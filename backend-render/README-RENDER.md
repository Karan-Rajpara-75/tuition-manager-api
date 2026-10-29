# Part 1 — Backend + API (Render)

## Deploy
1. Create a GitHub repository containing only this folder's files.
2. In Render choose **New → Web Service** and connect the repository.
3. Build command: `npm install`; Start command: `npm start`.
4. Attach a persistent disk mounted at `/var/data` (the included `render.yaml` requests this; disk availability depends on your Render plan).
5. Set `DATA_DIR=/var/data` and `FRONTEND_ORIGIN=https://YOUR-SITE.netlify.app`. If the frontend has a custom domain, include it comma-separated too.
6. After deploy, open `https://YOUR-SERVICE.onrender.com/api/health`. Expect `ok: true`.

Default fresh-install login: `admin` / `admin123`; change it after first login.

**Important:** Persistent disk is required for reliable storage. Without it, a Render restart/redeploy can reset stored data. This simple JSON store is intended for a single Render instance; do not scale it to multiple instances. Export a backup regularly.


CORS note: set FRONTEND_ORIGIN to https://tution-classes-75.netlify.app (exact origin, no trailing slash). This build also supports HTTPS Netlify subdomains and reflects the exact allowed origin for credentialed requests. After changing server.mjs, redeploy the Render service. Check https://tuition-manager-api.onrender.com/api/health first.


## Persistent storage (important)

When `DATABASE_URL` is set, the API stores application state, sessions, quizzes and quiz results in PostgreSQL (`tuition_manager_store` table). This is the recommended configuration because Render web-service filesystems such as `/tmp` are ephemeral and may be cleared when an instance restarts or sleeps. Keep `DATABASE_URL` set to your Render PostgreSQL **Internal Database URL** when the database and web service are in the same Render region. The app creates its table automatically on startup. `DATA_DIR` is only a fallback for local/file storage when no database URL is configured.

If a legacy JSON file still exists, the API imports its value into PostgreSQL on the first read of that key.
