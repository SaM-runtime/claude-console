import { expect, test } from 'claude-code/testing'
import { demoSnapshot, limitHelp, limitModel, limitName } from '../hooks/logic'

test('limitName: a window alone, a window scoped to a model, and a kind it does not know kept as given', () => {
  expect(limitName('five_hour')).toBe('5 小時')
  expect(limitName('seven_day')).toBe('本週')
  expect(limitName('seven_day_opus')).toBe('Opus 週')
  expect(limitName('seven_day_sonnet')).toBe('Sonnet 週')
  expect(limitName('seven_day_fable')).toBe('Fable 週')
  expect(limitName('five_hour_fable')).toBe('Fable 5 小時')
  // A model name it has no spelling for is shown as the host sent it, not dropped.
  expect(limitName('seven_day_mythos')).toBe('mythos 週')
  // Not a model suffix: the whole kind stays visible.
  expect(limitName('seven_day_overage_included')).toBe('seven_day_overage_included')
  expect(limitName('spend_limit')).toBe('花費上限')
  expect(limitName('mystery')).toBe('mystery')
})

test('limitModel names the model a per-model kind is scoped to', () => {
  expect(limitModel('seven_day_fable')).toBe('Fable')
  expect(limitModel('seven_day_opus')).toBe('Opus')
  expect(limitModel('seven_day')).toBe('')
  expect(limitModel('spend_limit')).toBe('')
})

test('limitHelp explains each row in its own words, naming the model for a per-model window', () => {
  expect(limitHelp('five_hour')).toBe('5 小時：Claude 帳號 5 小時滾動額度的剩餘量，到重置時間回滿。')
  expect(limitHelp('seven_day')).toBe('本週：Claude 帳號每週額度的剩餘量。')
  expect(limitHelp('seven_day_fable')).toBe('Fable 週：Claude 帳號本週 Fable 專用額度的剩餘量，與整體「本週」分開計算，到重置時間回滿。')
  expect(limitHelp('seven_day_opus')).toBe('Opus 週：Claude 帳號本週 Opus 專用額度的剩餘量，與整體「本週」分開計算，到重置時間回滿。')
  expect(limitHelp('five_hour_sonnet')).toBe('Sonnet 5 小時：Claude 帳號 5 小時滾動額度中 Sonnet 專用的剩餘量，與整體「5 小時」分開計算，到重置時間回滿。')
  expect(limitHelp('spend_limit')).toBe('花費上限：Claude gateway 為這個帳號設定的花費上限還剩多少，超額後電池見底，到週期重置時回滿。')
  expect(limitHelp('mystery')).toBe('mystery：host 回報的額度視窗，名稱照原字串顯示。')
})

test('demo mode carries one per-model weekly window so the row can be seen', () => {
  const demo = demoSnapshot(Date.parse('2030-01-05T12:00:00Z'))
  const fable = demo.limits?.find(limit => limit.kind === 'seven_day_fable')
  expect(fable?.percent).toBe(48)
  expect(limitName(fable?.kind ?? '')).toBe('Fable 週')
})
