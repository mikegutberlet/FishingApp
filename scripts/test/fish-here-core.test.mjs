import test from 'node:test';
import assert from 'node:assert/strict';
import { listedRows, hereLines, HOW_SOURCE } from '../../fish-here-core.js';

const FILE = { sources: [{ label: 'State plan', url: 'https://example.org/plan' }, { label: 'Record book', url: 'https://example.org/book' }], fish: {
  'n:1': [['Rainbow trout', 'lives', 0, 'introduced, hatchery'], ['Largemouth bass', 'lives', 0]],
  's:9': [['Rainbow trout', 'plan', 0, 'catchable, April to June'], ['Rainbow trout', 'lives', 0, 'introduced, hatchery'], ['Brown trout', 'caught', 1, 'record 12 lb 9 oz, 1986']],
} };

test('listedRows: a lake and its stocked water together, each fish once per way it is known', () => {
  const rows = listedRows(FILE, ['n:1', null, 's:9', 'n:1']);
  assert.deepEqual(rows.map(r => `${r.name}/${r.how}`), ['Rainbow trout/lives', 'Largemouth bass/lives', 'Rainbow trout/plan', 'Brown trout/caught']);
  assert.deepEqual(rows[1], { name: 'Largemouth bass', how: 'lives', note: '', source: FILE.sources[0] });
  assert.equal(rows[3].source.label, 'Record book');
  assert.deepEqual(listedRows(FILE, ['n:404']), []);
  assert.deepEqual(listedRows(null, ['n:1']), []);
  assert.deepEqual(listedRows({ fish: { 'n:1': [['Kokanee', 'lives', 3]] } }, ['n:1']), [{ name: 'Kokanee', how: 'lives', note: '', source: null }]);
});

test('hereLines: one line per fish, stocked first, with how each is known and the sources once', () => {
  const { lines, sources } = hereLines(listedRows(FILE, ['n:1', 's:9']));
  assert.deepEqual(lines, [
    { name: 'Rainbow trout', tags: ['Stocking planned: catchable, April to June', 'Lives here (introduced, hatchery)'] },
    { name: 'Largemouth bass', tags: ['Lives here'] },
    { name: 'Brown trout', tags: ['Record 12 lb 9 oz, 1986'] }]);
  assert.deepEqual(sources.map(s => s.label), ['State plan', 'Record book']);
  assert.deepEqual(hereLines([]), { lines: [], sources: [] });
  assert.deepEqual(hereLines([{ name: 'Wiper', how: 'caught', note: '', source: null }]).lines, [{ name: 'Wiper', tags: ['Caught here'] }]);
});

test('HOW_SOURCE: a planned plant counts as stocking among a water\'s fish', () => {
  assert.deepEqual(HOW_SOURCE, { plan: 'stocked', lives: 'lives', caught: 'caught' });
});
