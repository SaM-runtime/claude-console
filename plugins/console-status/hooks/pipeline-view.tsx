// Drawing for the workflow pipeline (hooks/pipeline.ts): a full line with stage names for cards,
// the band and project mode, and a six-glyph strip for the project table.
import type { Pipeline, Stage } from './pipeline'
import { STAGE_GLYPH } from './pipeline'

export type PipelinePalette = { green: string; teal: string; amber: string; purple: string; blue: string; red: string; faint: string; dim: string; text: string }

/** A waiting stage takes the colour of whoever it waits for: gates purple, sync blue, the rest amber. */
export function stageColor(stage: Stage, palette: PipelinePalette): string {
  switch (stage.status) {
    case 'done': return palette.green
    case 'active': return palette.teal
    case 'fail': return palette.red
    case 'todo': return palette.faint
    case 'wait': return stage.id === 'sync' ? palette.blue : stage.id === 'spec' || stage.id === 'review' || stage.id === 'release' ? palette.purple : palette.amber
  }
}

/** Six one-column glyphs, one per stage, for a table cell. */
export function pipelineParts(pl: Pipeline, palette: PipelinePalette): { t: string; c: string }[] {
  return pl.stages.map(stage => ({ t: STAGE_GLYPH[stage.status], c: stageColor(stage, palette) }))
}

/** `● 規格 ─ ◉ 實作 ─ ○ 同步 …`, the current stage bold, then the note unless `noteless`. */
export function pipelineLine(pl: Pipeline, palette: PipelinePalette, elements: any, key: string, opts: { noteless?: boolean } = {}) {
  const { Box, Text } = elements
  return <Box key={key} flexDirection="column">
    <Box flexWrap="wrap">
      {pl.stages.map((stage, index) => <Text key={key + '-' + stage.id} wrap="truncate-end">
        {index > 0 && <Text color={pl.stages[index - 1]!.status === 'done' ? palette.green : palette.faint}>{' ─ '}</Text>}
        <Text color={stageColor(stage, palette)} bold={stage.id === pl.current}>{STAGE_GLYPH[stage.status]} {stage.label}</Text>
      </Text>)}
    </Box>
    {!opts.noteless && pl.note && <Text color={pl.current ? stageColor(pl.stages.find(stage => stage.id === pl.current)!, palette) : palette.dim} wrap="wrap">{pl.note}</Text>}
  </Box>
}

/** One-line text form for narrow places (band, prompt context): `實作◉ · 待繼續：…`. */
export function pipelineText(pl: Pipeline): string {
  const strip = pl.stages.map(stage => STAGE_GLYPH[stage.status]).join('')
  const current = pl.stages.find(stage => stage.id === pl.current)
  return `${strip}${current ? ` ${current.label}` : ''}${pl.note ? ` · ${pl.note}` : ''}`
}
