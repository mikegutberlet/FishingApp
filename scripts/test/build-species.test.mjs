import test from 'node:test';
import assert from 'node:assert/strict';
import { namesFrom } from '../ca-lake-names.mjs';
import { extraLakes, listName, shareWord, pointsFor, matcher, nvCodes, recordNote, parsePlan, planNote, fhdNote, pointOf, NV_CODES } from '../build-species.mjs';

test('listName: the app\'s name for the fish, the agency\'s where that says more, null for a fish not on the list', () => {
  assert.equal(listName('Bass, Largemouth'), 'Largemouth bass');
  assert.equal(listName('Trout, Mackinaw'), 'Lake trout');
  assert.equal(listName('Trout, Rainbow x Cutthroat'), 'Cutbow trout');
  assert.equal(listName('Wiper, White x Striped'), 'Wiper');
  assert.equal(listName('Salmon, Silver'), 'Coho salmon');
  assert.equal(listName('Sunfish, Bluegill'), 'Bluegill');
  assert.equal(listName('Whate Crappie (lake)'), 'White crappie');
  assert.equal(listName('Fall Chinook (lake)'), 'Chinook salmon');
  assert.equal(listName('Winter Steelhead (lake)'), 'Steelhead');
  assert.equal(listName('Carp (lake)'), 'Common carp');
  assert.equal(listName('McCloud River Redband Trout'), 'Redband trout');
  assert.equal(listName('Eagle Lake Trout'), 'Eagle Lake trout');
  // A catch-all would lose what the record says, and a fish that isn't on the list keeps the agency's name.
  assert.equal(listName('Catfish, Bullhead'), 'Bullhead');
  assert.equal(listName('Bullhead'), 'Bullhead');
  assert.equal(listName('Crappie'), 'Crappie');
  // Not a fish the app's list carries.
  for (const raw of ['Tui Chub (lake)', 'Northern Pikeminnow (lake)', 'Warner Sucker (lake)', 'Goose Lake (lake)', 'Klamath Lake Sculpin', '  ']) assert.equal(listName(raw), null, raw);
  for (const [code, name] of Object.entries(NV_CODES)) assert.equal(listName(name), name, `Nevada code ${code}`);
});

test('shareWord: a telling word in common, not "lake" or "upper"', () => {
  assert.ok(shareWord('Topaz Lake', 'Topaz Reservoir'));
  assert.ok(!shareWord('Upper Twin Lake', 'Upper Blue Lake'));
  assert.ok(!shareWord('Wild Horse Reservoir', 'Wildhorse Reservoir'));
});

const POOL = pointsFor(
  [{ id: '1', name: 'Diamond Lake', lat: 43.16, lon: -122.15 }, { id: '2', name: 'Diamond Lake', lat: 44.9, lon: -117.2 }, { id: '3', name: 'Lake Owyhee', lat: 43.47, lon: -117.34 }, { id: '4', name: 'No Point Lake', lat: null, lon: null }],
  [{ id: 'diamond', name: 'Diamond Lake', lat: 43.17, lon: -122.14, county: 'Douglas' }, { id: 'abel-creek', name: 'Abel Creek', lat: null, lon: null, county: null, counties: 'Western region' },
    { id: 'cottonwood-creek', name: 'Cottonwood Creek', lat: null, lon: null, county: null }, { id: 9, name: 'Dry Lake', counties: 'Del Norte', lat: 41.7, lon: -123.9 }, { id: 10, name: 'Dry Lake', counties: 'Modoc, Lassen', lat: 41.5, lon: -120.9 }]);

test('pointsFor: lakes that have a point, every stocked water', () => {
  assert.deepEqual(POOL.map(p => p.key), ['n:1', 'n:2', 'n:3', 's:diamond', 's:abel-creek', 's:cottonwood-creek', 's:9', 's:10']);
  assert.equal(POOL[2].k, 'owyheelake');
});

