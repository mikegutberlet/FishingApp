import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStocked } from '../../states/ca.js';

// near: stocked waters around the lake, nearest first, as nearestWaters returns them.
const clear = { name: 'Clear Lake', kind: 'lake', acres: 39651 };

test('pickStocked: a stocked water of the same name near the lake is the lake', () => {
  const near = [{ id: 1, name: 'Cache Creek', distKm: 3 }, { id: 2, name: 'Clear Lake', distKm: 6 }];
  assert.equal(pickStocked(clear, near).id, 2);
});

test('pickStocked: a differently named water counts only when it lies on the lake itself', () => {
  // Indian Valley Reservoir is 22 km from the middle of Clear Lake: a neighbour, not the lake.
  assert.equal(pickStocked(clear, [{ id: 2055, name: 'Indian Valley Reservoir', distKm: 21.8 }]), null);
  assert.equal(pickStocked({ name: 'Mono Lake', kind: 'lake', acres: 45124 }, [{ id: 3, name: 'Lee Vining Creek', distKm: 11.9 }]), null);
  assert.equal(pickStocked({ name: 'Red Lake', kind: 'lake', acres: 8 }, [{ id: 4, name: 'Virginia Lake Lower', distKm: 0.3 }]), null);
  // The schedule's own name for the same water, at the same spot.
  assert.equal(pickStocked({ name: 'Newport Reservoir', kind: 'lake', acres: 48 }, [{ id: 5, name: 'Big Creek Reservoir 2', distKm: 0.2 }]).id, 5);
});

test('pickStocked: a water the schedule doesn\'t name can be the lake from a little farther out, not from across the basin', () => {
  assert.equal(pickStocked({ name: 'Pardee Reservoir', kind: 'lake', acres: 1562 }, [{ id: 3124, name: 'CDFW water #3124', distKm: 1.8 }]).id, 3124);
  assert.equal(pickStocked({ name: 'Mud Lake', kind: 'lake', acres: 5 }, [{ id: 9, name: 'CDFW water #9', distKm: 0.4 }]).id, 9);
  assert.equal(pickStocked({ name: 'Mud Lake', kind: 'lake', acres: 5 }, [{ id: 9, name: 'CDFW water #9', distKm: 2 }]), null);
  assert.equal(pickStocked({ name: 'Lake Tahoe', kind: 'lake', acres: 122975 }, [{ id: 14214, name: 'CDFW water #14214', distKm: 21.4 }]), null);
});

test('pickStocked: a river only takes a stocked water of its name', () => {
  assert.equal(pickStocked({ name: 'Owens River', kind: 'river' }, [{ id: 7, name: 'Pleasant Valley Reservoir', distKm: 0.5 }]), null);
  assert.equal(pickStocked({ name: 'Owens River', kind: 'river' }, [{ id: 8, name: 'Owens River, Lower', distKm: 12 }]).id, 8);
});
