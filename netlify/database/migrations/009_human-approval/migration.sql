ALTER TABLE approval_tokens ADD CONSTRAINT approval_tokens_token_hash_format
  CHECK (token_hash ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX approval_tokens_token_hash_unique ON approval_tokens (token_hash);
CREATE UNIQUE INDEX approval_tokens_one_active_per_action ON approval_tokens (action_id)
  WHERE state = 'active';
