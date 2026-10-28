/* Online Examination Management System
   Persistence: localStorage (data) + IndexedDB (PDF file). Data survives refresh/close/restart
   in the same browser. Default admin login: admin / admin123 (change it in Settings). */
'use strict';
const KEY = 'oems_db';
const DEFAULT = {
  school: 'My School',
  admin: { user: 'admin', pass: 'admin123' },
  exam: { title: '', date: '', time: '', duration: 60, key: '', publish: false, pdfName: '' },
  students: [], results: [], attempts: {}
};
/* Safe storage: falls back to memory if the browser blocks storage (e.g. sandboxed previews) */
const mem = {};
const store = (kind) => { try { const s = window[kind]; s.setItem('t', '1'); s.removeItem('t'); return s; } catch (e) { return { getItem: k => mem[kind + k] ?? null, setItem: (k, v) => { mem[kind + k] = v; }, removeItem: k => { delete mem[kind + k]; } }; } };
const LS = store('localStorage'), SS = store('sessionStorage');
let db = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), JSON.parse(LS.getItem(KEY) || '{}'));
let session = JSON.parse(SS.getItem('oems_session') || 'null');
let tab = 'settings', msg = '', timer = null;

const save = () => LS.setItem(KEY, JSON.stringify(db));
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setSession = s => { session = s; s ? SS.setItem('oems_session', JSON.stringify(s)) : SS.removeItem('oems_session'); };

/* ---------- PDF storage (IndexedDB) ---------- */
const pdfDB = () => new Promise((res, rej) => {
  const r = indexedDB.open('oems', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('f');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const pdfPut = async blob => { const d = await pdfDB(); return new Promise(r => { const t = d.transaction('f', 'readwrite'); t.objectStore('f').put(blob, 'exam'); t.oncomplete = r; }); };
const pdfGet = async () => { const d = await pdfDB(); return new Promise(r => { const q = d.transaction('f').objectStore('f').get('exam'); q.onsuccess = () => r(q.result); }); };

/* ---------- Helpers ---------- */
const sha = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const typedQs = () => db.exam.questions || [];
const liveQs = () => typedQs().filter(q => q.q);
const missing = e => [!e.date && 'exam date', !e.time && 'start time', !(e.questions || []).filter(q => q.q).length && 'questions'].filter(Boolean);
let cur = 0, pdfUrl = '';
const qCount = () => liveQs().length;
const dl = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); };

/* ---------- PDF data files (exam package + answer files are PDFs) ----------
   Each file is a real, readable PDF (summary pages) that also carries the app data
   inside a hidden embedded block, so it can be re-imported by this system. */
const pdfSafe = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
const toB64 = str => btoa(unescape(encodeURIComponent(str))).replace(/.{1,120}/g, '$&\n');
const fromB64 = b => decodeURIComponent(escape(atob(b.replace(/\s+/g, ''))));
function makePdf(title, lines, payload) {
  const PER = 46, pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += PER) pages.push(lines.slice(i, i + PER));
  const data = toB64(JSON.stringify(payload));
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R /OEMS 4 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const body = 'OEMS-DATA-BEGIN\n' + data + 'OEMS-DATA-END\n';
  objs[4] = '<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream';
  const kids = [];
  pages.forEach((pg, n) => {
    const pn = 5 + n * 2, cn = pn + 1; kids.push(pn + ' 0 R');
    let c = 'BT /F1 11 Tf 50 790 Td 16 TL\n';
    if (n === 0) c += '/F1 18 Tf (' + pdfSafe(title).slice(0, 70) + ') Tj T* /F1 11 Tf T*\n';
    pg.forEach(l => { c += '(' + pdfSafe(l).slice(0, 95) + ') Tj T*\n'; });
    c += 'ET';
    objs[pn] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + cn + ' 0 R >>';
    objs[cn] = '<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream';
  });
  objs[2] = '<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kids.join(' ') + '] >>';
  let out = '%PDF-1.4\n', off = [];
  for (let i = 1; i < objs.length; i++) { off[i] = out.length; out += i + ' 0 obj\n' + objs[i] + '\nendobj\n'; }
  const xr = out.length;
  out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xr + '\n%%EOF';
  const u = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u[i] = out.charCodeAt(i) & 255;
  return new Blob([u], { type: 'application/pdf' });
}
async function readPdfData(file) {
  const t = new TextDecoder('latin1').decode(await file.arrayBuffer());
  const a = t.indexOf('OEMS-DATA-BEGIN'), b = t.indexOf('OEMS-DATA-END', a);
  if (a < 0 || b < 0) throw new Error('no data');
  return JSON.parse(fromB64(t.slice(a + 15, b)));
}
const b64 = blob => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
const startTime = () => db.exam.date && db.exam.time ? new Date(db.exam.date + 'T' + db.exam.time).getTime() : null;
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':'); };
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const shell = (body, sub = '', name = '') => `<div class="topbar"><div class="brand"><div class="logo">🎓</div><div><h1>${esc(db.school)}</h1><small>Online Examination System</small></div></div>${session ? `<div class="user"><div class="avatar">${esc(initials(name || sub))}</div><div><b>${esc(sub)}</b></div><button onclick="logout()">Logout</button></div>` : ''}</div><main>${body}</main>`;

