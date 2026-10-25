/**
 * Fallback-only model → price table (USD per million tokens).
 *
 * The LIVE telemetry path does NOT use this. Claude Code emits a pre-computed,
 * per-model `cost_usd` on every `api_request` log and a `claude_code.cost.usage`
 * metric (verified by the 7A.1 spike), so the collector (`telemetry.ts`) trusts
 * Claude's own figure. This table exists solely for the OFFLINE transcript
 * reconciler (`transcript.ts`), which runs when telemetry is off and must
 * estimate cost from raw token counts.
 *
 * It supersedes the old hard-coded Sonnet-for-everyone constants that lived in
 * `transcript.ts` (cost bug #1 — Opus undercosted ~5×, Haiku overcosted). Prices
 * are now matched per model family. This is the ONE place per-model pricing
 * lives; both the transcript backend and the collector's fallback import it.
 */

/** USD per million tokens for one model family. */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

// Anthropic list prices, USD per million tokens. Approximate, fallback-only —
// the live path uses Claude's own per-model cost, so drift here is harmless.
// Opus too, one row per generation: a single row priced every Opus at Opus
// 4/4.1's $15/$75, three times Opus 4.6-5's list price. Cache rows use the
// usual multipliers (reads 0.1x input, 5-minute writes 1.25x), except Opus
// 5.5's reads, listed at $0.20 (0.05x).
// Opus 4.5 keeps the old row: no current price for it was on hand.
const OPUS_5_5: ModelPrice = { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWritePerM: 5 };
const OPUS_4_6: ModelPrice = { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 };
const OPUS_LEGACY: ModelPrice = { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 };
const SONNET: ModelPrice = { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 };
// Haiku moved price more than once, so one row per generation: a single row
// priced every Haiku at Haiku 3.5's $0.80/$4, eight times Haiku 5.5's list
// price and below Haiku 4.5's. Cache rows follow the usual multipliers: reads
// 0.1x input, 5-minute writes 1.25x. Haiku 5.5 is priced at its tier for
// prompts up to 100K tokens; a longer prompt bills $0.50/$2.50, which this
// per-model table cannot see, so such a request is under-estimated here.
const HAIKU_5_5: ModelPrice = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 };
const HAIKU_4_5: ModelPrice = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 };
const HAIKU_3_5: ModelPrice = { inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0 };
const HAIKU_3: ModelPrice = { inputPerM: 0.25, outputPerM: 1.25, cacheReadPerM: 0.03, cacheWritePerM: 0.3 };

/** When the model id is unknown, assume Sonnet (the historical default). */
const DEFAULT_PRICE: ModelPrice = SONNET;

/**
 * Strip Claude Code's variant suffix so `claude-opus-4-8[1m]` (the form the
 * `token.usage` metric carries) and `claude-opus-4-8` (the base id the
 * `api_request` log carries) resolve to the same family. Case is preserved;
 * matching is done case-insensitively in `priceFor`.
 */
export function normalizeModel(model: string | undefined | null): string {
  return (model ?? '').trim().replace(/\[[^\]]*\]\s*$/, '');
}

/** Resolve a model id to its price row by family, falling back to Sonnet. */
export function priceFor(model: string | undefined | null): ModelPrice {
  const m = normalizeModel(model).toLowerCase();
  if (m.includes('opus')) return opusPrice(m);
  if (m.includes('haiku')) return haikuPrice(m);
  if (m.includes('sonnet')) return SONNET;
  return DEFAULT_PRICE;
}

/** The Haiku row for a lower-cased model id. Ids carry the version either
 *  after the family (`claude-haiku-5-5`, `claude-haiku-4-5-20251001`) or
 *  before it (`claude-3-5-haiku-20241022`, `claude-3-haiku-20240307`). An id
 *  that names no known version gets Haiku 4.5's row, the dearer of the two
 *  current Haikus, so an unknown one is not under-estimated. */
function haikuPrice(m: string): ModelPrice {
  if (/haiku-5[-.]5/.test(m)) return HAIKU_5_5;
  if (/haiku-4[-.]5/.test(m)) return HAIKU_4_5;
  if (/3[-.]5-haiku/.test(m)) return HAIKU_3_5;
  if (/3-haiku/.test(m)) return HAIKU_3;
  return HAIKU_4_5;
}

/** Opus rows by `major.minor`; a missing minor is `.0` (`claude-opus-5`). */
const OPUS_BY_VERSION: Record<string, ModelPrice> = {
  '5.5': OPUS_5_5,
  '5.0': OPUS_4_6,
  '4.8': OPUS_4_6,
  '4.7': OPUS_4_6,
  '4.6': OPUS_4_6,
  '4.5': OPUS_LEGACY,
  '4.1': OPUS_LEGACY,
  '4.0': OPUS_LEGACY
};

/** The Opus row for a lower-cased model id. The version follows the family
 *  (`claude-opus-4-8`, `claude-opus-4-1-20250805`, `claude-opus-4.7`); a
 *  minor is one digit, so the date in `claude-opus-4-20250514` reads as 4.0.
 *  Claude 3 Opus (`claude-3-opus-20240229`) is on the old row. Any other id,
 *  the bare `opus` alias or a newer Opus, gets the newest known row. */
function opusPrice(m: string): ModelPrice {
  const v = /opus-(\d)(?!\d)(?:[-.](\d)(?!\d))?/.exec(m);
  if (v) return OPUS_BY_VERSION[`${v[1]}.${v[2] ?? '0'}`] ?? OPUS_5_5;
  if (/3-opus/.test(m)) return OPUS_LEGACY;
  return OPUS_5_5;
}

/** Token split used by the cost estimator (matches `AgentUsage` token fields). */
export interface TokenSplit {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Estimate USD cost for a token split using the model's fallback price row.
 * Used only by the transcript reconciler; the live path trusts Claude's cost.
 */
export function estimateCostUsd(model: string | undefined | null, tokens: TokenSplit): number {
  const p = priceFor(model);
  return (
    (tokens.inputTokens / 1_000_000) * p.inputPerM +
    (tokens.outputTokens / 1_000_000) * p.outputPerM +
    (tokens.cacheReadTokens / 1_000_000) * p.cacheReadPerM +
    (tokens.cacheWriteTokens / 1_000_000) * p.cacheWritePerM
  );
}
