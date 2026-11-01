// Limey Joe's homes + availability (Netlify Function).
//
// The list of homes comes straight from Lodgify, so a home added there appears on the website
// on its own (within about an hour). Each home is placed in a region by its map position.
//
//   ?homes=1                                   all homes, grouped by region (used by the website)
//   ?region=river&arrival=YYYY-MM-DD&departure=YYYY-MM-DD   which homes in a region are free
//   ?region=river&list=1                       the homes in one region (quick check)
//   ?check=1                                   every Lodgify property and where it was placed, and why
//
// Your Lodgify API key is read from the Netlify environment variable LODGIFY_API_KEY.
// It is never sent to the browser.

/* ===================== SETTINGS — edit these if needed ===================== */

// Region rules, by map position.
// A home within OSWEGO.miles of downtown Oswego goes to Oswego City.
// Otherwise, a home within RIVER.miles of Pulaski goes to Port Ontario & the Salmon River.
// Anything farther away than both is left off the site (e.g. homes in other parts of the state).
const OSWEGO = { lat: 43.4553, lng: -76.5105, miles: 4 };
const RIVER  = { lat: 43.5670, lng: -76.1277, miles: 30 };

// Cannon's Sports Lodge: every Lodgify unit at the lodge is left off this site,
// except the ones listed in ALWAYS_INCLUDE. The lodge's position is taken from CANNONS_ANCHOR_ID.
const CANNONS_ANCHOR_ID = 856029;   // Salmon River Lodge (at 614 County Route 40)
const CANNONS_RADIUS_MILES = 0.4;
const ALWAYS_INCLUDE = [856029, 856028]; // Salmon River Lodge and Salmon River Apt
const ALWAYS_EXCLUDE = [];               // any Lodgify ID to keep off the site entirely

// Force a home into a region whatever its map position, e.g. { 123456: 'oswego' }.
const REGION_OVERRIDES = {};

// Town names to show instead of Lodgify's, and per-home overrides by ID.
const TOWN_RENAMES = { Richland: 'Pulaski', Albion: 'Altmar' };
const TOWN_OVERRIDES = {};

// Page addresses on the Lodgify booking site, when they don't match the home's name.
const SLUG_OVERRIDES = {};

// Booking rules for individual homes, by Lodgify ID.
//   maxGuests:      only shown for groups this size or smaller (also caps the "Max X People" badge)
//   weeknightsOnly: only shown when every night of the stay is a Sunday to Thursday night
//   note:           short label shown on the home's tile
const HOME_RULES = {
  445689: { maxGuests: 4, weeknightsOnly: true, note: 'Weeknights only' }
};

// Used only if Lodgify's property list can't be read: the last known homes per region.
const FALLBACK = {
  river: [445688, 445690, 445691, 445694, 485239, 634859, 792765, 808807, 856029, 856028],
  oswego: [701384, 701378]
};

/* ========================================================================== */

const API = 'https://api.lodgify.com/v2';
const CALL_TIMEOUT_MS = 7000;           // each Lodgify call gives up after 7 seconds
const HOMES_CACHE_MS = 60 * 60 * 1000;  // reuse the property list for an hour

