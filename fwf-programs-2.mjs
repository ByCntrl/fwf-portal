// Fight Wright Foundation: Sister Circle + Programs admin (Netlify Function)
//
// Separate from the walk portal function on purpose: nothing here reads or writes
// walk registrations, check-ins, or waivers.
//
// POST /api/fwfp1  { action: ... }
//   Member side (Sister Circle):  join, login, reset, me, rsvp, post, cheer, profile
//   Programs admin (Yolanda):     alogin, asetup, admin { op: ... }
//
// Uses the same environment variables as the walk portal: AIRTABLE_TOKEN, SESSION_SECRET (optional), ALLOWED_ORIGIN.

const BASE_ID = 'appB6LAkrhD5OUSUr';
const API = `https://api.airtable.com/v0/${BASE_ID}`;
const SITE = 'https://portal.fightwrightfoundation.org';
const PAGE = '/circle-v1.html';
const auth = () => ({ Authorization: `Bearer ${Netlify.env.get('AIRTABLE_TOKEN')}`, 'Content-Type': 'application/json' });

const MEMBERS = 'Circle Members', SESSIONS = 'Circle Sessions', RSVPS = 'Circle RSVPs', POSTS = 'Circle Posts', RES = 'Circle Resources';
const PADMINS = 'Program Admins', STAFF = 'Staff Logins';
const TYPES = ['Survivor', 'In Treatment', 'Caregiver', 'Family', 'Supporter'];
const CORNER_TYPES = ['Survivor', 'In Treatment'];

// ---------- Airtable helpers ----------
const q = s => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
async function listAll(table, { fields, filter, sort } = {}) {
  const out = []; let offset = '';
  do {
    const p = new URLSearchParams();
    (fields || []).forEach(f => p.append('fields[]', f));
    if (filter) p.set('filterByFormula', filter);
    if (sort) { p.set('sort[0][field]', sort[0]); p.set('sort[0][direction]', sort[1] || 'asc'); }
    if (offset) p.set('offset', offset);
    const r = await fetch(`${API}/${encodeURIComponent(table)}?${p}`, { headers: auth() });
    if (!r.ok) throw new Error(table + ' ' + r.status);
    const d = await r.json();
    (d.records || []).forEach(x => out.push({ id: x.id, _t: x.createdTime, ...x.fields }));
    offset = d.offset || '';
  } while (offset && out.length < 5000);
  return out;
}
const one = async (table, filter, fields) => {
  const p = new URLSearchParams({ filterByFormula: filter, maxRecords: '1' });
  (fields || []).forEach(f => p.append('fields[]', f));
  const r = await fetch(`${API}/${encodeURIComponent(table)}?${p}`, { headers: auth() });
  if (!r.ok) return null;
  const d = await r.json();
  return d.records && d.records[0] ? { id: d.records[0].id, ...d.records[0].fields } : null;
};
async function write(table, method, records) {
  const out = [];
  for (let i = 0; i < records.length; i += 10) {
    const r = await fetch(`${API}/${encodeURIComponent(table)}`, { method, headers: auth(), body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }) });
    if (!r.ok) throw new Error('save ' + table + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
    out.push(...(await r.json()).records);
  }
  return out;
}
const create = (t, fields) => write(t, 'POST', [{ fields }]).then(r => r[0]);
const patch = (t, id, fields) => write(t, 'PATCH', [{ id, fields }]).then(r => r[0]);
async function del(table, ids) {
  for (let i = 0; i < ids.length; i += 10) {
    const p = new URLSearchParams(); ids.slice(i, i + 10).forEach(id => p.append('records[]', id));
    const r = await fetch(`${API}/${encodeURIComponent(table)}?${p}`, { method: 'DELETE', headers: auth() });
    if (!r.ok) throw new Error('delete ' + r.status);
  }
}
async function upload(id, field, ph) {
  if (!ph || !ph.file || !/^image\/(jpeg|png|webp|gif)$/.test(ph.contentType || '') || ph.file.length > 7_000_000) return;
  await fetch(`https://content.airtable.com/v0/${BASE_ID}/${id}/${encodeURIComponent(field)}/uploadAttachment`, {
    method: 'POST', headers: auth(), body: JSON.stringify({ contentType: ph.contentType, file: ph.file, filename: (ph.filename || 'photo.jpg').slice(0, 80) })
  });
}
const img = a => (Array.isArray(a) && a[0] ? (a[0].thumbnails?.large?.url || a[0].url) : '');
const sel = v => (v && typeof v === 'object' && v.name) ? v.name : (v || '');

