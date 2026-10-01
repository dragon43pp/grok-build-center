/**
 * Turning token counts into dollars — and being explicit about when we cannot.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A recorded bill always beats an estimate.** Grok, opencode and kimi write
 *    their own cost; when they do, nobody else's arithmetic gets a say.
 *
 * 2. **"Cannot price this" is a real answer, and it must not be spelled `$0`.**
 *    A model with no price row, or a session that spent cache tokens on a model
 *    whose cache price is unpublished, resolves to `unpriced` — the UI shows a
 *    dash, not a confident zero. Local models (`colasoft/qwen-local`) and
 *    locally-renamed deployments (`fushing-grok-47`) are supposed to land here
 *    forever; that is the correct outcome, not a gap to paper over.
 *
 * Prices are USD per 1M tokens. The BUILTIN_PRICES table is a compiled snapshot
 * of first-party providers only — see `tools/gen_pricing_table.py` for why a
 * reseller's row must never be used: the same model id is listed by dozens of
 * gateways at up to 30× apart, so an unlucky pick produces a plausible-looking
 * estimate that is simply wrong.
 *
 * The snapshot can be refreshed at runtime from models.dev into *our own*
 * userData directory. It is never written anywhere the user's CLIs own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_PRICES,
  FIRST_PARTY_PROVIDERS,
  PRICING_GENERATED_ON,
  type BuiltinPrice
} from './pricing-table'
import type { PricingRefreshResult, TokenUsage } from './types'

export type { BuiltinPrice }

/** models.dev's full catalogue; a few MB, hence the cache. */
const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 1M tokens is the unit every price is quoted in. */
const TOKENS_PER_UNIT = 1_000_000

export interface PriceMatch {
  /** The table key that actually matched, not what the CLI reported. */
  modelId: string
  price: BuiltinPrice
  /** True when the row came from the refreshed cache rather than the snapshot. */
  refreshed: boolean
}

export interface CostEstimate {
  usd: number
  /** `catalog` when we priced it, `unpriced` when we honestly could not. */
  source: 'catalog' | 'unpriced'
  match?: PriceMatch
  /** Why it is unpriced — surfaced in tooltips so the dash is explainable. */
  reason?: 'no-model' | 'no-cache-price' | 'no-write-price' | 'no-usage'
}

/* ------------------------------------------------------------------ */
/* Catalogue loading                                                   */
/* ------------------------------------------------------------------ */

let overlay: Record<string, BuiltinPrice> | null = null
let overlayPath: string | null = null

/**
 * Where the refreshed catalogue lives. Injected by the main process rather than
 * read from `app.getPath('userData')` here, because the whole session layer is
 * deliberately electron-free: that is what lets `tools/verify_readonly.py` and
 * the probes bundle it and run it under plain Node. When unset, we simply use
 * the compiled snapshot and never touch the disk.
 */
let userDataDir: string | null = null

export function configurePricingCache(dir: string | null): void {
  if (dir === userDataDir) return
  userDataDir = dir
  overlay = null
  overlayPath = null
}

export function pricingCachePath(): string | null {
  return userDataDir ? join(userDataDir, 'pricing', 'models.json') : null
}

interface PricingCacheFile {
  generatedOn?: string
  source?: string
  prices?: Record<string, BuiltinPrice>
}

/**
 * Load the refreshed catalogue into memory. Safe to call repeatedly — it is a
 * no-op once loaded, and it never throws: a corrupt cache degrades to the
 * built-in snapshot rather than breaking the whole scan.
 */
