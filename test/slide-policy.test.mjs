import assert from 'node:assert/strict';
import test from 'node:test';
import { localRendererPolicy } from '../engine/slide-policy.mjs';

test('renderer capability is opt-in, same-origin only, with no script relaxation', () => {
  for (const localRenderer of [undefined, false, 'true', 1, '*']) {
    assert.equal(localRendererPolicy({ localRenderer }), "connect-src 'none';");
  }
  const policy = localRendererPolicy({ localRenderer: true });
  assert.equal(policy, "connect-src 'self'; worker-src 'self' blob:;");
  assert.ok(!policy.includes('unsafe-eval'));
  assert.ok(!policy.includes('https:'));
});
