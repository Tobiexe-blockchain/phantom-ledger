import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Ledger } from '../src/ledger.js';
import { resetDb, setupDb } from './helpers.js';

let pool: Pool;
let ledger: Ledger;

beforeAll(async () => {
  pool = await setupDb();
  ledger = new Ledger(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const bal = async (user: string, currency = 'USDT') => (await ledger.getBalances(user))[currency] ?? { available: '0', locked: '0' };

describe('deposits', () => {
  it('credits the user and keeps the books balanced', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 1000n, key: 'dep-1' });
    expect(await bal('alice')).toEqual({ available: '1000', locked: '0' });
    const rec = await ledger.reconcile();
    expect(rec.ok).toBe(true);
    expect(rec.currencies).toEqual([{ currency: 'USDT', debits: '1000', credits: '1000', balanced: true }]);
  });

  it('is idempotent: replaying the same key credits once', async () => {
    const a = await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 500n, key: 'dep-1' });
    const b = await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 500n, key: 'dep-1' });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.entryId).toBe(a.entryId);
    expect((await bal('alice')).available).toBe('500');
  });

  it('rejects reuse of a key with a different payload', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 500n, key: 'dep-1' });
    await expect(ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 900n, key: 'dep-1' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
    });
    expect((await bal('alice')).available).toBe('500');
  });

  it('credits only once under concurrent requests with the same key', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'dep-same' })),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await bal('alice')).available).toBe('100');
  });
});

