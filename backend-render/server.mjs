import express from 'express';
import handler from './server/api-handler.mjs';

const app = express();
const port = Number(process.env.PORT || 10000);
const allowed = new Set((process.env.FRONTEND_ORIGIN || '').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean));
function originAllowed(origin) {
  if (!origin) return false;
  if (allowed.has(origin)) return true;
  // Netlify deploy previews/custom site subdomains; still echo the exact requesting origin.
  try { const u = new URL(origin); return u.protocol === 'https:' && (u.hostname.endsWith('.netlify.app') || u.hostname === 'localhost' || u.hostname === '127.0.0.1'); } catch { return false; }
}
for (const x of ['capacitor://localhost', 'http://localhost', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173']) allowed.add(x);
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'Tuition Manager API', health: '/api/health' }));
app.use('/api', async (req, res) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const url = `https://${req.headers.host || 'render.local'}${req.originalUrl}`;
    const headers = new Headers();
    for (const [k,v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) headers.set(k, v.join(', ')); else if (v != null) headers.set(k, String(v));
    }
    let body;
    if (!['GET','HEAD'].includes(req.method)) body = JSON.stringify(req.body ?? {});
    const request = new Request(url, { method: req.method, headers, body });
    const response = await handler(request);
    response.headers.forEach((v,k) => res.setHeader(k,v));
    if (originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    }
    res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('API request failed:', err);
    res.status(500).json({ ok:false, error:'Internal server error.' });
  }
});
app.listen(port, '0.0.0.0', () => console.log(`Tuition Manager API listening on ${port}`));
