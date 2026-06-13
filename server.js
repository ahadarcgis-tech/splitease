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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
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

// ──────────────────────────────────────────────
// SOCKET.IO EVENTS
// ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create party ──
  socket.on('create_party', ({ deviceId, userName }, cb) => {
    let code = generateCode();
    while (parties[code]) code = generateCode(); // ensure unique

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
    cb({ success: true, party: parties[code] });
    io.to(code).emit('party_updated', parties[code]);
  });

  // ── Join party ──
  socket.on('join_party', ({ code, deviceId, userName }, cb) => {
    const upper = code.toUpperCase();
    const party = parties[upper];
    if (!party) { cb({ success: false, error: 'Party not found' }); return; }

    // Add member if not already present
    if (!party.members.find(m => m.id === deviceId)) {
      party.members.push({ id: deviceId, name: userName, joinedAt: Date.now() });
    }

    socket.join(upper);
    socket.data.partyCode = upper;
    socket.data.deviceId  = deviceId;

    console.log(`[PARTY] ${userName} joined: ${upper}`);
    cb({ success: true, party });
    io.to(upper).emit('party_updated', party);
  });

  // ── Rejoin on reconnect ──
  socket.on('rejoin_party', ({ code, deviceId, userName }, cb) => {
    const upper = code.toUpperCase();
    const party = parties[upper];
    if (!party) { cb({ success: false, error: 'Party expired' }); return; }

    if (!party.members.find(m => m.id === deviceId)) {
      party.members.push({ id: deviceId, name: userName, joinedAt: Date.now() });
    }

    socket.join(upper);
    socket.data.partyCode = upper;
    socket.data.deviceId  = deviceId;

    cb({ success: true, party });
    io.to(upper).emit('party_updated', party);
  });

  // ── Add expense ──
  socket.on('add_expense', ({ code, memberId, memberName, amount, description, date }, cb) => {
    const party = parties[code];
    if (!party) { cb({ success: false }); return; }

    const expense = {
      id: uuidv4(),
      memberId, memberName,
      amount: parseFloat(amount),
      description, date,
      addedAt: Date.now()
    };
    party.expenses.push(expense);

    io.to(code).emit('party_updated', party);
    cb({ success: true });
  });

  // ── Delete expense ──
  socket.on('delete_expense', ({ code, expenseId }, cb) => {
    const party = parties[code];
    if (!party) { cb && cb({ success: false }); return; }

    party.expenses = party.expenses.filter(e => e.id !== expenseId);
    io.to(code).emit('party_updated', party);
    cb && cb({ success: true });
  });

  // ── Leave party ──
  socket.on('leave_party', ({ code, deviceId }) => {
    const party = parties[code];
    if (party) {
      party.members = party.members.filter(m => m.id !== deviceId);
      socket.leave(code);
      io.to(code).emit('party_updated', party);
      // Clean up empty parties
      if (party.members.length === 0) {
        setTimeout(() => {
          if (parties[code] && parties[code].members.length === 0) {
            delete parties[code];
            console.log(`[PARTY] Cleaned up empty party: ${code}`);
          }
        }, 60000); // wait 1 min before deleting
      }
    }
  });

  // ── Disconnect cleanup ──
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    // Members are NOT removed on disconnect — they persist until explicit leave
    // so refreshing doesn't kick people out
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
