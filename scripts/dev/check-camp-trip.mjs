// Dev check: the live answers the camp trip relies on, from a runner (the sandbox can't reach them). Prints what
// camping.js's weekendAvailability makes of Recreation.gov's month answer for the trip's nights (site and loop
// fields, NYR months ahead), and the status of every link the camp card and fish care pages show. Writes nothing.
globalThis.location = { origin: 'https://example.invalid' };
const realFetch = globalThis.fetch;
const H = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) TackleBox-check', Origin: 'https://mikegutberlet.github.io', Referer: 'https://mikegutberlet.github.io/FishingApp/' };
globalThis.fetch = (u, init = {}) => realFetch(u, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
const { weekendAvailability } = await import('../../camping.js');
const { FOOD_RULES, bookingOpens } = await import('../../camp-trip.js');

const iso = d => d.toISOString().slice(0, 10);
const nightsFrom = (days, n) => Array.from({ length: n }, (_, i) => iso(new Date(Date.now() + (days + i) * 864e5)));
for (const id of ['232263', '232447', '234023']) {
  for (const [label, nights] of [['in 3 weeks', nightsFrom(21, 3)], ['in 7 months', nightsFrom(213, 2)]]) {
    try {
      const r = await weekendAvailability(id, nights);
      console.log(`recgov ${id} ${label} ${nights.join(',')}: total=${r.total} all=${r.all} some=${r.some} NYR=${r.notReleased} values=${JSON.stringify(r.values)} open=${JSON.stringify(r.open.slice(0, 5))}`);
    } catch (e) { console.log(`recgov ${id} ${label}: FAILED ${e.message}`); }
  }
}
const raw = await fetch('https://www.recreation.gov/api/camps/availability/campground/232263/month?start_date=' + iso(new Date()).slice(0, 8) + '01T00%3A00%3A00.000Z').then(r => r.json()).catch(e => ({ e: e.message }));
const one = Object.values(raw.campsites ?? {})[0];
console.log('raw campsite keys', one && Object.keys(one).join(','), 'sample', one && JSON.stringify({ campsite_id: one.campsite_id, site: one.site, loop: one.loop }));
console.log('booking opens for 2027-07-02:', new Date(bookingOpens('2027-07-02')).toISOString(), '(expect 2027-01-02T15:00Z)');
for (const url of [...FOOD_RULES.map(r => r.url), 'https://www.sierrawild.gov/bears', 'https://www.preventwildfireca.org/Campfire-Permit/', 'https://oehha.ca.gov/fish/advisories']) {
  try { const r = await fetch(url, { redirect: 'follow' }); console.log('link', r.status, url, r.url !== url ? `-> ${r.url}` : ''); } catch (e) { console.log('link FAILED', url, e.message); }
}
