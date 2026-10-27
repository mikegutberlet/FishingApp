// Share a water with a friend. The Share button on a lake, river or pier offers:
//  - a link (or QR code) that opens the same water in their Tackle Box. It carries only the water's public facts
//    (name, place, size, state ids) in its #fragment, which browsers never send to the website;
//  - the lake pack file (settings.js shareLake): your depth maps and stocking notes, your notes and waypoints if you say so;
//  - the crew share (crew.js) for catches and spots.
import { db } from './db.js';
import { packJson, unpackJson } from './crypto.js';
import { STATES } from './states/index.js';
import { esc, status } from './ui.js';
import { openLake } from './views/lake.js';
import { shareLake } from './views/settings.js';
import { openComposer } from './crew.js';
import { APP_URL, isIos, isStandalone, sendLink, showQrSheet } from './welcome.js';

const stockFields = () => [...new Set(Object.values(STATES).map(S => S.stockField).filter(Boolean))];
const TEXT = { name: 120, type: 40, kind: 12, coastKind: 20, state: 2, county: 60, nhdId: 60, depthSource: 80, by: 40 };
const NUMS = ['lat', 'lon', 'acres', 'elevationFt', 'maxDepth', 'meanDepth', 'lengthKm'];

// Only these fields travel, and only these are taken from a link. Links (stockingUrl) are rebuilt from the state's id.
function cleanWater(w) {
  const out = {};
  for (const [k, max] of Object.entries(TEXT)) if (w[k] != null && w[k] !== '') out[k] = String(w[k]).replace(/[<>]/g, '').slice(0, max);
  for (const k of NUMS) if (w[k] != null && w[k] !== '' && Number.isFinite(+w[k])) out[k] = +w[k];
  for (const f of stockFields()) if (w[f] != null && w[f] !== '') out[f] = String(w[f]).replace(/[^\w .:'()&,-]/g, '').slice(0, 80);
  if (typeof w.publicPier === 'boolean') out.publicPier = w.publicPier;
  if (out.lat != null) out.lat = Math.round(out.lat * 1e5) / 1e5;
  if (out.lon != null) out.lon = Math.round(out.lon * 1e5) / 1e5;
  return out;
}

export async function waterLink(lake) {
  const by = (() => { try { return localStorage.getItem('tackle-box-crew-name')?.trim(); } catch { return ''; } })();
  return `${APP_URL}#water=${await packJson(cleanWater({ ...lake, by }))}`;
}

// A water you added by hand (no statewide id) may be your own secret spot: say so before its location goes out.
const isOwnSpot = lake => !lake.nhdId && !stockFields().some(f => lake[f] != null);

export async function openShareSheet(lake) {
  const saved = !lake.unsaved && lake.id;
  const sheet = document.createElement('div');
  sheet.className = 'qr-sheet';
  sheet.innerHTML = `<div class="qr-sheet-card sw-card"><h3>Share ${esc(lake.name)}</h3>
    <button class="sw-opt primary" data-how="link"><b>🔗 Send a link</b><span>Opens this water in their Tackle Box: its name and place, plus your crew name if you've set one. Nothing else of yours.</span></button>
    <button class="sw-opt" data-how="qr"><b>▦ Show a QR code</b><span>The same link, for a friend standing next to you.</span></button>
    ${saved ? `<button class="sw-opt" data-how="pack"><b>📦 Send with my depth maps</b><span>A file with your depth maps and stocking notes. You choose whether to add your notes and waypoints. Never catches.</span></button>
    <button class="sw-opt" data-how="crew"><b>👥 Send catches or spots</b><span>Pick which ones in the crew share. GPS spots and photo locations stay off unless you tick them.</span></button>` : ''}
    <button class="sw-cancel" style="width:100%">Cancel</button></div>`;
  document.body.append(sheet);
  const close = () => sheet.remove();
  sheet.onclick = e => { if (e.target === sheet) close(); };
  sheet.querySelector('.sw-cancel').onclick = close;
  sheet.querySelectorAll('.sw-opt').forEach(b => b.onclick = async () => {
    const how = b.dataset.how;
    if ((how === 'link' || how === 'qr') && isOwnSpot(lake) && !confirm(`${lake.name} is a water you added yourself. The link includes its location on the map.\n\nSend it?`)) return;
    close();
    try {
      if (how === 'pack') return await shareLake(lake);
      if (how === 'crew') return await openComposer();
      const url = await waterLink(lake);
      const text = `${lake.name} in Tackle Box:`;
      if (how === 'link') return await sendLink(url, { title: lake.name, text });
      await showQrSheet(url, { title: `Scan to open ${lake.name}`, shareText: text,
        text: 'Opens this water in their Tackle Box (or the app, if they don\'t have it yet). Nothing of yours is in the code.' });
    } catch (e) { alert(e.message); }
  });
}

// ---------- Receiving: #water=<packed> ----------
async function openShared(w) {
  const mine = await db.all('lakes');
  const sf = stockFields();
  const saved = mine.find(l => (w.nhdId && l.nhdId === w.nhdId) || sf.some(f => w[f] != null && l[f] != null && String(l[f]) === String(w[f])));
  status(`${w.by ? `From ${w.by}: ` : ''}${w.name}`);
  if (saved) return openLake(saved.id);
  const S = STATES[w.state];
  const { by, ...rec } = w;
  const sid = S && rec[S.stockField];
  openLake({ ...rec, unsaved: true, ...(sid != null && { stockingUrl: S.waterUrl(sid) }) });
}

async function checkWaterLink() {
  const m = location.hash.match(/^#water=([\w-]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let w;
  try { w = cleanWater(await unpackJson(m[1])); } catch { w = null; }
  if (!w?.name || !Number.isFinite(w.lat) || !Number.isFinite(w.lon) || Math.abs(w.lat) > 90 || Math.abs(w.lon) > 180)
    return alert("That water link didn't work. Check it was copied in full.");
  // On iPhone the camera and Messages open links in Safari, which keeps its data apart from the home-screen app.
  if (!isStandalone() && isIos && !confirm(`Open ${w.name} here in Safari?\n\nIf you use Tackle Box from your home screen, tap Cancel to copy the link, then in the app: ⚙️ gear → Invite a friend → Open a link a friend sent.`)) {
    const url = `${APP_URL}#water=${m[1]}`;
    try { await navigator.clipboard.writeText(url); alert('Link copied. Open Tackle Box from your home screen, then ⚙️ gear → Invite a friend → Open a link a friend sent.'); }
    catch { prompt('Copy this link:', url); }
    return;
  }
  openShared(w);
}

addEventListener('hashchange', checkWaterLink);
setTimeout(checkWaterLink, 0);
