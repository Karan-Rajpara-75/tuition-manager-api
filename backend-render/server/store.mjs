import fs from 'node:fs/promises';
import path from 'node:path';

// Production: set DATABASE_URL to a managed PostgreSQL connection string.
// Local development: if DATABASE_URL is absent, use a JSON-file store.
let store;

if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Managed PostgreSQL providers commonly require TLS. Set PGSSLMODE=disable
    // only for a trusted local database that explicitly does not support TLS.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  store = {
    async get(key, options = {}) {
      const { rows } = await pool.query('SELECT value FROM app_kv WHERE key = $1', [String(key)]);
      if (!rows.length) return null;
      const value = rows[0].value;
      return options.type === 'text' ? JSON.stringify(value) : value;
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfNew) {
        const result = await pool.query(
          'INSERT INTO app_kv (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
          [String(key), JSON.stringify(value)]
        );
        if (result.rowCount === 0) throw new Error('Key already exists');
        return;
      }
      await pool.query(
        `INSERT INTO app_kv (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [String(key), JSON.stringify(value)]
      );
    },
    async delete(key) {
      await pool.query('DELETE FROM app_kv WHERE key = $1', [String(key)]);
    },
  };
  console.log('Persistent PostgreSQL store enabled.');
} else {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  await fs.mkdir(dir, { recursive: true });
  const fileFor = key => path.join(dir, `${Buffer.from(String(key)).toString('base64url')}.json`);
  store = {
    async get(key, options = {}) {
      try {
        const raw = await fs.readFile(fileFor(key), 'utf8');
        const value = JSON.parse(raw);
        return options.type === 'text' ? raw : value;
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async setJSON(key, value, options = {}) {
      const file = fileFor(key);
      if (options.onlyIfNew) {
        try { await fs.access(file); throw new Error('Key already exists'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temp, file);
    },
    async delete(key) { try { await fs.unlink(fileFor(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  };
  console.warn('DATABASE_URL is not set: using local file storage (ephemeral on Render Free).');
}

export { store };
