import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { LedgerError } from './errors.js';
import { withTx } from './db.js';

export type AccountName = 'available' | 'locked' | 'external';
export interface AccountRef {
  owner: string;
  currency: string;
  name: AccountName;
}
export interface Line {
  account: AccountRef;
  direction: 'D' | 'C';
  amount: bigint;
}
export interface EntryInput {
  kind: string;
  key: string;
  requestHash: string;
  memo?: string;
  metadata?: Record<string, unknown>;
  lines: Line[];
}
export interface EntryResult {
  entryId: string;
  replayed: boolean;
}

const SYSTEM = 'system';
const acct = (owner: string, currency: string, name: AccountName): AccountRef => ({ owner, currency, name });
const external = (currency: string): AccountRef => acct(SYSTEM, currency, 'external');
const refKey = (r: AccountRef) => `${r.owner}|${r.currency}|${r.name}`;

export const hashRequest = (payload: Record<string, string>): string =>
  createHash('sha256').update(JSON.stringify(Object.entries(payload).sort())).digest('hex');

async function ensureAccounts(c: PoolClient, refs: AccountRef[]): Promise<Map<string, { id: string; allowNegative: boolean }>> {
  // Deterministic creation order avoids deadlocks between concurrent transactions.
  const unique = [...new Map(refs.map((r) => [refKey(r), r])).values()].sort((a, b) => refKey(a).localeCompare(refKey(b)));
  const out = new Map<string, { id: string; allowNegative: boolean }>();
  for (const r of unique) {
    await c.query(
      `INSERT INTO accounts(owner, currency, name, allow_negative) VALUES ($1, $2, $3, $4) ON CONFLICT (owner, currency, name) DO NOTHING`,
      [r.owner, r.currency, r.name, r.owner === SYSTEM],
    );
    const res = await c.query('SELECT id, allow_negative FROM accounts WHERE owner = $1 AND currency = $2 AND name = $3', [r.owner, r.currency, r.name]);
    out.set(refKey(r), { id: res.rows[0].id, allowNegative: res.rows[0].allow_negative });
  }
  return out;
}

/**
 * Posts one balanced journal entry atomically. Must be called inside a transaction.
 * Balance convention: balance = credits - debits (user accounts are liabilities of the exchange).
 */
