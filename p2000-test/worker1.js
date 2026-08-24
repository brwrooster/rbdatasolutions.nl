/* ============================================================================
   P2000-scherm — Cloudflare Worker
   Versie: augustus 2026 — klaargemaakt voor meerdere posten

   WAT ER IS VERANDERD TEN OPZICHTE VAN DE VORIGE VERSIE
   -----------------------------------------------------
   1. /api/route gooide ALTIJD een fout: er stond `env?.POST_NAAM` in een
      functie die `env` niet meegekregen had. Dat is een ReferenceError, dus
      de proxy gaf altijd 500. Nu krijgt route() gewoon env mee.
   2. COSTING stond op 'auto' — dus zonder busbanen. Nu 'bus'.
   3. Alle KV-sleutels staan nu per post: post:<id>:...  Meerdere posten
      kunnen dus dezelfde Worker gebruiken zonder elkaar te overschrijven.
   4. /api/config bewaart nu ALLES: postnaam, brandweer, adres, lat/lon,
      nachtmodus, ploegen, posten, voertuigen, capcodes, holdMin, taken.
      Voorheen vielen postnaam, locatie en ploegen er stilletjes uit.
   5. /api/wachtwoord erbij: het instellingenmenu wordt weer server-side
      gecontroleerd.
   6. /api/taken blijft bestaan als alias, zodat oude schermen die nog niet
      zijn bijgewerkt blijven werken tijdens de overgang.
   7. Voertuigen worden genormaliseerd opgeslagen (lat/lon als getal), zodat
      coördinaten niet meer kunnen wegvallen.

   wrangler.toml heeft nodig:
     [vars]
     POST_NAAM        = "Post Veluwsekant"
     POST_SLEUTEL     = "veluwsekant2026"     # gedeeld met de Raspberry Pi
     MENU_WACHTWOORD  = "kies-iets-eigens"    # voor het instellingenmenu
     FEED_URL         = "https://.../rss"
     STANDAARD_POST   = "veluwsekant"         # als ?post= ontbreekt
     [[kv_namespaces]]
     binding = "CONFIG"
     id      = "<jouw KV namespace id>"
   ========================================================================== */

const PLOEG_ANKER_STANDAARD = Date.UTC(2026, 5, 17);   // 17 juni 2026 = D-ploeg
const PLOEGEN_STANDAARD     = ['D', 'A', 'B', 'C'];
const TIJDZONE  = 'Europe/Amsterdam';
const VALHALLA  = 'https://valhalla1.openstreetmap.de';
const COSTING   = 'bus';   // busbanen meerekenen, zoals hulpdiensten rijden

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pad = url.pathname;

    if (request.method === 'OPTIONS') return leeg204();

    const post = postId(url, env);

    try {
      if (pad === '/api/config')     return await config(request, env, post);
      if (pad === '/api/taken')      return await config(request, env, post);   // oude naam
      if (pad === '/api/wachtwoord') return await wachtwoord(request, env, post);
      if (pad === '/api/melding')    return await melding(env, post);
      if (pad === '/api/pi')         return await pi(request, env, post);
      if (pad === '/api/route')      return await route(url, env);
      if (pad === '/api/status')     return json({
        ok: true, post, naam: env.POST_NAAM, costing: COSTING,
        tijd: new Date().toISOString()
      });
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500);
    }

    return json({ error: 'niet gevonden' }, 404);
  }
};

/* ================= Hulpstukken ================= */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS
    }
  });
}

function leeg204() {
  return new Response(null, { status: 204, headers: CORS });
}

/* Welke post? Uit ?post=, anders de standaardpost uit wrangler.toml.
   Alleen kleine letters, cijfers en streepjes — geen rare KV-sleutels. */
function postId(url, env) {
  const ruw = url.searchParams.get('post') || env.STANDAARD_POST || 'standaard';
  const schoon = String(ruw).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return schoon || 'standaard';
}

function sleutel(post, naam) {
  return 'post:' + post + ':' + naam;
}

/* ================= Instellingen ================= */

const LEGE_CONFIG = {
  versie: 0,
  postnaam: '',
  brandweer: '',
  adres: '',
  lat: null,
  lon: null,
  ingesteld: false,
  nachtVan: '22:00',
  nachtTot: '07:00',
  capcodes: [],
  holdMin: 5,
  ploegen: [],
  posten: {},
  voertuigen: {},
  taken: [],
  ploegAnker: null,      // '2026-06-17' — per post instelbaar
  ploegVolgorde: null    // ['D','A','B','C']
};