function render() {
  clearInterval(timer);
  $('#app').innerHTML = !session ? loginView() : session.role === 'admin' ? adminView() : studentView();
  if (session?.role === 'student') afterStudentRender();
}

/* ---------- Login ---------- */
function loginView() {
  return `<div class="auth"><div class="hero"><div class="logo">🎓</div><h1>${esc(db.school)}</h1>
    <p>A simple, secure way to run school examinations online from any device.</p>
    <ul><li><span>⏱️</span>Automatic exam timer</li><li><span>📄</span>Question papers in PDF</li><li><span>📊</span>Instant results and reports</li></ul></div>
    <div class="formside"><div class="formbox"><h2>Welcome back 👋</h2><p class="sub">Sign in with the username and password given to you.</p>
    <label>Username</label><input id="lu" autocomplete="username" placeholder="Enter your username">
    <label>Password</label><input id="lp" type="password" autocomplete="current-password" placeholder="Enter your password" onkeydown="if(event.key==='Enter')login()">
    <div class="msg">${esc(msg)}</div><button onclick="login()">Login</button></div></div></div>`;
}
async function login() {
  const u = $('#lu').value.trim(), p = $('#lp').value;
  msg = '';
  if (u === db.admin.user && p === db.admin.pass) setSession({ role: 'admin' });
  else {
    const h = await sha(p), s = db.students.find(x => x.user === u && (x.pass !== undefined ? x.pass === p : x.h === h));
    if (s) setSession({ role: 'student', id: s.id }); else msg = 'Invalid username or password.';
  }
  render();
}
function logout() { setSession(null); msg = ''; render(); }

