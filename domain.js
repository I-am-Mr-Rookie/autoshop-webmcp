const freezeGraph = graph => Object.freeze(Object.fromEntries(
  Object.entries(graph).map(([entity, states]) => [entity, Object.freeze(Object.fromEntries(
    Object.entries(states).map(([state, next]) => [state, Object.freeze(next)])
  ))])
));

export const INITIAL_STATES = Object.freeze({
  order: 'requested',
  mandate: 'active',
  pending: 'pending',
  approval: 'active',
  receipt: 'issued'
});

export const STATE_TRANSITIONS = freezeGraph({
  order: {
    requested: ['accepted', 'pending', 'cancelled', 'rejected'],
    pending: ['eligible', 'accepted', 'cancelled', 'rejected'],
    eligible: ['pending', 'accepted', 'cancelled', 'rejected'],
    accepted: [],
    cancelled: [],
    rejected: []
  },
  mandate: { active: ['superseded'], superseded: [] },
  pending: {
    pending: ['eligible', 'approved', 'replaced'],
    eligible: ['pending', 'committed', 'replaced'],
    approved: ['committed', 'replaced'],
    committed: [],
    replaced: []
  },
  approval: { active: ['consumed', 'expired', 'invalidated'], consumed: [], expired: [], invalidated: [] },
  receipt: { issued: [] }
});

export const canTransition = (entity, from, to) => STATE_TRANSITIONS[entity]?.[from]?.includes(to) ?? false;
