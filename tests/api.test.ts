import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { resetDb, setupDb } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = await setupDb();
  app = buildApp(pool);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const post = (url: string, payload: unknown, key?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: key ? { 'idempotency-key': key } : {} });

describe('HTTP API', () => {
  it('runs deposit -> withdraw -> confirm -> reconcile', async () => {
    expect((await post('/deposits', { userId: 'alice', currency: 'USDT', amount: '1000' }, 'k1')).statusCode).toBe(201);

    const wd = await post('/withdrawals', { userId: 'alice', currency: 'USDT', amount: '400', destination: '0xabc' }, 'k2');
    expect(wd.statusCode).toBe(201);
    const id = wd.json().withdrawal.id;

    expect((await app.inject({ method: 'GET', url: '/balances/alice' })).json()).toEqual({ USDT: { available: '600', locked: '400' } });
    expect((await post(`/withdrawals/${id}/confirm`, {})).json().status).toBe('confirmed');
    expect((await app.inject({ method: 'GET', url: '/reconcile' })).statusCode).toBe(200);
  });

  it('returns 200 with replayed=true for a repeated idempotency key', async () => {
    await post('/deposits', { userId: 'alice', currency: 'USDT', amount: '10' }, 'k1');
    const again = await post('/deposits', { userId: 'alice', currency: 'USDT', amount: '10' }, 'k1');
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await post('/deposits', { userId: 'alice', currency: 'USDT', amount: '10' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('rejects floats, negatives, and bad currencies', async () => {
    for (const amount of ['1.5', '-5', '0', 'abc', '01']) {
      expect((await post('/deposits', { userId: 'a', currency: 'USDT', amount }, `k-${amount}`)).statusCode).toBe(400);
    }
    expect((await post('/deposits', { userId: 'a', currency: 'usdt', amount: '5' }, 'k-cur')).statusCode).toBe(400);
  });

  it('returns 422 on insufficient funds', async () => {
    const res = await post('/transfers', { fromUserId: 'a', toUserId: 'b', currency: 'USDT', amount: '5' }, 'k1');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('returns 404 for an unknown withdrawal', async () => {
    const res = await post('/withdrawals/00000000-0000-0000-0000-000000000000/confirm', {});
    expect(res.statusCode).toBe(404);
  });
});