/* ---------- Admin ---------- */
function adminView() {
  const names = { settings: '⚙️ School & Exam', questions: '❓ Questions', students: '👥 Students', results: '📊 Results' };
  const tabs = Object.keys(names).map(k => `<button class="${tab === k ? 'on' : ''}" onclick="syncQ();tab='${k}';msg='';render()">${names[k]}</button>`).join('');
  const r = db.results, avg = r.length ? Math.round(r.reduce((a, x) => a + (x.total ? x.score / x.total : 0), 0) / r.length * 100) + '%' : '—';
  const st = startTime(), ex = st ? new Date(st).toLocaleDateString() : 'Not set';
  const stat = (i, v, l) => `<div class="stat"><i>${i}</i><div><b>${esc(v)}</b><span>${l}</span></div></div>`;
  return shell(`<div class="stats">${stat('🧑‍🎓', db.students.length, 'Accounts')}${stat('✅', r.length, 'Submitted')}${stat('📈', avg, 'Average score')}${stat('🗓️', ex, 'Exam date')}</div><div class="tabs">${tabs}</div>${tab === 'settings' ? settingsTab() : tab === 'questions' ? questionsTab() : tab === 'students' ? studentsTab() : resultsTab()}`, 'Administrator', 'Admin');
}
function settingsTab() {
  const e = db.exam, ok = !missing(e).length;
  return `<div class="card"><h2>School & Examination Settings</h2><p class="sub">These details appear to everyone using the system.</p>
  ${ok ? `<div class="note">✅ Exam is ready (${qCount()} questions). Export a package after any change so students get the update.</div>` : `<div class="note">⚠️ Not ready for students yet. Still missing: <b>${missing(e).join(', ')}</b>.</div>`}
  <div class="grid">
    <div><label>School name</label><input id="sn" value="${esc(db.school)}"></div>
    <div><label>Exam title</label><input id="et" value="${esc(e.title)}"></div>
    <div><label>Date</label><input id="ed" type="date" value="${esc(e.date)}"></div>
    <div><label>Start time</label><input id="etm" type="time" value="${esc(e.time)}"></div>
    <div><label>Duration (minutes)</label><input id="edu" type="number" min="1" value="${esc(e.duration)}"></div>
  </div>
  <div class="msg ${msg.startsWith('Saved') ? 'good' : ''}">${esc(msg)}</div>
  <button onclick="saveSettings()">💾 Save settings</button></div>
  <div class="card"><h2>Share with Student Devices</h2><p class="sub">Other computers or phones can't see this exam until the package file is loaded on them. Save your settings and questions first, then export the package and copy it to each student device (USB, email, WhatsApp, shared folder). On that device, log in as administrator, load the package below, then log out so students can sign in. Correct answers are never included in the package.</p>
  <button onclick="exportPackage()">📦 Export exam package</button>
  <label style="margin-top:22px">📥 Load an exam package on this device (use this on each student device, then log out)</label><input type="file" accept=".pdf,application/pdf" onchange="importPackage(this)"></div>
  <div class="card"><h2>Admin Account</h2><p class="sub">Change the administrator login.</p><div class="grid">
    <div><label>Admin username</label><input id="au" value="${esc(db.admin.user)}"></div>
    <div><label>New admin password</label><input id="ap" type="password" placeholder="leave blank to keep"></div></div>
    <br><button class="sec" onclick="saveAdmin()">Update admin</button></div>`;
}
function saveSettings() {
  db.school = $('#sn').value.trim() || 'My School';
  Object.assign(db.exam, { title: $('#et').value.trim(), date: $('#ed').value, time: $('#etm').value, duration: Math.max(1, +$('#edu').value || 60) });
  save(); msg = 'Saved successfully.'; render();
}
function saveAdmin() {
  const u = $('#au').value.trim(), p = $('#ap').value;
  if (u) db.admin.user = u; if (p) db.admin.pass = p;
  save(); msg = 'Saved admin account.'; render();
}
function syncKey() { db.exam.key = liveQs().map(q => q.ans || 'A').join(''); db.exam.count = db.exam.key.length; }
function autoSave() { syncKey(); save(); }
function syncQ() {
  if (!document.getElementById('qt0')) return;
  db.exam.questions = typedQs().map((q, i) => ({ q: $('#qt' + i).value.trim(), a: $('#qa' + i).value.trim(), b: $('#qb' + i).value.trim(), c: $('#qc' + i).value.trim(), d: $('#qd' + i).value.trim(), ans: $('#qk' + i).value }));
  autoSave();
}
function addQ() { syncQ(); db.exam.questions = [...typedQs(), { q: '', a: '', b: '', c: '', d: '', ans: 'A' }]; msg = ''; render(); }
function delQ(i) { syncQ(); db.exam.questions = typedQs().filter((_, j) => j !== i); msg = ''; autoSave(); render(); }
const blankQ = () => ({ q: '', a: '', b: '', c: '', d: '', ans: 'A' });
const isBlank = q => !q.q && !q.a && !q.b && !q.c && !q.d;
function addN(n) { syncQ(); db.exam.questions = [...typedQs(), ...Array.from({ length: n }, blankQ)]; msg = ''; autoSave(); render(); }
function saveQs() {
  syncQ();
  const qs = typedQs().filter(q => !isBlank(q));
  const bad = qs.findIndex(q => !q.q || [q.a, q.b, q.c, q.d].filter(Boolean).length < 2);
  if (!qs.length) { msg = 'Please type at least one question.'; return render(); }
  if (bad >= 0) { msg = 'Question ' + (bad + 1) + ' (after removing empty ones) needs question text and at least two options.'; return render(); }
  db.exam.questions = qs; syncKey(); save(); msg = 'Saved ' + qs.length + ' questions.'; render();
}
function parseQuestions(text) {
  const raw = text.replace(/\r/g, '').split('\n').map(l => l.trim());
  const isNum = l => /^\d+\s*[).:\-]\s*\S/.test(l);
  let blocks;
  if (raw.filter(isNum).length >= 2) {            /* numbered questions (PDF text has no blank lines) */
    blocks = []; let b = null;
    for (const l of raw) { if (!l) continue; if (isNum(l)) { b = []; blocks.push(b); } if (b) b.push(l); }
  } else blocks = text.split(/\n\s*\n/).map(x => x.split('\n').map(l => l.trim()).filter(Boolean));
  return blocks.map(lines => {
    const q = blankQ(), qt = []; let last = null;
    for (const l of lines) {
      let m;
      if ((m = l.match(/^(?:answer|ans|correct(?:\s*answer)?)\s*[:=\-]?\s*\(?([A-D])/i))) { q.ans = m[1].toUpperCase(); last = null; }
      else if ((m = l.match(/^\(?([A-D])\s*[).:\-]\s*(.+)/i))) { q[m[1].toLowerCase()] = m[2].trim(); last = m[1].toLowerCase(); }
      else if (last) q[last] += ' ' + l;           /* wrapped option line */
      else qt.push(l.replace(/^\d+\s*[).:\-]\s*/, ''));
    }
    q.q = qt.join(' '); return q;
  }).filter(q => q.q);
}
function bulkImport() {
  syncQ();
  const text = $('#bulk').value.trim(); if (!text) return;
  const out = parseQuestions(text);
  db.exam.questions = [...typedQs().filter(q => !isBlank(q)), ...out]; msg = out.length + ' questions added and saved. You can edit them below.'; autoSave(); render();
}
/* Import questions from an ordinary PDF (text-based, not scanned). Uses pdf.js, loaded once from cdnjs (needs internet). */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const loadPdfJs = () => new Promise((res, rej) => {
  if (window.pdfjsLib) return res(window.pdfjsLib);
  const s = document.createElement('script'); s.src = PDFJS;
  s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS.replace('pdf.min.js', 'pdf.worker.min.js'); res(pdfjsLib); };
  s.onerror = () => rej(new Error('offline')); document.head.appendChild(s);
});
async function pdfText(file) {
  const lib = await loadPdfJs(), pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; let out = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = (await (await pdf.getPage(p)).getTextContent()).items, rows = {};
    items.forEach(it => { if (!it.str.trim()) return; const y = Math.round(it.transform[5] / 3); (rows[y] = rows[y] || []).push(it); });
    Object.keys(rows).map(Number).sort((a, b) => b - a).forEach(y => { out += rows[y].sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim() + '\n'; });
  }
  return out;
}
async function importPdfQuestions(inp) {
  const f = inp.files[0]; if (!f) return;
  try {
    syncQ(); const out = parseQuestions(await pdfText(f));
    if (!out.length) { msg = 'No questions found in that PDF. Questions must look like: 1. Question text, A) ..., B) ..., C) ..., D) ..., Answer: A. Scanned (image) PDFs are not supported.'; return render(); }
    db.exam.questions = [...typedQs().filter(q => !isBlank(q)), ...out]; autoSave();
    msg = out.length + ' questions added from the PDF. Check each one and set the correct answers below' + (out.some(q => q.ans === 'A') ? ' (answers default to A when the PDF has no "Answer:" line).' : '.');
  } catch (err) { msg = err && err.message === 'offline' ? 'Could not load the PDF reader. Connect to the internet once and try again.' : 'Could not read that PDF.'; }
  render();
}
function questionsTab() {
  if (!typedQs().length) db.exam.questions = Array.from({ length: 20 }, blankQ);
  const cards = typedQs().map((q, i) => `<div class="card"><div class="qhead"><h3>Question ${i + 1}</h3><button class="bad" onclick="delQ(${i})">Delete</button></div>
    <label>Question</label><textarea id="qt${i}" rows="2">${esc(q.q)}</textarea><div class="grid">
    ${['a', 'b', 'c', 'd'].map(k => `<div><label>Option ${k.toUpperCase()}</label><input id="q${k}${i}" value="${esc(q[k])}"></div>`).join('')}
    <div><label>Correct answer (admin only)</label><select id="qk${i}">${'ABCD'.split('').map(L => `<option ${q.ans === L ? 'selected' : ''}>${L}</option>`).join('')}</select></div></div></div>`).join('');
  return `<div class="card"><h2>Exam Questions (${typedQs().length} slots)</h2><p class="sub">Fill in your questions. Empty slots are ignored when you save. Students see one question per page and never see the correct answers.</p>
    <div class="msg ${/^(Saved|\d+ questions added)/.test(msg) ? 'good' : ''}">${esc(msg)}</div>
    <button onclick="saveQs()" class="ok">💾 Save questions</button> <button class="sec" onclick="addN(1)">➕ Add 1</button> <button class="sec" onclick="addN(5)">➕ Add 5 more</button>
    <label style="margin-top:18px">📋 Or paste many questions at once (blank line between questions)</label>
    <textarea id="bulk" rows="5" placeholder="1. What is the capital of France?&#10;A) Paris&#10;B) Rome&#10;C) Madrid&#10;D) Berlin&#10;Answer: A"></textarea><br><br><button class="sec" onclick="bulkImport()">Add pasted questions</button>
    <label style="margin-top:18px">📄 Import questions from a PDF (1. question / A) B) C) D) / Answer: A)</label><input type="file" accept=".pdf,application/pdf" onchange="importPdfQuestions(this)"></div>
    ${cards}`;
}
function studentsTab() {
  const rows = db.students.map(s => `<tr><td><div class="person"><div class="avatar">${esc(initials(s.name))}</div>${esc(s.name)}</div></td><td>${esc(s.user)}</td>
    <td><span class="tag ${s.active ? 'on' : 'off'}">${s.active ? 'Active' : 'Deactivated'}</span></td><td>
    <button class="sec" onclick="editStudent('${s.id}')">Edit</button>
    <button class="sec" onclick="resetPass('${s.id}')">Reset password</button>
    <button class="${s.active ? 'bad' : 'ok'}" onclick="toggleStudent('${s.id}')">${s.active ? 'Deactivate' : 'Reactivate'}</button>
    <button class="bad" onclick="delStudent('${s.id}')">Delete</button></td></tr>`).join('');
  return `<div class="card"><h2>Create Student Account</h2><p class="sub">Give each student a username and password.</p><div class="grid">
    <div><label>Full name</label><input id="sname"></div><div><label>Username</label><input id="suser"></div>
    <div><label>Password</label><input id="spass"></div></div><div class="msg">${esc(msg)}</div>
    <br><button onclick="addStudent()">➕ Add student</button></div>
    <div class="card tbl"><h2>Students (${db.students.length})</h2><table><thead><tr><th>Name</th><th>Username</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No students yet. Add the first one above.</td></tr>'}</tbody></table></div>`;
}
function addStudent() {
  const name = $('#sname').value.trim(), user = $('#suser').value.trim(), pass = $('#spass').value;
  if (!name || !user || !pass) { msg = 'All fields are required.'; return render(); }
  if (user === db.admin.user || db.students.some(s => s.user === user)) { msg = 'Username already taken.'; return render(); }
  db.students.push({ id: 's' + Date.now(), name, user, pass, active: true }); save(); msg = ''; render();
}
const stu = id => db.students.find(s => s.id === id);
function editStudent(id) {
  const s = stu(id), n = prompt('Student name:', s.name); if (n === null) return;
  const u = prompt('Username:', s.user); if (u === null) return;
  if (!n.trim() || !u.trim() || db.students.some(x => x.user === u.trim() && x.id !== id)) return alert('Invalid or duplicate values.');
  s.name = n.trim(); s.user = u.trim(); save(); render();
}
function resetPass(id) { const p = prompt('New password for ' + stu(id).name + ':'); if (p) { stu(id).pass = p; save(); alert('Password updated.'); } }
function toggleStudent(id) { const s = stu(id); s.active = !s.active; if (s.active) { delete db.attempts[id]; s.ver = (s.ver || 0) + 1; } save(); render(); }
function delStudent(id) {
  if (!confirm('Delete this student and their results?')) return;
  db.students = db.students.filter(s => s.id !== id); db.results = db.results.filter(r => r.studentId !== id); delete db.attempts[id]; save(); render();
}
function resultsTab() {
  const rows = db.results.map(r => { const s = stu(r.studentId), p = r.total ? Math.round(r.score / r.total * 100) : 0;
    return `<tr><td><div class="person"><div class="avatar">${esc(initials(s?.name || '?'))}</div>${esc(s?.name || 'Deleted')}</div></td><td><b>${r.score} / ${r.total}</b></td><td><div class="bar"><i style="width:${p}%"></i></div></td><td>${p}%</td><td>${new Date(r.submittedAt).toLocaleString()}</td></tr>`; }).join('');
  return `<div class="card tbl"><h2>Student Results</h2><p class="sub">Scores are marked automatically against the answer key.</p>
  <label>📥 Import answer files from students (you can select many)</label><input type="file" accept=".pdf,application/pdf" multiple onchange="importResults(this)"><br><table><thead><tr><th>Student</th><th>Score</th><th>Progress</th><th>%</th><th>Submitted</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No results yet.</td></tr>'}</tbody></table></div>`;
}

