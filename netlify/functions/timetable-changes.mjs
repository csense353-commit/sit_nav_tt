import { getStore } from '@netlify/blobs';

const VALID_SECTIONS = new Set(['G', 'H']);
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

export default async (req) => {
  const store = getStore({ name: 'timetable-changes', consistency: 'strong' });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const sec = (url.searchParams.get('section') || '').toUpperCase();

    if (sec) {
      if (!VALID_SECTIONS.has(sec)) return json(400, { error: 'Invalid section' });
      const data = (await store.get(sec, { type: 'json' })) || {
        section: sec,
        version: 0,
        changes: { base: null, alts: [] }
      };
      return json(200, data);
    }

    const [gData, hData] = await Promise.all([
      store.get('G', { type: 'json' }),
      store.get('H', { type: 'json' })
    ]);

    return json(200, {
      G: gData || { section: 'G', version: 0, changes: { base: null, alts: [] } },
      H: hData || { section: 'H', version: 0, changes: { base: null, alts: [] } }
    });
  }

  if (req.method === 'POST') {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }

    const sec = String(payload?.section || '').toUpperCase();
    if (!VALID_SECTIONS.has(sec)) return json(400, { error: 'Invalid section' });

    const prev = (await store.get(sec, { type: 'json' })) || {
      section: sec,
      version: 0,
      changes: { base: null, alts: [] }
    };

    const nextDoc = {
      section: sec,
      version: Number(prev.version || 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: String(payload?.updatedBy || 'Teacher'),
      changes: {
        base: payload?.changes?.base ?? null,
        alts: Array.isArray(payload?.changes?.alts) ? payload.changes.alts : []
      }
    };

    await store.setJSON(sec, nextDoc);
    return json(200, nextDoc);
  }

  return json(405, { error: 'Method not allowed' });
};
