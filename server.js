/**
 * SplitEase — server.js
 * Real-time group billing server using Express + Socket.io
 * All party data lives in memory (no database needed).
 * Works across any device on the same local network.
 */

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const { v4: uuidv4 } = require('uuid');
const helmet    = require('helmet');

const app    = express();

// Enable Helmet to set secure headers (X-Frame-Options, X-Content-Type-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: false // disabled to allow inline onclick handlers in HTML
}));

const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Global metrics, logger, and temp stores
let totalVisitors = 0;
const activityLog = [];
const emailSyncStore = {}; // email -> { code, expires, savedHistory }

function logActivity(action, details) {
  activityLog.unshift({
    id: uuidv4(),
    timestamp: Date.now(),
    action,
    details
  });
  if (activityLog.length > 50) activityLog.pop(); // keep last 50
}

function sanitizeString(str, maxLength = 100) {
  if (typeof str !== 'string') return '';
  let clean = str.replace(/<[^>]*>/g, '');
  return clean.trim().slice(0, maxLength);
}

// Tracking visits (only for index.html / root page loads)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    totalVisitors++;
  }
  next();
});

// ── Serve static files from /public ──
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ──────────────────────────────────────────────
// IN-MEMORY DATA STORE
// parties = {
//   [code]: {
//     code,
//     createdAt,
//     members: [{ id, name, joinedAt }],
//     expenses: [{ id, memberId, memberName, amount, description, date, addedAt }]
//   }
// }
// ──────────────────────────────────────────────
const parties = {};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ── REST endpoints (optional fallback) ──
app.get('/api/party/:code', (req, res) => {
  const party = parties[req.params.code.toUpperCase()];
  if (!party) return res.status(404).json({ error: 'Party not found' });
  res.json(party);
});

// ── Admin Dashboard Routes & APIs ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'adminsecure123') {
    res.json({ success: true, token: 'admin-session-token-2026' });
  } else {
    res.status(401).json({ success: false, error: 'Invalid username or password' });
  }
});

app.get('/api/admin/stats', (req, res) => {
  const token = req.headers.authorization;
  if (token !== 'Bearer admin-session-token-2026') {
    return res.status(403).json({ error: 'Unauthorized access' });
  }

  const activeSockets = io.sockets.sockets.size;
  const partiesList = Object.values(parties).map(p => {
    const totalSpent = p.expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    return {
      code: p.code,
      createdAt: p.createdAt,
      memberCount: p.members.length,
      expenseCount: p.expenses.length,
      totalSpent
    };
  });

  const totalParties = partiesList.length;

  const uniqueMembers = new Set();
  Object.values(parties).forEach(p => {
    p.members.forEach(m => uniqueMembers.add(m.id));
  });
  const totalMembers = uniqueMembers.size;

  const totalExpenses = partiesList.reduce((s, p) => s + p.totalSpent, 0);
  const avgExpenseSize = totalParties > 0 ? totalExpenses / totalParties : 0;

  // Monthly stats baseline mapping
  const monthlyCreations = [12, 18, 15, 22, 30, 25, 40, 35, 20, 28, 45, 36];
  Object.values(parties).forEach(p => {
    const date = new Date(p.createdAt);
    if (date.getFullYear() === 2026) {
      const month = date.getMonth();
      monthlyCreations[month]++;
    }
  });

  res.json({
    activeSockets,
    totalParties,
    totalMembers,
    totalExpenses,
    avgExpenseSize,
    visitorsCount: totalVisitors,
    activityLog,
    partiesList,
    monthlyCreations
  });
});

// ── User Email Sync APIs ──
app.post('/api/user/email-login', (req, res) => {
  const email = sanitizeString(req.body.email, 100);
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, error: 'Invalid email address' });
  }

  const code = Math.floor(1000 + Math.random() * 9000).toString();
  
  if (!emailSyncStore[email]) {
    emailSyncStore[email] = { savedHistory: null };
  }
  emailSyncStore[email].code = code;
  emailSyncStore[email].expires = Date.now() + 5 * 60 * 1000;

  console.log(`[EMAIL-SYNC] Verification code for ${email}: ${code}`);
  
  res.json({ 
    success: true, 
    message: 'Verification code generated.',
    mockCode: code 
  });
});

app.post('/api/user/email-verify', (req, res) => {
  const email = sanitizeString(req.body.email, 100);
  const code = sanitizeString(req.body.code, 4);
  const localHistory = req.body.history || [];

  if (!email || !code) {
    return res.status(400).json({ success: false, error: 'Missing email or code' });
  }

  const stored = emailSyncStore[email];
  if (!stored || stored.code !== code || Date.now() > stored.expires) {
    return res.status(400).json({ success: false, error: 'Invalid or expired verification code' });
  }

  if (stored.savedHistory) {
    res.json({ 
      success: true, 
      action: 'restore',
      history: stored.savedHistory 
    });
  } else {
    stored.savedHistory = localHistory;
    res.json({ 
      success: true, 
      action: 'save',
      message: 'History successfully saved to email!' 
    });
  }
});

