import type { Register } from 'claude-code'

/**
 * `claude -p /dispatch-probe` runs each command through the engine's `$.process.run`, as console-status does
 * when it dispatches, and prints what came back as one JSON line. scripts/check-dispatch.mjs reads it.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'dispatch-probe', description: 'CI only: run the dispatch probes' })
    return next(e)
  })

  on('command.run', { command: 'dispatch-probe' }, async $ => {
    const plan = JSON.parse(String(await $.env.get('DISPATCH_PROBE_PLAN'))) as { name: string; argv: string[]; stdin?: string; cwd: string }[]
    const results: Record<string, unknown> = {}
    for (const step of plan) {
      try {
        const run = await $.process.run(step.argv, { cwd: step.cwd, timeoutMs: 60_000, ...(step.stdin === undefined ? {} : { stdin: step.stdin }) })
        results[step.name] = { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr }
      } catch (error) {
        results[step.name] = { error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { text: `DISPATCH_PROBE ${JSON.stringify(results)}` }
  })
}