async function leesConfig(env, post) {
  let opgeslagen = await env.CONFIG.get(sleutel(post, 'config'), 'json');

  /* Overgang: was er nog niets, maar staat de OUDE sleutel er wel?
     Dan die eenmalig overnemen, zodat capcodes en voertuigen niet weg zijn. */
  if (!opgeslagen) {
    const oud = await env.CONFIG.get('instellingen', 'json');
    if (oud) {
      opgeslagen = {
        capcodes:   Array.isArray(oud.capcodes) ? oud.capcodes : [],
        holdMin:    Number(oud.holdMin) > 0 ? Number(oud.holdMin) : 5,
        posten:     oud.posts || {},
        voertuigen: normaliseerVoertuigen(oud.units || {}),
        taken:      Array.isArray(oud.tasks) ? oud.tasks : []
      };
    }
  }

  return Object.assign({}, LEGE_CONFIG, opgeslagen || {});
}

/* Voertuigen altijd in hetzelfde formaat wegschrijven. Hier zat de bron van
   het coördinatenverlies: soms 'coords' als tekst, soms lat/lon, soms niets. */
function normaliseerVoertuigen(bron) {
  const uit = {};
  if (!bron || typeof bron !== 'object') return uit;

  for (const cap of Object.keys(bron)) {
    const v = bron[cap] || {};
    let lat = getal(v.lat);
    let lon = getal(v.lon);

    if ((lat === null || lon === null) && typeof v.coords === 'string') {
      const d = v.coords.split(',');
      if (d.length === 2) {
        const a = getal(d[0]), b = getal(d[1]);
        if (a !== null && b !== null) { lat = a; lon = b; }
      }
    }

    let post = v.post || null;
    if (post === 'current') post = null;   // stille valkuil uit de oude versie

    const nummer = String(cap).trim();
    if (!nummer) continue;

    uit[nummer] = {
      naam:  String(v.naam || '').trim(),
      post:  post ? String(post).toLowerCase().trim() : null,
      adres: v.adres ? String(v.adres).trim() : '',
      lat, lon
    };
  }
  return uit;
}

function getal(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normaliseerPosten(bron) {
  const uit = {};
  if (!bron || typeof bron !== 'object') return uit;
  for (const k of Object.keys(bron)) {
    const p = bron[k] || {};
    const lat = getal(p.lat), lon = getal(p.lon);
    if (lat === null || lon === null) continue;   // een post zonder coördinaten is nutteloos
    uit[String(k).toLowerCase().trim()] = { naam: String(p.naam || k).trim(), lat, lon };
  }
  return uit;
}

async function config(request, env, post) {

  /* ---------- opslaan ---------- */
  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'ongeldige inhoud' }, 400);

    const huidig = await leesConfig(env, post);

    /* Oude veldnamen blijven werken (tasks/posts/units), zodat een scherm dat
       nog niet is bijgewerkt geen schade aanricht. */
    const voertuigenIn = body.voertuigen || body.units;
    const postenIn     = body.posten     || body.posts;
    const takenIn      = body.taken      || body.tasks;

    const nieuw = {
      versie:    (Number(huidig.versie) || 0) + 1,

      postnaam:  tekst(body.postnaam,  huidig.postnaam),
      brandweer: tekst(body.brandweer, huidig.brandweer),
      adres:     tekst(body.adres,     huidig.adres),
      lat:       body.lat !== undefined ? getal(body.lat) : huidig.lat,
      lon:       body.lon !== undefined ? getal(body.lon) : huidig.lon,
      ingesteld: body.ingesteld !== undefined ? !!body.ingesteld : !!huidig.ingesteld,

      nachtVan:  tekst(body.nachtVan, huidig.nachtVan),
      nachtTot:  tekst(body.nachtTot, huidig.nachtTot),

      capcodes:  Array.isArray(body.capcodes)
                   ? body.capcodes.map(c => String(c).trim()).filter(Boolean)
                   : huidig.capcodes,
      holdMin:   getal(body.holdMin) > 0 ? getal(body.holdMin) : huidig.holdMin,

      ploegen:   Array.isArray(body.ploegen) ? body.ploegen : huidig.ploegen,
      posten:    postenIn     ? normaliseerPosten(postenIn)         : huidig.posten,
      voertuigen: voertuigenIn ? normaliseerVoertuigen(voertuigenIn) : huidig.voertuigen,
      taken:     Array.isArray(takenIn) ? takenIn : huidig.taken,

      ploegAnker:    body.ploegAnker    || huidig.ploegAnker,
      ploegVolgorde: Array.isArray(body.ploegVolgorde) ? body.ploegVolgorde : huidig.ploegVolgorde,

      gewijzigd: new Date().toISOString()
    };

    await env.CONFIG.put(sleutel(post, 'config'), JSON.stringify(nieuw));
    return json({ ok: true, versie: nieuw.versie, post });
  }

  /* ---------- ophalen ---------- */
  const inst = await leesConfig(env, post);
  inst.post = post;
  inst.tellingen = await leesTellingen(env, post, inst);

  /* oude veldnamen meesturen voor schermen die nog niet zijn bijgewerkt */
  inst.units = inst.voertuigen;
  inst.posts = inst.posten;
  inst.tasks = inst.taken;

  return json(inst);
}

