// Where this phone last had signal, for the SOS card ("last had signal 2:14 pm, 1.3 mi SW of here"). While trip mode,
// the truck screen or a check-in plan is running, each fresh GPS fix is paired with a tiny request to this app's own
// site; when it gets an answer, that fix is remembered here. The request carries nothing about where you are, and the
// spot stays in this phone's storage.
const KEY = 'tackle-box-last-signal';
const EVERY = 3 * 60e3;
let fix = null, lastPing = 0, pinging = false;

export const lastSignal = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };

async function ping() {
  if (pinging || !fix || Date.now() - fix.time > 120e3) return;
  pinging = true; lastPing = Date.now();
  const at = fix;
  try {
    // sw.js lets ?tb-ping through to the network, so a cached copy never passes for signal.
    const r = await fetch(`manifest.json?tb-ping=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.ok) localStorage.setItem(KEY, JSON.stringify({ lat: +at.lat.toFixed(5), lon: +at.lon.toFixed(5), time: Date.now() }));
  } catch { /* no signal */ } finally { pinging = false; }
}

// Called with each GPS fix from trip mode and the truck screen.
export function noteFix(lat, lon, accuracy = 0) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || accuracy > 100) return;
  fix = { lat, lon, time: Date.now() };
  if (navigator.onLine !== false && Date.now() - lastPing > EVERY) ping();
}
addEventListener('online', () => { lastPing = 0; ping(); });