function json(status, body, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' };
  if (cacheSeconds) headers['Netlify-CDN-Cache-Control'] = 'public, s-maxage=' + cacheSeconds + ', stale-while-revalidate=86400';
  return { statusCode: status, headers, body: JSON.stringify(body) };
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

/* ---------- Building the list of homes ---------- */

function miles(aLat, aLng, bLat, bLng) {
  const R = 3958.8, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function num(v) { const n = parseFloat(v); return isFinite(n) && n !== 0 ? n : null; }

// Lodgify forms page addresses from the home's name: "Salmon River view! | Bar, Grill" -> "salmon-river-view-bar-grill".
function slugify(name) {
  return String(name || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// Tidy listing titles for the website: "Estate | Firepit + Grill + Charters!" -> "Estate: Firepit, Grill & Charters".
function joinList(parts) {
  return parts.length < 2 ? parts.join('') : parts.slice(0, -1).join(', ') + ' & ' + parts[parts.length - 1];
}
function displayName(name) {
  const segments = String(name || '').replace(/!/g, '').split(/\s*\|\s*/).map(seg => joinList(seg.split(/\s*\+\s*/).map(x => x.trim()).filter(Boolean)));
  const s = segments.length > 1 ? segments[0] + ': ' + segments.slice(1).join(', ') : segments[0] || '';
  return s.replace(/\s{2,}/g, ' ').trim();
}
function imageUrl(u) {
  if (!u) return '';
  u = String(u);
  if (u.startsWith('//')) u = 'https:' + u;
  if (!/^https?:\/\//.test(u)) return '';
  return u.includes('?') ? u : u + '?w=800';
}

async function allProperties(key) {
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const data = await lodgify('/properties?page=' + page + '&size=50&includeCount=true', key);
    const list = Array.isArray(data) ? data : (data.items || []);
    items.push(...list);
    const count = Array.isArray(data) ? list.length : (data.count || 0);
    if (!list.length || list.length < 50 || items.length >= count) break;
  }
  return items;
}

async function maxGuests(id, key) {
  try {
    const rooms = await lodgify('/properties/' + id + '/rooms', key);
    const list = Array.isArray(rooms) ? rooms : (rooms.items || []);
    const m = Math.max(0, ...list.map(r => parseInt(r.max_people, 10) || 0));
    return m || null;
  } catch (e) { return null; }
}

// Decide each property's region. Returns { region, reason } where region is null if left off the site.
function placeAll(props) {
  const anchor = props.find(p => p.id === CANNONS_ANCHOR_ID);
  const cLat = anchor && num(anchor.latitude), cLng = anchor && num(anchor.longitude);
  return props.map(p => {
    const lat = num(p.latitude), lng = num(p.longitude);
    const city = String(p.city || '').trim();
    let region = null, reason = '';
    if (ALWAYS_EXCLUDE.includes(p.id)) reason = 'in ALWAYS_EXCLUDE';
    else if (p.is_active === false) reason = 'inactive in Lodgify';
    else if (REGION_OVERRIDES[p.id]) { region = REGION_OVERRIDES[p.id]; reason = 'REGION_OVERRIDES'; }
    else if (!ALWAYS_INCLUDE.includes(p.id) && cLat && lat && miles(lat, lng, cLat, cLng) <= CANNONS_RADIUS_MILES) reason = "Cannon's Sports Lodge unit";
    else if (lat && lng) {
      const dO = miles(lat, lng, OSWEGO.lat, OSWEGO.lng), dR = miles(lat, lng, RIVER.lat, RIVER.lng);
      if (dO <= OSWEGO.miles) { region = 'oswego'; reason = dO.toFixed(1) + ' mi from downtown Oswego'; }
      else if (dR <= RIVER.miles) { region = 'river'; reason = dR.toFixed(1) + ' mi from Pulaski'; }
      else reason = 'outside both regions (' + dO.toFixed(0) + ' mi from Oswego)';
    }
    else if (/^oswego$/i.test(city)) { region = 'oswego'; reason = 'no map pin; town is Oswego'; }
    else if (city) { region = 'river'; reason = 'no map pin; placed by default (town: ' + city + ')'; }
    else reason = 'no map pin or town in Lodgify';
    return { p, region, reason };
  });
}

function applyRules(h) {
  const r = HOME_RULES[h.id];
  if (!r) return h;
  if (r.maxGuests) h.guests = h.guests ? Math.min(h.guests, r.maxGuests) : r.maxGuests;
  if (r.note) h.note = r.note;
  if (r.weeknightsOnly) h.weeknightsOnly = true;
  return h;
}

// True when any night of the stay is a Friday or Saturday night.
function hasWeekendNight(arrival, departure) {
  for (let d = arrival; d < departure; d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay(); // 5 = Friday, 6 = Saturday
    if (dow === 5 || dow === 6) return true;
  }
  return false;
}

let cache = null; // { at, homes, report }

async function getHomes(key) {
  if (cache && Date.now() - cache.at < HOMES_CACHE_MS) return cache;
  const props = await allProperties(key);
  const placed = placeAll(props);
  const keep = placed.filter(x => x.region);
  const guests = await Promise.all(keep.map(x => maxGuests(x.p.id, key)));
  const homes = keep.map((x, i) => {
    const p = x.p, city = String(p.city || '').trim();
    return applyRules({
      id: p.id,
      name: displayName(p.name),
      town: TOWN_OVERRIDES[p.id] || TOWN_RENAMES[city] || city,
      guests: guests[i],
      cover: imageUrl(p.image_url),
      slug: SLUG_OVERRIDES[p.id] || slugify(p.name),
      region: x.region
    });
  }).sort((a, b) => a.name.localeCompare(b.name));
  const report = placed.map(x => ({ id: x.p.id, name: x.p.name, town: x.p.city || '', region: x.region || 'not on site', reason: x.reason }));
  cache = { at: Date.now(), homes, report };
  return cache;
}

/* ---------- Availability ---------- */

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
function checkStay(periods, arrival, departure) {
  if (!periods.length) return 'unknown';
  const lastNight = addDays(departure, -1);
  let covered = false;
  for (const p of periods) {
    const start = day(p.start), end = day(p.end) || start;
    if (end < arrival || start > lastNight) continue;
    covered = true;
    if (p.closed_period === true) return 'unavailable';
    if (typeof p.available === 'number' && p.available < 1) return 'unavailable';
  }
  return covered ? 'available' : 'unknown';
}

/* ---------- Handler ---------- */

exports.handler = async (event) => {
  const key = process.env.LODGIFY_API_KEY;
  if (!key) return json(500, { error: 'The LODGIFY_API_KEY environment variable is not set in Netlify.' });
  const q = event.queryStringParameters || {};

  let data, fallback = false;
  try { data = await getHomes(key); }
  catch (e) {
    fallback = true;
    data = { homes: [].concat(...Object.keys(FALLBACK).map(r => FALLBACK[r].map(id => applyRules({ id, region: r, name: '' })))), report: [] };
  }

  if (q.check) return json(200, { fallback, homes: data.homes.length, properties: data.report });
  if (q.homes) return json(200, { fallback, homes: data.homes }, fallback ? 0 : 3600);

  if (!['river', 'oswego'].includes(q.region)) return json(400, { error: 'Unknown region.' });
  const homes = data.homes.filter(h => h.region === q.region);

  if (q.list) return json(200, { region: q.region, fallback, homes: homes.map(h => ({ id: h.id, name: h.name, town: h.town, guests: h.guests })) });

  const arrival = q.arrival, departure = q.departure;
  if (!isDate(arrival) || !isDate(departure) || departure <= arrival) {
    return json(400, { error: 'Send arrival and departure as YYYY-MM-DD, with departure after arrival.' });
  }

  // Leave out homes whose booking rules don't allow this stay (group size, weeknights only).
  const groupSize = parseInt(q.guests, 10) || 0;
  const weekend = hasWeekendNight(arrival, departure);
  const allowed = homes.filter(h => {
    const r = HOME_RULES[h.id] || {};
    if (r.weeknightsOnly && weekend) return false;
    if (r.maxGuests && groupSize > r.maxGuests) return false;
    return true;
  });

  const results = await Promise.all(allowed.map(async h => {
    try {
      // Lodgify's docs list both start/end and from/to for this call, so send both.
      const qs = new URLSearchParams({ start: arrival, end: departure, from: arrival, to: departure });
      const av = await lodgify('/availability/' + h.id + '?' + qs.toString(), key);
      return Object.assign({}, h, { status: checkStay(periodsOf(av), arrival, departure) });
    } catch (e) {
      return Object.assign({}, h, { status: 'unknown', error: e.message });
    }
  }));

  return json(200, { region: q.region, configured: true, fallback, arrival, departure, homes: results });
};