function tekst(waarde, terugval) {
  return (typeof waarde === 'string') ? waarde : terugval;
}

/* ================= Wachtwoord instellingenmenu ================= */

async function wachtwoord(request, env, post) {
  if (request.method !== 'POST') return json({ error: 'methode niet toegestaan' }, 405);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'ongeldige inhoud' }, 400);

  const opgeslagen = await env.CONFIG.get(sleutel(post, 'wachtwoord'));
  const geldig = opgeslagen || env.MENU_WACHTWOORD || env.POST_SLEUTEL;

  if (!geldig) return json({ ok: false, error: 'geen wachtwoord ingesteld' }, 500);
  if (String(body.wachtwoord || '') !== String(geldig)) {
    return json({ ok: false }, 200);   // geen 401: dan hoeft het scherm niets te vangen
  }

  /* Wachtwoord wijzigen kan alleen mét het huidige wachtwoord erbij. */
  if (body.nieuw && String(body.nieuw).length >= 4) {
    await env.CONFIG.put(sleutel(post, 'wachtwoord'), String(body.nieuw));
    return json({ ok: true, gewijzigd: true });
  }

  return json({ ok: true });
}

/* ================= Feed (112-nu RSS) ================= */

async function melding(env, post) {
  const cache = caches.default;
  const cacheSleutel = new Request('https://cache.intern/feed/' + post, { method: 'GET' });
  const uitCache = await cache.match(cacheSleutel);
  if (uitCache) return uitCache;

  if (!env.FEED_URL) return json({ error: 'FEED_URL niet ingesteld', meldingen: [] });

  const antwoord = await fetch(env.FEED_URL, {
    headers: { 'user-agent': 'P2000-scherm/' + post }
  });
  if (!antwoord.ok) return json({ error: 'feed niet bereikbaar', meldingen: [] });

  const xml = await antwoord.text();
  const meldingen = parseRss(xml);

  const res = json({ meldingen });
  const bewaar = new Response(res.clone().body, res);
  bewaar.headers.set('cache-control', 'max-age=20');
  await cache.put(cacheSleutel, bewaar);
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

async function pi(request, env, post) {
  if (request.method === 'GET') {
    const laatste = await env.CONFIG.get(sleutel(post, 'laatste-melding'), 'json');
    return json(laatste || {});
  }

  if (request.method !== 'POST') return json({ error: 'methode niet toegestaan' }, 405);

  const body = await request.json().catch(() => null);
  if (!body || body.sleutel !== env.POST_SLEUTEL) return json({ error: 'geen toegang' }, 403);

  const tekstIn = String(body.text || '').trim();
  if (!tekstIn) return json({ error: 'lege melding' }, 400);

  const bronId = body.bronId || null;
  const telSleutel = sleutel(post, 'gezien:' + (bronId || tekstIn.slice(0, 120)));

  const alGezien = await env.CONFIG.get(telSleutel);
  let geteld = false;
  if (!alGezien) {
    await env.CONFIG.put(telSleutel, '1', { expirationTtl: 86400 });
    await telMelding(env, post, tekstIn);
    geteld = true;
  }

  if (!bronId) {
    await env.CONFIG.put(sleutel(post, 'laatste-melding'), JSON.stringify({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      text: tekstIn,
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
    jaar:  Number(delen.year),
    maand: Number(delen.month),
    dag:   Number(delen.day),
    uur:   Number(delen.hour)
  };
}

/* Ploegrotatie is nu per post instelbaar; zonder instelling geldt D-A-B-C
   met ankerdatum 17 juni 2026, precies zoals het was. */
function huidigeDienst(cfg) {
  const n = nuInNederland();
  let dagUTC = Date.UTC(n.jaar, n.maand - 1, n.dag);
  if (n.uur < 7) dagUTC -= 86400000;

  let anker = PLOEG_ANKER_STANDAARD;
  if (cfg && cfg.ploegAnker) {
    const d = new Date(cfg.ploegAnker + 'T00:00:00Z');
    if (!isNaN(d.getTime())) anker = d.getTime();
  }
  const volgorde = (cfg && Array.isArray(cfg.ploegVolgorde) && cfg.ploegVolgorde.length)
    ? cfg.ploegVolgorde : PLOEGEN_STANDAARD;

  const dagen = Math.round((dagUTC - anker) / 86400000);
  const ploeg = volgorde[((dagen % volgorde.length) + volgorde.length) % volgorde.length];
  return { merk: new Date(dagUTC).toISOString().slice(0, 10), ploeg, jaar: n.jaar };
}

async function leesTellingen(env, post, cfg) {
  const dienst = huidigeDienst(cfg);
  const opgeslagen = (await env.CONFIG.get(sleutel(post, 'tellingen'), 'json')) || {};

  let jaar = opgeslagen.jaar;
  if (!jaar || jaar.jaar !== dienst.jaar) {
    jaar = { jaar: dienst.jaar, totaal: 0, A: 0, B: 0, C: 0, D: 0 };
  }
  let huidig = opgeslagen.dienst;
  if (!huidig || huidig.merk !== dienst.merk) {
    huidig = { merk: dienst.merk, ploeg: dienst.ploeg, aantal: 0, meldingen: [] };
  }
  if (!Array.isArray(huidig.meldingen)) huidig.meldingen = [];
  return { dienst: huidig, jaar };
}

async function telMelding(env, post, tekstIn) {
  const cfg = await leesConfig(env, post);
  const stand = await leesTellingen(env, post, cfg);

  stand.dienst.aantal += 1;
  stand.jaar.totaal += 1;
  const p = stand.dienst.ploeg;
  stand.jaar[p] = (stand.jaar[p] || 0) + 1;

  /* De ticker onderin het scherm toont de meldingen van deze dienst.
     Maximaal 20 bewaren, anders groeit de KV-waarde onbeperkt. */
  stand.dienst.meldingen.push({ ts: Date.now(), text: tekstIn.slice(0, 300) });
  if (stand.dienst.meldingen.length > 20) {
    stand.dienst.meldingen = stand.dienst.meldingen.slice(-20);
  }

  await env.CONFIG.put(sleutel(post, 'tellingen'), JSON.stringify(stand));
}

/* ================= Route (Valhalla) =================
   Hier zat de fout: env werd niet doorgegeven, waardoor env?.POST_NAAM een
   ReferenceError gooide en elke routeaanvraag met 500 eindigde. */

async function route(url, env) {
  const ruw = url.searchParams.get('json');
  if (!ruw) return json({ error: 'geen json-parameter' }, 400);

  let verzoek;
  try {
    verzoek = JSON.parse(ruw);
  } catch {
    return json({ error: 'json onleesbaar' }, 400);
  }

  verzoek.costing = COSTING;

  const matrix = url.searchParams.get('soort') === 'matrix';
  const doel = VALHALLA + (matrix ? '/sources_to_targets' : '/route') +
               '?json=' + encodeURIComponent(JSON.stringify(verzoek));

  const antwoord = await fetch(doel, {
    headers: { 'user-agent': 'P2000-scherm/' + ((env && env.POST_NAAM) || 'worker') }
  });

  if (!antwoord.ok) {
    return json({ error: 'valhalla ' + antwoord.status }, 502);
  }

  const data = await antwoord.text();
  return new Response(data, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'max-age=60',
      ...CORS
    }
  });
}
