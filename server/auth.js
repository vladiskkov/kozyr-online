'use strict';
/**
 * Auth: Google Identity Services ID token → our own signed session cookie.
 * No database: the cookie carries the profile, signed with HMAC-SHA256.
 */
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const COOKIE = 'kz_sid';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOW_GUESTS = process.env.ALLOW_GUESTS !== 'false';
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] SESSION_SECRET is not set — sessions will reset on every restart.');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const b64 = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function sign(user) {
  const body = b64(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE_MS }));
  return `${body}.${hmac(body)}`;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return { id: data.id, name: data.name, avatar: data.avatar || null, guest: !!data.guest };
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const k = part.indexOf('=');
    if (k < 0) continue;
    out[part.slice(0, k).trim()] = decodeURIComponent(part.slice(k + 1).trim());
  }
  return out;
}

function userFromRequest(req) {
  return verify(parseCookies(req.headers.cookie)[COOKIE]);
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function setSession(res, user) {
  res.cookie(COOKIE, sign(user), {
    httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE_MS,
    secure: process.env.NODE_ENV === 'production',
  });
}

function routes(app) {
  app.get('/api/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, allowGuests: ALLOW_GUESTS });
  });

  app.get('/api/me', (req, res) => {
    res.json({ user: userFromRequest(req) });
  });

  app.post('/api/auth/google', async (req, res) => {
    if (!googleClient) return res.status(400).json({ error: 'Вхід через Google не налаштовано на сервері' });
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || credential.length > 4096) return res.status(400).json({ error: 'Некоректний токен' });
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (!p || !p.sub) throw new Error('no subject');
      const user = { id: 'g_' + p.sub, name: cleanName(p.given_name || p.name || 'Гравець') || 'Гравець', avatar: p.picture || null };
      setSession(res, user);
      res.json({ user });
    } catch (e) {
      console.warn('[auth] google verify failed:', e.message);
      res.status(401).json({ error: 'Google не підтвердив вхід. Спробуйте ще раз.' });
    }
  });

  app.post('/api/auth/guest', (req, res) => {
    if (!ALLOW_GUESTS) return res.status(403).json({ error: 'Гостьовий вхід вимкнено' });
    const name = cleanName(req.body && req.body.name);
    if (name.length < 2) return res.status(400).json({ error: 'Ім\'я має містити щонайменше 2 символи' });
    const user = { id: 'guest_' + crypto.randomBytes(8).toString('hex'), name, avatar: null, guest: true };
    setSession(res, user);
    res.json({ user });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });
}

module.exports = { routes, userFromRequest, cleanName };
