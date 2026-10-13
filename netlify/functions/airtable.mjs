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
  const [settings, teams, shifts, sponsors, ann, impact, staff] = await Promise.all([
    list('Portal Settings', { fields: ['Donorbox Campaign URL', 'Shop URL', 'Waiver Text', 'Photo Release Text', 'Waiver Version'], max: 1 }),
    list('Teams', { fields: ['Team Name'], filter: '{Active}', sort: ['Team Name'] }),
    list('Shifts', { fields: ['Shift Name', 'Start', 'End', 'Location', 'Slots', 'Filled'], filter: "IS_AFTER({End}, DATEADD(NOW(), -1, 'days'))", sort: ['Start'] }),
    list('Sponsors', { fields: ['Sponsor Name', 'Tier', 'Logo', 'Website'], filter: '{Show on Walk Day}' }),
    list('Announcements', { fields: ['Title', 'Message', 'Sent At', 'Audience'], sort: ['Sent At', 'desc'], max: 5 }),
    list('Impact Levels', { fields: ['Amount', 'What It Funds'], sort: ['Amount'] }),
    list('Admin Team', { fields: ['Full Name', 'Role in Organization', 'Photo', 'Bio'], filter: '{Show on Portal}', sort: ['Full Name'] })
  ]);
  const s = settings[0] || {};
  return {
    settings: { donorbox: s['Donorbox Campaign URL'] || '', shop: s['Shop URL'] || '', waiver: s['Waiver Text'] || '', photoRelease: s['Photo Release Text'] || '', version: s['Waiver Version'] || '' },
    teams: teams.map(t => t['Team Name']).filter(Boolean),
    shifts: shifts.filter(x => x['Shift Name'] && x.Start && x.End).map(x => ({ id: x.id, name: x['Shift Name'], start: x.Start, end: x.End, place: x.Location || '', slots: x.Slots || 0, filled: x.Filled || 0 })),
    sponsors: sponsors.map(x => [x['Sponsor Name'] || '', x.Tier || 'Community', img(x.Logo), x.Website || '']),
    announcements: ann.filter(a => !a.Audience || a.Audience === 'Everyone').map(a => [a.Title || '', a.Message || '', a['Sent At'] || '']),
    impact: impact.filter(i => i.Amount).map(i => [i.Amount, (i['What It Funds'] || '').replace(/\s*\(confirm with FWF\)/i, '')]),
    team: staff.map(x => ({ name: x['Full Name'] || '', role: x['Role in Organization'] || '', photo: img(x.Photo), bio: x.Bio || '' }))
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

// Admin console: every team, its leaders and contact details. Requires ADMIN_CODE.
async function admin(body) {
  const code = Netlify.env.get('ADMIN_CODE') || '';
  if (code.length < 8 || String(body.code || '') !== code) return { status: 401, data: { error: 'Wrong passcode' } };
  if (body.op === 'saveTeam') {
    const f = body.fields || {};
    const name = String(f.team || '').trim().slice(0, 40);
    if (!name) return { status: 400, data: { error: 'Team name required' } };
    const q = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const found = await list('Teams', { fields: ['Team Name'], filter: `LOWER({Team Name})=LOWER("${q}")`, max: 1 });
    const s = v => String(v || '').trim().slice(0, 100);
    const em = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim()) ? String(v).trim() : null;
    const fields = { 'Team Name': name, Active: true, 'Company Contact': s(f.contact), 'Contact Title': s(f.title), 'Contact Email': em(f.email), 'Planned Leader': s(f.leader), 'Planned Leader Email': em(f.leaderEmail) };
    const rec = found.length ? { id: found[0].id, fields } : { fields };
    const r = await fetch(`${API}/Teams`, { method: found.length ? 'PATCH' : 'POST', headers: auth(), body: JSON.stringify({ records: [rec], typecast: true }) });
    return r.ok ? { status: 200, data: { ok: true } } : { status: 502, data: { error: 'Could not save team' } };
  }
  const [teams, vols] = await Promise.all([
    listAll('Teams', { fields: ['Team Name', 'Active', 'Company Contact', 'Contact Title', 'Contact Email', 'Planned Leader', 'Planned Leader Email'] }),
    listAll('Volunteers', { fields: ['Full Name', 'Email', 'Phone', 'Role', 'Team', 'Liability Waiver Signed', 'Total Approved Hours', 'Joined'], filter: `AND({Team}!="",{Full Name}!="",{Email}!="")` })
  ]);
  const map = new Map();
  const get = n => { const k = n.toLowerCase(); if (!map.has(k)) map.set(k, { team: n, active: true, contact: '', title: '', contactEmail: '', leader: '', leaderEmail: '', members: [] }); return map.get(k); };
  teams.forEach(t => { if (!t['Team Name']) return; const g = get(t['Team Name']); g.active = !!t.Active; g.contact = t['Company Contact'] || ''; g.title = t['Contact Title'] || ''; g.contactEmail = t['Contact Email'] || ''; g.leader = t['Planned Leader'] || ''; g.leaderEmail = t['Planned Leader Email'] || ''; });
  vols.forEach(v => get(v.Team).members.push({ name: v['Full Name'], email: v.Email || '', phone: v.Phone || '', role: v.Role || '', waiver: !!v['Liability Waiver Signed'], hours: num(v['Total Approved Hours']), joined: v.Joined || '' }));
  const list2 = [...map.values()].map(g => ({ ...g, members: g.members.sort((a, b) => (b.role === 'Team Leader') - (a.role === 'Team Leader') || a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.team.localeCompare(b.team));
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

  if (body.action === 'admin') {
    try { const r = await admin(body); return json(r.data, r.status); }
    catch (e) { return json({ error: 'Could not load teams' }, 502); }
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