test('matcher: a record with a map point takes the waters of its name nearby', () => {
  const find = matcher(POOL);
  assert.deepEqual(find({ name: 'Diamond Lake', lat: 43.165, lon: -122.145 }).sort(), ['n:1', 's:diamond']);
  assert.deepEqual(find({ name: 'Diamond Lake', lat: 44.9, lon: -117.21 }), ['n:2']);
  assert.deepEqual(find({ name: 'Diamond Lake', lat: 40, lon: -120 }), []);
  // A different name only when asked for, close by, and sharing a telling word.
  assert.deepEqual(find({ name: 'Owyhee Reservoir', lat: 43.48, lon: -117.34 }), []);
  assert.deepEqual(find({ name: 'Owyhee Reservoir', lat: 43.48, lon: -117.34 }, { nearKm: 2.5 }), ['n:3']);
  assert.deepEqual(find({ name: 'Owyhee Reservoir', lat: 43.9, lon: -117.34 }, { nearKm: 2.5 }), []);
});

test('matcher: a stocked water with no map point is reached by a name that is one place', () => {
  const find = matcher(POOL);
  assert.deepEqual(find({ name: 'ABEL CREEK', lat: 39, lon: -119, county: 'Carson City' }), ['s:abel-creek']);
  // The source has several creeks of this name: none of them is surely this one.
  assert.deepEqual(find({ name: 'Cottonwood Creek', lat: 39, lon: -119 }, { unique: false }), []);
});

test('matcher: a record with no map point needs its county, or a name that is one place', () => {
  const find = matcher(POOL);
  assert.deepEqual(find({ name: 'Dry Lake', county: 'Del Norte' }), ['s:9']);
  assert.deepEqual(find({ name: 'Dry Lake', county: 'Lassen' }), ['s:10']);
  assert.deepEqual(find({ name: 'Dry Lake' }), []); // two places
  assert.deepEqual(find({ name: 'Diamond Lake' }), []); // two places
  assert.deepEqual(find({ name: 'Owyhee Lake' }), ['n:3']);
  assert.deepEqual(find({ name: 'Abel Creek' }), ['s:abel-creek']);
  assert.deepEqual(find({ name: 'Nowhere Pond' }), []);
});

test('nvCodes: the row\'s codes in the layer\'s order, trimmed, each once', () => {
  assert.deepEqual(nvCodes({ NAME: 'Rye Patch Reservoir', FISH1: 'RB', FISH2: 'CC', FISH3: ' YP', FISH4_: 'LMB', FISH5: 'SB', FISH6: ' ', FISH10: 'SB', FISH11: 'smb', FISHREGMP: 'X', STOCK_2010: 'YES' }), ['RB', 'CC', 'YP', 'LMB', 'SB', 'SMB']);
  assert.deepEqual(nvCodes({ FISH1: null, FISH2: '' }), []);
});

test('recordNote: the record as a few words', () => {
  assert.equal(recordNote(['Trout, Cutthroat', 24, 12, 1977]), 'record 24 lb 12 oz, 1977');
  assert.equal(recordNote(['Trout, Brook', 0, 6, 2015]), 'record 6 oz, 2015');
  assert.equal(recordNote(['Bass, Largemouth', 5, 0, null]), 'record 5 lb');
});

// Words as pdftotext -bbox writes them, laid out in the document's seven columns.
const word = (x, y, t) => `<word xMin="${x}" yMin="${y}" xMax="${x + t.length * 5}" yMax="${y + 9}">${t}</word>`;
const line = (y, cells) => cells.flatMap(([x, text]) => text.split(' ').map((t, i, all) => word(x + all.slice(0, i).join(' ').length * 5 + (i ? 5 : 0), y, t))).join('\n');
const X = [70, 120, 210, 330, 440, 530, 640];
const row = (y, cells) => line(y, cells.map((t, i) => [X[i], t]).filter(([, t]) => t));
const PAGE = `<page width="792" height="612">
${word(70, 20, '2026')} ${word(100, 20, 'Provisional')} ${word(160, 20, 'Stocking')}
${row(60, ['REGION', 'COUNTY', 'WATER', 'SPECIES', 'SIZE', 'PROGRAM', 'MONTH'])}
${row(80, ['R1', 'Del Norte', 'Dry Lake', 'Rainbow Trout', 'Catchable', 'Put and Take', 'April-June'])}
${row(100, ['R2', 'El Dorado', 'Loon Lake', 'Brown Trout', 'Sub-catchable', 'Put and Grow', 'May-June &'])}
${row(110, ['', '', '', '', '', '', 'October'])}
${row(130, ['R6', 'Mono', 'Crowley Lake', 'Lahontan Cutthroat', 'Fingerling', 'Put and Grow', 'August-September'])}
${line(141, [[X[6], '26 | P a g e']])}
${row(140, ['', '', '', 'Trout', '', '', ''])}
${word(700, 580, '4|Page')}
</page>`;

