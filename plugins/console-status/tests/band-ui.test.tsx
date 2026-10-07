import { expect, test } from 'claude-code/testing'
import { displayWidth } from '../hooks/logic'

test('band stays one line at 40, 70, 120 and compact widths with the pane control last', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2030-01-05T12:00:00Z') }))
  on('env.get', () => ({ value: '/home/example' }))
  on('fs.read', () => ({ value: '{}' }))
  on('ui.open', () => ({ value: {} }))
  on('ui.close', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  await $.command.run({ command: 'console', args: 'demo' } as any)
  const leaves = (node: any, type: string): any[] => typeof node === 'string' ? [] : node?.type === type ? [node] : (node?.children ?? []).flatMap((child: any) => leaves(child, type))
  const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join('')
  for (const paneOpen of [true, false]) {
    if (!paneOpen) await $.command.run({ command: 'console', args: '' } as any)
    for (const bodyColumns of [40, 70, 120, 39, 20]) {
      const band = await $.ui.mount({ plugin: 'console-status', component: 'AbovePrompt', surface: 'terminal',
        props: { hasSurvey: false, bodyColumns, maxRows: 3, bodyRows: 3, scroll: { offset: 0, total: 0, visible: 0 } } } as any)
      const drawn: any = await band.drawn()
      expect(drawn.props.height).toBe(1)
      expect(drawn.props.width).toBe(bodyColumns)
      const texts = leaves(drawn, 'Text')
      for (const node of texts) {
        expect(node.props.wrap).toBe('truncate-end')
        expect(text(node).includes('\n')).toBe(false)
      }
      const button = await band.find({ key: 'pane' })
      expect(button?.text).toBe(bodyColumns < 40 ? '⌗' : '⌗ 面板')
      const visible = texts.reduce((sum, node) => sum + displayWidth(text(node)), 0) + displayWidth(button!.text) + texts.length
      expect(visible <= bodyColumns).toBe(true)
      const boxes = drawn.children
      expect(boxes[boxes.length - 1].props.flexShrink).toBe(0)
      expect(boxes[0].props.flexShrink).toBe(0)
      for (const item of boxes[0].children) expect(item.props.flexShrink).toBe(0)
      await band.unmount()
    }
  }
})
