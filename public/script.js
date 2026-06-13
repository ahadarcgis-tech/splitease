/* ══════════════════════════════════════════════════
   SplitEase — script.js
   ══════════════════════════════════════════════════ */

// ── 1. DEVICE IDENTITY ──────────────────────────────
function genId(len = 16) {
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}
let deviceId = sessionStorage.getItem('se_deviceId');
if (!deviceId) { deviceId = genId(); sessionStorage.setItem('se_deviceId', deviceId); }
let userName = sessionStorage.getItem('se_userName') || localStorage.getItem('se_userName') || null;

// ── 2. SOCKET ────────────────────────────────────────
// Use lazy connect so we control when it fires
const socket = io({ autoConnect: false });

socket.on('connect', () => {
  const bar   = document.getElementById('statusBar');
  const text  = document.getElementById('statusText');
  const badge = document.getElementById('liveBadge');
  if (bar)   bar.className = 'status-bar connected';
  if (text)  text.textContent = 'Connected — real-time sync active';
  if (badge) { badge.className = 'live-badge live'; badge.textContent = 'LIVE'; }

  // Auto-rejoin saved party
  const code = localStorage.getItem('se_party');
  if (code && userName) {
    socket.emit('rejoin_party', { code, deviceId, userName }, (res) => {
      if (res && res.success) {
        enterPartyUI(code);
        applyPartyData(res.party);
      } else {
        localStorage.removeItem('se_party');
      }
    });
  }
});

socket.on('disconnect', () => {
  const bar   = document.getElementById('statusBar');
  const text  = document.getElementById('statusText');
  const badge = document.getElementById('liveBadge');
  if (bar)   bar.className = 'status-bar disconnected';
  if (text)  text.textContent = 'Disconnected — trying to reconnect…';
  if (badge) { badge.className = 'live-badge'; badge.textContent = 'OFFLINE'; }
});

socket.on('party_updated', (party) => {
  if (party.code === currentParty) applyPartyData(party);
});

// ── 3. ONBOARDING ────────────────────────────────────
const modal      = document.getElementById('onboardModal');
const nameInput  = document.getElementById('nameInput');
const nameSubmit = document.getElementById('nameSubmitBtn');

if (userName) {
  modal.classList.add('hidden');
  initApp();
} else {
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });
  nameSubmit.addEventListener('click', submitName);
}

function submitName() {
  const n = nameInput.value.trim();
  if (!n) { nameInput.style.borderColor = 'var(--danger)'; return; }
  userName = n;
  sessionStorage.setItem('se_userName', n);
  localStorage.setItem('se_userName', n);
  modal.classList.add('hidden');
  initApp();
}

function initApp() {
  // Show the app shell
  document.getElementById('app').classList.remove('hidden');

  // Safe DOM access — elements now exist in visible DOM
  document.getElementById('navUser').textContent = `Hi, ${userName}! 👋`;

  // Load saved prefs
  const theme  = localStorage.getItem('se_theme') || 'warm';
  const isDark = localStorage.getItem('se_dark') !== 'false';
  applyTheme(theme, false);
  applyDark(isDark, false);
  const darkToggle = document.getElementById('darkToggle');
  if (darkToggle) darkToggle.checked = isDark;
  document.querySelectorAll('.pill-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.val === theme);
  });

  // Default date
  const dateInput = document.getElementById('dateInput');
  if (dateInput) dateInput.valueAsDate = new Date();

  // Populate empty paid-by
  populatePaidBy([]);

  // Render history
  renderHistory();

  // NOW connect socket (after DOM is ready)
  socket.connect();
}

// ── 4. THEME ─────────────────────────────────────────
function setTheme(t) {
  applyTheme(t, true);
  document.querySelectorAll('.pill-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.val === t);
  });
}
function applyTheme(t, save) {
  document.documentElement.setAttribute('data-theme', t);
  if (save) localStorage.setItem('se_theme', t);
}
function toggleDark(el) { applyDark(el.checked, true); }
function applyDark(d, save) {
  document.documentElement.setAttribute('data-mode', d ? 'dark' : 'light');
  if (save) localStorage.setItem('se_dark', String(d));
}

