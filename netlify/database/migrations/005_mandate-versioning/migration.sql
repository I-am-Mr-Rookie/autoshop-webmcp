ALTER TABLE mandates ADD CONSTRAINT mandates_version_unique UNIQUE (version);
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_mandate_version_fkey
  FOREIGN KEY (mandate_version) REFERENCES mandates(version);

CREATE UNIQUE INDEX mandates_one_active ON mandates (state) WHERE state = 'active';
CREATE UNIQUE INDEX pending_actions_one_live_per_order ON pending_actions (order_id)
  WHERE state IN ('pending', 'eligible', 'approved');
