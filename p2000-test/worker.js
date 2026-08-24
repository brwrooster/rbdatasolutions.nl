/* ============================================================================
   P2000-scherm — Worker voor Cloudflare
   
   Config komt uit wrangler.toml (environment variables).
   Instellingen (capcodes, taken, ploegen) gaan naar KV (CONFIG namespace).
   ========================================================================== */

const PLOEG_ANKER = Date.UTC(2026, 5, 17);
const PLOEGEN = ['D', 'A', 'B', 'C'];
const TIJDZONE = 'Europe/Amsterdam';
const VALHALLA = 'https://valhalla1.openstreetmap.de';
const COSTING = 'auto';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pad = url.pathname;

    if (request.method === 'OPTIONS') return leeg204();

    try {
      if (pad === '/api/taken')   return await taken(request, env);
      if (pad === '/api/melding') return await melding(env);
      if (pad === '/api/pi')      return await pi(request, env);
      if (pad === '/api/route')   return await route(url);
      if (pad === '/api/status')  return json({ ok: true, post: env.POST_NAAM, tijd: new Date().toISOString() });
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }

    return json({ error: 'niet gevonden' }, 404);
  }
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }
  });
}
function leeg204() {
  return new Response(null, { status: 204, headers: CORS });
}

/* ================= Taken + instellingen ================= */

async function taken(request, env) {
  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'ongeldige inhoud' }, 400);

    const huidig = await leesInstellingen(env);
    const nieuw = {
      tasks:    Array.isArray(body.tasks)    ? body.tasks    : huidig.tasks,
      capcodes: Array.isArray(body.capcodes) ? body.capcodes : huidig.capcodes,
      posts:    body.posts    && typeof body.posts === 'object' ? body.posts : huidig.posts,
      units:    body.units    && typeof body.units === 'object' ? body.units : huidig.units,
      holdMin:  Number(body.holdMin) > 0 ? Number(body.holdMin) : huidig.holdMin
    };
    await env.CONFIG.put('instellingen', JSON.stringify(nieuw));
    return json({ ok: true });
  }

  const inst = await leesInstellingen(env);
  inst.tellingen = await leesTellingen(env);
  return json(inst);
}

async function leesInstellingen(env) {
  const opgeslagen = await env.CONFIG.get('instellingen', 'json');
  return Object.assign({}, {
    tasks: [],
    capcodes: [],
    posts: {},
    units: {},
    holdMin: 5
  }, opgeslagen || {});
}

/* ================= Feed (112-nu RSS) ================= */

async function melding(env) {
  const cache = caches.default;
  const sleutel = new Request('https://cache.intern/feed', { method: 'GET' });
  const uitCache = await cache.match(sleutel);
  if (uitCache) return uitCache;

  const antwoord = await fetch(env.FEED_URL, {
    headers: { 'user-agent': 'P2000-' + env.POST_NAAM }
  });
  if (!antwoord.ok) return json({ error: 'feed niet bereikbaar', meldingen: [] });

  const xml = await antwoord.text();
  const meldingen = parseRss(xml);

  const res = json({ meldingen });
  const bewaar = new Response(res.clone().body, res);
  bewaar.headers.set('cache-control', 'max-age=20');
  await cache.put(sleutel, bewaar);
  return res;
}

function parseRss(xml) {
  const items = [];
  const stukken = xml.split(/<item[\s>]/i).slice(1);
  for (const stuk of stukken.slice(0, 50)) {
    const inhoud = stuk.split(/<\/item>/i)[0];
    const titel = veld(inhoud, 'title');
    const omschrijving = veld(inhoud, 'description');
    const datum = veld(inhoud, 'pubDate');
    const link = veld(inhoud, 'link');
    const gid = veld(inhoud, 'guid');
    if (!titel && !omschrijving) continue;
    items.push({
      id: gid || link || (titel + '|' + datum),
      title: titel,
      desc: omschrijving,
      pub: datum ? new Date(datum).toISOString() : null
    });
  }
  return items;
}

function veld(xml, naam) {
  const m = xml.match(new RegExp('<' + naam + '[^>]*>([\\s\\S]*?)<\\/' + naam + '>', 'i'));
  if (!m) return '';
  return ontsnap(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/\s+/g, ' ').trim();
}

