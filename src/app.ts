import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { parseAmount, parseCurrency } from './amount.js';
import { LedgerError } from './errors.js';
import { Ledger } from './ledger.js';

const userId = z.string().min(1).max(100);
const currency = z.string().transform((v, ctx) => {
  try {
    return parseCurrency(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid currency' });
    return z.NEVER;
  }
});
const amount = z.string().transform((v, ctx) => {
  try {
    return parseAmount(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'amount must be a positive integer string in minor units' });
    return z.NEVER;
  }
});

const schemas = {
  deposit: z.object({ userId, currency, amount, reference: z.string().max(200).optional() }),
  transfer: z.object({ fromUserId: userId, toUserId: userId, currency, amount }),
  hold: z.object({ userId, currency, amount, reference: z.string().max(200).optional() }),
  withdrawal: z.object({ userId, currency, amount, destination: z.string().min(1).max(200) }),
  trade: z.object({
    tradeId: z.string().min(1).max(100),
    buyerId: userId,
    sellerId: userId,
    baseCurrency: currency,
    quoteCurrency: currency,
    baseAmount: amount,
    quoteAmount: amount,
  }),
};

function idemKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    throw new LedgerError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  return key;
}

export function buildApp(pool: Pool): FastifyInstance {
  const app = Fastify({ logger: false });
  const ledger = new Ledger(pool);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LedgerError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'invalid request', details: err.issues } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/deposits', async (req, reply) => {
    const body = schemas.deposit.parse(req.body);
    const r = await ledger.deposit({ ...body, key: idemKey(req.headers) });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/transfers', async (req, reply) => {
    const body = schemas.transfer.parse(req.body);
    const r = await ledger.transfer({ ...body, key: idemKey(req.headers) });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/holds', async (req, reply) => {
    const body = schemas.hold.parse(req.body);
    const r = await ledger.hold({ ...body, key: idemKey(req.headers) });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/holds/release', async (req, reply) => {
    const body = schemas.hold.parse(req.body);
    const r = await ledger.release({ ...body, key: idemKey(req.headers) });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/trades/settle', async (req, reply) => {
    const body = schemas.trade.parse(req.body);
    const r = await ledger.settleTrade(body);
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post('/withdrawals', async (req, reply) => {
    const body = schemas.withdrawal.parse(req.body);
    const r = await ledger.requestWithdrawal({ ...body, key: idemKey(req.headers) });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  app.post<{ Params: { id: string } }>('/withdrawals/:id/confirm', async (req) => ledger.confirmWithdrawal(req.params.id));
  app.post<{ Params: { id: string } }>('/withdrawals/:id/fail', async (req) => ledger.failWithdrawal(req.params.id));

  app.get<{ Params: { userId: string } }>('/balances/:userId', async (req) => ledger.getBalances(req.params.userId));

  app.get('/reconcile', async (_req, reply) => {
    const r = await ledger.reconcile();
    return reply.status(r.ok ? 200 : 500).send(r);
  });

  return app;
}
