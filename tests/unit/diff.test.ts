import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countBy, diffClaimSets } from '../../src/worker/diff.js';
import { fakeClaim, resetIds } from '../helpers.js';

test('diffClaimSets: added / removed / changed / unchanged by claim_key', () => {
  resetIds();
  const from = [
    fakeClaim({ claimKey: 'same', verdict: 'accepts', statuses: [200, 200] }),
    fakeClaim({ claimKey: 'verdict-flips', verdict: 'accepts', statuses: [200, 200] }),
    fakeClaim({ claimKey: 'status-flips', verdict: 'observes', statuses: [200, 404] }),
    fakeClaim({ claimKey: 'gone', verdict: 'rejects', statuses: [200, 400] }),
  ];
  const to = [
    fakeClaim({ claimKey: 'same', verdict: 'accepts', statuses: [200, 200] }), // different trial ids, same statuses
    fakeClaim({ claimKey: 'verdict-flips', verdict: 'rejects', statuses: [200, 400] }),
    fakeClaim({ claimKey: 'status-flips', verdict: 'observes', statuses: [200, 200] }),
    fakeClaim({ claimKey: 'new', verdict: 'observes', statuses: [200] }),
  ];
  const entries = diffClaimSets(from, to);
  const byKey = Object.fromEntries(entries.map((e) => [e.claimKey, e.changeType]));
  assert.deepEqual(byKey, { same: 'unchanged', 'verdict-flips': 'changed', 'status-flips': 'changed', gone: 'removed', new: 'added' });
  assert.deepEqual(countBy(entries), { unchanged: 1, changed: 2, added: 1, removed: 1 });
  const changed = entries.find((e) => e.claimKey === 'verdict-flips')!;
  assert.equal(changed.from?.verdict, 'accepts');
  assert.equal(changed.to?.verdict, 'rejects');
  assert.deepEqual(entries.map((e) => e.claimKey), ['gone', 'new', 'same', 'status-flips', 'verdict-flips']); // sorted
});

test('diffClaimSets: empty sides', () => {
  resetIds();
  assert.deepEqual(diffClaimSets([], []), []);
  assert.deepEqual(diffClaimSets([fakeClaim({ claimKey: 'a' })], []).map((e) => e.changeType), ['removed']);
  assert.deepEqual(diffClaimSets([], [fakeClaim({ claimKey: 'a' })]).map((e) => e.changeType), ['added']);
});
