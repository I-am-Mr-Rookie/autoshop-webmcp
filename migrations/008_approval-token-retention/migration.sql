ALTER TABLE approval_tokens DROP CONSTRAINT approval_tokens_action_id_fkey;
ALTER TABLE approval_tokens ADD CONSTRAINT approval_tokens_action_id_fkey
  FOREIGN KEY (action_id) REFERENCES pending_actions(id) ON DELETE CASCADE;
