import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATES, STATE_TRANSITIONS, canTransition } from '../domain.js';

test('freezes the five minimal AutoShop lifecycles', () => {
  assert.deepEqual(INITIAL_STATES, {
    order: 'requested',
    mandate: 'active',
    pending: 'pending',
    approval: 'active',
    receipt: 'issued'
  });

  assert.equal(canTransition('order', 'requested', 'accepted'), true);
  assert.equal(canTransition('order', 'requested', 'pending'), true);
  assert.equal(canTransition('order', 'pending', 'eligible'), true);
  assert.equal(canTransition('order', 'eligible', 'accepted'), true);
  assert.equal(canTransition('order', 'accepted', 'requested'), false);

  assert.equal(canTransition('mandate', 'active', 'superseded'), true);
  assert.equal(canTransition('pending', 'pending', 'approved'), true);
  assert.equal(canTransition('pending', 'pending', 'eligible'), true);
  assert.equal(canTransition('pending', 'approved', 'committed'), true);
  assert.equal(canTransition('pending', 'eligible', 'committed'), true);
  assert.equal(canTransition('approval', 'active', 'consumed'), true);
  assert.equal(canTransition('receipt', 'issued', 'voided'), false);

  assert.equal(canTransition('order', 'missing', 'accepted'), false);
  assert.equal(canTransition('missing', 'active', 'consumed'), false);
  assert.ok(Object.isFrozen(STATE_TRANSITIONS.order.requested));
});
