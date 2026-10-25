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