// ── 5. PARTY STATE ───────────────────────────────────
let currentParty = null;
let partyData    = null;
let expenseChartInstance = null;

// Wire up buttons AFTER DOM loads (DOMContentLoaded guarantees it)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('createPartyBtn').addEventListener('click', createParty);
  document.getElementById('joinBtn').addEventListener('click', joinParty);
  document.getElementById('leaveBtn').addEventListener('click', leaveParty);
  document.getElementById('copyBtn').addEventListener('click', copyCode);
  document.getElementById('calcBtn').addEventListener('click', doSettle);
  document.getElementById('clearAllBtn').addEventListener('click', clearAllExpenses);
  document.getElementById('expenseForm').addEventListener('submit', submitExpense);

  const joinInput = document.getElementById('joinInput');
  joinInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinParty(); });
  joinInput.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
  });
});

function createParty() {
  if (!userName) { toast('Enter your name first'); return; }
  if (!socket.connected) { toast('⚠️ Not connected yet — please wait a moment'); return; }

  const btn = document.getElementById('createPartyBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  socket.emit('create_party', { deviceId, userName }, (res) => {
    btn.disabled = false;
    btn.textContent = '+ Create New Party';
    if (res && res.success) {
      enterPartyUI(res.party.code);
      applyPartyData(res.party);
      saveHistory(res.party.code, 'Created');
      toast('🎉 Party created! Share the code');
    } else {
      toast('❌ Could not create party — try again');
    }
  });

  setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false;
      btn.textContent = '+ Create New Party';
      toast('⚠️ No response from server');
    }
  }, 8000);
}

function joinParty() {
  const joinInput = document.getElementById('joinInput');
  const code = joinInput.value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter at least 4 characters'); return; }
  if (!socket.connected) { toast('⚠️ Not connected yet — please wait'); return; }

  const btn = document.getElementById('joinBtn');
  btn.disabled = true;
  btn.textContent = 'Joining…';

  socket.emit('join_party', { code, deviceId, userName }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Join →';
    if (res && res.success) {
      joinInput.value = '';
      enterPartyUI(code);
      applyPartyData(res.party);
      saveHistory(code, 'Joined');
      toast(`✅ Joined party ${code}!`);
    } else {
      toast(`❌ Party "${code}" not found`);
    }
  });

  setTimeout(() => {
    if (btn.disabled) { btn.disabled = false; btn.textContent = 'Join →'; }
  }, 8000);
}

function leaveParty() {
  if (!currentParty) return;
  socket.emit('leave_party', { code: currentParty, deviceId });
  localStorage.removeItem('se_party');
  currentParty = null; partyData = null;
  leavePartyUI();
  toast('👋 Left the party');
}

function copyCode() {
  if (!currentParty) return;
  navigator.clipboard.writeText(currentParty)
    .then(() => toast('📋 Code copied!'))
    .catch(() => toast(`Code: ${currentParty}`));
}

// ── UI transitions ──
function enterPartyUI(code) {
  currentParty = code;
  localStorage.setItem('se_party', code);
  document.getElementById('noParty').classList.add('hidden');
  document.getElementById('inParty').classList.remove('hidden');
  document.getElementById('codeDisplay').textContent = code;
  const pCell = document.getElementById('partyCell');
  if (pCell) pCell.classList.remove('no-party-active');
}

function leavePartyUI() {
  document.getElementById('noParty').classList.remove('hidden');
  document.getElementById('inParty').classList.add('hidden');
  document.getElementById('codeDisplay').textContent = '------';
  const pCell = document.getElementById('partyCell');
  if (pCell) pCell.classList.add('no-party-active');
  renderMembers([]);
  renderExpenses([]);
  clearSettle();
  updateStats([], []);
  populatePaidBy([]);
}

