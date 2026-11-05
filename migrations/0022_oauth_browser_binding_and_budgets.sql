-- Existing unbound login transactions expire naturally; owner sessions survive.
ALTER TABLE oauth_states ADD COLUMN browser_hash TEXT;
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE request_budgets (
  budget_key TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  admission_id TEXT
);
CREATE INDEX request_budgets_expiry ON request_budgets(expires_at);