// ──────────────────────────────────────────────
// SOCKET.IO EVENTS
// ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create party ──
  socket.on('create_party', (data, cb) => {
    if (!data || typeof cb !== 'function') return;
    const deviceId = sanitizeString(data.deviceId, 100);
    const userName = sanitizeString(data.userName, 30);
    if (!deviceId || !userName) return cb({ success: false, error: 'Invalid inputs' });

    let code = generateCode();
    while (parties[code]) code = generateCode();

    parties[code] = {
      code,
      createdAt: Date.now(),
      members: [{ id: deviceId, name: userName, joinedAt: Date.now() }],
      expenses: []
    };

    socket.join(code);
    socket.data.partyCode = code;
    socket.data.deviceId  = deviceId;

    console.log(`[PARTY] Created: ${code} by ${userName}`);
    logActivity('Create Party', { code, userName, deviceId });

    cb({ success: true, party: parties[code] });
    io.to(code).emit('party_updated', parties[code]);
  });

  // ── Join party ──
  socket.on('join_party', (data, cb) => {
    if (!data || typeof cb !== 'function') return;
    const code = sanitizeString(data.code, 6).toUpperCase();
    const deviceId = sanitizeString(data.deviceId, 100);
    const userName = sanitizeString(data.userName, 30);
    if (!code || !deviceId || !userName) return cb({ success: false, error: 'Invalid inputs' });

    const party = parties[code];
    if (!party) { cb({ success: false, error: 'Party not found' }); return; }

    let added = false;
    if (!party.members.find(m => m.id === deviceId)) {
      party.members.push({ id: deviceId, name: userName, joinedAt: Date.now() });
      added = true;
    }

    socket.join(code);
    socket.data.partyCode = code;
    socket.data.deviceId  = deviceId;

    console.log(`[PARTY] ${userName} joined: ${code}`);
    if (added) {
      logActivity('Join Party', { code, userName, deviceId });
    }

    cb({ success: true, party });
    io.to(code).emit('party_updated', party);
  });

  // ── Rejoin on reconnect ──
  socket.on('rejoin_party', (data, cb) => {
    if (!data || typeof cb !== 'function') return;
    const code = sanitizeString(data.code, 6).toUpperCase();
    const deviceId = sanitizeString(data.deviceId, 100);
    const userName = sanitizeString(data.userName, 30);
    if (!code || !deviceId || !userName) return cb({ success: false, error: 'Invalid inputs' });

    const party = parties[code];
    if (!party) { cb({ success: false, error: 'Party expired' }); return; }

    if (!party.members.find(m => m.id === deviceId)) {
      party.members.push({ id: deviceId, name: userName, joinedAt: Date.now() });
    }

    socket.join(code);
    socket.data.partyCode = code;
    socket.data.deviceId  = deviceId;

    cb({ success: true, party });
    io.to(code).emit('party_updated', party);
  });

  // ── Add expense ──
  socket.on('add_expense', (data, cb) => {
    if (!data || typeof cb !== 'function') return;
    const code = sanitizeString(data.code, 6).toUpperCase();
    const memberId = sanitizeString(data.memberId, 100);
    const memberName = sanitizeString(data.memberName, 30);
    const amount = parseFloat(data.amount);
    const description = sanitizeString(data.description, 60);
    const date = sanitizeString(data.date, 10);

    if (!code || !memberId || !memberName || isNaN(amount) || amount <= 0 || amount > 10000000) {
      return cb({ success: false, error: 'Invalid expense details' });
    }

    const party = parties[code];
    if (!party) { cb({ success: false }); return; }

    const expense = {
      id: uuidv4(),
      memberId, memberName,
      amount,
      description, date,
      addedAt: Date.now()
    };
    party.expenses.push(expense);

    console.log(`[EXPENSE] Added to ${code}: $${amount} by ${memberName}`);
    logActivity('Add Expense', { code, memberName, amount, description });

    io.to(code).emit('party_updated', party);
    cb({ success: true });
  });

  // ── Delete expense ──
  socket.on('delete_expense', (data, cb) => {
    if (!data) return;
    const code = sanitizeString(data.code, 6).toUpperCase();
    const expenseId = sanitizeString(data.expenseId, 100);
    if (!code || !expenseId) return cb && cb({ success: false });

    const party = parties[code];
    if (!party) { cb && cb({ success: false }); return; }

    party.expenses = party.expenses.filter(e => e.id !== expenseId);
    logActivity('Delete Expense', { code, expenseId });

    io.to(code).emit('party_updated', party);
    cb && cb({ success: true });
  });

  // ── Leave party ──
  socket.on('leave_party', (data) => {
    if (!data) return;
    const code = sanitizeString(data.code, 6).toUpperCase();
    const deviceId = sanitizeString(data.deviceId, 100);
    if (!code || !deviceId) return;

    const party = parties[code];
    if (party) {
      party.members = party.members.filter(m => m.id !== deviceId);
      socket.leave(code);
      logActivity('Leave Party', { code, deviceId });

      io.to(code).emit('party_updated', party);
      if (party.members.length === 0) {
        setTimeout(() => {
          if (parties[code] && parties[code].members.length === 0) {
            delete parties[code];
            console.log(`[PARTY] Cleaned up empty party: ${code}`);
          }
        }, 60000);
      }
    }
  });

  // ── Disconnect cleanup ──
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// ──────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       SplitEase Server Running       ║');
  console.log(`  ║  Local:   http://localhost:${PORT}       ║`);
  console.log('  ║  Share URL with your team members!   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  // Print local network IPs
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});