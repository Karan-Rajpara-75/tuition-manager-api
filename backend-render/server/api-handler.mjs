import { store } from './store.mjs';
import crypto from 'node:crypto';

const DATA_KEY = 'state';
const LOCK_KEY = 'write-lock';
const SESSION_PREFIX = 'session:';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const LOCK_TTL = 15000;

const baseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders, ...extra }
  });
}

function cookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=None`;
  if (opts.maxAge != null) s += `; Max-Age=${opts.maxAge}`;
  if (opts.secure !== false) s += '; Secure';
  return s;
}

function getCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}

function uid() {
  return crypto.randomUUID();
}

function blankData() {
  return {
    users: [{
      id: 'admin',
      username: 'admin',
      role: 'admin',
      studentId: null
    }],
    students: [],
    attendance: [],
    subjectUpdates: [],
    doubts: [],
    schoolPapers: []
  };
}

function attendanceBehaviorPart(data, studentId) {
  const rows = data.attendance.filter(a => a.studentId === studentId);
  if (!rows.length) return 0;
  const present = rows.filter(a => a.status === 'Present').length;
  return (present / rows.length) * 2;
}
function effectiveBehavior(data, studentId, manual) {
  const m = Math.min(8, Math.max(0, Number(manual) || 0));
  return Math.min(10, m + attendanceBehaviorPart(data, studentId));
}
function pointTestKey(point) {
  return String(point.testName || point.note || new Date(Number(point.date) || 0).toISOString().slice(0, 10) || 'Test').trim().toLowerCase();
}
function recomputeLives(data) {
  const groups = new Map();
  for (const student of data.students) {
    for (const point of (student.pointsHistory || [])) {
      if (point.source === 'school-paper' || point.schoolPaperId) continue;
      const key = pointTestKey(point);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ studentId: student.id, point });
    }
  }
  const ordered = [...groups.entries()].map(([key, rows]) => ({ key, rows, time: Math.max(...rows.map(x => Number(x.point.date) || 0)) })).sort((a,b) => a.time - b.time);
  const lives = new Map(data.students.map(s => [s.id, { max: 6, current: 0, unlocked: false, history: [] }]));
  for (const group of ordered) {
    const bestByStudent = new Map();
    for (const row of group.rows) {
      const score = Number(row.point.totalMarks) > 0 ? Number(row.point.obtainedMarks) / Number(row.point.totalMarks) : 0;
      const old = bestByStudent.get(row.studentId);
      if (!old || score > old.score) bestByStudent.set(row.studentId, { row, score });
    }
    const best = Math.max(...[...bestByStudent.values()].map(x => x.score), 0);
    for (const [studentId, life] of lives) {
      const entry = bestByStudent.get(studentId);
      if (!entry) continue;
      const isKing = entry.score >= best - 1e-9;
      const wasUnlocked = life.unlocked;
      let change = 0;
      if (!wasUnlocked && isKing) { life.unlocked = true; life.current = 1; change = 1; }
      else if (wasUnlocked) { change = isKing ? 1 : -1; life.current = Math.max(0, Math.min(6, life.current + change)); }
      entry.row.point.isKing = isKing;
      entry.row.point.lifeChange = change;
      life.history.push({ test: group.key, date: Number(entry.row.point.date) || Date.now(), isKing, change, health: life.current });
    }
  }
  for (const student of data.students) student.life = lives.get(student.id);
}
function normalizeData(data) {
  const next = data && typeof data === 'object' ? structuredClone(data) : blankData();
  if (!Array.isArray(next.users)) next.users = [];
  if (!Array.isArray(next.students)) next.students = [];
  if (!Array.isArray(next.attendance)) next.attendance = [];
  if (!Array.isArray(next.subjectUpdates)) next.subjectUpdates = [];
  if (!Array.isArray(next.doubts)) next.doubts = [];
  if (!Array.isArray(next.schoolPapers)) next.schoolPapers = [];

  next.students = next.students.map(s => ({
    ...s,
    id: String(s.id || uid()),
    pointsHistory: Array.isArray(s.pointsHistory) ? s.pointsHistory : [],
    life: s.life && typeof s.life === 'object' ? s.life : { max: 6, current: 0, unlocked: false, history: [] },
    homework: Array.isArray(s.homework) ? s.homework : []
  }));

  next.attendance = next.attendance
    .filter(a => a && a.studentId && a.date && (a.status === 'Present' || a.status === 'Absent'))
    .map(a => ({
      id: String(a.id || uid()),
      studentId: String(a.studentId),
      date: String(a.date),
      status: a.status,
      createdAt: Number(a.createdAt) || Date.now(),
      updatedAt: Number(a.updatedAt) || Number(a.createdAt) || Date.now()
    }));

  next.subjectUpdates = next.subjectUpdates
    .filter(x => x && x.subject && x.text)
    .map(x => ({
      id: String(x.id || uid()),
      type: ['Tomorrow', 'Paper', 'Subject'].includes(x.type) ? x.type : 'Subject',
      subject: String(x.subject).slice(0, 60),
      date: String(x.date || ''),
      time: String(x.time || '').slice(0, 10),
      topic: String(x.topic || '').slice(0, 120),
      text: String(x.text).slice(0, 500),
      createdAt: Number(x.createdAt) || Date.now(),
      updatedAt: Number(x.updatedAt) || Number(x.createdAt) || Date.now()
    }));

  next.doubts = next.doubts
    .filter(x => x && x.studentId && x.text)
    .map(x => ({
      id: String(x.id || uid()),
      studentId: String(x.studentId),
      studentName: String(x.studentName || '').slice(0, 100),
      text: String(x.text).slice(0, 1000),
      reply: String(x.reply || '').slice(0, 1000),
      createdAt: Number(x.createdAt) || Date.now(),
      repliedAt: x.repliedAt ? Number(x.repliedAt) : null
    }));

  next.schoolPapers = next.schoolPapers
    .filter(x => x && x.studentId && x.name)
    .map(x => ({
      id: String(x.id || uid()),
      studentId: String(x.studentId),
      studentName: String(x.studentName || '').slice(0, 100),
      name: String(x.name).slice(0, 100),
      date: String(x.date || ''),
      subjects: Array.isArray(x.subjects) ? x.subjects.map(r => ({
        subject: String(r.subject || '').slice(0, 80),
        obtained: Number(r.obtained) || 0,
        total: Number(r.total) || 0
      })).filter(r => r.subject) : [],
      obtained: Number(x.obtained) || 0,
      total: Number(x.total) || 0,
      academic: Number(x.academic) || 0,
      behavior: 0,
      schoolPoints: Math.max(0, Math.min(10, Number(x.schoolPoints ?? x.academic ?? x.behavior) || 0)),
      final: Number(x.final) || 0,
      pointId: String(x.pointId || ''),
      createdAt: Number(x.createdAt) || Date.now()
    }));

  // Behavior = Manual 8 + Attendance 2. School Paper is a separate School Points value.
  next.students.forEach(student => {
    if (!Array.isArray(student.pointsHistory)) student.pointsHistory = [];
    student.pointsHistory = student.pointsHistory.map(point => {
      if (point.source === 'school-paper' || point.schoolPaperId) {
        const schoolPoints = Number(point.schoolPoints ?? point.academicPoints ?? point.final ?? 0);
        return { ...point, schoolPoints: Math.max(0, Math.min(10, schoolPoints)), behaviorMarks: 0, manualBehaviorMarks: 0, attendanceBehaviorMarks: 0, schoolPaperBehaviorMarks: 0, final: Math.max(0, Math.min(10, schoolPoints)) };
      }
      const manual = point.manualBehaviorMarks != null ? Number(point.manualBehaviorMarks) : Math.min(8, Math.max(0, Number(point.behaviorMarks) || 0));
      const behavior = effectiveBehavior(next, student.id, manual);
      const academic = Number(point.academicPoints) || 0;
      return { ...point, testName: String(point.testName || point.note || 'Test').slice(0,100), manualBehaviorMarks: Math.min(8, Math.max(0, manual)), attendanceBehaviorMarks: attendanceBehaviorPart(next, student.id), schoolPaperBehaviorMarks: 0, schoolPoints: 0, behaviorMarks: behavior, final: (academic + behavior) / 2 };
    });
  });
  recomputeLives(next);

  if (!next.users.some(u => u.id === 'admin' || u.role === 'admin')) {
    next.users.unshift({
      id: 'admin',
      username: 'admin',
      role: 'admin',
      studentId: null
    });
  }
  return next;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username || '',
    role: u.role,
    studentId: u.studentId || null
  };
}

function publicData(data, session) {
  const safe = normalizeData(data);
  if (session.role === 'admin') {
    return {
      ...safe,
      users: safe.users.map(publicUser)
    };
  }
  const student = safe.students.find(s => s.id === session.studentId);
  return {
    users: student ? [{
      id: session.userId,
      username: '',
      role: 'user',
      studentId: session.studentId
    }] : [],
    students: student ? [student] : [],
    attendance: safe.attendance.filter(a => a.studentId === session.studentId),
    subjectUpdates: safe.subjectUpdates,
    doubts: safe.doubts.filter(d => d.studentId === session.studentId),
    schoolPapers: safe.schoolPapers.filter(p => p.studentId === session.studentId)
  };
}

async function readState() {
  const raw = await store.get(DATA_KEY, { type: 'json', consistency: 'strong' });
  if (!raw) return { version: 0, data: blankData() };

  if (Array.isArray(raw.users) && Array.isArray(raw.students)) {
    return { version: 1, data: normalizeData(raw) };
  }

  if (raw && Number.isInteger(raw.version) && raw.data) {
    return { version: raw.version, data: normalizeData(raw.data) };
  }

  return { version: 0, data: blankData() };
}

async function writeState(data, version) {
  await store.setJSON(DATA_KEY, { version, data: normalizeData(data) });
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(password), salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise(resolve => {
    if (!stored || typeof stored !== 'string' || !stored.includes(':')) return resolve(false);
    const [salt, expectedHex] = stored.split(':');
    crypto.scrypt(String(password), salt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      const expected = Buffer.from(expectedHex, 'hex');
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

async function migratePasswords(data) {
  const next = normalizeData(data);
  let changed = false;

  for (const user of next.users) {
    if (user.passwordHash) continue;
    const legacyPassword = typeof user.password === 'string' && user.password
      ? user.password
      : (user.id === 'admin' ? 'admin123' : '1234');
    user.passwordHash = await hashPassword(legacyPassword);
    delete user.password;
    changed = true;
  }

  for (const user of next.users) {
    delete user.password;
  }

  return { data: next, changed };
}

async function ensureInitialized() {
  const state = await readState();
  let version = state.version;
  if (version === 0) version = 1;
  const needsMigration = state.version === 0 || state.data.users.some(u => !u.passwordHash);
  if (!needsMigration) return { version, data: state.data };
  const migrated = await migratePasswords(state.data);
  await writeState(migrated.data, version);
  return { version, data: migrated.data };
}

async function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await store.setJSON(SESSION_PREFIX + token, {
    userId: user.id,
    role: user.role,
    studentId: user.studentId || null,
    createdAt: Date.now()
  });
  return token;
}

async function getSession(req) {
  const token = getCookie(req, 'tm_session');
  if (!token) return null;
  const s = await store.get(SESSION_PREFIX + token, { type: 'json', consistency: 'strong' });
  if (!s) return null;
  if (Date.now() - Number(s.createdAt || 0) > SESSION_MAX_AGE * 1000) {
    await store.delete(SESSION_PREFIX + token).catch(() => {});
    return null;
  }
  return s;
}

async function acquireLock() {
  const token = crypto.randomBytes(16).toString('hex');
  try {
    await store.setJSON(LOCK_KEY, { token, expiresAt: Date.now() + LOCK_TTL }, { onlyIfNew: true });
    return token;
  } catch {
    const existing = await store.get(LOCK_KEY, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (existing && Number(existing.expiresAt) < Date.now()) {
      await store.delete(LOCK_KEY).catch(() => {});
      try {
        await store.setJSON(LOCK_KEY, { token, expiresAt: Date.now() + LOCK_TTL }, { onlyIfNew: true });
        return token;
      } catch {}
    }
    return null;
  }
}

async function releaseLock(token) {
  const existing = await store.get(LOCK_KEY, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (existing?.token === token) await store.delete(LOCK_KEY).catch(() => {});
}

function normalizePath(req) {
  const url = new URL(req.url);
  return url.pathname
    .replace(/^\/\.netlify\/functions\/api\/?/, '')
    .replace(/^\/api\/?/, '')
    .replace(/\/$/, '');
}

function isValidData(data) {
  return data && Array.isArray(data.users) && Array.isArray(data.students) && Array.isArray(data.attendance);
}

async function prepareIncomingData(incoming, current, passwordUpdates = {}) {
  const next = normalizeData(incoming);
  if (next.users.length > 10000 || next.students.length > 10000 || next.attendance.length > 100000) {
    throw Object.assign(new Error('Data limit exceeded.'), { status: 413 });
  }

  const currentById = new Map(current.users.map(u => [u.id, u]));
  const usernames = new Set();

  for (const user of next.users) {
    user.id = String(user.id || uid());
    user.username = String(user.username || '').trim();
    user.role = user.role === 'admin' ? 'admin' : 'user';
    user.studentId = user.studentId || null;
    if (!user.username) throw Object.assign(new Error('Every user needs a username.'), { status: 400 });
    const lower = user.username.toLowerCase();
    if (usernames.has(lower)) throw Object.assign(new Error('Usernames must be unique.'), { status: 400 });
    usernames.add(lower);

    const old = currentById.get(user.id);
    const requestedPassword = typeof passwordUpdates[user.id] === 'string' ? passwordUpdates[user.id] : '';
    if (requestedPassword) {
      user.passwordHash = await hashPassword(requestedPassword);
    } else if (old?.passwordHash) {
      user.passwordHash = old.passwordHash;
    } else {
      user.passwordHash = await hashPassword(user.id === 'admin' ? 'admin123' : '1234');
    }
    delete user.password;
  }

  return next;
}

export default async function handler(req) {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders,
          'Access-Control-Allow-Origin': req.headers.get('origin') || '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        }
      });
    }

    const path = normalizePath(req);
    const method = req.method.toUpperCase();

    if (method === 'GET' && path === 'health') {
      const state = await ensureInitialized();
      return json({ ok: true, backend: 'render-express', storage: 'persistent-json-disk', version: state.version });
    }

    if (method === 'POST' && path === 'login') {
      const body = await req.json().catch(() => ({}));
      const state = await ensureInitialized();
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return json({ ok: false, error: 'Username and password are required.' }, 400);

      const user = state.data.users.find(u => String(u.username).toLowerCase() === username.toLowerCase());
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return json({ ok: false, error: 'Invalid username or password.' }, 401);
      }

      const token = await createSession(user);
      const session = { userId: user.id, role: user.role, studentId: user.studentId || null };
      return json(
        { ok: true, session, data: publicData(state.data, session), version: state.version },
        200,
        { 'Set-Cookie': cookie('tm_session', token, { maxAge: SESSION_MAX_AGE }) }
      );
    }

    if (method === 'POST' && path === 'logout') {
      const token = getCookie(req, 'tm_session');
      if (token) await store.delete(SESSION_PREFIX + token).catch(() => {});
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('tm_session', '', { maxAge: 0 }) });
    }

    const session = await getSession(req);

    if (!session && method === 'GET' && (path === 'session' || path === 'data')) {
      const state = await ensureInitialized();
      return json({ ok: true, session: null, data: blankData(), version: state.version });
    }

    if (!session) return json({ ok: false, error: 'Not authenticated.' }, 401);

    if (method === 'GET' && (path === 'session' || path === 'data')) {
      const state = await ensureInitialized();
      return json({
        ok: true,
        session,
        data: publicData(state.data, session),
        version: state.version
      });
    }

    if (method === 'PUT' && path === 'data') {
      if (session.role !== 'admin') return json({ ok: false, error: 'Admin access required.' }, 403);
      const incoming = await req.json().catch(() => null);
      const clientVersion = Number(incoming?.version);
      if (!Number.isInteger(clientVersion) || !isValidData(incoming?.data)) {
        return json({ ok: false, error: 'Invalid data payload.' }, 400);
      }

      const lockToken = await acquireLock();
      if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);

      try {
        const current = await ensureInitialized();
        if (clientVersion !== current.version) {
          return json({
            ok: false,
            error: 'Data changed by another user. Latest data has been loaded. Please retry your change.',
            version: current.version,
            data: publicData(current.data, session)
          }, 409);
        }

        const prepared = await prepareIncomingData(incoming.data, current.data, incoming.passwordUpdates || {});
        const nextVersion = current.version + 1;
        await writeState(prepared, nextVersion);
        return json({ ok: true, data: publicData(prepared, session), version: nextVersion });
      } finally {
        await releaseLock(lockToken);
      }
    }


    if (path === 'points') {
      if (session.role !== 'admin') return json({ ok: false, error: 'Admin access required.' }, 403);
      const action = method === 'POST' ? 'add' : method === 'PUT' ? 'edit' : method === 'DELETE' ? 'delete' : '';
      if (!action) return json({ ok: false, error: 'Method not allowed.' }, 405);
      const body = await req.json().catch(() => ({}));
      const studentId = String(body.studentId || '');
      const id = String(body.id || '');
      const lockToken = await acquireLock();
      if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
      try {
        const current = await ensureInitialized();
        const student = current.data.students.find(s => s.id === studentId);
        if (!student) return json({ ok: false, error: 'Student not found.' }, 404);
        if (!Array.isArray(student.pointsHistory)) student.pointsHistory = [];

        if (action === 'add') {
          const totalMarks = Number(body.totalMarks), obtainedMarks = Number(body.obtainedMarks), manualBehaviorMarks = Number(body.manualBehaviorMarks);
          if (!Number.isFinite(totalMarks) || totalMarks <= 0 || !Number.isFinite(obtainedMarks) || obtainedMarks < 0 || obtainedMarks > totalMarks || !Number.isFinite(manualBehaviorMarks) || manualBehaviorMarks < 0 || manualBehaviorMarks > 8) {
            return json({ ok: false, error: 'Invalid marks. Total must be positive, obtained must be within total, and manual behavior must be 0-5.' }, 400);
          }
          const academicPoints = Math.min(10, Math.max(0, obtainedMarks / totalMarks * 10));
          const behaviorMarks = effectiveBehavior(current.data, studentId, manualBehaviorMarks);
          student.pointsHistory.push({
            id: uid(), date: Date.now(), totalMarks, obtainedMarks,
            testName: String(body.testName || body.note || 'Test').slice(0,100),
            behaviorMarks, manualBehaviorMarks,
            attendanceBehaviorMarks: attendanceBehaviorPart(current.data, studentId),
            schoolPaperBehaviorMarks: 0, schoolPoints: 0,
            academicPoints, final: (academicPoints + behaviorMarks) / 2,
            note: String(body.note || '').slice(0, 180)
          });
        } else {
          const point = student.pointsHistory.find(x => x.id === id);
          if (!point) return json({ ok: false, error: 'Points record not found.' }, 404);
          if (point.source === 'school-paper' || point.schoolPaperId) return json({ ok: false, error: 'School Paper points must be edited from School Paper.' }, 400);
          if (action === 'delete') {
            student.pointsHistory = student.pointsHistory.filter(x => x.id !== id);
          } else {
            const totalMarks = Number(body.totalMarks), obtainedMarks = Number(body.obtainedMarks), manualBehaviorMarks = Number(body.manualBehaviorMarks);
            if (!Number.isFinite(totalMarks) || totalMarks <= 0 || !Number.isFinite(obtainedMarks) || obtainedMarks < 0 || obtainedMarks > totalMarks || !Number.isFinite(manualBehaviorMarks) || manualBehaviorMarks < 0 || manualBehaviorMarks > 8) {
              return json({ ok: false, error: 'Invalid marks. Total must be positive, obtained must be within total, and manual behavior must be 0-5.' }, 400);
            }
            const academicPoints = Math.min(10, Math.max(0, obtainedMarks / totalMarks * 10));
            const behaviorMarks = effectiveBehavior(current.data, studentId, manualBehaviorMarks);
            Object.assign(point, {
              totalMarks, obtainedMarks, manualBehaviorMarks,
              testName: String(body.testName || body.note || point.testName || 'Test').slice(0,100),
              behaviorMarks,
              attendanceBehaviorMarks: attendanceBehaviorPart(current.data, studentId),
              schoolPaperBehaviorMarks: 0, schoolPoints: 0,
              academicPoints,
              final: (academicPoints + behaviorMarks) / 2,
              note: String(body.note || '').slice(0, 180),
              updatedAt: Date.now()
            });
          }
        }

        student.updatedAt = Date.now();
        recomputeLives(current.data);
        const nextVersion = current.version + 1;
        await writeState(current.data, nextVersion);
        return json({ ok: true, pointsHistory: student.pointsHistory, version: nextVersion });
      } finally { await releaseLock(lockToken); }
    }


    if (path === 'doubts') {
      const state = await ensureInitialized();

      if (method === 'GET') {
        const doubts = session.role === 'admin'
          ? state.data.doubts
          : state.data.doubts.filter(d => d.studentId === session.studentId);
        return json({ ok: true, doubts });
      }

      if (method === 'POST') {
        if (session.role !== 'user') return json({ ok: false, error: 'Only student users can send doubts.' }, 403);
        const body = await req.json().catch(() => ({}));
        const text = String(body.text || '').trim();
        if (!text) return json({ ok: false, error: 'Doubt text is required.' }, 400);
        if (text.length > 1000) return json({ ok: false, error: 'Doubt is too long.' }, 400);
        const student = state.data.students.find(s => s.id === session.studentId);
        if (!student) return json({ ok: false, error: 'Student profile not found.' }, 404);
        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const row = { id: uid(), studentId: student.id, studentName: student.name, text, reply: '', createdAt: Date.now(), repliedAt: null };
          current.data.doubts.push(row);
          const nextVersion = current.version + 1;
          await writeState(current.data, nextVersion);
          return json({ ok: true, doubts: current.data.doubts.filter(d => d.studentId === session.studentId), version: nextVersion });
        } finally { await releaseLock(lockToken); }
      }

      if (method === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const id = String(body.id || ''), action = String(body.action || 'reply');
        if (!id) return json({ ok: false, error: 'Doubt id is required.' }, 400);
        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const found = current.data.doubts.find(d => d.id === id);
          if (!found) return json({ ok: false, error: 'Doubt not found.' }, 404);
          if (session.role === 'admin') {
            if (action === 'delete') {
              current.data.doubts = current.data.doubts.filter(d => d.id !== id);
            } else {
              const reply = String(body.reply || '').trim();
              if (!reply) return json({ ok: false, error: 'Reply is required.' }, 400);
              if (reply.length > 1000) return json({ ok: false, error: 'Reply is too long.' }, 400);
              found.reply = reply; found.repliedAt = Date.now();
            }
          } else if (session.role === 'user' && found.studentId === session.studentId) {
            if (action === 'delete') {
              current.data.doubts = current.data.doubts.filter(d => d.id !== id);
            } else if (action === 'edit') {
              if (found.reply) return json({ ok: false, error: 'A replied doubt cannot be edited.' }, 400);
              const text = String(body.text || '').trim();
              if (!text || text.length > 1000) return json({ ok: false, error: 'Valid doubt text is required.' }, 400);
              found.text = text; found.updatedAt = Date.now();
            } else return json({ ok: false, error: 'Invalid action.' }, 400);
          } else return json({ ok: false, error: 'Access denied.' }, 403);
          const nextVersion = current.version + 1;
          await writeState(current.data, nextVersion);
          const doubts = session.role === 'admin' ? current.data.doubts : current.data.doubts.filter(d => d.studentId === session.studentId);
          return json({ ok: true, doubts, version: nextVersion });
        } finally { await releaseLock(lockToken); }
      }
    }

    if (path === 'school-papers') {
      if (session.role !== 'admin') {
        if (method === 'GET') {
          const state = await ensureInitialized();
          return json({ ok: true, schoolPapers: state.data.schoolPapers.filter(p => p.studentId === session.studentId) });
        }
        return json({ ok: false, error: 'Admin access required.' }, 403);
      }

      if (method === 'GET') {
        const state = await ensureInitialized();
        return json({ ok: true, schoolPapers: state.data.schoolPapers });
      }

      if (method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const studentId = String(body.studentId || ''), name = String(body.name || '').trim(), date = String(body.date || '');
        const schoolPoints = Math.min(10, Math.max(0, Number(body.behavior) || 0));
        const subjects = Array.isArray(body.subjects) ? body.subjects.map(x => ({ subject: String(x.subject || '').trim().slice(0,80), obtained: Number(x.obtained), total: Number(x.total) })).filter(x => x.subject) : [];
        if (!studentId || !name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !subjects.length) return json({ ok: false, error: 'Student, paper name, date and at least one subject are required.' }, 400);
        if (subjects.some(x => !Number.isFinite(x.obtained) || !Number.isFinite(x.total) || x.total <= 0 || x.obtained < 0 || x.obtained > x.total)) return json({ ok: false, error: 'Invalid subject marks.' }, 400);
        const state = await ensureInitialized();
        const student = state.data.students.find(s => s.id === studentId);
        if (!student) return json({ ok: false, error: 'Student not found.' }, 404);
        const obtained = subjects.reduce((n,x) => n+x.obtained, 0), total = subjects.reduce((n,x) => n+x.total, 0);
        const academic = total > 0 ? Math.min(10, (obtained/total)*10) : 0;
        const generatedSchoolPoints = academic;
        const final = academic;
        const id = uid(), now = Date.now();
        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const liveStudent = current.data.students.find(s => s.id === studentId);
          if (!liveStudent) return json({ ok: false, error: 'Student not found.' }, 404);
          current.data.schoolPapers.push({ id, studentId, studentName: liveStudent.name, name: name.slice(0,100), date, subjects, obtained, total, academic, behavior: 0, schoolPoints: generatedSchoolPoints, manualBehaviorMarks: 0, attendanceBehaviorMarks: 0, schoolPaperBehaviorMarks: 0, final: generatedSchoolPoints, createdAt: now });
          const nextVersion = current.version + 1;
          recomputeLives(current.data);
          await writeState(current.data, nextVersion);
          return json({ ok: true, schoolPapers: current.data.schoolPapers, version: nextVersion });
        } finally { await releaseLock(lockToken); }
      }

      if (method === 'PUT') {
        const body = await req.json().catch(() => ({}));
        const id = String(body.id || ''), action = String(body.action || 'edit');
        if (!id) return json({ ok: false, error: 'School paper id is required.' }, 400);
        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const found = current.data.schoolPapers.find(p => p.id === id);
          if (!found) return json({ ok: false, error: 'School paper not found.' }, 404);
          const student = current.data.students.find(s => s.id === found.studentId);
          if (!student) return json({ ok: false, error: 'Student not found.' }, 404);
          if (action === 'delete') {
            current.data.schoolPapers = current.data.schoolPapers.filter(p => p.id !== id);
          } else {
            const name = String(body.name || '').trim(), date = String(body.date || '');
            const schoolPoints = Math.min(10, Math.max(0, Number(body.behavior) || 0));
            const subjects = Array.isArray(body.subjects) ? body.subjects.map(x => ({subject:String(x.subject||'').trim().slice(0,80),obtained:Number(x.obtained),total:Number(x.total)})).filter(x=>x.subject) : [];
            if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !subjects.length) return json({ok:false,error:'Valid paper name, date and subjects are required.'},400);
            if (subjects.some(x=>!Number.isFinite(x.obtained)||!Number.isFinite(x.total)||x.total<=0||x.obtained<0||x.obtained>x.total)) return json({ok:false,error:'Invalid subject marks.'},400);
            const obtained=subjects.reduce((n,x)=>n+x.obtained,0), total=subjects.reduce((n,x)=>n+x.total,0), academic=total?Math.min(10,obtained/total*10):0, generatedSchoolPoints=academic, final=academic;
            Object.assign(found,{name:name.slice(0,100),date,subjects,obtained,total,academic,behavior:0,schoolPoints:generatedSchoolPoints,final,updatedAt:Date.now()});
          }
          const nextVersion=current.version+1; recomputeLives(current.data); await writeState(current.data,nextVersion);
          return json({ok:true,schoolPapers:current.data.schoolPapers,version:nextVersion});
        } finally { await releaseLock(lockToken); }
      }
    }

    if (path === 'attendance') {
      if (session.role !== 'admin') {
        if (method === 'GET') {
          const state = await ensureInitialized();
          return json({ ok: true, attendance: state.data.attendance.filter(a => a.studentId === session.studentId) });
        }
        return json({ ok: false, error: 'Admin access required.' }, 403);
      }

      const state = await ensureInitialized();

      if (method === 'GET') {
        return json({ ok: true, attendance: state.data.attendance });
      }

      if (method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (body.batch === true) {
          const date = String(body.date || '');
          const status = body.status;
          const ids = Array.isArray(body.studentIds) ? body.studentIds.map(String) : [];
          if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date) || !['Present','Absent'].includes(status) || !ids.length) return json({ok:false,error:'Valid batch attendance data is required.'},400);
          const lockToken = await acquireLock();
          if (!lockToken) return json({ok:false,error:'Another save is in progress. Please retry.'},409);
          try {
            const current = await ensureInitialized();
            const validIds = new Set(current.data.students.map(s=>s.id));
            const now = Date.now();
            for (const studentId of ids) {
              if (!validIds.has(studentId)) continue;
              const found=current.data.attendance.find(a=>a.studentId===studentId&&a.date===date);
              if(found){found.status=status;found.updatedAt=now;}
              else current.data.attendance.push({id:uid(),studentId,date,status,createdAt:now,updatedAt:now});
            }
            const nextVersion=current.version+1;
            await writeState(current.data,nextVersion);
            return json({ok:true,attendance:current.data.attendance,version:nextVersion});
          } finally { await releaseLock(lockToken); }
        }
      }

      if (['POST', 'PUT'].includes(method)) {
        const body = await req.json().catch(() => ({}));
        const studentId = String(body.studentId || '');
        const date = String(body.date || '');
        const status = body.status;
        if (!studentId || !state.data.students.some(s => s.id === studentId)) return json({ ok: false, error: 'Student not found.' }, 404);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: 'Valid attendance date is required.' }, 400);
        if (!['Present', 'Absent'].includes(status)) return json({ ok: false, error: 'Attendance status must be Present or Absent.' }, 400);

        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const found = current.data.attendance.find(a => a.studentId === studentId && a.date === date);
          const now = Date.now();
          if (found) {
            found.status = status;
            found.updatedAt = now;
          } else {
            current.data.attendance.push({ id: uid(), studentId, date, status, createdAt: now, updatedAt: now });
          }
          const nextVersion = current.version + 1;
          await writeState(current.data, nextVersion);
          return json({ ok: true, attendance: current.data.attendance, version: nextVersion });
        } finally {
          await releaseLock(lockToken);
        }
      }

      if (method === 'DELETE') {
        const body = await req.json().catch(() => ({}));
        const id = String(body.id || '');
        const lockToken = await acquireLock();
        if (!lockToken) return json({ ok: false, error: 'Another save is in progress. Please retry.' }, 409);
        try {
          const current = await ensureInitialized();
          const before = current.data.attendance.length;
          current.data.attendance = current.data.attendance.filter(a => a.id !== id);
          if (current.data.attendance.length === before) return json({ ok: false, error: 'Attendance record not found.' }, 404);
          const nextVersion = current.version + 1;
          await writeState(current.data, nextVersion);
          return json({ ok: true, attendance: current.data.attendance, version: nextVersion });
        } finally {
          await releaseLock(lockToken);
        }
      }
    }

    return json({ ok: false, error: 'Not found.' }, 404);
  } catch (err) {
    console.error('Tuition Manager API error:', err);
    const status = Number(err?.status) >= 400 ? Number(err.status) : 500;
    return json({
      ok: false,
      error: status === 500 ? `Server error: ${String(err?.message || 'Something went wrong. Check the Netlify Function logs.')}` : String(err.message || 'Request failed.')
    }, status);
  }
}