export async function postEntry(c: PoolClient, e: EntryInput): Promise<EntryResult> {
  if (e.lines.length < 2) throw new LedgerError(500, 'INVALID_ENTRY', 'an entry needs at least two lines');

  const perCurrency = new Map<string, bigint>();
  for (const l of e.lines) {
    if (l.amount <= 0n) throw new LedgerError(500, 'INVALID_ENTRY', 'line amounts must be positive');
    const signed = l.direction === 'C' ? l.amount : -l.amount;
    perCurrency.set(l.account.currency, (perCurrency.get(l.account.currency) ?? 0n) + signed);
  }
  for (const [currency, net] of perCurrency) {
    if (net !== 0n) throw new LedgerError(500, 'UNBALANCED_ENTRY', `debits and credits differ for ${currency}`);
  }

  const ins = await c.query(
    `INSERT INTO journal_entries(kind, idempotency_key, request_hash, memo, metadata)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [e.kind, e.key, e.requestHash, e.memo ?? null, JSON.stringify(e.metadata ?? {})],
  );
  if (ins.rowCount === 0) {
    const existing = await c.query('SELECT id, request_hash FROM journal_entries WHERE idempotency_key = $1', [e.key]);
    if (existing.rows[0].request_hash !== e.requestHash) {
      throw new LedgerError(409, 'IDEMPOTENCY_MISMATCH', 'idempotency key was already used with a different request');
    }
    return { entryId: existing.rows[0].id, replayed: true };
  }
  const entryId: string = ins.rows[0].id;

  const accounts = await ensureAccounts(c, e.lines.map((l) => l.account));
  const deltas = new Map<string, bigint>();
  for (const l of e.lines) {
    const id = accounts.get(refKey(l.account))!.id;
    deltas.set(id, (deltas.get(id) ?? 0n) + (l.direction === 'C' ? l.amount : -l.amount));
  }

  // Lock rows in a fixed order, then validate balances.
  const ids = [...deltas.keys()];
  const locked = await c.query(
    'SELECT id, balance::text AS balance, allow_negative, owner, currency, name FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  for (const row of locked.rows) {
    const next = BigInt(row.balance) + deltas.get(row.id)!;
    if (next < 0n && !row.allow_negative) {
      throw new LedgerError(422, 'INSUFFICIENT_FUNDS', 'insufficient funds', {
        owner: row.owner,
        currency: row.currency,
        account: row.name,
        available: row.balance,
      });
    }
  }
  for (const [id, delta] of deltas) {
    await c.query('UPDATE accounts SET balance = balance + $2::numeric, updated_at = now() WHERE id = $1', [id, delta.toString()]);
  }
  for (const l of e.lines) {
    await c.query('INSERT INTO ledger_lines(entry_id, account_id, direction, amount) VALUES ($1, $2, $3, $4::numeric)', [
      entryId,
      accounts.get(refKey(l.account))!.id,
      l.direction,
      l.amount.toString(),
    ]);
  }
  return { entryId, replayed: false };
}

// ---------- operations ----------

export interface Withdrawal {
  id: string;
  userId: string;
  currency: string;
  amount: string;
  destination: string;
  status: 'pending' | 'confirmed' | 'failed';
}
const WD_COLS = 'id, user_id, currency, amount::text AS amount, destination, status, request_hash';
const toWithdrawal = (r: any): Withdrawal => ({
  id: r.id,
  userId: r.user_id,
  currency: r.currency,
  amount: r.amount,
  destination: r.destination,
  status: r.status,
});

export class Ledger {
  constructor(private readonly pool: Pool) {}

  deposit(p: { userId: string; currency: string; amount: bigint; key: string; reference?: string }): Promise<EntryResult> {
    return withTx(this.pool, (c) =>
      postEntry(c, {
        kind: 'deposit',
        key: p.key,
        requestHash: hashRequest({ op: 'deposit', userId: p.userId, currency: p.currency, amount: p.amount.toString(), reference: p.reference ?? '' }),
        metadata: { reference: p.reference },
        lines: [
          { account: external(p.currency), direction: 'D', amount: p.amount },
          { account: acct(p.userId, p.currency, 'available'), direction: 'C', amount: p.amount },
        ],
      }),
    );
  }

  transfer(p: { fromUserId: string; toUserId: string; currency: string; amount: bigint; key: string }): Promise<EntryResult> {
    if (p.fromUserId === p.toUserId) throw new LedgerError(400, 'INVALID_TRANSFER', 'cannot transfer to the same user');
    return withTx(this.pool, (c) =>
      postEntry(c, {
        kind: 'transfer',
        key: p.key,
        requestHash: hashRequest({ op: 'transfer', from: p.fromUserId, to: p.toUserId, currency: p.currency, amount: p.amount.toString() }),
        lines: [
          { account: acct(p.fromUserId, p.currency, 'available'), direction: 'D', amount: p.amount },
          { account: acct(p.toUserId, p.currency, 'available'), direction: 'C', amount: p.amount },
        ],
      }),
    );
  }

  /** Move funds from available to locked, e.g. to back an open order. */
  hold(p: { userId: string; currency: string; amount: bigint; key: string; reference?: string }): Promise<EntryResult> {
    return this.moveBetweenBuckets('hold', 'available', 'locked', p);
  }

  /** Move funds from locked back to available, e.g. on order cancel. */
  release(p: { userId: string; currency: string; amount: bigint; key: string; reference?: string }): Promise<EntryResult> {
    return this.moveBetweenBuckets('release', 'locked', 'available', p);
  }

  private moveBetweenBuckets(
    op: string,
    from: AccountName,
    to: AccountName,
    p: { userId: string; currency: string; amount: bigint; key: string; reference?: string },
  ): Promise<EntryResult> {
    return withTx(this.pool, (c) =>
      postEntry(c, {
        kind: op,
        key: p.key,
        requestHash: hashRequest({ op, userId: p.userId, currency: p.currency, amount: p.amount.toString(), reference: p.reference ?? '' }),
        metadata: { reference: p.reference },
        lines: [
          { account: acct(p.userId, p.currency, from), direction: 'D', amount: p.amount },
          { account: acct(p.userId, p.currency, to), direction: 'C', amount: p.amount },
        ],
      }),
    );
  }

  /** Settles one trade atomically. The buyer's quote and the seller's base must already be locked. */
  settleTrade(p: {
    tradeId: string;
    buyerId: string;
    sellerId: string;
    baseCurrency: string;
    quoteCurrency: string;
    baseAmount: bigint;
    quoteAmount: bigint;
  }): Promise<EntryResult> {
    if (p.buyerId === p.sellerId) throw new LedgerError(400, 'INVALID_TRADE', 'buyer and seller must differ');
    if (p.baseCurrency === p.quoteCurrency) throw new LedgerError(400, 'INVALID_TRADE', 'base and quote currencies must differ');
    return withTx(this.pool, (c) =>
      postEntry(c, {
        kind: 'trade',
        key: `trade:${p.tradeId}`,
        requestHash: hashRequest({
          op: 'trade',
          buyer: p.buyerId,
          seller: p.sellerId,
          base: p.baseCurrency,
          quote: p.quoteCurrency,
          baseAmount: p.baseAmount.toString(),
          quoteAmount: p.quoteAmount.toString(),
        }),
        metadata: { tradeId: p.tradeId },
        lines: [
          { account: acct(p.buyerId, p.quoteCurrency, 'locked'), direction: 'D', amount: p.quoteAmount },
          { account: acct(p.sellerId, p.quoteCurrency, 'available'), direction: 'C', amount: p.quoteAmount },
          { account: acct(p.sellerId, p.baseCurrency, 'locked'), direction: 'D', amount: p.baseAmount },
          { account: acct(p.buyerId, p.baseCurrency, 'available'), direction: 'C', amount: p.baseAmount },
        ],
      }),
    );
  }

  /** Creates a pending withdrawal and locks the funds. */
  requestWithdrawal(p: { userId: string; currency: string; amount: bigint; destination: string; key: string }): Promise<{ withdrawal: Withdrawal; replayed: boolean }> {
    const requestHash = hashRequest({ op: 'withdraw', userId: p.userId, currency: p.currency, amount: p.amount.toString(), destination: p.destination });
    return withTx(this.pool, async (c) => {
      const ins = await c.query(
        `INSERT INTO withdrawals(user_id, currency, amount, destination, idempotency_key, request_hash)
         VALUES ($1, $2, $3::numeric, $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING ${WD_COLS}`,
        [p.userId, p.currency, p.amount.toString(), p.destination, p.key, requestHash],
      );
      if (ins.rowCount === 0) {
        const existing = await c.query(`SELECT ${WD_COLS} FROM withdrawals WHERE idempotency_key = $1`, [p.key]);
        if (existing.rows[0].request_hash !== requestHash) {
          throw new LedgerError(409, 'IDEMPOTENCY_MISMATCH', 'idempotency key was already used with a different request');
        }
        return { withdrawal: toWithdrawal(existing.rows[0]), replayed: true };
      }
      const w = ins.rows[0];
      await postEntry(c, {
        kind: 'withdrawal_hold',
        key: `wd:${w.id}:hold`,
        requestHash: hashRequest({ op: 'withdrawal_hold', id: w.id }),
        metadata: { withdrawalId: w.id },
        lines: [
          { account: acct(p.userId, p.currency, 'available'), direction: 'D', amount: p.amount },
          { account: acct(p.userId, p.currency, 'locked'), direction: 'C', amount: p.amount },
        ],
      });
      return { withdrawal: toWithdrawal(w), replayed: false };
    });
  }

  /** The chain transaction succeeded: the locked funds leave the exchange. */
  confirmWithdrawal(id: string): Promise<Withdrawal> {
    return this.finishWithdrawal(id, 'confirmed');
  }

  /** The withdrawal failed or was rejected: the locked funds return to available. */
  failWithdrawal(id: string): Promise<Withdrawal> {
    return this.finishWithdrawal(id, 'failed');
  }

  private finishWithdrawal(id: string, outcome: 'confirmed' | 'failed'): Promise<Withdrawal> {
    return withTx(this.pool, async (c) => {
      const res = await c.query(`SELECT ${WD_COLS} FROM withdrawals WHERE id = $1 FOR UPDATE`, [id]);
      if (res.rowCount === 0) throw new LedgerError(404, 'NOT_FOUND', 'withdrawal not found');
      const w = res.rows[0];
      if (w.status === outcome) return toWithdrawal(w);
      if (w.status !== 'pending') throw new LedgerError(409, 'INVALID_STATE', `withdrawal is already ${w.status}`);
      const amount = BigInt(w.amount);
      const lockedDebit: Line = { account: acct(w.user_id, w.currency, 'locked'), direction: 'D', amount };
      const credit: Line = {
        account: outcome === 'confirmed' ? external(w.currency) : acct(w.user_id, w.currency, 'available'),
        direction: 'C',
        amount,
      };
      await postEntry(c, {
        kind: `withdrawal_${outcome}`,
        key: `wd:${id}:${outcome}`,
        requestHash: hashRequest({ op: `withdrawal_${outcome}`, id }),
        metadata: { withdrawalId: id },
        lines: [lockedDebit, credit],
      });
      const upd = await c.query(`UPDATE withdrawals SET status = $2, updated_at = now() WHERE id = $1 RETURNING ${WD_COLS}`, [id, outcome]);
      return toWithdrawal(upd.rows[0]);
    });
  }

  async getBalances(userId: string): Promise<Record<string, { available: string; locked: string }>> {
    const res = await this.pool.query(
      `SELECT currency, name, balance::text AS balance FROM accounts WHERE owner = $1 ORDER BY currency`,
      [userId],
    );
    const out: Record<string, { available: string; locked: string }> = {};
    for (const r of res.rows) {
      out[r.currency] ??= { available: '0', locked: '0' };
      if (r.name === 'available' || r.name === 'locked') out[r.currency][r.name as 'available' | 'locked'] = r.balance;
    }
    return out;
  }

  /** Verifies the books: debits = credits per currency, cached balances = ledger-derived balances, no illegal negatives. */
  async reconcile() {
    const totals = await this.pool.query(
      `SELECT a.currency,
              COALESCE(SUM(CASE WHEN l.direction = 'D' THEN l.amount END), 0)::text AS debits,
              COALESCE(SUM(CASE WHEN l.direction = 'C' THEN l.amount END), 0)::text AS credits
         FROM ledger_lines l JOIN accounts a ON a.id = l.account_id
        GROUP BY a.currency ORDER BY a.currency`,
    );
    const mismatches = await this.pool.query(
      `SELECT a.id, a.owner, a.currency, a.name, a.balance::text AS cached,
              COALESCE(SUM(CASE WHEN l.direction = 'C' THEN l.amount ELSE -l.amount END), 0)::text AS derived
         FROM accounts a LEFT JOIN ledger_lines l ON l.account_id = a.id
        GROUP BY a.id HAVING a.balance <> COALESCE(SUM(CASE WHEN l.direction = 'C' THEN l.amount ELSE -l.amount END), 0)`,
    );
    const negatives = await this.pool.query(
      `SELECT id, owner, currency, name, balance::text AS balance FROM accounts WHERE balance < 0 AND NOT allow_negative`,
    );
    const currencies = totals.rows.map((r) => ({ currency: r.currency, debits: r.debits, credits: r.credits, balanced: r.debits === r.credits }));
    return {
      ok: currencies.every((c) => c.balanced) && mismatches.rowCount === 0 && negatives.rowCount === 0,
      currencies,
      balanceMismatches: mismatches.rows,
      illegalNegatives: negatives.rows,
    };
  }
}
