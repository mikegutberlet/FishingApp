import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryFor, kindOf, noteFor, placesFrom, MIN } from '../build-state-access.mjs';

test('the query asks for one state by its ISO code', () => {
  assert.match(queryFor('nv'), /area\["ISO3166-2"="US-NV"\]/); assert.match(queryFor('OR'), /"US-OR"/); assert.match(queryFor('ca'), /"US-CA"/);
  assert.throws(() => queryFor('wa'), /state/);
  assert.deepEqual(Object.keys(MIN).sort(), ['ca', 'nv', 'or']);
});
test('what kind of place a set of tags is', () => {
  assert.equal(kindOf({ leisure: 'slipway' }), 'ramp'); assert.equal(kindOf({ leisure: 'fishing' }), 'pier'); assert.equal(kindOf({ man_made: 'pier', fishing: 'yes' }), 'pier');
  assert.equal(kindOf({ tourism: 'camp_site' }), 'camp'); assert.equal(kindOf({ leisure: 'marina' }), 'marina'); assert.equal(kindOf({ amenity: 'boat_rental' }), 'rental');
  assert.equal(kindOf({ shop: 'fishing' }), 'tackle'); assert.equal(kindOf({ amenity: 'parking' }), 'parking'); assert.equal(kindOf({ amenity: 'cafe' }), null);
});
test('the note under a name', () => {
  assert.equal(noteFor('ramp', { fee: 'yes', charge: '10 USD', trailer: 'no', surface: 'concrete', toilets: 'yes' }), 'fee 10 USD · no trailers (car-top) · concrete · restrooms');
  assert.equal(noteFor('camp', { fee: 'no', operator: 'BLM', opening_hours: '24/7' }), 'free · BLM · open 24 h');
});
test('places from the service\'s answer', () => {
  const { places, counts } = placesFrom([
    { type: 'node', lat: 39.4, lon: -119.1, tags: { leisure: 'slipway', name: 'North Shore Ramp', fee: 'yes' } },
    { type: 'way', center: { lat: 39.40001, lon: -119.10001 }, tags: { leisure: 'slipway' } },           // the same ramp drawn as a way
    { type: 'way', center: { lat: 38.123456, lon: -118.5 }, tags: { tourism: 'camp_site', name: 'Sportsman\'s Beach' } },
    { type: 'node', lat: 39.5, lon: -119.2, tags: { leisure: 'slipway', access: 'private' } },             // not for the public
    { type: 'node', lat: 39.6, lon: -119.3, tags: { amenity: 'cafe' } },                                    // not an access place
    { type: 'way', tags: { leisure: 'marina' } },                                                           // no position
    { type: 'node', lat: 39.7, lon: -119.4 },                                                               // no tags
  ]);
  assert.deepEqual(places, [[38.12346, -118.5, 'camp', 'Sportsman\'s Beach', ''], [39.4, -119.1, 'ramp', 'North Shore Ramp', 'fee']]);
  assert.deepEqual(counts, { ramp: 1, camp: 1 });
});
