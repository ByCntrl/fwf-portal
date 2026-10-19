// Fight Wright Foundation Portal: Airtable relay (Netlify Function)
//
// GET  /api/airtable          Public portal content (settings, teams, shifts, sponsors,
//                             announcements, impact levels, approved admin team).
//                             Only whitelisted, non-private fields are ever returned.
// POST /api/airtable          { table, fields }            Save a submission.
// POST /api/airtable          { action:'team', fields, photo } Admin team profile with photo.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   AIRTABLE_TOKEN  personal access token, scopes data.records:read and data.records:write,
//                   access limited to the "Fight Wright Foundation Portal" base
//   ALLOWED_ORIGIN  https://portal.fightwrightfoundation.org

const BASE_ID = 'appB6LAkrhD5OUSUr';
const API = `https://api.airtable.com/v0/${BASE_ID}`;

const WRITABLE = new Set([
  'Volunteers', 'Hours Log', 'Waivers', 'Survivor Stories', 'Community Posts', 'Shift Signups'
]);
const UPSERT_ON = { 'Volunteers': ['Email'] };

const auth = () => ({ Authorization: `Bearer ${Netlify.env.get('AIRTABLE_TOKEN')}`, 'Content-Type': 'application/json' });

async function list(table, { fields, filter, sort, max } = {}) {
  const p = new URLSearchParams();
  (fields || []).forEach(f => p.append('fields[]', f));
  if (filter) p.set('filterByFormula', filter);
  if (max) p.set('maxRecords', String(max));
  if (sort) { p.set('sort[0][field]', sort[0]); p.set('sort[0][direction]', sort[1] || 'asc'); }
  const r = await fetch(`${API}/${encodeURIComponent(table)}?${p}`, { headers: auth() });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.records || []).map(x => ({ id: x.id, ...x.fields }));
}
const img = a => (Array.isArray(a) && a[0] ? (a[0].thumbnails?.large?.url || a[0].url) : '');

async function content() {
  const [settings, teams, shifts, sponsors, ann, impact, staff, booths, vendors, posts] = await Promise.all([
    list('Portal Settings', { fields: ['Donorbox Campaign URL', 'Shop URL', 'Waiver Text', 'Photo Release Text', 'Waiver Version', 'Festival Map'], max: 1 }),
    list('Teams', { fields: ['Team Name'], filter: '{Active}', sort: ['Team Name'] }),
    list('Shifts', { fields: ['Shift Name', 'Start', 'End', 'Location', 'Slots', 'Filled', 'Arrival Note'], filter: "IS_AFTER({End}, DATEADD(NOW(), -1, 'days'))", sort: ['Start'] }),
    list('Sponsors', { fields: ['Sponsor Name', 'Tier', 'Logo', 'Website'], filter: '{Show on Walk Day}' }),
    list('Announcements', { fields: ['Title', 'Message', 'Sent At', 'Audience'], sort: ['Sent At', 'desc'], max: 5 }),
    list('Impact Levels', { fields: ['Amount', 'What It Funds'], sort: ['Amount'] }),
    list('Admin Team', { fields: ['Full Name', 'Role in Organization', 'Photo', 'Bio'], filter: '{Show on Portal}', sort: ['Full Name'] }),
    list('Booths', { fields: ['Booth Number', 'Area'], filter: '{Active}', sort: ['Booth Number'] }),
    list('Vendors', { fields: ['Business Name', 'Category', 'Description', 'Booth Number', 'Website', 'Instagram', 'Facebook', 'TikTok', 'Logo', 'Show on Map'], sort: ['Booth Number'] }),
    list('Community Posts', { fields: ['Type', 'Title', 'Body', 'Posted By', 'For Team', 'Posted At'], filter: "AND(NOT({Hidden}),OR({Type}='Cheer',{Type}='Why I Fight'))", sort: ['Posted At', 'desc'], max: 80 })
  ]);
  const taken = new Set(vendors.map(v => v['Booth Number']).filter(n => n != null));
  const s = settings[0] || {};
  return {
    settings: { donorbox: s['Donorbox Campaign URL'] || '', shop: s['Shop URL'] || '', waiver: s['Waiver Text'] || '', photoRelease: s['Photo Release Text'] || '', version: s['Waiver Version'] || '' },
    teams: teams.map(t => t['Team Name']).filter(Boolean),
    shifts: shifts.filter(x => x['Shift Name'] && x.Start && x.End).map(x => ({ id: x.id, name: x['Shift Name'], start: x.Start, end: x.End, place: x.Location || '', slots: x.Slots || 0, filled: x.Filled || 0, note: x['Arrival Note'] || '' })),
    sponsors: sponsors.map(x => [x['Sponsor Name'] || '', x.Tier || 'Community', img(x.Logo), x.Website || '']),
    announcements: ann.filter(a => !a.Audience || a.Audience === 'Everyone').map(a => [a.Title || '', a.Message || '', a['Sent At'] || '']),
    impact: impact.filter(i => i.Amount).map(i => [i.Amount, (i['What It Funds'] || '').replace(/\s*\(confirm with FWF\)/i, '')]),
    team: staff.map(x => ({ name: x['Full Name'] || '', role: x['Role in Organization'] || '', photo: img(x.Photo), bio: x.Bio || '' })),
    map: img(s['Festival Map']),
    booths: booths.filter(b => b['Booth Number'] != null).map(b => ({ n: b['Booth Number'], area: b.Area || '', taken: taken.has(b['Booth Number']) })),
    posts: posts.filter(x => x.Body && !/Not for public sharing/i.test(x.Body)).map(x => ({ id: x.id, type: x.Type === 'Cheer' ? 'cheer' : 'why', to: String(x.Title || '').replace(/^(Cheer for|I fight for)\s*/i, ''), team: x['For Team'] || '', body: x.Body, by: x['Posted By'] || '', at: x['Posted At'] || '' })),
    vendors: vendors.filter(v => v['Show on Map'] && v['Business Name']).map(v => ({ name: v['Business Name'], cat: v.Category || '', desc: v.Description || '', booth: v['Booth Number'] ?? null, web: v.Website || '', ig: v.Instagram || '', fb: v.Facebook || '', tt: v.TikTok || '', logo: img(v.Logo) }))
  };
}

