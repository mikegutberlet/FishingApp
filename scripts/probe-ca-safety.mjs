// Temporary: logs what the safety-data sources look like from a GitHub runner. Removed before merge. Round 3.
const UA = { 'User-Agent': 'TackleBox-fishing-app (personal, github.com/mikegutberlet/FishingApp)' };
const text = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
async function get(url, init) {
  try {
    const r = await fetch(url, { ...init, headers: { ...UA, ...init?.headers }, signal: AbortSignal.timeout(200000) });
    const body = await r.text();
    console.log(`\n=== ${r.status} ${url} (${body.length} bytes)`);
    return body;
  } catch (e) { console.log(`\n=== FAIL ${url}: ${e.message}`); return ''; }
}
const sql = async q => { const j = await get(`https://data.ca.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(q)}`); try { for (const r of JSON.parse(j).result.records) { delete r._full_text; console.log(JSON.stringify(r)); } } catch { console.log(j.slice(0, 800)); } };

const HAB = 'c6a36b91-ad38-4611-8750-87ee99e497dd';
await sql(`SELECT "Advisory_Recommended", "Reported_Advisory_Types", "Case_Status", count(*) n FROM "${HAB}" GROUP BY 1,2,3 ORDER BY n DESC LIMIT 60`);
await sql(`SELECT "Bloom_Report_ID","Case_ID","Water_Body_Name","Official_Water_Body_Name","Case_Water_Body_Name","County","Observation_Date","Advisory_Recommended","AdvisoryStartDate","AdvisoryEndDate","Advisory_Date","Case_Status","Case_End_Date","Last_Field_Result_Sample_Date","AdvisoryDetail","Advisory_Detail_Description" FROM "${HAB}" WHERE "Observation_Date" > '2026-06-01' AND "Advisory_Recommended" IS NOT NULL ORDER BY "Observation_Date" DESC LIMIT 40`);
await sql(`SELECT count(*) FROM "${HAB}" WHERE "Case_Status" = 'Open'`);

const SERV = '55b9a341-04e1-4f4a-9839-6eb36e6cc8ed';
await sql(`SELECT count(*) FROM "${SERV}" WHERE "Advisory" IS NOT NULL`);
await sql(`SELECT * FROM "${SERV}" WHERE "Advisory" IS NOT NULL ORDER BY "_id" LIMIT 40`);
await sql(`SELECT * FROM "${SERV}" WHERE "Advisory" = 'Lake Berryessa'`);

// LII: district general regulations table and species sections
for (const sec of ['7.00', '5.00']) {
  const h = await get(`https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`);
  const body = h.slice(h.indexOf('<h1'));
  const firstTable = body.indexOf('<table');
  console.log('BEFORE TABLE:', text(body.slice(0, firstTable)).slice(-3000));
  for (const [, row] of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) console.log('ROW', [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => text(m[1])).join(' | ').slice(0, 400));
  console.log('AFTER TABLE:', text(body.slice(body.lastIndexOf('</table>'))).slice(0, 1500));
}
for (const sec of ['5.10', '5.15', '5.25', '5.30', '5.45', '5.50', '5.55', '5.60', '5.65', '5.70', '5.75', '5.80', '5.85', '5.87', '5.88', '5.90', '5.95', '7.40', '8.00', '1.74', '2.00', '2.05', '2.10']) {
  const h = await get(`https://www.law.cornell.edu/regulations/california/14-CCR-${sec}`);
  if (!h) continue;
  const body = h.slice(h.indexOf('<h1'));
  console.log(text(body).slice(0, 900));
}
