# Tuition Manager API — Render + persistent PostgreSQL

This backend supports a managed PostgreSQL database through `DATABASE_URL`. When `DATABASE_URL` is set, app data, sessions, and the lock record are stored in PostgreSQL instead of Render's temporary filesystem.

## Setup (free-tier option: Neon PostgreSQL)

1. Create a PostgreSQL project at https://neon.com/ and copy its connection string. Keep the string private; it contains credentials.
2. In Render, open your existing `tuition-manager-api` Web Service → **Environment**.
3. Add/update:
   - Key: `DATABASE_URL`
   - Value: the full Neon PostgreSQL connection string (use the pooled connection string if Neon offers one).
4. Keep your existing `FRONTEND_ORIGIN` unchanged. `DATA_DIR` is not needed when `DATABASE_URL` is set; it may be removed.
5. Save changes and let Render redeploy. In the logs, look for `Persistent PostgreSQL store enabled.`
6. Open the website and restore/import your latest Backup JSON using the app's existing restore/import feature. Verify the records are visible, then restart/redeploy the Render service and verify again.

The first start automatically creates the `app_kv` table. No manual SQL is required.

## Important

- Do not put `DATABASE_URL` in frontend/Netlify variables or commit it to GitHub. It belongs only in Render's backend Environment settings.
- Neon Free has usage/storage limits and compute may sleep when idle; data remains in the database when compute sleeps. Exceeding quotas may temporarily stop database operations. Review current terms at https://neon.com/docs/introduction/plans.
- This makes data persistent across Render restarts/redeploys, but no free service can guarantee data forever. Keep regular Backup JSON exports somewhere safe.
- If the app is currently using `/tmp`, its existing records will not automatically appear in the new database. Restore the newest Backup JSON after configuring the database.
- Local development without `DATABASE_URL` still uses a JSON file under `./data`.