// ── 6. APPLY PARTY ───────────────────────────────────
function applyPartyData(party) {
  partyData = party;
  renderMembers(party.members);
  renderExpenses(party.expenses);
  updateStats(party.members, party.expenses);
  populatePaidBy(party.members);
}

// ── 7. MEMBERS ───────────────────────────────────────
function renderMembers(members) {
  const list = document.getElementById('membersList');
  const chip = document.getElementById('memberCountChip');
  chip.textContent = members.length;

  if (!members.length) {
    list.innerHTML = '<div class="empty-msg">Waiting for members…</div>';
    return;
  }
  list.innerHTML = '';
  members.forEach((m, i) => {
    const spent = (partyData?.expenses || [])
      .filter(e => e.memberId === m.id)
      .reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const isMe = m.id === deviceId;
    const div  = document.createElement('div');
    div.className = 'member-item' + (isMe ? ' is-me' : '');
    div.style.animationDelay = `${i * 40}ms`;
    div.innerHTML = `
      <div class="avatar" style="background:${memberColor(m.id)}">${initials(m.name)}</div>
      <div class="member-info">
        <div class="member-name">${esc(m.name)}</div>
        <div class="member-sub">$${spent.toFixed(2)} spent</div>
      </div>
      ${isMe ? '<span class="you-tag">You</span>' : ''}
    `;
    list.appendChild(div);
  });
}

function memberColor(id) {
  const colors = [
    'hsl(28,85%,52%)','hsl(195,80%,48%)','hsl(142,60%,42%)',
    'hsl(260,70%,58%)','hsl(348,70%,52%)','hsl(42,90%,48%)',
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xFFFFFF;
  return colors[h % colors.length];
}
function initials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ── 8. EXPENSE FORM ──────────────────────────────────
function populatePaidBy(members) {
  const sel = document.getElementById('paidBy');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  if (!members.length) {
    sel.innerHTML = '<option value="">— Join a party first —</option>';
    return;
  }
  members.forEach(m => {
    const opt    = document.createElement('option');
    opt.value    = m.id;
    opt.textContent = m.name + (m.id === deviceId ? ' (You)' : '');
    if (m.id === deviceId) opt.selected = true;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function submitExpense(e) {
  e.preventDefault();
  if (!currentParty) { toast('Join a party first!'); return; }
  const member = partyData?.members.find(m => m.id === document.getElementById('paidBy').value);
  if (!member) { toast('Select who paid'); return; }

  const data = {
    code:        currentParty,
    memberId:    member.id,
    memberName:  member.name,
    amount:      parseFloat(document.getElementById('amtInput').value),
    description: document.getElementById('descInput').value.trim() || '—',
    date:        document.getElementById('dateInput').value,
  };

  socket.emit('add_expense', data, (res) => {
    if (res && res.success) {
      document.getElementById('expenseForm').reset();
      document.getElementById('dateInput').valueAsDate = new Date();
      populatePaidBy(partyData?.members || []);
      toast('💸 Expense added!');
    } else {
      toast('Failed to add expense');
    }
  });
}

// ── 9. EXPENSE LOG ───────────────────────────────────
function renderExpenses(expenses) {
  const log  = document.getElementById('expenseLog');
  const chip = document.getElementById('expChip');
  chip.textContent = expenses.length;
  if (!expenses.length) {
    log.innerHTML = '<div class="empty-msg">No expenses yet — add one!</div>';
    return;
  }
  log.innerHTML = '';
  [...expenses].reverse().forEach((exp, i) => {
    const div = document.createElement('div');
    div.className = 'log-item';
    div.style.animationDelay = `${i * 30}ms`;
    div.innerHTML = `
      <div class="log-amt">$${parseFloat(exp.amount).toFixed(2)}</div>
      <div class="log-info">
        <div class="log-desc">${esc(exp.description)}</div>
        <div class="log-meta">${esc(exp.memberName)} · ${exp.date}</div>
      </div>
      <button class="del-btn" data-id="${exp.id}" title="Remove">✕</button>
    `;
    log.appendChild(div);
  });
  log.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('delete_expense', { code: currentParty, expenseId: btn.dataset.id });
    });
  });
}

