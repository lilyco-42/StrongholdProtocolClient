import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forEachLimited } from '../shell/picker-core.js';

test('picker refresh caps simultaneous server probes and visits each entry', async () => {
  const items = Array.from({ length: 11 }, (_, i) => i);
  const seen = [];
  let active = 0, peak = 0;
  await forEachLimited(items, 2, async item => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, item % 3 + 1));
    seen.push(item);
    active--;
  });
  assert.equal(peak, 2);
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test('empty list causes no work; invalid limit is one worker', async () => {
  let active = 0, peak = 0, calls = 0;
  await forEachLimited([], 2, async () => { throw Error('should not run'); });
  await forEachLimited([1, 2, 3], 0, async () => {
    active++; peak = Math.max(peak, active); calls++;
    await Promise.resolve(); active--;
  });
  assert.equal(calls, 3);
  assert.equal(peak, 1);
});

test('probe failures propagate, never silently become success', async () => {
  await assert.rejects(
    forEachLimited([1], 2, async () => { throw new Error('bad probe'); }),
    /bad probe/,
  );
});