// Every page of a table (Airtable returns 100 records per page).
async function listAll(table, { fields, filter } = {}) {
  const out = []; let offset = '';
  do {
    const p = new URLSearchParams();
    (fields || []).forEach(f => p.append('fields[]', f));
    if (filter) p.set('filterByFormula', filter);
    if (offset) p.set('offset', offset);
    const r = await fetch(`${API}/${encodeURIComponent(table)}?${p}`, { headers: auth() });
    if (!r.ok) throw new Error('Airtable ' + r.status);
    const d = await r.json();
    (d.records || []).forEach(x => out.push({ id: x.id, ...x.fields }));
    offset = d.offset || '';
  } while (offset);
  return out;
}
const num = v => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

// ---------- Staff sign in (Staff Logins table) ----------
// Passwords are stored only as PBKDF2 hashes. A signed session token (30 days) is
// returned on sign in and checked, along with the Active box, on every admin call.
const STAFF = 'Staff Logins';
const SITE = 'https://portal.fightwrightfoundation.org';
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
async function makeToken(email) { const p = b64(JSON.stringify({ e: email, x: Date.now() + 30 * 864e5 })); return p + '.' + await hmac(p); }
// Letter links: each team's 501(c)(3) letter has a private link signed with the server secret.
const letterSig = async team => (await hmac('letter:' + String(team || '').trim().toLowerCase())).slice(0, 24);
async function readToken(t) {
  const [p, sig] = String(t || '').split('.');
  if (!p || !sig || !same(await hmac(p), sig)) return null;
  try { const d = JSON.parse(unb64(p)); return d.x > Date.now() ? d.e : null; } catch { return null; }
}
const staffBy = async filter => (await list(STAFF, { fields: ['Name', 'Email', 'Active', 'Password Hash', 'Setup Code', 'Setup Sent At', 'Failed Sign Ins', 'Locked Until'], filter, max: 1 }))[0];
const patchStaff = (id, fields) => fetch(`${API}/${encodeURIComponent(STAFF)}`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ records: [{ id, fields }], typecast: true }) });