export function loadPricingCache(): { loaded: boolean; count: number; generatedOn: string } {
  const path = pricingCachePath()
  if (!path) {
    return { loaded: false, count: 0, generatedOn: PRICING_GENERATED_ON }
  }
  if (overlay && overlayPath === path) {
    return {
      loaded: true,
      count: Object.keys(overlay).length,
      generatedOn: PRICING_GENERATED_ON
    }
  }
  overlay = null
  overlayPath = path
  try {
    if (!existsSync(path)) {
      return { loaded: false, count: 0, generatedOn: PRICING_GENERATED_ON }
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PricingCacheFile
    const prices = parsed.prices
    if (!prices || typeof prices !== 'object') {
      return { loaded: false, count: 0, generatedOn: PRICING_GENERATED_ON }
    }
    const clean: Record<string, BuiltinPrice> = {}
    for (const [id, row] of Object.entries(prices)) {
      if (!row || typeof row.input !== 'number' || typeof row.output !== 'number') continue
      clean[id] = {
        provider: String(row.provider ?? 'unknown'),
        input: row.input,
        output: row.output,
        cacheRead: typeof row.cacheRead === 'number' ? row.cacheRead : null,
        cacheWrite: typeof row.cacheWrite === 'number' ? row.cacheWrite : null
      }
    }
    overlay = Object.keys(clean).length ? clean : null
    return {
      loaded: Boolean(overlay),
      count: overlay ? Object.keys(overlay).length : 0,
      generatedOn: parsed.generatedOn ?? PRICING_GENERATED_ON
    }
  } catch {
    return { loaded: false, count: 0, generatedOn: PRICING_GENERATED_ON }
  }
}

/* ------------------------------------------------------------------ */
/* Model id matching                                                   */
/* ------------------------------------------------------------------ */

/** `claude-sonnet-4-5-20250929` -> `claude-sonnet-4-5`; also `-2025-09-29`. */
const DATE_PIN = /-(?:19|20)\d{2}-?(?:0[1-9]|1[0-2])-?(?:0[1-9]|[12]\d|3[01])$/

/**
 * Deliberately conservative: we only strip things we have seen CLIs append, and
 * only accept the result if it is genuinely in the table. No fuzzy matching and
 * no family fallback — silently pricing `gpt-5.6-sol` as `gpt-5.5` would produce
 * a number that looks authoritative and is off by 2×.
 */
function candidates(model: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }

  push(model)

  // `vendor/model` — the vendor prefix is a routing hint, not part of the id.
  const slash = model.lastIndexOf('/')
  if (slash >= 0) {
    push(model.slice(slash + 1))
    push(model.slice(0, slash))
  }

  for (const base of [...out]) {
    const stripped = base.replace(DATE_PIN, '')
    if (stripped !== base) push(stripped)
  }
  for (const base of [...out]) {
    // `-build` / `-latest` / `-highspeed` are deployment suffixes, not versions.
    for (const suffix of ['-build', '-latest', '-highspeed', '-thinking']) {
      if (base.endsWith(suffix)) push(base.slice(0, -suffix.length))
    }
  }
  return out
}

function lookup(model: string): BuiltinPrice | null {
  const builtin = BUILTIN_PRICES
  const cache = overlay
  // The refreshed catalogue is authoritative when present: it is the same
  // first-party filter, just newer.
  for (const candidate of candidates(model)) {
    const hit = cache?.[candidate] ?? builtin[candidate]
    if (hit) return hit
  }
  return null
}

export function priceForModel(model: string): PriceMatch | null {
  if (!model) return null
  loadPricingCache()
  const price = lookup(model)
  if (!price) return null
  // Report which key matched so the UI can show its provenance.
  let matched = model
  for (const candidate of candidates(model)) {
    if ((overlay?.[candidate] ?? BUILTIN_PRICES[candidate]) === price) {
      matched = candidate
      break
    }
  }
  return { modelId: matched, price, refreshed: Boolean(overlay?.[matched]) }
}

/* ------------------------------------------------------------------ */
/* Cost                                                               */
/* ------------------------------------------------------------------ */

/**
 * Price one session's normalised usage.
 *
 * `usage.output` has already had `reasoning` carved out of it by the readers
 * (both Grok and Codex report reasoning as a *subset* of output, and neither
 * bills it separately), so reasoning is added back and billed at the output
 * rate. Getting this wrong in the other direction would double-charge every
 * thinking model.
 */
