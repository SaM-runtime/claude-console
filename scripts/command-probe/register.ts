// CI only. scripts/check-commands.mjs copies this file and console-status's hooks into a throwaway plugin
// (`../console/hooks/…`), loads it with `claude -p /command-probe --plugin-dir`, and checks what comes back.
// Every command is built by console-status's own code and run through the engine's `$.process.run`, as
// the console runs it, on whatever operating system the check runs on.
import type { Register } from 'claude-code'

import { verificationArgs, verificationResult } from '../console/hooks/actions'
import { tailArgs } from '../console/hooks/digest'
import { claudeArgs, createExecutor } from '../console/hooks/executors'
import type { ExecutorDeps } from '../console/hooks/executors'
import { parseCodexQuota } from '../console/hooks/logic'
import { isWindowsOs, preflightArgs, quotaArgs, tailLinesArgs } from '../console/hooks/platform'

type Input = {
  pluginRoot: string
  work: string
  sessions: string
  companion: string
  stateDir: string
  stateRoots: string[]
  tailFile: string
  shim: string
  prompt: string
  verify: Record<string, string>
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'command-probe', description: 'CI only: run console-status commands' })
    return next(e)
  })

  on('command.run', { command: 'command-probe' }, async $ => {
    const input = JSON.parse(String(await $.env.get('COMMAND_PROBE'))) as Input
    const windows = isWindowsOs(await $.env.get('OS'))
    const out: Record<string, unknown> = { windows }
    const run = async (name: string, argv: string[], init: { cwd?: string; stdin?: string } = {}) => {
      try {
        const result = await $.process.run(argv, { timeoutMs: 120_000, ...init })
        out[name] = { argv, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
        return result
      } catch (error) {
        out[name] = { argv, error: error instanceof Error ? error.message : String(error) }
        return null
      }
    }

    // The Codex probes, as the refresh runs them.
    const quota = await run('quota', quotaArgs(input.pluginRoot, windows))
    out.quotaParsed = quota ? parseCodexQuota(quota.stdout, await $.clock.now()) : null
    await run('preflight', preflightArgs(input.pluginRoot, windows, input.companion, input.stateDir, input.stateRoots))
    await run('preflightMissing', preflightArgs(input.pluginRoot, windows, `${input.companion}.missing`, input.stateDir, input.stateRoots))

    // A CARD's 驗證 command, as ▶ 執行驗證 runs it.
    for (const [name, command] of Object.entries(input.verify)) {
      const result = await run(name, verificationArgs(command, windows), { cwd: input.work })
      if (result) out[`${name}Result`] = verificationResult(command, 0, result)
    }

    // A transcript's tail, as the digest (bytes) and the cache clock (lines) read one past what $.fs.read takes.
    await run('tailBytes', tailArgs(input.tailFile, windows, 4096))
    await run('tailLines', tailLinesArgs(input.tailFile, windows, 400))

    // A Claude dispatch, through the executor itself.
    const deps: ExecutorDeps = {
      run: (argv, init) => $.process.run(argv, init),
      files: { read: path => $.fs.read(path), list: path => $.fs.list(path), write: (path, text) => $.fs.write(path, text), stat: path => $.fs.stat(path) },
      now: () => $.clock.now(),
      windows,
    }
    try {
      out.dispatch = await createExecutor('claude', deps, { companionScript: '', companionStateRoots: [], claudeSessionsPath: input.sessions }).dispatch(input.work, input.prompt, {})
    } catch (error) {
      out.dispatch = { error: error instanceof Error ? error.message : String(error) }
    }
    // For the record: the prompt as the last argument, which is what the executor did before (and still does off Windows).
    if (windows) await run('dispatchAsArgument', claudeArgs(input.work, input.prompt, {}, undefined, 'probe-argument'), { cwd: input.work })
    await run('shimArgument', [input.shim, '--bg', input.prompt], { cwd: input.work })
    await run('shimStdin', [input.shim, '--bg'], { cwd: input.work, stdin: input.prompt })

    return { text: `COMMAND_PROBE ${JSON.stringify(out)}` }
  })
}
