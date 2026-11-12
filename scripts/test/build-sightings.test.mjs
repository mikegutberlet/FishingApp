import test from 'node:test';
import assert from 'node:assert/strict';
import { radiusM, reachOf, licenceOf, tally, openOnly, taxonKeyOf, queryOf, FISH } from '../build-sightings.mjs';

test('radiusM: how far from a water\'s map point a sighting still counts, from its size', () => {
  assert.equal(radiusM(null), 400);
  assert.equal(radiusM(3), 400);
  assert.equal(radiusM(100), 717);
  assert.equal(radiusM(133931), 10000);
});

test('reachOf: every located water with its reach; a stocked water with no size borrows its lake\'s', () => {
  const lakes = [{ id: '7', name: 'Wild Horse Reservoir', lat: 41.67, lon: -115.8, acres: 2830 }, { id: '8', name: 'Tiny Pond', lat: 40, lon: -116, acres: null }];
  const stocked = [{ id: 'wild-horse', name: 'Wild Horse Reservoir', lat: 41.68, lon: -115.81, acres: null }, { id: 'far', name: 'Wild Horse Reservoir', lat: 39, lon: -118 }, { id: 'nowhere', name: 'Abel Creek', lat: null, lon: null }];
  const pts = reachOf(lakes, stocked);
  assert.deepEqual(pts.map(p => [p.key, p.r]), [['n:7', radiusM(2830)], ['n:8', 400], ['s:wild-horse', radiusM(2830)], ['s:far', 400]]);
});

test('licenceOf: the three licences sighting records carry', () => {
  assert.equal(licenceOf('http://creativecommons.org/licenses/by-nc/4.0/legalcode'), 'CC BY-NC 4.0');
  assert.equal(licenceOf('http://creativecommons.org/licenses/by/4.0/legalcode'), 'CC BY 4.0');
  assert.equal(licenceOf('http://creativecommons.org/publicdomain/zero/1.0/legalcode'), 'CC0 1.0');
  assert.equal(licenceOf('CC_BY_NC_4_0'), 'CC BY-NC 4.0');
  assert.equal(licenceOf(''), null);
});

test('tally: sightings within a water\'s reach, counted per fish and collection with the latest year', () => {
  const pts = [{ key: 'n:1', lat: 40, lon: -120, r: 500 }, { key: 's:1', lat: 40.001, lon: -120, r: 400 }, { key: 'n:2', lat: 41, lon: -120, r: 400 }];
  const rec = (o = {}) => ({ name: 'Brown trout', lat: 40.002, lon: -120, year: 2020, dataset: 'inat', licence: 'CC BY-NC 4.0', ...o });
  const { fish, datasets } = tally([
    rec(), rec({ year: 2024 }), rec({ year: 1961, dataset: 'museum', licence: 'CC0 1.0' }),
    rec({ name: 'Bluegill', lat: 40.0044, lon: -120 }), // 490 m from n:1, 380 m from s:1
    rec({ lat: 40.5 }), // near nothing
    rec({ uncertainty: 28000 }), // a place hidden by its observer
    rec({ uncertainty: 30, lat: 41, year: null }),
    rec({ licence: null }), // no licence, no use
  ], pts);
  assert.deepEqual(datasets, ['inat', 'museum']);
  assert.deepEqual(fish, {
    'n:1': [['Brown trout', 'seen', 0, 2024, 2], ['Brown trout', 'seen', 1, 1961, 1], ['Bluegill', 'seen', 0, 2020, 1]],
    's:1': [['Brown trout', 'seen', 0, 2024, 2], ['Brown trout', 'seen', 1, 1961, 1], ['Bluegill', 'seen', 0, 2020, 1]],
    'n:2': [['Brown trout', 'seen', 0, null, 1]],
  });
});

test('openOnly: the file without the records licensed for non-commercial use only', () => {
  const file = { updatedAt: 'x', sources: [{ label: 'A', licence: 'CC BY-NC 4.0' }, { label: 'B', licence: 'CC0 1.0' }, { label: 'C', licence: 'CC BY 4.0' }],
    fish: { 'n:1': [['Brown trout', 'seen', 0, 2024, 2], ['Brown trout', 'seen', 2, 1961, 1]], 'n:2': [['Bluegill', 'seen', 0, 2020, 1]], 'n:3': [['Carp', 'seen', 1, 1999, 4]] } };
  assert.deepEqual(openOnly(file), { updatedAt: 'x', sources: [{ label: 'B', licence: 'CC0 1.0' }, { label: 'C', licence: 'CC BY 4.0' }],
    fish: { 'n:1': [['Brown trout', 'seen', 1, 1961, 1]], 'n:3': [['Carp', 'seen', 0, 1999, 4]] } });
});

test('FISH: every fish looked for is one the app\'s list carries, under the app\'s name', async () => {
  const { listName } = await import('../build-species.mjs');
  assert.ok(FISH.length > 30);
  for (const [sci, name] of FISH) { assert.match(sci, /^[A-Z][a-z]+ [a-z]+$/); assert.equal(listName(name), name, name); }
});

test('taxonKeyOf: only a species GBIF knows by that name; a name it can only place in a wider group is no match', () => {
  assert.equal(taxonKeyOf({ matchType: 'EXACT', rank: 'SPECIES', usageKey: 8215487 }), 8215487);
  assert.equal(taxonKeyOf({ matchType: 'EXACT', rank: 'SPECIES', usageKey: 5, acceptedUsageKey: 9 }), 9);
  assert.equal(taxonKeyOf({ matchType: 'HIGHERRANK', rank: 'KINGDOM', usageKey: 1 }), null); // would otherwise ask for every animal in the state
  assert.equal(taxonKeyOf({ matchType: 'EXACT', rank: 'GENUS', usageKey: 2351426 }), null);
  assert.equal(taxonKeyOf({ matchType: 'NONE' }), null);
});

test('queryOf: a fish by GBIF\'s key for it, or by the name as recorded when GBIF has not filed that name yet', () => {
  assert.deepEqual(queryOf('Salmo trutta', { matchType: 'EXACT', rank: 'SPECIES', usageKey: 8215487 }), { taxonKey: 8215487 });
  // Largemouth bass under its newer name sits unfiled in the bass genus.
  assert.deepEqual(queryOf('Micropterus nigricans', { matchType: 'HIGHERRANK', rank: 'KINGDOM', usageKey: 1 }), { verbatimScientificName: 'Micropterus nigricans' });
});
