import { expect, test } from 'claude-code/testing'
import { cacheChip, cacheTtlOption, cacheView, cacheWarning, inputPricePerMTok, learnTtl, leftText, priceOverride, rewriteCost } from '../hooks/cache'
import type { CacheClock } from '../types'

const round = (v: number | null) => v === null ? null : Math.round(v * 1000) / 1000
const clock = (over: Partial<CacheClock> = {}): CacheClock => ({ at: 0, tokens: 200_000, model: 'claude-opus-5-5', ttl: '5m', ...over })

test('list prices by model and the cache-write multiplier per TTL', () => {
  expect(inputPricePerMTok('claude-opus-5-5')).toBe(4)
  expect(inputPricePerMTok('claude-opus-4-8')).toBe(5)
  expect(inputPricePerMTok('claude-fable-5-1')).toBe(10)
  expect(inputPricePerMTok('claude-sonnet-5-5')).toBe(2)
  expect(inputPricePerMTok('claude-sonnet-4-6')).toBe(3)
  expect(inputPricePerMTok('claude-haiku-4-5')).toBe(1)
  expect(inputPricePerMTok('some-gateway-model')).toBe(null)
  expect(round(rewriteCost(200_000, 'claude-opus-5-5', '5m'))).toBe(1.0)
  expect(round(rewriteCost(200_000, 'claude-opus-5-5', '1h'))).toBe(1.6)
  expect(round(rewriteCost(1_000_000, 'unknown', '5m', 3))).toBe(3)
  expect(rewriteCost(1_000_000, 'unknown', '5m')).toBe(null)
  expect(priceOverride(' 7.5 ')).toBe(7.5)
  expect(priceOverride('')).toBe(null)
  expect(priceOverride('abc')).toBe(null)
})

test('warm, nearly cold and cold views; a running turn or a small context shows nothing', () => {
  const warm = cacheView(clock(), 60_000, false, null)!
  expect(warm).toEqual({ warm: true, leftMs: 240_000, coldForMs: 0, cost: 1, ttl: '5m' })
  expect(cacheChip(warm, false)).toEqual({ text: '快取 4m', tone: 'green' })
  expect(cacheChip(cacheView(clock(), 250_000, false, null)!, false)).toEqual({ text: '快取 <1m', tone: 'amber' })
  const cold = cacheView(clock(), 12 * 60_000, false, null)!
  expect(cacheChip(cold, false)).toEqual({ text: '快取已冷 $1.00', tone: 'red' })
  expect(cacheChip(cold, true)).toEqual({ text: '⧗冷 $1.00', tone: 'red' })
  expect(cacheWarning(clock(), cold)).toBe('主控台快取已過期 7m：這則提示會重寫約 200k tokens（約 $1.00）')
  expect(cacheWarning(clock(), warm)).toBe('主控台快取 4m 後過期：之後送出的提示會重寫約 200k tokens（約 $1.00）')
  expect(cacheView(clock(), 60_000, true, null)).toBe(null)
  expect(cacheView(clock({ tokens: 5_000 }), 60_000, false, null)).toBe(null)
  expect(cacheView(null, 0, false, null)).toBe(null)
  expect(leftText(90 * 60_000)).toBe('1h')
})

test('the TTL is learned only from an idle gap on the same model', () => {
  const prev = clock({ at: 0 })
  expect(learnTtl(prev, 20 * 60_000, 'claude-opus-5-5', 190_000)).toBe('1h')
  expect(learnTtl(prev, 20 * 60_000, 'claude-opus-5-5', 0)).toBe('5m')
  expect(learnTtl(prev, 20 * 60_000, 'claude-opus-5-5', 60_000)).toBe(null)
  expect(learnTtl(prev, 3 * 60_000, 'claude-opus-5-5', 0)).toBe(null)
  expect(learnTtl(prev, 2 * 60 * 60_000, 'claude-opus-5-5', 0)).toBe(null)
  expect(learnTtl(prev, 20 * 60_000, 'claude-sonnet-5-5', 0)).toBe(null)
  expect(learnTtl(null, 20 * 60_000, 'claude-opus-5-5', 0)).toBe(null)
  expect(cacheTtlOption('1H')).toBe('1h')
  expect(cacheTtlOption('')).toBe('auto')
})
