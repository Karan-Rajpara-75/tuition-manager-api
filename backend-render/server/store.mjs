import fs from 'node:fs/promises';
import path from 'node:path';

// Prefer PostgreSQL whenever DATABASE_URL is configured. This survives Render
// instance sleep/restarts and does not depend on the ephemeral filesystem.
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  await pool.query(`CREATE TABLE IF NOT EXISTS tuition_manager_store (
    store_key TEXT PRIMARY KEY,
    store_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

const dir = path.resolve(process.env.DATA_DIR || './data');
if (!pool) await fs.mkdir(dir, { recursive: true });
const fileFor = key => path.join(dir, `${Buffer.from(String(key)).toString('base64url')}.json`);
export const store = {
  async get(key, options = {}) {
    if (pool) {
      const { rows } = await pool.query('SELECT store_value FROM tuition_manager_store WHERE store_key = $1', [String(key)]);
      if (!rows.length) {
        // One-time migration fallback: import any surviving legacy JSON-file value.
        try {
          const legacyRaw = await fs.readFile(fileFor(key), 'utf8');
          const legacyValue = JSON.parse(legacyRaw);
          await pool.query('INSERT INTO tuition_manager_store (store_key, store_value) VALUES ($1, $2::jsonb) ON CONFLICT (store_key) DO NOTHING', [String(key), JSON.stringify(legacyValue)]);
          return options.type === 'text' ? legacyRaw : legacyValue;
        } catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
      }
      const value = rows[0].store_value;
      return options.type === 'text' ? JSON.stringify(value) : value;
    }
    try {
      const raw = await fs.readFile(fileFor(key), 'utf8');
      const value = JSON.parse(raw);
      return options.type === 'text' ? raw : value;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  },
  async setJSON(key, value, options = {}) {
    if (pool) {
      if (options.onlyIfNew) {
        const { rowCount } = await pool.query(
          'INSERT INTO tuition_manager_store (store_key, store_value) VALUES ($1, $2::jsonb) ON CONFLICT (store_key) DO NOTHING',
          [String(key), JSON.stringify(value)]
        );
        if (!rowCount) throw new Error('Key already exists');
        return;
      }
      await pool.query(`INSERT INTO tuition_manager_store (store_key, store_value, updated_at)
        VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (store_key)
        DO UPDATE SET store_value = EXCLUDED.store_value, updated_at = NOW()`, [String(key), JSON.stringify(value)]);
      return;
    }
    const file = fileFor(key);
    if (options.onlyIfNew) {
      try { await fs.access(file); throw new Error('Key already exists'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, file);
  },
  async delete(key) {
    if (pool) { await pool.query('DELETE FROM tuition_manager_store WHERE store_key = $1', [String(key)]); return; }
    try { await fs.unlink(fileFor(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
};