// ---------- Passwords and sessions ----------
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const okEmail = e => /^[^@\s"\\]+@[^@\s"\\]+\.[^@\s"\\]+$/.test(e);
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function hashPw(pw) { const salt = randHex(16), it = 210000; return `pbkdf2$${it}$${salt}$${await pbkdf2(pw, salt, it)}`; }
async function checkPw(pw, stored) {
  const [k, it, salt, h] = String(stored || '').split('$');
  if (k !== 'pbkdf2' || !salt || !h) return false;
  return same(await pbkdf2(pw, salt, Number(it)), h);
}
async function hmac(s) {
  const secret = Netlify.env.get('SESSION_SECRET') || ('fwf-session:' + Netlify.env.get('AIRTABLE_TOKEN'));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(s)));
}
const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
// Tokens are scoped: 'm' = Sister Circle member, 'a' = Programs admin. One can never be used as the other.
async function makeToken(kind, email, extra = {}) { const p = b64(JSON.stringify({ k: kind, e: email, x: Date.now() + 30 * 864e5, ...extra })); return p + '.' + await hmac('fwfp:' + p); }
// Main portal staff token (same format the walk portal uses), so one sign-in works everywhere.
async function mainToken(email) { const p = b64(JSON.stringify({ e: email, x: Date.now() + 30 * 864e5 })); return p + '.' + await hmac(p); }
async function readToken(t, kind) {
  const [p, sig] = String(t || '').split('.');
  if (!p || !sig || !same(await hmac('fwfp:' + p), sig)) return null;
  try { const d = JSON.parse(unb64(p)); return d.k === kind && d.x > Date.now() ? d : null; } catch { return null; }
}
// Shared sign in with lockout after 5 wrong tries.
async function signIn(table, rec, pw) {
  if (rec['Locked Until'] && new Date(rec['Locked Until']) > new Date()) return 'locked';
  if (!rec['Password Hash'] || !(await checkPw(pw, rec['Password Hash']))) {
    const n = (rec['Failed Sign Ins'] || 0) + 1;
    await patch(table, rec.id, n >= 5 ? { 'Failed Sign Ins': 0, 'Locked Until': new Date(Date.now() + 15 * 6e4).toISOString() } : { 'Failed Sign Ins': n });
    return 'bad';
  }
  await patch(table, rec.id, { 'Failed Sign Ins': 0, 'Locked Until': null, 'Last Sign In': new Date().toISOString() });
  return 'ok';
}
const wkey = e => { let h = 5381; for (const c of String(e || '').toLowerCase()) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const clip = (v, n) => String(v || '').trim().slice(0, n);
const phone = v => String(v || '').replace(/[^\d+()\-. ]/g, '').trim().slice(0, 30) || null;

// ---------- Sister Circle: members ----------
const MF = ['Name', 'Email', 'Phone', 'Member Type', 'Status', 'Survivors Corner', 'Show Type', 'Greeting', 'About Me', 'Photo', 'Password Hash', 'Failed Sign Ins', 'Locked Until', 'Reset Code', 'Reset Sent At', 'Last Sign In', 'Joined At'];
const memberBy = email => one(MEMBERS, `LOWER({Email})="${q(email)}"`, MF);

async function join(b) {
  const email = clip(b.email, 200).toLowerCase(), name = clip(b.name, 80), pw = String(b.password || '');
  if (!name) return [400, { error: 'Please add your name.' }];
  if (!okEmail(email)) return [400, { error: 'Please check your email address.' }];
  if (pw.length < 8 || pw.length > 200) return [400, { error: 'Your password needs at least 8 characters.' }];
  if (!b.agree) return [400, { error: 'Please agree to the circle guidelines.' }];
  const type = TYPES.includes(b.type) ? b.type : 'Supporter';
  const found = await memberBy(email);
  if (found && found['Password Hash']) return [409, { error: 'You already have a Sister Circle account. Sign in instead.' }];
  const fields = { Name: name, Email: email, Phone: phone(b.phone), 'Member Type': type, 'Show Type': b.showType !== false, Greeting: clip(b.greeting, 20) || 'sis', 'About Me': clip(b.about, 600), 'Agreed To Guidelines': true, 'Password Hash': await hashPw(pw), Status: (found && sel(found.Status)) || 'Pending' };
  if (found) await patch(MEMBERS, found.id, fields); else await create(MEMBERS, fields);
  return [200, { ok: true, pending: fields.Status !== 'Approved', name }];
}

async function login(b) {
  const email = clip(b.email, 200).toLowerCase(), pw = String(b.password || '');
  const bad = [401, { error: 'That email and password do not match.' }];
  if (!okEmail(email) || !pw) return bad;
  const m = await memberBy(email);
  const r = m && m['Password Hash'] ? await signIn(MEMBERS, m, pw) : 'none';
  if (r !== 'ok') {
    // Staff and program admins can use the same Sister Circle sign-in. They land in the staff view.
    const a = await alogin(b);
    if (a[0] === 200) {
      const main = a[1].full ? await mainToken(email) : '';
      return [200, { staff: true, token: a[1].token, name: a[1].name, full: a[1].full, email, main }];
    }
    if (r === 'locked' || a[0] === 429) return [429, { error: 'Too many tries. Wait 15 minutes, then try again.' }];
    return bad;
  }
  const st = sel(m.Status);
  if (st === 'Pending') return [403, { pending: true, name: m.Name || '', error: 'Your request is waiting for approval. You will be able to sign in as soon as Yolanda welcomes you in.' }];
  if (st !== 'Approved') return [403, { error: 'Your membership is paused. Please reach out to Yolanda.' }];
  return [200, { token: await makeToken('m', email) }];
}

// Members get a reset link from Yolanda (no email service is connected yet).
async function reset(b) {
  const code = String(b.code || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) return [400, { error: 'This link is not valid. Ask Yolanda for a new one.' }];
  const m = await one(MEMBERS, `{Reset Code}="${code}"`, MF);
  const fresh = m && m['Reset Sent At'] && Date.now() - new Date(m['Reset Sent At']) < 14 * 864e5;
  if (!m || !fresh) return [400, { error: 'This link has expired or was already used. Ask Yolanda for a new one.' }];
  if (!b.password) return [200, { name: m.Name || '', email: m.Email }];
  const pw = String(b.password);
  if (pw.length < 8 || pw.length > 200) return [400, { error: 'Use at least 8 characters.' }];
  const st = sel(m.Status) === 'Paused' ? 'Paused' : 'Approved';
  await patch(MEMBERS, m.id, { 'Password Hash': await hashPw(pw), 'Reset Code': '', 'Failed Sign Ins': 0, 'Locked Until': null, Status: st, 'Approved At': m['Approved At'] || new Date().toISOString(), 'Last Sign In': new Date().toISOString() });
  return [200, { token: await makeToken('m', m.Email.toLowerCase()) }];
}

async function meMember(b) {
  const t = await readToken(b.token, 'm');
  const m = t && await memberBy(t.e);
  if (!m || sel(m.Status) !== 'Approved') return [null, [401, { error: 'Please sign in again.' }]];
  return [m, null];
}
const corner = m => !!m['Survivors Corner'];
const pubSession = (s, rs, myEmail) => {
  const going = rs.filter(r => sel(r.Status) !== 'Cancelled' && (r.Session || []).includes(s.id));
  const mine = going.find(r => String(r.Email || '').toLowerCase() === myEmail);
  return { id: s.id, topic: s.Topic || '', date: s.Date || '', speaker: s.Speaker || '', location: s.Location || '', format: sel(s.Format), link: mine ? (s['Join Link'] || '') : '', details: s.Details || '', recap: s.Recap || '', status: sel(s.Status) || 'Upcoming', going: going.reduce((n, r) => n + 1 + (r.Guests || 0), 0), mine: mine ? { guests: mine.Guests || 0 } : null };
};
async function feed(m) {
  const email = String(m.Email).toLowerCase(), key = wkey(email);
  const [members, sessions, rsvps, posts, res] = await Promise.all([
    listAll(MEMBERS, { fields: ['Name', 'Email', 'Member Type', 'Show Type', 'Photo', 'Status'], filter: `{Status}="Approved"` }),
    listAll(SESSIONS, { fields: ['Topic', 'Date', 'Speaker', 'Location', 'Format', 'Join Link', 'Details', 'Recap', 'Status'], sort: ['Date', 'asc'] }),
    listAll(RSVPS, { fields: ['Email', 'Session', 'Status', 'Guests'] }),
    listAll(POSTS, { fields: ['Body', 'Kind', 'Space', 'Title', 'Author Name', 'Author Email', 'Pinned', 'Cheers', 'Cheered By', 'Photo', 'Posted At'], filter: corner(m) ? 'NOT({Hidden})' : `AND(NOT({Hidden}),{Space}!="Survivors Corner")`, sort: ['Posted At', 'desc'] }),
    listAll(RES, { fields: ['Title', 'Link', 'Description', 'Category'], filter: '{Active}' })
  ]);
  const who = new Map(members.map(x => [String(x.Email || '').toLowerCase(), x]));
  const now = Date.now();
  const live = sessions.filter(s => sel(s.Status) !== 'Cancelled');
  const next = live.find(s => s.Date && new Date(s.Date).getTime() > now - 4 * 36e5);
  const later = live.filter(s => s !== next && s.Date && new Date(s.Date).getTime() > now).slice(0, 3);
  const past = live.filter(s => s.Date && new Date(s.Date).getTime() <= now - 4 * 36e5 && (s.Recap || '').trim()).reverse().slice(0, 6);
  const P = p => {
    const a = who.get(String(p['Author Email'] || '').toLowerCase());
    const by = String(p['Cheered By'] || '').split(/\s+/).filter(Boolean);
    return { id: p.id, kind: sel(p.Kind) || 'Post', space: sel(p.Space) || 'All Sisters', title: p.Title || '', body: p.Body || '', name: p['Author Name'] || (a && a.Name) || '', photo: a ? img(a.Photo) : '', type: a && a['Show Type'] ? sel(a['Member Type']) : '', at: p['Posted At'] || p._t, pinned: !!p.Pinned, cheers: by.length, cheered: by.includes(key), mine: String(p['Author Email'] || '').toLowerCase() === email, pic: img(p.Photo) };
  };
  const all = posts.map(P);
  return {
    me: { name: m.Name || '', first: String(m.Name || '').split(' ')[0], greeting: m.Greeting || 'sis', type: sel(m['Member Type']), showType: !!m['Show Type'], about: m['About Me'] || '', phone: m.Phone || '', photo: img(m.Photo), corner: corner(m) },
    next: next ? pubSession(next, rsvps, email) : null,
    later: later.map(s => pubSession(s, rsvps, email)),
    past: past.map(s => ({ id: s.id, topic: s.Topic || '', date: s.Date, speaker: s.Speaker || '', recap: s.Recap || '' })),
    updates: all.filter(p => p.kind === 'Update').slice(0, 8),
    spotlight: all.find(p => p.kind === 'Spotlight') || null,
    board: all.filter(p => p.kind === 'Post' && p.space === 'All Sisters').slice(0, 60),
    cornerBoard: corner(m) ? all.filter(p => p.kind === 'Post' && p.space === 'Survivors Corner').slice(0, 60) : [],
    resources: res.map(r => ({ title: r.Title || '', link: r.Link || '', desc: r.Description || '', cat: r.Category || '' })),
    count: members.length
  };
}

async function member(b) {
  const [m, err] = await meMember(b);
  if (err) return err;
  const email = String(m.Email).toLowerCase();
  if (b.action === 'rsvp') {
    const s = /^rec[A-Za-z0-9]{14}$/.test(b.session) ? b.session : '';
    if (!s) return [400, { error: 'Pick a gathering.' }];
    const cur = (await listAll(RSVPS, { fields: ['Email', 'Session'], filter: `LOWER({Email})="${q(email)}"` })).find(r => (r.Session || []).includes(s));
    const fields = { Name: m.Name || '', Email: email, Session: [s], Status: b.going === false ? 'Cancelled' : 'Going', Guests: Math.max(0, Math.min(5, Number(b.guests) || 0)) };
    if (cur) await patch(RSVPS, cur.id, fields); else await create(RSVPS, fields);
  } else if (b.action === 'post') {
    const body = clip(b.body, 2000);
    if (!body) return [400, { error: 'Write something first.' }];
    const space = b.space === 'Survivors Corner' && corner(m) ? 'Survivors Corner' : 'All Sisters';
    const rec = await create(POSTS, { Body: body, Kind: 'Post', Space: space, 'Author Name': m.Name || '', 'Author Email': email, Cheers: 0 });
    await upload(rec.id, 'Photo', b.photo);
  } else if (b.action === 'cheer') {
    const id = /^rec[A-Za-z0-9]{14}$/.test(b.id) ? b.id : '';
    const g = id && await fetch(`${API}/${encodeURIComponent(POSTS)}/${id}`, { headers: auth() });
    if (!g || !g.ok) return [404, { error: 'Post not found.' }];
    const p = (await g.json()).fields;
    if (sel(p.Space) === 'Survivors Corner' && !corner(m)) return [403, { error: 'Not allowed.' }];
    const k = wkey(email);
    let by = String(p['Cheered By'] || '').split(/\s+/).filter(Boolean);
    by = by.includes(k) ? by.filter(x => x !== k) : [...by, k];
    await patch(POSTS, id, { 'Cheered By': by.join(' '), Cheers: by.length });
  } else if (b.action === 'unpost') {
    const id = /^rec[A-Za-z0-9]{14}$/.test(b.id) ? b.id : '';
    const g = id && await fetch(`${API}/${encodeURIComponent(POSTS)}/${id}`, { headers: auth() });
    if (!g || !g.ok) return [404, { error: 'Post not found.' }];
    if (String((await g.json()).fields['Author Email'] || '').toLowerCase() !== email) return [403, { error: 'You can only remove your own posts.' }];
    await patch(POSTS, id, { Hidden: true });
  } else if (b.action === 'profile') {
    const f = b.fields || {};
    await patch(MEMBERS, m.id, { Phone: phone(f.phone), 'About Me': clip(f.about, 600), Greeting: clip(f.greeting, 20) || 'sis', 'Show Type': !!f.showType });
    if (b.photo) { await patch(MEMBERS, m.id, { Photo: [] }); await upload(m.id, 'Photo', b.photo); }
  }
  return [200, await feed(b.action === 'profile' ? await memberBy(email) : m)];
}

// ---------- Programs admin (Yolanda + full staff) ----------
const AF = ['Name', 'Email', 'Active', 'Password Hash', 'Setup Code', 'Setup Sent At', 'Failed Sign Ins', 'Locked Until', 'Last Sign In', 'Phone'];
async function alogin(b) {
  const email = clip(b.email, 200).toLowerCase(), pw = String(b.password || '');
  const bad = [401, { error: 'That email and password do not match.' }];
  if (!okEmail(email) || !pw) return bad;
  // Program admins first, then full staff (Tyler, Sheena) can use their existing staff password.
  for (const [table, full] of [[PADMINS, false], [STAFF, true]]) {
    const a = await one(table, `AND({Active},LOWER({Email})="${q(email)}")`, AF);
    if (!a || !a['Password Hash']) continue;
    const r = await signIn(table, a, pw);
    if (r === 'locked') return [429, { error: 'Too many tries. Wait 15 minutes, then try again.' }];
    if (r === 'ok') return [200, { token: await makeToken('a', email, { f: full ? 1 : 0 }), name: a.Name || '', full }];
  }
  return bad;
}
// One sign-in: staff who are signed in on the main portal (Staff Logins) get Programs access
// without a second password. The main portal token is checked with the same server secret.
async function sso(b) {
  const [p, sig] = String(b.token || '').split('.');
  const no = [401, { error: 'Please sign in on the main portal.' }];
  if (!p || !sig || !same(await hmac(p), sig)) return no;
  let d; try { d = JSON.parse(unb64(p)); } catch { return no; }
  if (!d || d.k || !d.e || !(d.x > Date.now())) return no;
  const email = String(d.e).toLowerCase();
  const s = await one(STAFF, `AND({Active},LOWER({Email})="${q(email)}")`, ['Name']);
  if (!s) return no;
  return [200, { token: await makeToken('a', email, { f: 1 }), name: s.Name || '', full: true }];
}
async function asetup(b) {
  const code = String(b.code || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) return [400, { error: 'This setup link is not valid.' }];
  const a = await one(PADMINS, `AND({Active},{Setup Code}="${code}")`, AF);
  const fresh = a && a['Setup Sent At'] && Date.now() - new Date(a['Setup Sent At']) < 14 * 864e5;
  if (!a || !fresh || !a.Email) return [400, { error: 'This setup link has expired or was already used. Ask Tyler for a new one.' }];
  if (!b.password) return [200, { name: a.Name || '', email: a.Email }];
  const pw = String(b.password);
  if (pw.length < 8 || pw.length > 200) return [400, { error: 'Use at least 8 characters.' }];
  await patch(PADMINS, a.id, { 'Password Hash': await hashPw(pw), 'Setup Code': '', 'Failed Sign Ins': 0, 'Locked Until': null, 'Last Sign In': new Date().toISOString() });
  return [200, { token: await makeToken('a', a.Email.toLowerCase(), { f: 0 }), name: a.Name || '', full: false }];
}

// What the admin may edit, table by table. Anything not listed is ignored.
const EDIT = {
  sessions: [SESSIONS, ['Topic', 'Date', 'Speaker', 'Location', 'Format', 'Join Link', 'Details', 'Recap', 'Status']],
  resources: [RES, ['Title', 'Link', 'Description', 'Category', 'Active']],
  members: [MEMBERS, ['Name', 'Phone', 'Member Type', 'Status', 'Survivors Corner', 'Show Type', 'Greeting', 'About Me', 'Last Reached Out']],
  posts: [POSTS, ['Title', 'Body', 'Kind', 'Space', 'Pinned', 'Hidden']],
  rsvps: [RSVPS, ['Attended', 'Status', 'Guests']],
  partners: ['Care Bag Partners', ['Partner', 'Type', 'Status', 'Contact Name', 'Contact Email', 'Contact Phone', 'Address', 'Show Publicly', 'Notes']],
  deliveries: ['Care Bag Deliveries', ['Summary', 'Date', 'Partner', 'Bags', 'Delivered By', 'Sponsored By', 'Notes']],
  inventory: ['Care Bag Inventory', ['Item', 'Per Bag', 'In Stock', 'Reorder At', 'Notes']],
  assembly: ['Care Bag Assembly Days', ['Title', 'Date', 'Location', 'Volunteers Needed', 'Bags Goal', 'Bags Packed', 'Notes']],
  sponsors: ['Sponsors', ['Sponsor Name', 'Tier', 'Website', 'Commitment', 'Amount Received', 'Payment Status', 'Program', 'Year', 'Contact Name', 'Contact Email', 'Contact Phone', 'Benefits Promised', 'Benefits Delivered', 'Thank You Sent', 'Renewal Date', 'Show on Walk Day', 'Notes', 'Stage', 'Ask Amount', 'Next Follow-up']]
};
const IMPORTABLE = new Set(['sponsors', 'partners', 'deliveries', 'inventory', 'assembly', 'sessions', 'resources', 'members']);
const DELETABLE = new Set(['sessions', 'resources', 'partners', 'deliveries', 'inventory', 'assembly', 'sponsors']);
const NUMS = new Set(['Ask Amount', 'Commitment', 'Amount Received', 'Year', 'Bags', 'Per Bag', 'In Stock', 'Reorder At', 'Volunteers Needed', 'Bags Goal', 'Bags Packed', 'Guests']);
const BOOLS = new Set(['Active', 'Survivors Corner', 'Show Type', 'Pinned', 'Hidden', 'Attended', 'Show Publicly', 'Show on Walk Day']);
const EMAILS = new Set(['Contact Email']);
function cleanFields(kind, f) {
  const [, allowed] = EDIT[kind]; const out = {};
  for (const k of allowed) {
    if (!(k in (f || {}))) continue;
    let v = f[k];
    if (BOOLS.has(k)) v = !!v;
    else if (NUMS.has(k)) { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); v = String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : n; }
    else if (k === 'Program') v = (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
    else if (EMAILS.has(k)) v = okEmail(String(v || '').trim()) ? String(v).trim() : null;
    else if (k === 'Contact Phone' || k === 'Phone') v = phone(v);
    else if (k === 'Website' || k === 'Link' || k === 'Join Link') { v = String(v || '').trim(); if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; v = v.slice(0, 500) || null; }
    else { v = String(v ?? '').trim().slice(0, 5000); if (v === '') v = null; }
    out[k] = v;
  }
  return out;
}

async function adminLoad(full) {
  const T = k => EDIT[k][0];
  const [members, sessions, rsvps, posts, res, partners, deliveries, inventory, assembly, sponsors, admins] = await Promise.all([
    listAll(MEMBERS, { fields: ['Name', 'Email', 'Phone', 'Member Type', 'Status', 'Survivors Corner', 'Show Type', 'About Me', 'Photo', 'Joined At', 'Approved At', 'Last Sign In', 'Password Hash', 'Last Reached Out'] }),
    listAll(SESSIONS, { sort: ['Date', 'desc'] }),
    listAll(RSVPS, { fields: ['Name', 'Email', 'Session', 'Status', 'Guests', 'Attended', '2-Day Reminder Sent', 'Day-Of Reminder Sent'] }),
    listAll(POSTS, { fields: ['Body', 'Kind', 'Space', 'Title', 'Author Name', 'Pinned', 'Hidden', 'Cheers', 'Posted At'], sort: ['Posted At', 'desc'] }),
    listAll(RES),
    listAll(T('partners')), listAll(T('deliveries'), { sort: ['Date', 'desc'] }), listAll(T('inventory')), listAll(T('assembly'), { sort: ['Date', 'desc'] }),
    listAll(T('sponsors')),
    full ? listAll(PADMINS, { fields: ['Name', 'Email', 'Phone', 'Active', 'Password Hash', 'Setup Sent At', 'Last Sign In'] }) : Promise.resolve([])
  ]);
  const flat = r => { const o = { id: r.id }; for (const [k, v] of Object.entries(r)) { if (k === 'id' || k === '_t' || k === 'Password Hash') continue; o[k] = Array.isArray(v) && v[0] && v[0].url ? img(v) : (v && typeof v === 'object' && !Array.isArray(v) && v.name ? v.name : v); } return o; };
  return {
    full,
    members: members.map(m => ({ ...flat(m), ready: !!m['Password Hash'] })),
    sessions: sessions.map(flat), rsvps: rsvps.map(flat), posts: posts.slice(0, 300).map(flat), resources: res.map(flat),
    partners: partners.map(flat), deliveries: deliveries.map(flat), inventory: inventory.map(flat), assembly: assembly.map(flat),
    sponsors: sponsors.map(flat),
    admins: admins.map(a => ({ id: a.id, name: a.Name || '', email: a.Email || '', phone: a.Phone || '', active: !!a.Active, ready: !!a['Password Hash'], sent: a['Setup Sent At'] || '', last: a['Last Sign In'] || '' }))
  };
}

async function admin(b) {
  const t = await readToken(b.token, 'a');
  if (!t) return [401, { error: 'Please sign in again.' }];
  const full = !!t.f;
  const who = await one(full ? STAFF : PADMINS, `AND({Active},LOWER({Email})="${q(t.e)}")`, ['Name']);
  if (!who) return [401, { error: 'Please sign in again.' }];
  const op = b.op, id = /^rec[A-Za-z0-9]{14}$/.test(b.id || '') ? b.id : '';
  if (op === 'save') {
    if (!EDIT[b.kind]) return [400, { error: 'Unknown list.' }];
    const fields = cleanFields(b.kind, b.fields);
    if (b.kind === 'deliveries' && !fields.Summary) fields.Summary = `${fields.Bags || 0} bags to ${fields.Partner || 'partner'}`;
    if (b.kind === 'sponsors' && !id && !fields['Sponsor Name']) return [400, { error: 'Add the sponsor name.' }];
    if (b.kind === 'members' && fields.Status === 'Approved') fields['Approved At'] = new Date().toISOString();
    const rec = id ? await patch(EDIT[b.kind][0], id, fields) : await create(EDIT[b.kind][0], fields);
    if (b.kind === 'sponsors' && b.logo) { await patch('Sponsors', rec.id, { Logo: [] }); await upload(rec.id, 'Logo', b.logo); }
  } else if (op === 'delete') {
    if (!DELETABLE.has(b.kind) || !id) return [400, { error: 'That cannot be deleted here.' }];
    await del(EDIT[b.kind][0], [id]);
  } else if (op === 'import') {
    // Smart upload: the page reads the spreadsheet, decides which list each sheet belongs to,
    // and sends batches here. Each row is cleaned with the same rules as the edit forms.
    const batches = Array.isArray(b.batches) ? b.batches : [{ kind: 'sponsors', rows: b.rows }];
    const done = {};
    let total = 0;
    for (const bt of batches.slice(0, 12)) {
      const kind = IMPORTABLE.has(bt.kind) ? bt.kind : null;
      if (!kind) continue;
      let rows = (Array.isArray(bt.rows) ? bt.rows : []).slice(0, 1000);
      if (kind === 'members') {
        const have = new Set((await listAll(MEMBERS, { fields: ['Email'] })).map(m => String(m.Email || '').toLowerCase()));
        rows = rows.map(r => {
          const email = clip(r.Email, 200).toLowerCase();
          if (!okEmail(email) || have.has(email) || !clip(r.Name, 80)) return null;
          have.add(email);
          const f = cleanFields('members', r);
          f.Email = email;
          f['Member Type'] = TYPES.includes(f['Member Type']) ? f['Member Type'] : 'Supporter';
          f.Status = 'Approved'; f['Approved At'] = new Date().toISOString(); f['Show Type'] = true; f.Greeting = f.Greeting || 'sis';
          f['Survivors Corner'] = CORNER_TYPES.includes(f['Member Type']);
          return f;
        }).filter(Boolean);
      } else {
        rows = rows.map(r => cleanFields(kind, r));
        if (kind === 'deliveries') rows.forEach(f => { if (!f.Summary) f.Summary = `${f.Bags || 0} bags to ${f.Partner || 'partner'}`; });
        const key = { sponsors: 'Sponsor Name', partners: 'Partner', inventory: 'Item', resources: 'Title' }[kind];
        rows = rows.filter(f => key ? f[key] : Object.values(f).some(v => v != null && v !== ''));
      }
      if (rows.length) await write(EDIT[kind][0], 'POST', rows.map(fields => ({ fields })));
      done[kind] = (done[kind] || 0) + rows.length; total += rows.length;
    }
    if (!total) return [400, { error: 'Nothing new was found to import.' }];
    return [200, { done, data: await adminLoad(full), name: who.Name || '' }];
  } else if (op === 'post') {
    const body = clip(b.body, 4000);
    if (!body) return [400, { error: 'Write the message first.' }];
    const kind = ['Update', 'Spotlight'].includes(b.kind) ? b.kind : 'Update';
    const rec = await create(POSTS, { Title: clip(b.title, 120), Body: body, Kind: kind, Space: b.space === 'Survivors Corner' ? 'Survivors Corner' : 'All Sisters', 'Author Name': who.Name || 'Fight Wright', 'Author Email': t.e, Pinned: !!b.pinned, Cheers: 0 });
    await upload(rec.id, 'Photo', b.photo);
  } else if (op === 'approve') {
    if (!id) return [400, { error: 'Pick a member.' }];
    const g = await fetch(`${API}/${encodeURIComponent(MEMBERS)}/${id}`, { headers: auth() });
    const m = g.ok ? (await g.json()).fields : {};
    await patch(MEMBERS, id, { Status: 'Approved', 'Approved At': new Date().toISOString(), 'Survivors Corner': b.corner == null ? CORNER_TYPES.includes(sel(m['Member Type'])) : !!b.corner });
  } else if (op === 'resetLink') {
    if (!id) return [400, { error: 'Pick a member.' }];
    const code = randHex(16);
    await patch(MEMBERS, id, { 'Reset Code': code, 'Reset Sent At': new Date().toISOString() });
    return [200, { link: `${SITE}${PAGE}#reset=${code}` }];
  } else if (op === 'addAdmin' || op === 'adminLink' || op === 'adminActive') {
    if (!full) return [403, { error: 'Only full staff can manage admin access.' }];
    if (op === 'adminActive') { if (!id) return [400, { error: 'Pick a person.' }]; await patch(PADMINS, id, { Active: !!b.active }); }
    else {
      let rid = id;
      if (op === 'addAdmin') {
        const email = clip(b.email, 200).toLowerCase();
        if (!clip(b.name, 80) || !okEmail(email)) return [400, { error: 'Add a name and a valid email.' }];
        const found = await one(PADMINS, `LOWER({Email})="${q(email)}"`, ['Name']);
        rid = found ? found.id : (await create(PADMINS, { Name: clip(b.name, 80), Email: email, Phone: phone(b.phone), Active: true })).id;
        if (found) await patch(PADMINS, rid, { Name: clip(b.name, 80), Phone: phone(b.phone), Active: true });
      }
      if (!rid) return [400, { error: 'Pick a person.' }];
      const code = randHex(16);
      await patch(PADMINS, rid, { 'Setup Code': code, 'Setup Sent At': new Date().toISOString() });
      return [200, { link: `${SITE}${PAGE}#admin-setup=${code}`, data: await adminLoad(full) }];
    }
  } else if (op !== 'load') return [400, { error: 'Unknown action.' }];
  return [200, { data: await adminLoad(full), name: who.Name || '' }];
}

export default async (request) => {
  const cors = { 'Access-Control-Allow-Origin': Netlify.env.get('ALLOWED_ORIGIN') || '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    const a = b.action;
    const r = a === 'join' ? await join(b)
      : a === 'login' ? await login(b)
      : a === 'reset' ? await reset(b)
      : ['me', 'rsvp', 'post', 'cheer', 'unpost', 'profile'].includes(a) ? await member(b)
      : a === 'alogin' ? await alogin(b)
      : a === 'asetup' ? await asetup(b)
      : a === 'sso' ? await sso(b)
      : a === 'admin' ? await admin(b)
      : [400, { error: 'Unknown action' }];
    return json(r[1], r[0]);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Please try again.' }, 502);
  }
};

export const config = { path: '/api/fwfp2' };