test('parsePlan: one row per region line, wrapped cells joined, the year from the title', () => {
  const { year, rows } = parsePlan(`<doc>${PAGE}</doc>`);
  assert.equal(year, 2026);
  assert.deepEqual(rows, [
    { region: 'R1', county: 'Del Norte', water: 'Dry Lake', species: 'Rainbow Trout', size: 'Catchable', program: 'Put and Take', months: 'April-June' },
    { region: 'R2', county: 'El Dorado', water: 'Loon Lake', species: 'Brown Trout', size: 'Sub-catchable', program: 'Put and Grow', months: 'May-June & October' },
    { region: 'R6', county: 'Mono', water: 'Crowley Lake', species: 'Lahontan Cutthroat Trout', size: 'Fingerling', program: 'Put and Grow', months: 'August-September' }]);
  assert.equal(planNote(rows[1]), 'sub-catchable, May to June and October');
  assert.deepEqual(parsePlan('<doc><page width="1" height="1"></page></doc>').rows, []);
});

test('fhdNote: wild or hatchery in plain words; a fish that is only history is left out', () => {
  assert.equal(fhdNote({ fhdOrig: 'NonNative', fhdProd: 'Hatchery', fhdUseTy: 'ResidentMultipleUses' }), 'introduced, hatchery');
  assert.equal(fhdNote({ fhdOrig: 'NativeLocal', fhdProd: 'Natural' }), 'native, wild');
  assert.equal(fhdNote({ fhdOrig: 'NativeNonLocal', fhdProd: 'Mixed' }), 'introduced, wild and hatchery');
  assert.equal(fhdNote({ fhdOrig: 'Unknown', fhdProd: 'Unknown' }), '');
  assert.equal(fhdNote({ fhdOrig: 'NativeLocal', fhdProd: 'Natural', fhdUseTy: 'Historical' }), null);
});

test('pointOf: a point, the middle of a line, the middle of an outline\'s box', () => {
  assert.deepEqual(pointOf({ x: -120.123456, y: 39.5 }), { lat: 39.5, lon: -120.12346 });
  assert.deepEqual(pointOf({ paths: [[[-120, 39]], [[-121, 40], [-121.5, 40.5], [-122, 41]]] }), { lat: 40.5, lon: -121.5 });
  assert.deepEqual(pointOf({ rings: [[[-120, 39], [-121, 39], [-121, 40], [-120, 40]]] }), { lat: 39.5, lon: -120.5 });
  assert.deepEqual(pointOf(null), { lat: null, lon: null });
});

test('namesFrom: CDFW\'s name for a water id, else the USGS one', () => {
  const names = namesFrom([{ attributes: { DFGWATERID: 26575, NAME: 'Lake Oroville', GNIS_NAME: 'Lake Oroville' } }, { attributes: { DFGWATERID: 4425, NAME: 'Lake Elizabeth', GNIS_NAME: 'Lagoon, The' } },
    { attributes: { DFGWATERID: 7, NAME: ' ', GNIS_NAME: 'Stampede  Reservoir' } }, { attributes: { DFGWATERID: 8, NAME: ' ', GNIS_NAME: ' ' } }, { attributes: { DFGWATERID: 12438, NAME: 'Lake Of The Woods', GNIS_NAME: ' ' } }]);
  assert.deepEqual([...names], [[26575, 'Lake Oroville'], [4425, 'Lake Elizabeth'], [7, 'Stampede Reservoir'], [12438, 'Lake of the Woods']]);
  assert.deepEqual([...namesFrom(undefined)], []);
});

