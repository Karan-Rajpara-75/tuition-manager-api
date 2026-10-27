import fs from 'node:fs/promises';
import path from 'node:path';

// Render: set DATA_DIR=/var/data and attach a persistent disk at /var/data.
const dir = path.resolve(process.env.DATA_DIR || './data');
await fs.mkdir(dir, { recursive: true });
const fileFor = key => path.join(dir, `${Buffer.from(String(key)).toString('base64url')}.json`);
const localStore = {
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
export const store = localStore;