function clearAllExpenses() {
  if (!currentParty || !partyData?.expenses.length) return;
  if (!confirm('Clear all expenses for this party?')) return;
  partyData.expenses.forEach(ex => {
    socket.emit('delete_expense', { code: currentParty, expenseId: ex.id });
  });
}

// ── 10. STATS ────────────────────────────────────────
function updateStats(members, expenses) {
  const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const share = members.length > 0 ? total / members.length : 0;
  const tEl = document.getElementById('statTotal');
  const sEl = document.getElementById('statShare');
  const mEl = document.getElementById('statMembers');
  if (tEl) tEl.textContent = `$${total.toFixed(2)} total`;
  if (sEl) sEl.textContent = `$${share.toFixed(2)} each`;
  if (mEl) mEl.textContent = `${members.length} member${members.length !== 1 ? 's' : ''}`;
}

// ── 11. SETTLEMENT ───────────────────────────────────
function doSettle() {
  if (!partyData) { toast('Join a party first'); return; }
  const { members, expenses } = partyData;
  if (!expenses.length) { toast('No expenses to settle'); return; }
  if (members.length < 2) { toast('Need at least 2 members'); return; }

  const spent = {};
  members.forEach(m => { spent[m.id] = 0; });
  expenses.forEach(e => { if (spent[e.memberId] !== undefined) spent[e.memberId] += parseFloat(e.amount || 0); });

  const total = Object.values(spent).reduce((s, v) => s + parseFloat(v || 0), 0);
  const share = total / members.length;

  const bal = {};
  members.forEach(m => { bal[m.id] = parseFloat((spent[m.id] - share).toFixed(2)); });

  // Create a copy of bal for the greedy transfers solver to mutate, keeping the original intact for the UI!
  const solverBal = { ...bal };

  // Greedy min-transfers solver
  const pos = [...members].filter(m => solverBal[m.id] >  0.005).sort((a,b) => solverBal[b.id]-solverBal[a.id]);
  const neg = [...members].filter(m => solverBal[m.id] < -0.005).sort((a,b) => solverBal[a.id]-solverBal[b.id]);
  const transfers = [];
  let pi = 0, ni = 0;
  while (pi < pos.length && ni < neg.length) {
    const p = pos[pi], n = neg[ni];
    const amt = parseFloat(Math.min(solverBal[p.id], -solverBal[n.id]).toFixed(2));
    if (amt > 0) {
      transfers.push({ fromId: n.id, fromName: n.name, toId: p.id, toName: p.name, amount: amt });
      solverBal[p.id] = parseFloat((solverBal[p.id] - amt).toFixed(2));
      solverBal[n.id] = parseFloat((solverBal[n.id] + amt).toFixed(2));
    }
    if (Math.abs(solverBal[p.id]) < 0.01) pi++;
    if (Math.abs(solverBal[n.id]) < 0.01) ni++;
  }
  renderSettle(members, spent, share, total, bal, transfers);
}