export function estimateCost(model: string, usage: TokenUsage): CostEstimate {
  if (usage.total <= 0) return { usd: 0, source: 'unpriced', reason: 'no-usage' }
  const match = priceForModel(model)
  if (!match) return { usd: 0, source: 'unpriced', reason: 'no-model' }

  const { price } = match
  // ⚠️ A null cache price is *not* zero, and it is not "same as input" either.
  // Codex sessions here are ~97% cache reads; billing them at the input rate
  // would overstate the estimate by more than 10×. Refusing to price is the
  // only honest option.
  if (usage.cacheRead > 0 && price.cacheRead === null) {
    return { usd: 0, source: 'unpriced', reason: 'no-cache-price', match }
  }
  if (usage.cacheWrite > 0 && price.cacheWrite === null) {
    return { usd: 0, source: 'unpriced', reason: 'no-write-price', match }
  }

  const units = (tokens: number, unitPrice: number): number =>
    (tokens / TOKENS_PER_UNIT) * unitPrice

  const usd =
    units(usage.input, price.input) +
    units(usage.output + usage.reasoning, price.output) +
    units(usage.cacheRead, price.cacheRead ?? 0) +
    units(usage.cacheWrite, price.cacheWrite ?? 0)

  if (!Number.isFinite(usd) || usd <= 0) {
    return { usd: 0, source: 'unpriced', reason: 'no-usage', match }
  }
  return { usd, source: 'catalog', match }
}

/* ------------------------------------------------------------------ */
/* Refresh                                                             */
/* ------------------------------------------------------------------ */

// 类型只有一份定义，在 shared/ 里 —— 渲染进程要拿它当 IPC 返回值，
// 而 shared/ 不能反向依赖 electron/sessions/（那边有 node:fs）。
export type { PricingRefreshResult }

/**
 * Pull models.dev and cache the first-party rows. Keeps only providers already
 * present in the compiled snapshot (via `FIRST_PARTY_PROVIDERS`), which drops
 * the payload from ~5 MB to a few KB — and, more importantly, makes it
 * impossible for a gateway's marked-up price to sneak in from a refresh.
 */
export async function refreshPricingCache(): Promise<PricingRefreshResult> {
  const previous = loadPricingCache()
  const path = pricingCachePath()
  if (!path) {
    return {
      ok: false,
      count: previous.count,
      generatedOn: previous.generatedOn,
      error: '价目表缓存目录未配置（configurePricingCache 未调用）'
    }
  }
  try {
    const response = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(45_000)
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const raw = (await response.json()) as Record<
      string,
      { models?: Record<string, { id?: string; cost?: Record<string, unknown> }> }
    >

    const prices: Record<string, BuiltinPrice> = {}
    for (const providerId of FIRST_PARTY_PROVIDERS) {
      const provider = raw[providerId]
      if (!provider) continue
      for (const model of Object.values(provider.models ?? {})) {
        const id = model?.id
        if (!id || prices[id]) continue
        const cost = model.cost ?? {}
        const input = number(cost.input)
        const output = number(cost.output)
        if (input === null || output === null) continue
        prices[id] = {
          provider: providerId,
          input,
          output,
          cacheRead: number(cost.cache_read),
          cacheWrite: number(cost.cache_write)
        }
      }
    }

    const count = Object.keys(prices).length
    if (count === 0) throw new Error('刷新后一条价格都没有，拒绝写入')

    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(
        {
          generatedOn: new Date().toISOString().slice(0, 10),
          source: MODELS_DEV_URL,
          prices
        },
        null,
        1
      ),
      'utf8'
    )
    // Force the next read to pick up what we just wrote.
    overlay = null
    overlayPath = null
    const loaded = loadPricingCache()
    return { ok: true, count, generatedOn: loaded.generatedOn }
  } catch (error) {
    return {
      ok: false,
      count: previous.count,
      generatedOn: previous.generatedOn,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Test seam: drop the in-memory catalogue so a new cache file is re-read. */
export function resetPricingCache(): void {
  overlay = null
  overlayPath = null
}
