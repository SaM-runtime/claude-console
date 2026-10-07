import { expect, test } from 'claude-code/testing'

// Another plugin beneath on the band's row (paste-preview's thumbnails) stays visible.
const setUp = async ($: any, on: any, beneath: any) => {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: '{}' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => beneath)
  await $.command.run({ command: 'console', args: 'demo' } as any)
}
const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
const mount = ($: any, hasSurvey = false) => $.ui.mount({ plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey, bodyColumns: 80, maxRows: 6, bodyRows: 6, scroll: { offset: 0, total: 0, visible: 0 } } } as any)

test('a band drawn beneath stacks under the console band', async ($, on) => {
  await setUp($, on, { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['Image #1'] }] })
  const band = await mount($)
  const drawn: any = await band.drawn()
  expect(drawn.props.flexDirection).toBe('column')
  expect(drawn.children.length).toBe(2)
  expect(drawn.children[0].props.height).toBe(1)
  expect(text(drawn.children[0]).includes('示範')).toBe(true)
  expect(text(drawn.children[1])).toBe('Image #1')
  expect(await band.find({ key: 'pane' })).toBeTruthy()
  await band.unmount()
})

test('nothing drawn beneath leaves the console band as it was', async ($, on) => {
  await setUp($, on, { type: 'Box', props: {}, children: [] })
  const band = await mount($)
  const drawn: any = await band.drawn()
  expect(drawn.props.height).toBe(1)
  expect(drawn.props.flexDirection).toBe('row')
  await band.unmount()
})

test('a survey still takes the band', async ($, on) => {
  await setUp($, on, { type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: ['survey'] }] })
  const band = await mount($, true)
  expect(text(await band.drawn())).toBe('survey')
  await band.unmount()
})
