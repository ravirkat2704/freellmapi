import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { runDecision, DecisionError } from '../../services/decision.js';
import { getMonthlyUsage } from '../../services/key-budget.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

// POST /v1/decisions spends real provider quota on every routing turn, but
// logDecision only wrote decision_requests. The per-key monthly caps (#1158)
// and GET /v1/usage read key_monthly_usage, which the
// requests_key_monthly_usage trigger feeds from `requests` — so a capped key
// never accrued decision spend and served decisions forever past its cap.
// This is the rerank (#1621/#1627), moderation (#1625) and search (#1648)
// gap on the decision surface.

const realFetch = globalThis.fetch;

function addKey(platform: string, monthlyRequestCap = 0): number {
  const raw = platform === 'cloudflare' ? 'acct123:cf-token' : `${platform}-test-key`;
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(platform, encrypted, iv, authTag, monthlyRequestCap);
  return Number(row.lastInsertRowid);
}

function spendRequests(keyId: number, requests: number) {
  getDb().prepare(
    'INSERT INTO key_monthly_usage (key_id, month, requests, tokens) VALUES (?, ?, ?, 10)',
  ).run(keyId, new Date().toISOString().slice(0, 7), requests);
}

const ANSWERS = { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.02, code: 0.98 }, confidence: 0.96 } };
const REQUEST = {
  state: 'Write a Python function that merges two sorted lists.',
  questions: {
    tier: { type: 'choice' as const, instructions: 'Which tier should answer?', criteria: { light: 'chat', code: 'coding' } },
  },
};

const okResponse = () => new Response(JSON.stringify({
  success: true,
  result: { model: 'clef-flash', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } },
}), { status: 200 });

describe('decision spend lands in the requests ledger (#1158)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('a served decision writes a success row and counts toward the monthly ledger', async () => {
    const key = addKey('cloudflare');
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    const out = await runDecision(REQUEST);
    expect(out.provider).toBe('cloudflare');

    const row = getDb().prepare(
      "SELECT platform, model_id, status, request_type FROM requests WHERE key_id = ?",
    ).get(key) as any;
    expect(row).toMatchObject({
      platform: 'cloudflare', status: 'success', request_type: 'decision',
    });
    // The trigger on requests feeds key_monthly_usage, which the caps and
    // /v1/usage read: the decision is now visible to both.
    expect(getMonthlyUsage(key).requests).toBe(1);
  });

  it('a failed attempt logs an error row that does NOT count toward usage', async () => {
    const key = addKey('cloudflare');
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })) as unknown as typeof fetch;

    await expect(runDecision(REQUEST)).rejects.toBeInstanceOf(DecisionError);

    const row = getDb().prepare(
      "SELECT status, request_type FROM requests WHERE key_id = ?",
    ).get(key) as any;
    expect(row).toMatchObject({ status: 'error', request_type: 'decision' });
    expect(getMonthlyUsage(key)).toEqual({ requests: 0, tokens: 0 });
  });

  it('spend accumulates until the cap bites (end-to-end cap enforcement)', async () => {
    const key = addKey('cloudflare', 2);
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    await runDecision(REQUEST);
    await runDecision(REQUEST);
    expect(getMonthlyUsage(key).requests).toBe(2);

    const err = await runDecision(REQUEST).catch(e => e) as DecisionError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
  });

  it('a key at its cap is skipped without touching upstream', async () => {
    const key = addKey('cloudflare', 1);
    spendRequests(key, 1);
    const fetch = vi.fn(async () => okResponse());
    globalThis.fetch = fetch as unknown as typeof fetch;

    const err = await runDecision(REQUEST).catch(e => e) as DecisionError;
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('quota_exceeded');
    expect(fetch).not.toHaveBeenCalled();
  });
});
