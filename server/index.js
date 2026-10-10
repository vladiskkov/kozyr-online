'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const auth = require('./auth.js');
const { RoomManager } = require('./rooms.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

// Security headers. The Google entries are the ones Google documents for Sign in with Google.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com",
    "frame-src https://accounts.google.com/gsi/",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // allow the Google sign-in popup to talk back to the page
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));
auth.routes(app);
// Each deploy gets its own asset version, so phones never keep an old app.js/app.css.
const VERSION = (process.env.RENDER_GIT_COMMIT || Date.now().toString(36)).slice(0, 10);
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/__V__/g, VERSION);
const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(INDEX); };
app.get(['/', '/index.html', '/r/:code'], sendIndex);
app.use(express.static(PUBLIC, {
  extensions: ['html'], index: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'), // always revalidate (cheap 304 via ETag)
}));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingInterval: 20000, pingTimeout: 25000 });
const rooms = new RoomManager();

io.use((socket, next) => {
  const user = auth.userFromRequest(socket.request);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  let bucket = 30; let last = Date.now();
  const limited = () => {
    const now = Date.now();
    bucket = Math.min(30, bucket + ((now - last) / 1000) * 10); last = now;
    if (bucket < 1) return true;
    bucket -= 1; return false;
  };

  const handle = (name, fn) => socket.on(name, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (limited()) return reply({ ok: false, error: 'Забагато дій. Зачекайте секунду.' });
    try {
      const res = fn(payload || {});
      reply({ ok: true, ...(res || {}) });
    } catch (e) {
      reply({ ok: false, error: e.message || 'Помилка' });
    }
  });

  const current = () => socket.data.room && rooms.get(socket.data.room);
  const need = () => { const r = current(); if (!r) throw new Error('Ви не в кімнаті'); return r; };

  const enter = (room) => {
    const prev = current();
    if (prev && prev !== room) prev.detach(socket);
    socket.data.room = room.code;
    room.attach(socket);
    room.broadcast();
  };

  handle('create', ({ settings, solo }) => {
    const room = rooms.create(socket.user, settings, !!solo);
    enter(room);
    return { code: room.code };
  });

  handle('join', ({ code }) => {
    const room = rooms.get(code);
    if (!room) throw new Error('Кімнату не знайдено. Перевірте код.');
    const r = room.join(socket.user);
    if (!r.ok) throw new Error(r.error);
    enter(room);
    return { code: room.code };
  });

  handle('leave', () => {
    const room = current();
    if (!room) return;
    socket.data.room = null;
    room.detach(socket);
    room.leave(socket.user.id);
  });

  handle('settings', (s) => need().setSettings(socket.user.id, s));
  handle('addBot', ({ level }) => need().addBot(socket.user.id, level));
  handle('removeSeat', ({ seat }) => need().removeSeat(socket.user.id, Number(seat)));
  handle('start', () => need().start(socket.user.id));
  handle('act', (a) => need().act(socket.user.id, a));

  socket.on('disconnect', () => {
    const room = current();
    if (room) room.detach(socket);
  });
});

server.listen(PORT, () => console.log(`Козир працює на http://localhost:${PORT}`));