function renderSettle(members, spent, share, total, bal, transfers) {
  const wrap = document.getElementById('settleWrap');
  wrap.innerHTML = '';

  const tabs = document.createElement('div');
  tabs.className = 'settle-tabs';

  // 📋 Global "All" overview tab
  const allBtn = document.createElement('button');
  allBtn.className = 's-tab active';
  allBtn.textContent = '📋 All Transfers';
  allBtn.dataset.i = 'all';
  tabs.appendChild(allBtn);

  members.forEach((m, i) => {
    const btn = document.createElement('button');
    btn.className = 's-tab';
    btn.textContent = m.id === deviceId ? `${m.name} ⭐` : m.name;
    btn.dataset.i = i;
    tabs.appendChild(btn);
  });
  wrap.appendChild(tabs);

  const body = document.createElement('div');
  body.className = 'settle-body';
  wrap.appendChild(body);

  function show(tabVal) {
    body.innerHTML = '';

    if (tabVal === 'all') {
      // Global overview of all transfers
      const sum = document.createElement('div');
      sum.className = 'settle-summary';
      sum.innerHTML = `
        <div class="settle-meta">Total Expenses: <strong>$${total.toFixed(2)}</strong> · Members: <strong>${members.length}</strong></div>
        <div class="settle-bal" style="color: var(--primary);">
          ✨ Settle Plan (${transfers.length} transaction${transfers.length !== 1 ? 's' : ''})
        </div>`;
      body.appendChild(sum);

      if (!transfers.length) {
        const ok = document.createElement('div');
        ok.className = 'txn-row';
        ok.style.cssText = 'justify-content:center;color:var(--success);border-left:3px solid var(--success)';
        ok.textContent = '✅ Everyone is even! No transfers needed.';
        body.appendChild(ok);
      } else {
        transfers.forEach(t => {
          const row = document.createElement('div');
          row.className = 'txn-row pay';
          row.style.borderLeftColor = 'var(--primary)';
          row.innerHTML = `
            <span><strong>${esc(t.fromName)}</strong> pays <strong>${esc(t.toName)}</strong></span>
            <span class="txn-amt" style="color:var(--primary);">$${t.amount.toFixed(2)}</span>
          `;
          body.appendChild(row);
        });
      }

      // Add the Pie Chart container!
      const chartDiv = document.createElement('div');
      chartDiv.id = 'chartContainer';
      chartDiv.className = 'chart-card';
      chartDiv.style.cssText = 'background:var(--surface2); border:1px solid var(--border); border-radius:9px; padding:12px; margin-top:10px; flex-shrink:0;';
      chartDiv.innerHTML = `
        <div style="font-size:0.85rem; font-weight:700; color:var(--text-2); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; text-align:center;">Expense Share</div>
        <div style="position:relative; height:180px; width:100%;"><canvas id="expenseChart"></canvas></div>
      `;
      body.appendChild(chartDiv);

      // Render the chart
      renderPieChart(members, spent);
      return;
    }

    // Individual member tab view
    const m = members[tabVal];
    const b = bal[m.id];
    const mT = transfers.filter(t => t.fromId === m.id || t.toId === m.id);

    const sum = document.createElement('div');
    sum.className = 'settle-summary';

    let balText = '';
    let balClass = '';
    if (b > 0.005) {
      balText = `▲ Gets back $${b.toFixed(2)}`;
      balClass = 'pos';
    } else if (b < -0.005) {
      balText = `▼ Owes $${Math.abs(b).toFixed(2)}`;
      balClass = 'neg';
    } else {
      balText = `✅ Settled ($0.00)`;
      balClass = 'settled';
    }

    sum.innerHTML = `
      <div class="settle-meta">Paid <strong>$${spent[m.id].toFixed(2)}</strong> · Fair share <strong>$${share.toFixed(2)}</strong></div>
      <div class="settle-bal ${balClass}">
        ${balText}
      </div>`;
    body.appendChild(sum);

    if (!mT.length) {
      const ok = document.createElement('div');
      ok.className = 'txn-row';
      ok.style.cssText = 'justify-content:center;color:var(--success);border-left:3px solid var(--success)';
      ok.textContent = '✅ Perfectly settled!';
      body.appendChild(ok);
    } else {
      mT.forEach(t => {
        const isPay = t.fromId === m.id;
        const row = document.createElement('div');
        row.className = `txn-row ${isPay ? 'pay' : 'recv'}`;
        row.innerHTML = isPay
          ? `💸 <span>Pay <strong>${esc(t.toName)}</strong></span><span class="txn-amt">$${t.amount.toFixed(2)}</span>`
          : `💰 <span>Receive from <strong>${esc(t.fromName)}</strong></span><span class="txn-amt">$${t.amount.toFixed(2)}</span>`;
        body.appendChild(row);
      });
    }
  }

  // Show the "All" tab by default
  show('all');

  tabs.querySelectorAll('.s-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.s-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.i === 'all') {
        show('all');
      } else {
        show(+btn.dataset.i);
      }
    });
  });
}