/* ---------- Student ---------- */
function studentView() {
  const s = stu(session.id);
  if (!s) { setSession(null); return loginView(); }
  const e = db.exam, res = db.results.find(r => r.studentId === s.id), att = db.attempts[s.id], st = startTime();
  const wrap = b => shell(b, s.name, s.name);
  const state = (ico, t, p, extra = '') => wrap(`<div class="card state"><div class="ico">${ico}</div><h2>${t}</h2><p class="muted">${p}</p>${extra}</div>`);
  if (att) {
    if (Date.now() >= att.start + e.duration * 60000) { submitExam(true, true); return studentView(); }
    return wrap(`<div class="exambar"><div><h2>${esc(e.title || 'Examination')}</h2><span class="muted">One question at a time. You must answer every question before you can submit.</span></div><div class="timer" id="timer">--:--:--</div></div>
      <div class="exam solo"><div class="card sheet" id="qpanel"></div></div>`);
  }
  if (res && !s.active) return wrap(`<div class="card state"><div class="ico">✅</div><h2>Exam submitted</h2><p class="muted">Your answers were received. Your teacher will share your result.</p><p class="note">Your account is deactivated for further attempts until the administrator reactivates it.</p><button onclick="exportResult()">📤 Download my answer file</button><p class="muted">If the administrator is on another device, send them this file.</p></div>`);
  if (!s.active) return state('🔒', 'Account deactivated', 'Please contact your administrator.');
  const miss = missing(e);
  if (miss.length || !st) return state('🗓️', 'No exam available', miss.length ? `This device has an incomplete exam. Missing: <b>${miss.join(', ')}</b>.<br>Ask your administrator to save these settings, export a <b>new</b> exam package, and load it here.` : 'No examination has been scheduled yet.');
  const now = Date.now(), end = st + e.duration * 60000;
  const chips = `<div class="chips"><span class="chip">📅 ${new Date(st).toLocaleString()}</span><span class="chip">⏱️ ${e.duration} minutes</span><span class="chip">❓ ${qCount()} questions</span></div>`;
  const top = body => wrap(`<div class="card welcome"><h2>Hello, ${esc(s.name)} 👋</h2><p class="sub">${esc(e.title || 'Examination')}</p>${chips}${body}</div>`);
  if (now < st) return top('<p>The exam opens in <b id="cd" style="font-size:1.4rem"></b></p>');
  if (now > end) return top('<p><b>The exam window has closed.</b></p>');
  return top('<p>Once you start, the timer cannot be paused. You can only take this exam once.</p><br><button class="start" onclick="startExam()">Start exam →</button>');
}
function afterStudentRender() {
  const s = stu(session.id), att = db.attempts[s.id];
  if (att) {
    refreshQ();
    if (false) pdfGet().then(b => { if (b && $('#pdf')) { pdfUrl = URL.createObjectURL(b); $('#pdf').src = pdfUrl + (db.exam.pagePerQ ? '#page=' + (cur + 1) : ''); $('#pdfnote').innerHTML = `PDF not showing? <a href="${pdfUrl}" target="_blank">Open it in a new tab</a>`; } else if ($('#pdfnote')) $('#pdfnote').textContent = 'Question paper not found.'; });
    const tick = () => { const left = att.start + db.exam.duration * 60000 - Date.now();
      const t = $('#timer'); if (!t) return; t.textContent = fmt(left); t.classList.toggle('low', left < 300000);
      if (left <= 0) submitExam(true); };
    tick(); timer = setInterval(tick, 1000);
  } else if ($('#cd')) {
    const tick = () => { const left = startTime() - Date.now(); if (left <= 0) return render(); $('#cd').textContent = fmt(left); };
    tick(); timer = setInterval(tick, 1000);
  }
}
function prog(att) { const n = qCount(), d = Object.keys(att.answers).length; if ($('#bar')) { $('#bar').style.width = (n ? d / n * 100 : 0) + '%'; $('#cnt').textContent = d + ' of ' + n + ' answered'; } }
function qPanel(att) {
  const n = qCount(), t = liveQs()[cur], ans = att.answers[cur], done = Object.keys(att.answers).length;
  const opts = t ? ['a', 'b', 'c', 'd'].filter(k => t[k]).map(k => { const L = k.toUpperCase(); return `<button class="opt ${ans === L ? 'sel' : ''}" onclick="pick('${L}')"><b>${L}</b><span>${esc(t[k])}</span></button>`; }).join('')
    : `<div class="letters">${'ABCD'.split('').map(L => `<button class="opt ${ans === L ? 'sel' : ''}" onclick="pick('${L}')"><b>${L}</b></button>`).join('')}</div>`;
  const pal = Array.from({ length: n }, (_, i) => `<span class="${i === cur ? 'cur' : ''} ${att.answers[i] ? 'done' : ''}" onclick="go(${i})">${i + 1}</span>`).join('');
  return `<div class="bar"><i style="width:${n ? done / n * 100 : 0}%"></i></div><p class="muted">${done} of ${n} answered</p>
    <h3>Question ${cur + 1} <span class="muted">of ${n}</span></h3>
    ${t ? `<p class="qtext">${esc(t.q)}</p>` : '<p class="muted">Read this question in the question paper, then choose your answer.</p>'}
    <div class="opts">${opts}</div>
    <div class="nav"><button class="sec" onclick="go(cur-1)" ${cur === 0 ? 'disabled' : ''}>← Previous</button>${cur >= n - 1
      ? '<button class="ok" onclick="trySubmit()">Submit exam ✓</button>' : '<button onclick="go(cur+1)">Next →</button>'}</div>
    <div class="pal">${pal}</div>`;
}
function refreshQ() { const att = db.attempts[session.id]; if (att && $('#qpanel')) $('#qpanel').innerHTML = qPanel(att); }
function go(i) { if (i < 0 || i >= qCount()) return; cur = i; refreshQ(); if (db.exam.pagePerQ && pdfUrl && $('#pdf')) $('#pdf').src = pdfUrl + '#page=' + (cur + 1); }
function pick(L) { const att = db.attempts[session.id]; att.answers[cur] = L; save(); refreshQ(); }
function startExam() { cur = 0; db.attempts[session.id] = { start: Date.now(), answers: {} }; save(); render(); }
/* Students must answer every question before they can submit (time running out still auto-submits). */
function trySubmit() {
  const att = db.attempts[session.id]; if (!att) return;
  const left = Array.from({ length: qCount() }, (_, i) => i).filter(i => !att.answers[i]);
  if (left.length) {
    alert('You must answer all questions before submitting.\n\nUnanswered: ' + left.map(i => i + 1).join(', '));
    return go(left[0]);
  }
  if (confirm('Submit your answers now?')) submitExam(false);
}
function submitExam(auto, quiet) {
  const id = session.id, att = db.attempts[id], key = db.exam.key; if (!att) return;
  let score = null; if (key) { score = 0; [...key].forEach((k, i) => { if (att.answers[i] === k) score++; }); }
  db.results = db.results.filter(r => r.studentId !== id);
  db.results.push({ studentId: id, answers: att.answers, score, total: qCount(), submittedAt: Date.now(), auto });
  delete db.attempts[id]; stu(id).active = false; save(); if (!quiet) render();
}