function ontsnap(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&');
}

/* ================= Raspberry Pi + testmeldingen ================= */

async function pi(request, env) {
  if (request.method === 'GET') {
    const laatste = await env.CONFIG.get('laatste-melding', 'json');
    return json(laatste || {});
  }

  if (request.method !== 'POST') return json({ error: 'methode niet toegestaan' }, 405);

  const body = await request.json().catch(() => null);
  if (!body || body.sleutel !== env.POST_SLEUTEL) return json({ error: 'geen toegang' }, 403);

  const tekst = (body.text || '').trim();
  if (!tekst) return json({ error: 'lege melding' }, 400);

  const bronId = body.bronId || null;
  const telSleutel = 'gezien:' + (bronId || tekst.slice(0, 120));

  const alGezien = await env.CONFIG.get(telSleutel);
  let geteld = false;
  if (!alGezien) {
    await env.CONFIG.put(telSleutel, '1', { expirationTtl: 86400 });
    await telMelding(env);
    geteld = true;
  }

  if (!bronId) {
    await env.CONFIG.put('laatste-melding', JSON.stringify({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      text: tekst,
      ts: Date.now(),
      test: !!body.test
    }));
  }

  return json({ ok: true, geteld });
}

/* ================= Tellingen ================= */

function nuInNederland() {
  const d = new Date();
  const delen = new Intl.DateTimeFormat('nl-NL', {
    timeZone: TIJDZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    jaar: Number(delen.year),
    maand: Number(delen.month),
    dag: Number(delen.day),
    uur: Number(delen.hour)
  };
}

function huidigeDienst() {
  const n = nuInNederland();
  let dagUTC = Date.UTC(n.jaar, n.maand - 1, n.dag);
  if (n.uur < 7) dagUTC -= 86400000;
  const dagen = Math.round((dagUTC - PLOEG_ANKER) / 86400000);
  const ploeg = PLOEGEN[((dagen % 4) + 4) % 4];
  return { merk: new Date(dagUTC).toISOString().slice(0, 10), ploeg, jaar: n.jaar };
}

async function leesTellingen(env) {
  const dienst = huidigeDienst();
  const opgeslagen = (await env.CONFIG.get('tellingen', 'json')) || {};

  let jaar = opgeslagen.jaar;
  if (!jaar || jaar.jaar !== dienst.jaar) {
    jaar = { jaar: dienst.jaar, totaal: 0, A: 0, B: 0, C: 0, D: 0 };
  }
  let huidig = opgeslagen.dienst;
  if (!huidig || huidig.merk !== dienst.merk) {
    huidig = { merk: dienst.merk, ploeg: dienst.ploeg, aantal: 0 };
  }
  return { dienst: huidig, jaar };
}

async function telMelding(env) {
  const stand = await leesTellingen(env);
  stand.dienst.aantal += 1;
  stand.jaar.totaal += 1;
  const p = stand.dienst.ploeg;
  stand.jaar[p] = (stand.jaar[p] || 0) + 1;
  await env.CONFIG.put('tellingen', JSON.stringify(stand));
}

/* ================= Route (Valhalla) ================= */

async function route(url) {
  const ruw = url.searchParams.get('json');
  if (!ruw) return json({ error: 'geen json-parameter' }, 400);

  let verzoek;
  try { verzoek = JSON.parse(ruw); } catch { return json({ error: 'json onleesbaar' }, 400); }

  verzoek.costing = COSTING;

  const matrix = url.searchParams.get('soort') === 'matrix';
  const doel = VALHALLA + (matrix ? '/sources_to_targets' : '/route') +
               '?json=' + encodeURIComponent(JSON.stringify(verzoek));

  const antwoord = await fetch(doel, {
    headers: { 'user-agent': 'P2000-' + (env?.POST_NAAM || 'worker') }
  });
  if (!antwoord.ok) return json({ error: 'valhalla ' + antwoord.status }, 502);

  const data = await antwoord.text();
  return new Response(data, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=60', ...CORS }
  });
}