function renderPieChart(members, spent) {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded.');
    return;
  }
  const ctx = document.getElementById('expenseChart');
  if (!ctx) return;

  if (expenseChartInstance) {
    expenseChartInstance.destroy();
    expenseChartInstance = null;
  }

  const labels = [];
  const data = [];
  const backgroundColors = [];

  members.forEach(m => {
    const amt = spent[m.id] || 0;
    if (amt > 0) {
      labels.push(m.name);
      data.push(amt);
      backgroundColors.push(memberColor(m.id));
    }
  });

  const container = document.getElementById('chartContainer');
  if (data.length === 0) {
    if (container) container.style.display = 'none';
    return;
  } else {
    if (container) container.style.display = 'block';
  }

  const isDark = document.documentElement.getAttribute('data-mode') === 'dark';
  const textColor = isDark ? 'hsl(30,12%,82%)' : 'hsl(20,20%,24%)';

  expenseChartInstance = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: backgroundColors,
        borderWidth: isDark ? 2 : 1,
        borderColor: isDark ? '#1a120c' : '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: textColor,
            font: {
              family: 'Inter',
              weight: 'bold',
              size: 11
            },
            boxWidth: 10
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw || 0;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((val / total) * 100).toFixed(1);
              return ` ${context.label}: $${val.toFixed(2)} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function clearSettle() {
  const w = document.getElementById('settleWrap');
  if (w) w.innerHTML = '<div class="empty-msg">Add expenses then press Calculate</div>';
}

// ── 12. HISTORY ──────────────────────────────────────
function saveHistory(code, action) {
  const hist = JSON.parse(localStorage.getItem('se_history') || '[]');
  const idx  = hist.findIndex(h => h.code === code);
  if (idx >= 0) hist[idx] = { code, action, ts: Date.now() };
  else          hist.unshift({ code, action, ts: Date.now() });
  if (hist.length > 30) hist.splice(30);
  localStorage.setItem('se_history', JSON.stringify(hist));
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const hist = JSON.parse(localStorage.getItem('se_history') || '[]');
  if (!hist.length) {
    list.innerHTML = '<div class="empty-msg">Your past parties appear here</div>';
    return;
  }
  list.innerHTML = '';
  hist.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'hist-item';
    div.style.animationDelay = `${i * 40}ms`;
    div.innerHTML = `
      <div class="hist-top">
        <span class="hist-code">${h.code}</span>
        <span class="hist-date">${fmtDate(h.ts)}</span>
      </div>
      <div class="hist-detail">${h.action} · tap to rejoin</div>`;
    div.addEventListener('click', () => {
      if (currentParty === h.code) { toast('Already in this party'); return; }
      if (currentParty) leaveParty();
      socket.emit('rejoin_party', { code: h.code, deviceId, userName }, (res) => {
        if (res && res.success) {
          enterPartyUI(h.code);
          applyPartyData(res.party);
          saveHistory(h.code, 'Rejoined');
          toast(`✅ Rejoined ${h.code}`);
        } else {
          toast(`❌ Party ${h.code} has expired`);
        }
      });
    });
    list.appendChild(div);
  });
}

// ── 13. UTILITIES ────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