/* ---------- Share between devices ---------- */
async function exportPackage() {
  const pdf = await pdfGet();
  const m = missing(db.exam);
  if (m.length) return alert('Cannot export yet. Please fill in and save: ' + [...new Set(m)].join(', ') + '.');
  const e = { ...db.exam, count: qCount(), key: '', publish: false, questions: liveQs().map(q => ({ ...q, ans: '' })) };
  const students = await Promise.all(db.students.map(async s => ({ id: s.id, name: s.name, user: s.user, h: s.pass !== undefined ? await sha(s.pass) : s.h, active: s.active, ver: s.ver || 0 })));
  const lines = ['School: ' + db.school, 'Exam: ' + (e.title || '-'), 'Date: ' + e.date + '   Time: ' + e.time + '   Duration: ' + e.duration + ' min', 'Questions: ' + e.count, 'Students: ' + students.length, '',
    'This PDF is an exam package for the Online Examination Management System.', 'Load it on each student device with "Load an exam package". Do not edit it.', '', 'Student list:'];
  students.forEach((s, i) => lines.push((i + 1) + '. ' + s.name + '  (' + s.user + ')'));
  dl('exam-package.pdf', makePdf('Exam Package - ' + (e.title || db.school), lines, { v: 1, school: db.school, exam: e, students, pdf: pdf ? await b64(pdf) : '' }));
  alert('exam-package.pdf downloaded. Give it to your students.');
}
async function importPackage(inp) {
  const f = inp.files[0]; if (!f) return;
  if (!confirm('Load this exam package? It replaces the exam, school name and student list on this device.')) { inp.value = ''; return; }
  try {
    const d = await readPdfData(f); if (d.v !== 1 || !d.exam || !d.students) throw 0;
    if (d.pdf) await pdfPut(await (await fetch(d.pdf)).blob());
    const old = Object.fromEntries(db.students.map(x => [x.id, x]));
    db.school = d.school; db.exam = d.exam;
    db.students = d.students.map(x => {
      const o = old[x.id];
      if (o && (o.ver || 0) >= x.ver) return { ...x, active: o.active, ver: o.ver || 0 };
      delete db.attempts[x.id]; db.results = db.results.filter(r => r.studentId !== x.id);
      return x;
    });
    save(); alert('Exam package loaded. Log out now; students can sign in on this device.');
  } catch (err) { alert(err && err.message === 'no data' ? 'This PDF is not an exam package made by this system (it looks like an ordinary PDF).\n\nTo load the exam on this device, use the exam-package.pdf exported from the teacher computer.\nTo add questions from an ordinary PDF, go to the Questions tab and use "Import questions from a PDF".' : 'That is not a valid exam package PDF.'); }
  render();
}
function exportResult() {
  const r = db.results.find(x => x.studentId === session.id); if (!r) return;
  const s = stu(session.id), ans = Object.keys(r.answers).map(Number).sort((a, b) => a - b).map(i => (i + 1) + ': ' + r.answers[i]);
  const lines = ['Student: ' + s.name + '  (' + s.user + ')', 'Submitted: ' + new Date(r.submittedAt).toLocaleString(), 'Answered: ' + ans.length + ' of ' + (r.total || qCount()), '', 'Answers:'];
  for (let i = 0; i < ans.length; i += 8) lines.push(ans.slice(i, i + 8).join('    '));
  lines.push('', 'Give this PDF to the teacher. Do not edit it.');
  dl('answers-' + s.user + '.pdf', makePdf('Exam Answers - ' + s.name, lines, { v: 1, type: 'result', studentId: r.studentId, answers: r.answers, submittedAt: r.submittedAt }));
}
async function importResults(inp) {
  let n = 0;
  for (const f of inp.files) {
    try {
      const d = await readPdfData(f), st = stu(d.studentId);
      if (d.type !== 'result' || !st || !db.exam.key) continue;
      let score = 0; [...db.exam.key].forEach((k, i) => { if (d.answers[i] === k) score++; });
      db.results = db.results.filter(r => r.studentId !== d.studentId);
      db.results.push({ studentId: d.studentId, answers: d.answers, score, total: db.exam.key.length, submittedAt: d.submittedAt });
      st.active = false; delete db.attempts[d.studentId]; n++;
    } catch (err) { }
  }
  save(); alert(n + ' answer file(s) imported.'); render();
}

render();