async function staffLogin(body) {
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200), pw = String(body.password || '');
  const bad = { status: 401, data: { error: 'That email and password do not match.' } };
  if (!okEmail(email) || !pw) return bad;
  const s = await staffBy(`AND({Active},LOWER({Email})="${email}")`);
  if (!s) return bad;
  if (s['Locked Until'] && new Date(s['Locked Until']) > new Date()) return { status: 429, data: { error: 'Too many tries. Wait 15 minutes, then try again.' } };
  if (!s['Password Hash']) return { status: 401, data: { error: 'You have not created a password yet. Ask an admin to send you a setup link.' } };
  if (!(await checkPw(pw, s['Password Hash']))) {
    const n = (s['Failed Sign Ins'] || 0) + 1;
    await patchStaff(s.id, n >= 5 ? { 'Failed Sign Ins': 0, 'Locked Until': new Date(Date.now() + 15 * 6e4).toISOString() } : { 'Failed Sign Ins': n });
    return bad;
  }
  await patchStaff(s.id, { 'Failed Sign Ins': 0, 'Locked Until': null, 'Last Sign In': new Date().toISOString() });
  return { status: 200, data: { token: await makeToken(email), name: s.Name || '', email } };
}
async function staffSetup(body) {
  const code = String(body.code || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) return { status: 400, data: { error: 'This setup link is not valid. Ask an admin for a new one.' } };
  const s = await staffBy(`AND({Active},{Setup Code}="${code}")`);
  const fresh = s && s['Setup Sent At'] && Date.now() - new Date(s['Setup Sent At']) < 14 * 864e5;
  if (!s || !fresh || !s.Email) return { status: 400, data: { error: 'This setup link has expired or was already used. Ask an admin for a new one.' } };
  if (!body.password) return { status: 200, data: { name: s.Name || '', email: s.Email.toLowerCase() } };
  const pw = String(body.password);
  if (pw.length < 8 || pw.length > 200) return { status: 400, data: { error: 'Use at least 8 characters.' } };
  await patchStaff(s.id, { 'Password Hash': await hashPw(pw), 'Setup Code': '', 'Failed Sign Ins': 0, 'Locked Until': null, 'Last Sign In': new Date().toISOString() });
  const email = s.Email.toLowerCase();
  return { status: 200, data: { token: await makeToken(email), name: s.Name || '', email } };
}
async function staffOps(body, me) {
  if (body.op === 'staff') {
    const rows = await listAll(STAFF, { fields: ['Name', 'Email', 'Phone', 'Active', 'Password Hash', 'Setup Sent At', 'Last Sign In'] });
    return { status: 200, data: { staff: rows.filter(r => r.Email).map(r => ({ id: r.id, name: r.Name || '', email: r.Email, phone: r.Phone || '', active: !!r.Active, ready: !!r['Password Hash'], sent: r['Setup Sent At'] || '', last: r['Last Sign In'] || '' })).sort((a, b) => a.name.localeCompare(b.name)) } };
  }
  if (body.op === 'addStaff') {
    const name = String(body.name || '').trim().slice(0, 100), email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const phone = String(body.phone || '').replace(/[^\d+()\-. ]/g, '').trim().slice(0, 30);
    if (!name || !okEmail(email)) return { status: 400, data: { error: 'Enter a name and a valid email.' } };
    const found = await staffBy(`LOWER({Email})="${email}"`);
    const r = await fetch(`${API}/${encodeURIComponent(STAFF)}`, { method: found ? 'PATCH' : 'POST', headers: auth(), body: JSON.stringify({ records: [found ? { id: found.id, fields: { Name: name, Active: true, ...(phone ? { Phone: phone } : {}) } } : { fields: { Name: name, Email: email, Active: true, ...(phone ? { Phone: phone } : {}) } }], typecast: true }) });
    if (!r.ok) return { status: 502, data: { error: 'Could not save.' } };
    const d = await r.json();
    return { status: 200, data: { id: d.records[0].id } };
  }
  if (body.op === 'profile' || body.op === 'saveProfile') {
    const T = 'Admin Team';
    const rows = await list(T, { fields: ['Full Name', 'Role in Organization', 'Bio', 'Phone', 'Email', 'Photo', 'Show on Portal', 'Submitted At'], filter: `LOWER(TRIM({Email}))="${me}"`, sort: ['Submitted At', 'desc'], max: 1 });
    const cur = rows[0];
    if (body.op === 'profile') {
      return { status: 200, data: { profile: cur ? { name: (cur['Full Name'] || '').trim(), role: (cur['Role in Organization'] || '').trim(), bio: cur.Bio || '', phone: cur.Phone || '', photo: img(cur.Photo), shown: !!cur['Show on Portal'] } : null } };
    }
    const f = body.fields || {};
    const fields = { 'Full Name': String(f.name || '').trim().slice(0, 100), 'Role in Organization': String(f.role || '').trim().slice(0, 100), Bio: String(f.bio || '').slice(0, 1200), Phone: String(f.phone || '').replace(/[^\d+()\-. ]/g, '').trim().slice(0, 30) || null, Email: me, 'Submitted At': new Date().toISOString(), 'Show on Portal': true };
    if (!fields['Full Name']) return { status: 400, data: { error: 'Enter your name.' } };
    const ph = body.photo;
    const newPhoto = ph && ph.file && /^image\/(jpeg|png|webp)$/.test(ph.contentType) && ph.file.length < 7_000_000;
    if (newPhoto && cur) fields.Photo = [];
    const r = await fetch(`${API}/${encodeURIComponent(T)}`, { method: cur ? 'PATCH' : 'POST', headers: auth(), body: JSON.stringify({ records: [cur ? { id: cur.id, fields } : { fields }], typecast: true }) });
    if (!r.ok) return { status: 502, data: { error: 'Could not save. Please try again.' } };
    const id = (await r.json()).records[0].id;
    if (newPhoto) {
      const u = await fetch(`https://content.airtable.com/v0/${BASE_ID}/${id}/Photo/uploadAttachment`, { method: 'POST', headers: auth(), body: JSON.stringify({ contentType: ph.contentType, file: ph.file, filename: (ph.filename || 'photo.jpg').slice(0, 80) }) });
      if (!u.ok) return { status: 502, data: { error: 'Your details saved, but the photo did not upload. Try the photo again.' } };
    }
    return { status: 200, data: { ok: true } };
  }
  if (body.op === 'posts') {
    const rows = await list('Community Posts', { fields: ['Type', 'Title', 'Body', 'Posted By', 'For Team', 'Posted At', 'Hidden'], filter: "OR({Type}='Cheer',{Type}='Why I Fight')", sort: ['Posted At', 'desc'], max: 100 });
    return { status: 200, data: { posts: rows.map(x => ({ id: x.id, type: x.Type || '', title: x.Title || '', team: x['For Team'] || '', body: x.Body || '', by: x['Posted By'] || '', at: x['Posted At'] || '', hidden: !!x.Hidden })) } };
  }
  if (body.op === 'hidePost') {
    const id = String(body.id || '');
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return { status: 400, data: { error: 'Missing post.' } };
    const r = await fetch(`${API}/${encodeURIComponent('Community Posts')}`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ records: [{ id, fields: { Hidden: !!body.hidden } }] }) });
    return r.ok ? { status: 200, data: { ok: true } } : { status: 502, data: { error: 'Could not update. Try again.' } };
  }
  if (body.op === 'staffLink' || body.op === 'staffActive') {
    const id = String(body.id || '');
    if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return { status: 400, data: { error: 'Missing person.' } };
    const g = await fetch(`${API}/${encodeURIComponent(STAFF)}/${id}`, { headers: auth() });
    if (!g.ok) return { status: 404, data: { error: 'Not found.' } };
    const rec = (await g.json()).fields || {};
    if (body.op === 'staffActive') {
      if (String(rec.Email || '').toLowerCase() === me) return { status: 400, data: { error: 'You cannot turn off your own access.' } };
      await patchStaff(id, { Active: !!body.active });
      return { status: 200, data: { ok: true } };
    }
    if (!rec.Active || !rec.Email) return { status: 400, data: { error: 'Turn on their access first.' } };
    const code = randHex(16);
    await patchStaff(id, { 'Setup Code': code, 'Setup Sent At': new Date().toISOString() });
    return { status: 200, data: { link: `${SITE}/?setup=${code}`, name: rec.Name || '', email: rec.Email } };
  }
  return null;
}