describe('transfers', () => {
  it('moves funds between users', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 1000n, key: 'd1' });
    await ledger.transfer({ fromUserId: 'alice', toUserId: 'bob', currency: 'USDT', amount: 250n, key: 't1' });
    expect((await bal('alice')).available).toBe('750');
    expect((await bal('bob')).available).toBe('250');
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('rejects insufficient funds and leaves balances untouched', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    await expect(
      ledger.transfer({ fromUserId: 'alice', toUserId: 'bob', currency: 'USDT', amount: 101n, key: 't1' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', status: 422 });
    expect((await bal('alice')).available).toBe('100');
    expect((await bal('bob')).available).toBe('0');
  });

  it('rejects transfers to self', () => {
    expect(() => ledger.transfer({ fromUserId: 'a', toUserId: 'a', currency: 'USDT', amount: 1n, key: 't' })).toThrow();
  });

  it('does not deadlock on opposing concurrent transfers', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 1000n, key: 'da' });
    await ledger.deposit({ userId: 'bob', currency: 'USDT', amount: 1000n, key: 'db' });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? ledger.transfer({ fromUserId: 'alice', toUserId: 'bob', currency: 'USDT', amount: 10n, key: `ab-${i}` })
          : ledger.transfer({ fromUserId: 'bob', toUserId: 'alice', currency: 'USDT', amount: 10n, key: `ba-${i}` }),
      ),
    );
    const total = BigInt((await bal('alice')).available) + BigInt((await bal('bob')).available);
    expect(total).toBe(2000n);
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('double spend protection', () => {
  it('never overdraws under concurrent withdrawals', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        ledger.requestWithdrawal({ userId: 'alice', currency: 'USDT', amount: 30n, destination: '0xabc', key: `w-${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    }
    expect(await bal('alice')).toEqual({ available: '10', locked: '90' });
    expect((await ledger.reconcile()).ok).toBe(true);
  });
});

describe('withdrawal lifecycle', () => {
  it('locks funds on request, then releases them to the chain on confirm', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    const { withdrawal } = await ledger.requestWithdrawal({ userId: 'alice', currency: 'USDT', amount: 60n, destination: '0xabc', key: 'w1' });
    expect(withdrawal.status).toBe('pending');
    expect(await bal('alice')).toEqual({ available: '40', locked: '60' });

    const done = await ledger.confirmWithdrawal(withdrawal.id);
    expect(done.status).toBe('confirmed');
    expect(await bal('alice')).toEqual({ available: '40', locked: '0' });
    expect((await ledger.confirmWithdrawal(withdrawal.id)).status).toBe('confirmed'); // idempotent
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('returns funds on failure and blocks invalid state changes', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    const { withdrawal } = await ledger.requestWithdrawal({ userId: 'alice', currency: 'USDT', amount: 60n, destination: '0xabc', key: 'w1' });
    await ledger.failWithdrawal(withdrawal.id);
    expect(await bal('alice')).toEqual({ available: '100', locked: '0' });
    await expect(ledger.confirmWithdrawal(withdrawal.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('replays a withdrawal request with the same key without locking twice', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    const a = await ledger.requestWithdrawal({ userId: 'alice', currency: 'USDT', amount: 60n, destination: '0xabc', key: 'w1' });
    const b = await ledger.requestWithdrawal({ userId: 'alice', currency: 'USDT', amount: 60n, destination: '0xabc', key: 'w1' });
    expect(b.replayed).toBe(true);
    expect(b.withdrawal.id).toBe(a.withdrawal.id);
    expect(await bal('alice')).toEqual({ available: '40', locked: '60' });
  });
});

describe('holds and trade settlement', () => {
  it('settles a trade atomically between locked balances', async () => {
    await ledger.deposit({ userId: 'buyer', currency: 'USDT', amount: 50_000n, key: 'd-buyer' });
    await ledger.deposit({ userId: 'seller', currency: 'BTC', amount: 2n, key: 'd-seller' });
    await ledger.hold({ userId: 'buyer', currency: 'USDT', amount: 30_000n, key: 'h-buyer' });
    await ledger.hold({ userId: 'seller', currency: 'BTC', amount: 1n, key: 'h-seller' });

    await ledger.settleTrade({
      tradeId: 'T1',
      buyerId: 'buyer',
      sellerId: 'seller',
      baseCurrency: 'BTC',
      quoteCurrency: 'USDT',
      baseAmount: 1n,
      quoteAmount: 30_000n,
    });

    const buyer = await ledger.getBalances('buyer');
    const seller = await ledger.getBalances('seller');
    expect(buyer.USDT).toEqual({ available: '20000', locked: '0' });
    expect(buyer.BTC).toEqual({ available: '1', locked: '0' });
    expect(seller.USDT).toEqual({ available: '30000', locked: '0' });
    expect(seller.BTC).toEqual({ available: '1', locked: '0' });
    expect((await ledger.reconcile()).ok).toBe(true);
  });

  it('settles each trade once (idempotent by trade id)', async () => {
    await ledger.deposit({ userId: 'buyer', currency: 'USDT', amount: 100n, key: 'd1' });
    await ledger.deposit({ userId: 'seller', currency: 'BTC', amount: 1n, key: 'd2' });
    await ledger.hold({ userId: 'buyer', currency: 'USDT', amount: 100n, key: 'h1' });
    await ledger.hold({ userId: 'seller', currency: 'BTC', amount: 1n, key: 'h2' });
    const trade = { tradeId: 'T1', buyerId: 'buyer', sellerId: 'seller', baseCurrency: 'BTC', quoteCurrency: 'USDT', baseAmount: 1n, quoteAmount: 100n };
    const first = await ledger.settleTrade(trade);
    const second = await ledger.settleTrade(trade);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect((await bal('seller')).available).toBe('100');
  });

  it('fails the whole trade if one side has not locked enough', async () => {
    await ledger.deposit({ userId: 'buyer', currency: 'USDT', amount: 100n, key: 'd1' });
    await ledger.deposit({ userId: 'seller', currency: 'BTC', amount: 1n, key: 'd2' });
    await ledger.hold({ userId: 'buyer', currency: 'USDT', amount: 100n, key: 'h1' }); // seller never locks
    await expect(
      ledger.settleTrade({ tradeId: 'T1', buyerId: 'buyer', sellerId: 'seller', baseCurrency: 'BTC', quoteCurrency: 'USDT', baseAmount: 1n, quoteAmount: 100n }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await bal('buyer')).toEqual({ available: '0', locked: '100' }); // nothing moved
    expect((await bal('seller', 'USDT')).available).toBe('0');
  });

  it('releases a hold back to available', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    await ledger.hold({ userId: 'alice', currency: 'USDT', amount: 40n, key: 'h1' });
    await ledger.release({ userId: 'alice', currency: 'USDT', amount: 40n, key: 'r1' });
    expect(await bal('alice')).toEqual({ available: '100', locked: '0' });
  });
});

describe('integrity', () => {
  it('detects a tampered cached balance during reconciliation', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    await pool.query(`UPDATE accounts SET balance = balance + 5 WHERE owner = 'alice' AND name = 'available'`);
    const rec = await ledger.reconcile();
    expect(rec.ok).toBe(false);
    expect(rec.balanceMismatches).toHaveLength(1);
  });

  it('refuses to modify or delete ledger lines', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    await expect(pool.query('UPDATE ledger_lines SET amount = 1')).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM ledger_lines')).rejects.toThrow(/append-only/);
  });

  it('refuses a negative balance at the database level', async () => {
    await ledger.deposit({ userId: 'alice', currency: 'USDT', amount: 100n, key: 'd1' });
    await expect(pool.query(`UPDATE accounts SET balance = -1 WHERE owner = 'alice' AND name = 'available'`)).rejects.toThrow();
  });
});
