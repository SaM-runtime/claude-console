import { expect, test } from 'claude-code/testing'
import { cacheChip, cacheTtlOption, cacheView, cacheWarning, inputPricePerMTok, learnTtl, leftText, priceOverride, rewriteCost, transcriptCache, transcriptPathFor, ttlLabel } from '../hooks/cache'
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
  expect(cacheChip(cacheView(clock(), 250_000, false, null)!, false)).toEqual({ text: '快取 50s', tone: 'amber' })
  const cold = cacheView(clock(), 12 * 60_000, false, null)!
  expect(cacheChip(cold, false)).toEqual({ text: '快取已冷 $1.00', tone: 'red' })
  expect(cacheChip(cold, true)).toEqual({ text: '⧗冷 $1.00', tone: 'red' })
  expect(cacheWarning(clock(), cold)).toBe('主控台快取已過期 7m：這則提示會重寫約 200k tokens（約 $1.00）')
  expect(cacheWarning(clock(), warm)).toBe('主控台快取 4m 後過期：之後送出的提示會重寫約 200k tokens（約 $1.00）')
  expect(cacheView(clock(), 60_000, true, null)).toBe(null)
  expect(cacheView(clock({ tokens: 5_000 }), 60_000, false, null)).toBe(null)
  expect(cacheView(null, 0, false, null)).toBe(null)
  expect(leftText(90 * 60_000)).toBe('1h')
  expect(leftText(45_000)).toBe('45s')
  expect(leftText(400)).toBe('1s')
  expect(leftText(60_000)).toBe('1m')
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

test('the transcript tail gives the last main-thread response, timed from its request, and the TTL it wrote with', () => {
  const row = (o: any) => JSON.stringify({ isSidechain: false, ...o })
  const usage = (c5: number, c1: number) => ({ input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: c5 + c1, cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 } })
  const text = [
    '{"cut line',
    row({ type: 'assistant', timestamp: '2030-01-01T00:00:05Z', message: { id: 'a', model: 'm', usage: usage(0, 40) } }),
    row({ type: 'user', timestamp: '2030-01-01T00:01:00Z' }),
    row({ type: 'assistant', timestamp: '2030-01-01T00:01:30Z', message: { id: 'b', model: 'm', usage: usage(0, 0) } }),
    row({ type: 'assistant', timestamp: '2030-01-01T00:01:31Z', message: { id: 'b', model: 'm', usage: usage(0, 0) } }),
    row({ type: 'assistant', isSidechain: true, timestamp: '2030-01-01T00:02:00Z', message: { id: 'c', model: 'x', usage: usage(50, 0) } }),
    '{"type":"last-prompt"}',
  ].join('\n')
  // Nothing written by the last response: the TTL is the one its cache entry was written with.
  expect(transcriptCache(text)).toEqual({ at: Date.parse('2030-01-01T00:01:00Z'), tokens: 110, hit: 100 / 101, model: 'm', ttl: '1h' })
  expect(transcriptCache(row({ type: 'assistant', timestamp: '2030-01-01T00:00:00Z', message: { id: 'a', model: 'm', usage: usage(30, 0) } }))?.ttl).toBe('5m')
  expect(transcriptCache('')).toBe(null)
  expect(transcriptPathFor('C:/Users/me/.claude/', 'D:\\Work\\K app', 'abc')).toBe('C:/Users/me/.claude/projects/D--Work-K-app/abc.jsonl')
  expect(ttlLabel('1h', 'usage')).toBe('1h・實際')
  expect(ttlLabel('5m', undefined)).toBe('5m・預設')
})