// Admin console: every team, its leaders and contact details. Requires a staff session.
async function admin(body) {
  const me = await readToken(body.token);
  const who = me && await staffBy(`AND({Active},LOWER({Email})="${me}")`);
  if (!who) return { status: 401, data: { error: 'Please sign in again.' } };
  if (body.op === 'me') return { status: 200, data: { name: who.Name || '', email: me } };
  const so = await staffOps(body, me);
  if (so) return so;
  if (body.op === 'saveTeam') {
    const f = body.fields || {};
    const name = String(f.team || '').trim().slice(0, 40);
    if (!name) return { status: 400, data: { error: 'Team name required' } };
    const q = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const found = await list('Teams', { fields: ['Team Name'], filter: `LOWER({Team Name})=LOWER("${q}")`, max: 1 });
    const s = v => String(v || '').trim().slice(0, 100);
    const em = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()) ? String(v).trim() : null;
    const ph = v => String(v || '').replace(/[^\d+()\-. ]/g, '').trim().slice(0, 30) || null;
    const fields = { 'Team Name': name, Active: true, 'Company Contact': s(f.contact), 'Contact Title': s(f.title), 'Contact Email': em(f.email), 'Contact Phone': ph(f.phone), 'Planned Leader': s(f.leader), 'Planned Leader Email': em(f.leaderEmail), 'Planned Leader Phone': ph(f.leaderPhone) };
    const rec = found.length ? { id: found[0].id, fields } : { fields };
    const r = await fetch(`${API}/Teams`, { method: found.length ? 'PATCH' : 'POST', headers: auth(), body: JSON.stringify({ records: [rec], typecast: true }) });
    return r.ok ? { status: 200, data: { ok: true } } : { status: 502, data: { error: 'Could not save team' } };
  }
  const [teams, vols] = await Promise.all([
    listAll('Teams', { fields: ['Team Name', 'Active', 'Company Contact', 'Contact Title', 'Contact Email', 'Contact Phone', 'Planned Leader', 'Planned Leader Email', 'Planned Leader Phone'] }),
    listAll('Volunteers', { fields: ['Full Name', 'Email', 'Phone', 'Role', 'Team', 'Liability Waiver Signed', 'Total Approved Hours', 'Joined'], filter: `AND({Team}!="",{Full Name}!="",{Email}!="")` })
  ]);
  const map = new Map();
  const get = n => { const k = n.toLowerCase(); if (!map.has(k)) map.set(k, { team: n, active: true, contact: '', title: '', contactEmail: '', contactPhone: '', leader: '', leaderEmail: '', leaderPhone: '', members: [] }); return map.get(k); };
  teams.forEach(t => { if (!t['Team Name']) return; const g = get(t['Team Name']); g.active = !!t.Active; g.contact = t['Company Contact'] || ''; g.title = t['Contact Title'] || ''; g.contactEmail = t['Contact Email'] || ''; g.leader = t['Planned Leader'] || ''; g.leaderEmail = t['Planned Leader Email'] || ''; g.contactPhone = t['Contact Phone'] || ''; g.leaderPhone = t['Planned Leader Phone'] || ''; });
  vols.forEach(v => get(v.Team).members.push({ name: v['Full Name'], email: v.Email || '', phone: v.Phone || '', role: v.Role || '', waiver: !!v['Liability Waiver Signed'], hours: num(v['Total Approved Hours']), joined: v.Joined || '' }));
  const list2 = [...map.values()].map(g => ({ ...g, members: g.members.sort((a, b) => (b.role === 'Team Leader') - (a.role === 'Team Leader') || a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.team.localeCompare(b.team));
  await Promise.all(list2.map(async g => { g.sig = await letterSig(g.team); }));
  return { status: 200, data: { teams: list2 } };
}

// New team names from registration get a Teams record so they show in the portal list.
async function ensureTeam(name, captain) {
  if (!name) return;
  try {
    const q = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const found = await list('Teams', { fields: ['Team Name'], filter: `LOWER({Team Name})=LOWER("${q}")`, max: 1 });
    if (found.length) return;
    await fetch(`${API}/Teams`, { method: 'POST', headers: auth(), body: JSON.stringify({ records: [{ fields: { 'Team Name': name, Captain: captain || '', Active: true } }], typecast: true }) });
  } catch (e) { /* never block a registration */ }
}

export default async (request) => {
  const cors = {
    'Access-Control-Allow-Origin': Netlify.env.get('ALLOWED_ORIGIN') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  const json = (obj, status = 200, extra = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

  if (request.method === 'GET') {
    try { return json(await content(), 200, { 'Cache-Control': 'public, max-age=60' }); }
    catch (e) { return json({ error: 'Could not load content' }, 502); }
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));

  // Admin team profile, with optional photo
  if (body.action === 'team') {
    const f = body.fields || {};
    const fields = clean({
      'Full Name': String(f.name || '').slice(0, 100), 'Role in Organization': String(f.role || '').slice(0, 100),
      Bio: String(f.bio || '').slice(0, 1200), Email: f.email, Phone: f.phone,
      'Submitted At': new Date().toISOString(), 'Show on Portal': false
    });
    if (!fields['Full Name']) return json({ error: 'Name required' }, 400);
    const r = await fetch(`${API}/${encodeURIComponent('Admin Team')}`, { method: 'POST', headers: auth(), body: JSON.stringify({ records: [{ fields }], typecast: true }) });
    const d = await r.json();
    if (!r.ok) return json({ error: d.error || 'Airtable error' }, 502);
    const id = d.records[0].id;
    const ph = body.photo;
    if (ph && ph.file && /^image\/(jpeg|png|webp)$/.test(ph.contentType) && ph.file.length < 7_000_000) {
      await fetch(`https://content.airtable.com/v0/${BASE_ID}/${id}/Photo/uploadAttachment`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ contentType: ph.contentType, file: ph.file, filename: (ph.filename || 'photo.jpg').slice(0, 80) })
      });
    }
    return json({ ok: true });
  }

  if (body.action === 'staffLogin' || body.action === 'staffSetup') {
    try { const r = await (body.action === 'staffLogin' ? staffLogin(body) : staffSetup(body)); return json(r.data, r.status); }
    catch (e) { return json({ error: 'Could not connect. Try again in a minute.' }, 502); }
  }

  if (body.action === 'admin') {
    try { const r = await admin(body); return json(r.data, r.status); }
    catch (e) { return json({ error: 'Could not load teams' }, 502); }
  }

  // Vendor booth profile: create or update by email, claim an open booth, optional logo.
  if (body.action === 'vendor') {
    const f = body.fields || {};
    const s = (v, n = 200) => String(v || '').trim().slice(0, n);
    const email = s(f.email).toLowerCase();
    if (!/^[^@\s"\\]+@[^@\s"\\]+\.[^@\s"\\]+$/.test(email)) return json({ error: 'Enter a valid email.' }, 400);
    if (!s(f.business)) return json({ error: 'Enter your business name.' }, 400);
    const booth = Number(f.booth);
    const [existing, boothRow, holder] = await Promise.all([
      list('Vendors', { fields: ['Email', 'Booth Number'], filter: `LOWER({Email})="${email}"`, max: 1 }),
      Number.isInteger(booth) ? list('Booths', { fields: ['Booth Number'], filter: `AND({Active},{Booth Number}=${booth})`, max: 1 }) : Promise.resolve([]),
      Number.isInteger(booth) ? list('Vendors', { fields: ['Email'], filter: `{Booth Number}=${booth}`, max: 1 }) : Promise.resolve([])
    ]);
    if (!Number.isInteger(booth) || !boothRow.length) return json({ error: 'Choose an open booth.' }, 400);
    if (holder.length && String(holder[0].Email || '').toLowerCase() !== email) return json({ error: 'That booth was just taken. Please choose another.', taken: true }, 409);
    const url = v => { v = s(v, 300); return !v ? '' : /^https?:\/\//i.test(v) ? v : 'https://' + v; };
    const fields = clean({
      'Business Name': s(f.business, 120), 'Contact Name': s(f.contact, 100), Email: email, Phone: s(f.phone, 40),
      Category: s(f.category, 60), Description: s(f.desc, 600), 'Booth Number': booth, Website: url(f.web),
      Instagram: s(f.ig, 100), Facebook: s(f.fb, 200), TikTok: s(f.tt, 100), 'Special Requests': s(f.notes, 600),
      'Submitted At': new Date().toISOString()
    });
    if (!existing.length) fields['Show on Map'] = true;
    else if (body.logo && body.logo.file) fields.Logo = [];
    const rec = existing.length ? { id: existing[0].id, fields } : { fields };
    const r = await fetch(`${API}/Vendors`, { method: existing.length ? 'PATCH' : 'POST', headers: auth(), body: JSON.stringify({ records: [rec], typecast: true }) });
    const d = await r.json();
    if (!r.ok) return json({ error: 'Could not save. Please try again.' }, 502);
    const id = d.records[0].id;
    const ph = body.logo;
    if (ph && ph.file && /^image\/(jpeg|png|webp)$/.test(ph.contentType) && ph.file.length < 7_000_000) {
      await fetch(`https://content.airtable.com/v0/${BASE_ID}/${id}/Logo/uploadAttachment`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ contentType: ph.contentType, file: ph.file, filename: (ph.filename || 'logo.png').slice(0, 80) })
      });
    }
    return json({ ok: true, booth });
  }

  // Public 501(c)(3) letter link: returns only what is printed on the letter.
  if (body.action === 'letter') {
    const team = String(body.team || '').trim().slice(0, 40), k = String(body.k || '');
    const bad = { error: 'This letter link is not valid. Please ask Fight Wright Foundation for a new one.' };
    if (!team || !k || !same(await letterSig(team), k)) return json(bad, 403);
    const q = team.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      const [rows, leads] = await Promise.all([
        list('Teams', { fields: ['Team Name', 'Company Contact', 'Contact Title', 'Contact Email', 'Planned Leader', 'Planned Leader Email'], filter: `LOWER({Team Name})=LOWER("${q}")`, max: 1 }),
        list('Volunteers', { fields: ['Full Name', 'Email'], filter: `AND(LOWER({Team})=LOWER("${q}"),{Role}="Team Leader",{Full Name}!="")`, max: 1 })
      ]);
      const t = rows[0], l = leads[0];
      if (!t) return json(bad, 404);
      return json({
        team: t['Team Name'], company: t['Team Name'], contact: t['Company Contact'] || '', title: t['Contact Title'] || '', contactEmail: t['Contact Email'] || '',
        leader: l ? l['Full Name'] : (t['Planned Leader'] || ''), leaderEmail: l ? (l.Email || '') : (t['Planned Leader Email'] || '')
      });
    } catch (e) { return json({ error: 'Could not load the letter. Try again in a minute.' }, 502); }
  }

  // Welcome Back: find a registration by email so returning people skip re-entering details.
  if (body.action === 'lookup') {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^@\s"\\]+@[^@\s"\\]+$/.test(email)) return json({ error: 'Email required' }, 400);
    const [rows, sups] = await Promise.all([
      list('Volunteers', { fields: ['Full Name', 'Role', 'Team', 'Liability Waiver Signed', 'Photo Release Signed', 'Walking For', 'Reminder Channels', 'Phone', 'Emergency Contact Name', 'Profile Photo'], filter: `LOWER({Email})="${email}"`, max: 1 }),
      list('Shift Signups', { fields: ['Shift', 'Status'], filter: `LOWER({Email})="${email}"` })
    ]);
    const v = rows[0];
    if (!v) {
      // A staff email with no registration: they get the full portal as staff.
      const st = await staffBy(`AND({Active},LOWER({Email})="${email}")`).catch(() => null);
      if (!st) return json({ found: false });
      const pf = (await list('Admin Team', { fields: ['Full Name', 'Photo', 'Submitted At'], filter: `LOWER(TRIM({Email}))="${email}"`, sort: ['Submitted At', 'desc'], max: 1 }))[0];
      return json({ found: false, staff: true, name: ((pf && pf['Full Name']) || st.Name || '').trim(), photo: pf ? img(pf.Photo) : '' });
    }
    // Private details (phone numbers, emergency contact, medical notes) are never sent back.
    // The phone only learns they are on file, so nothing is asked twice and nothing is erased.
    const shifts = [...new Set(sups.filter(x => x.Status !== 'Cancelled').flatMap(x => x.Shift || []))];
    return json({ found: true, name: v['Full Name'] || '', role: v.Role || 'Volunteer', team: v.Team || '', waiver: !!v['Liability Waiver Signed'], photoRel: !!v['Photo Release Signed'], for: v['Walking For'] || '', reminders: (v['Reminder Channels'] || []).length > 0, phoneOnFile: !!v.Phone, ecOnFile: !!v['Emergency Contact Name'], photo: img(v['Profile Photo']), shifts });
  }

  // Volunteer profile photo: replaces the photo on their registration.
  if (body.action === 'vphoto') {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200), ph = body.photo || {};
    if (!okEmail(email)) return json({ error: 'Email required' }, 400);
    if (!ph.file || !/^image\/(jpeg|png|webp)$/.test(ph.contentType) || ph.file.length > 7_000_000) return json({ error: 'Choose a JPG or PNG photo.' }, 400);
    try {
      const rows = await list('Volunteers', { fields: ['Email'], filter: `LOWER({Email})="${email}"`, max: 1 });
      if (!rows.length) return json({ error: 'We could not find your registration. Save your profile first.' }, 404);
      const id = rows[0].id;
      await fetch(`${API}/Volunteers`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ records: [{ id, fields: { 'Profile Photo': [] } }] }) });
      const u = await fetch(`https://content.airtable.com/v0/${BASE_ID}/${id}/fld3N9NX0S3c9Sjdr/uploadAttachment`, { method: 'POST', headers: auth(), body: JSON.stringify({ contentType: ph.contentType, file: ph.file, filename: (ph.filename || 'photo.jpg').slice(0, 80) }) });
      return u.ok ? json({ ok: true }) : json({ error: 'The photo did not upload. Please try again.' }, 502);
    } catch (e) { return json({ error: 'Could not connect. Try again in a minute.' }, 502); }
  }

  // Team leader roster: names, roles, waiver status, approved hours. No contact details.
  if (body.action === 'roster') {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    if (!/^[^@\s"\\]+@[^@\s"\\]+$/.test(email)) return json({ error: 'Email required' }, 400);
    const leaders = await list('Volunteers', { fields: ['Full Name', 'Team', 'Role'], filter: `AND(LOWER({Email})="${email}",{Role}="Team Leader")`, max: 1 });
    const lead = leaders[0];
    if (!lead || !lead.Team) return json({ error: 'Not a team leader' }, 403);
    const team = lead.Team;
    const q = team.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const rows = await list('Volunteers', { fields: ['Full Name', 'Role', 'Liability Waiver Signed', 'Total Approved Hours'], filter: `AND({Team}="${q}",{Full Name}!="")`, sort: ['Full Name'] });
    const hrs = v => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
    return json({ team, leader: lead['Full Name'] || '', members: rows.map(x => ({ name: x['Full Name'], role: x.Role || '', waiver: !!x['Liability Waiver Signed'], hours: hrs(x['Total Approved Hours']) })) });
  }

  const { table, fields } = body;
  if (!WRITABLE.has(table)) return json({ error: 'Table not allowed' }, 403);
  if (table === 'Volunteers' && fields && fields.Team) await ensureTeam(String(fields.Team).slice(0, 40), fields['Full Name']);
  if (!fields || typeof fields !== 'object') return json({ error: 'Missing fields' }, 400);
  const payload = { records: [{ fields: clean(fields) }], typecast: true };
  let method = 'POST';
  if (UPSERT_ON[table]) { payload.performUpsert = { fieldsToMergeOn: UPSERT_ON[table] }; method = 'PATCH'; }
  const r = await fetch(`${API}/${encodeURIComponent(table)}`, { method, headers: auth(), body: JSON.stringify(payload) });
  const d = await r.json();
  // A full registration (Status set) logs a row in Registrations, which sends the welcome email.
  if (r.ok && table === 'Volunteers' && fields.Status && fields.Email) {
    try {
      await fetch(`${API}/Registrations`, { method: 'POST', headers: auth(), body: JSON.stringify({ records: [{ fields: clean({
        Name: String(fields['Full Name'] || '').slice(0, 100), Email: fields.Email, Role: fields.Role, Team: fields.Team, 'Registered At': new Date().toISOString()
      }) }], typecast: true }) });
    } catch (e) { /* email is best effort */ }
  }
  return r.ok ? json({ ok: true, id: d.records?.[0]?.id }) : json({ error: d.error || 'Airtable error' }, 502);
};

export const config = { path: '/api/airtable' };
