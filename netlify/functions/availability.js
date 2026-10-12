// Limey Joe's availability checker (Netlify Function).
// Called by the website as: /.netlify/functions/availability?region=river&arrival=2026-11-06&departure=2026-11-08
// Optional: ?region=river&list=1 returns each home's Lodgify ID and name (no dates needed), to check the setup.
//
// Your Lodgify API key is read from the Netlify environment variable LODGIFY_API_KEY.
// It is never sent to the browser.

// Lodgify property IDs for each region. Add the Oswego IDs here when you have them.
const REGIONS = {
  river: [445688, 445690, 445691, 445694, 485239, 634859, 792765, 808807, 856029, 856028],
  oswego: [701384, 701378]
};

// Home names by ID, so searches don't have to ask Lodgify for them (keeps searches fast).
// A home missing from this list has its name looked up from Lodgify instead.
const NAMES = {
  445688: 'Mexico Point Farmhouse',
  445690: 'Salmon River view! | Bar, Grill & Perfect Location',
  445691: 'Mexico Point Ranch',
  445694: 'Rustic Riverside Charm and Exclusive Fishing Access!',
  485239: 'Riverview Bliss in Beautiful Home',
  634859: 'Country Cottage by the Salmon River',
  792765: 'Charming Cottage by Lake Ontario | Firepit + Yard'
};

const API = 'https://api.lodgify.com/v2';
const CALL_TIMEOUT_MS = 7000; // each Lodgify call gives up after 7 seconds so the function answers in time

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
    body: JSON.stringify(body)
  };
}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function day(s) { return String(s || '').slice(0, 10); }
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function lodgify(path, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(API + path, { headers: { 'X-ApiKey': key, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('Lodgify ' + res.status + ' on ' + path);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Lodgify returns either [{ periods:[...] }] or a plain list of periods. Flatten to one list.
function periodsOf(data) {
  const list = Array.isArray(data) ? data : (data && (data.items || data.periods)) || [];
  const out = [];
  list.forEach(item => {
    if (item && Array.isArray(item.periods)) out.push(...item.periods);
    else if (item && item.start) out.push(item);
  });
  return out;
}

// A home is free when no period touching any night of the stay is closed or has zero units.
// Nights run from arrival up to the night before departure.
function checkStay(periods, arrival, departure) {
  if (!periods.length) return 'unknown';
  const lastNight = addDays(departure, -1);
  let covered = false;
  for (const p of periods) {
    const start = day(p.start), end = day(p.end) || start;
    if (end < arrival || start > lastNight) continue; // period is outside the stay
    covered = true;
    if (p.closed_period === true) return 'unavailable';
    if (typeof p.available === 'number' && p.available < 1) return 'unavailable';
  }
  return covered ? 'available' : 'unknown';
}

async function propertyName(id, key) {
  try {
    const info = await lodgify('/properties/' + id, key);
    return info.name || info.title || '';
  } catch (e) { return ''; }
}

exports.handler = async (event) => {
  const key = process.env.LODGIFY_API_KEY;
  if (!key) return json(500, { error: 'The LODGIFY_API_KEY environment variable is not set in Netlify.' });

  const q = event.queryStringParameters || {};
  const ids = REGIONS[q.region];
  if (!ids) return json(400, { error: 'Unknown region.' });
  if (!ids.length) return json(200, { region: q.region, configured: false, homes: [] });

  if (q.list) {
    const homes = await Promise.all(ids.map(async id => ({ id, name: await propertyName(id, key) })));
    return json(200, { region: q.region, homes });
  }

  const arrival = q.arrival, departure = q.departure;
  if (!isDate(arrival) || !isDate(departure) || departure <= arrival) {
    return json(400, { error: 'Send arrival and departure as YYYY-MM-DD, with departure after arrival.' });
  }

  const homes = await Promise.all(ids.map(async id => {
    const name = NAMES[id] || await propertyName(id, key);
    try {
      // Lodgify's docs list both start/end and from/to for this call, so send both.
      const qs = new URLSearchParams({ start: arrival, end: departure, from: arrival, to: departure });
      const data = await lodgify('/availability/' + id + '?' + qs.toString(), key);
      return { id, name, status: checkStay(periodsOf(data), arrival, departure) };
    } catch (e) {
      return { id, name, status: 'unknown', error: e.message };
    }
  }));

  return json(200, { region: q.region, configured: true, arrival, departure, homes });
};
