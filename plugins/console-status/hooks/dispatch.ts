
export type Executor = 'claude' | 'codex'
export type DispatchSettings = { executor: Executor; model: string; effort: string }
export type ModelOption = { model: string; efforts: string[] }
const CLAUDE_MODELS: ModelOption[] = ['fable', 'opus', 'sonnet'].map(model => ({ model, efforts: [] }))
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']
const clean = (value: unknown): string | null => typeof value === 'string' && !/[\r\n\x00]/.test(value) ? value.trim() : null
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseSettings(text: string | null, defaults: DispatchSettings): DispatchSettings {
  try {
    const data = JSON.parse((text ?? '').replace(/^\uFEFF/, ''))
    if (object(data)) {
      const executor = data.executor === 'claude' || data.executor === 'codex' ? data.executor : defaults.executor
      return { executor, model: clean(data.model) ?? defaults.model, effort: clean(data.effort) ?? defaults.effort }
    }
  } catch { /* Missing or partially written file: use user defaults. */ }
  return { ...defaults }
}

export function parseModels(text: string | null): ModelOption[] {
  try {
    const data = JSON.parse((text ?? '').replace(/^\uFEFF/, ''))
    const entries = Array.isArray(data) ? data : data?.models
    if (!Array.isArray(entries)) return []
    const result: ModelOption[] = []
    for (const entry of entries) {
      if (!object(entry)) continue
      const model = clean(entry.slug) || clean(entry.id)
      if (!model || result.some(m => m.model === model)) continue
      const levels = entry.supported_reasoning_levels
      const efforts = Array.isArray(levels) ? levels.map(v => clean(object(v) ? v.effort : v)).filter((v): v is string => !!v) : []
      result.push({ model, efforts: [...new Set(efforts)] })
    }
    return result
  } catch { return [] }
}

/** Models exposed by the selected executor; Claude aliases come from its CLI. */
export function modelOptions(executor: Executor, codexModels: ModelOption[]): ModelOption[] {
  return executor === 'claude' ? CLAUDE_MODELS.map(option => ({ ...option, efforts: [...option.efforts] })) : codexModels
}

export function effortOptions(executor: Executor, models: ModelOption[], model: string): string[] {
  if (executor === 'claude') return [...CLAUDE_EFFORTS]
  const options = models.find(m => m.model === model)?.efforts
  return options?.length ? options : [...CODEX_EFFORTS]
}

export function nextOption(current: string, options: string[]): string {
  return options.length ? options[(options.indexOf(current) + 1) % options.length] : current
}

