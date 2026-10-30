// Fight Wright Foundation: walk photos for the portal sign-in screen (Netlify Function)
// GET /api/fwfphotos -> { photos: [url, ...] }
// Reads the "Walk Photos" field on the Portal Settings record in Airtable. Read only.

const BASE_ID = 'appB6LAkrhD5OUSUr';

export default async () => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' };
  try {
    const p = new URLSearchParams({ maxRecords: '1' });
    p.append('fields[]', 'Walk Photos');
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent('Portal Settings')}?${p}`, {
      headers: { Authorization: `Bearer ${Netlify.env.get('AIRTABLE_TOKEN')}` }
    });
    if (!r.ok) return new Response(JSON.stringify({ photos: [] }), { headers });
    const d = await r.json();
    const files = (d.records && d.records[0] && d.records[0].fields['Walk Photos']) || [];
    const photos = files
      .filter(f => /^image\//.test(f.type || ''))
      .slice(0, 6)
      .map(f => (f.thumbnails && f.thumbnails.large && f.thumbnails.large.url) || f.url);
    return new Response(JSON.stringify({ photos }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ photos: [] }), { headers });
  }
};

export const config = { path: '/api/fwfphotos' };
