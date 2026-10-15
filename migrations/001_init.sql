CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner          text NOT NULL,
  currency       text NOT NULL,
  name           text NOT NULL CHECK (name IN ('available', 'locked', 'external')),
  allow_negative boolean NOT NULL DEFAULT false,
  balance        numeric(78,0) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, currency, name),
  CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  memo            text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_lines (
  id         bigserial PRIMARY KEY,
  entry_id   uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  direction  char(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount     numeric(78,0) NOT NULL CHECK (amount > 0)
);
CREATE INDEX ledger_lines_entry_idx ON ledger_lines(entry_id);
CREATE INDEX ledger_lines_account_idx ON ledger_lines(account_id);

-- Ledger lines and entries are append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger tables are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_lines_immutable BEFORE UPDATE OR DELETE ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE withdrawals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  currency        text NOT NULL,
  amount          numeric(78,0) NOT NULL CHECK (amount > 0),
  destination     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  idempotency_key text NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