test('matcher: a big lake answers to a kindred name from farther out, in step with its size', () => {
  const find = matcher(pointsFor([{ id: 'bc', name: 'Lake Billy Chinook', lat: 44.58, lon: -121.3, acres: 3900 }, { id: 'sm', name: 'Chinook Pond', lat: 44.0, lon: -121.0, acres: 3 }], []));
  // 3.9 km from the lake's point: past 2.5 km, inside twice the radius of a 3,900-acre lake.
  assert.deepEqual(find({ name: 'Billy Chinook Reservoir', lat: 44.615, lon: -121.3 }, { nearKm: 2.5 }), ['n:bc']);
  assert.deepEqual(find({ name: 'Chinook Slough Pond', lat: 44.035, lon: -121.0 }, { nearKm: 2.5 }), []);
});

test('matcher: on asks for the lake a record\'s point lies on, whatever its name, when nothing of its name is near', () => {
  const find = matcher(pointsFor([{ id: 'aw', name: 'Acorn Woman Lakes', lat: 42.04, lon: -123.02, acres: 60 }, { id: 'sr', name: 'Sunrise Lake', lat: 43.9, lon: -122.0, acres: 2 }], []));
  assert.deepEqual(find({ name: 'Squaw Lakes', lat: 42.0404, lon: -123.02 }), []);
  assert.deepEqual(find({ name: 'Squaw Lakes', lat: 42.0404, lon: -123.02 }, { on: true }), ['n:aw']); // renamed; 45 m from its point
  assert.deepEqual(find({ name: 'Sunup Lake', lat: 43.9015, lon: -122.0 }, { on: true }), ['n:sr']); // 170 m from a small lake's point: the same water
  assert.deepEqual(find({ name: 'Sunset Lake', lat: 43.9045, lon: -122.0 }, { on: true }), []); // a neighbour 500 m off a 2-acre lake
});

test('extraLakes: the lakes a state maps that the app has no water for, one per place, streams and other states left out', () => {
  const square = [[-124, 42], [-117, 42], [-117, 46], [-124, 46]];
  const list = extraLakes([
    { name: 'Delta Park Ponds ', lat: 45.599, lon: -122.683 }, { name: 'Delta Park Ponds', lat: 45.602, lon: -122.688 }, { name: 'Delta Park Ponds', lat: 45.599, lon: -122.692 },
    { name: 'Twin Ponds', lat: 44.5, lon: -118.5 }, { name: 'Twin Ponds', lat: 43.1, lon: -121.9 },
    { name: 'Serres Reservoir', lat: 45.137, lon: -122.825 },
    { name: 'Cottonwood Creek', lat: 42.3, lon: -120.4 }, { name: 'Hutton Spring', lat: 42.9, lon: -120.1 }, { name: 'Unnamed trib to Thomas Creek', lat: 44.7, lon: -122.6 }, { name: 'Rogue River Bay', lat: 42.42, lon: -124.42 },
    { name: 'Lake Wallula', lat: 46.22, lon: -118.96 }, // Washington's side
    { name: 'Woodburn Pond', lat: 45.137, lon: -122.825 }, // a second name for the spot Serres Reservoir is on
    { name: 'Squaw Lake', lat: 43.0, lon: -122.5 }, // a name the state has since retired: the lake is on the map under its new one
  ], square, 'odfw');
  assert.deepEqual(list, [
    { id: 'odfw-deltaparkponds-4560-12269', name: 'Delta Park Ponds', type: 'Pond', lat: 45.6, lon: -122.68767, acres: null },
    { id: 'odfw-serresreservoir-4514-12283', name: 'Serres Reservoir', type: 'Reservoir', lat: 45.137, lon: -122.825, acres: null },
    { id: 'odfw-twinponds-4310-12190', name: 'Twin Ponds', type: 'Pond', lat: 43.1, lon: -121.9, acres: null },
    { id: 'odfw-twinponds-4450-11850', name: 'Twin Ponds', type: 'Pond', lat: 44.5, lon: -118.5, acres: null },
  ]);
});
