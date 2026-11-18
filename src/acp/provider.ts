/** Kiro-specific ACP subagent provider with a safe tool-activity callback. */

import type { Context } from '@deepseek-ai/cordis'
import {
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_DISPOSE_EOF_GRACE_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  type PermissionPolicy,
  startAcpRun,
} from './run.js'

interface Config {
  providerName: string
  command: string
  args: string[]
  permission: PermissionPolicy
  env: Record<string, string>
  onActivity: (parentSessionId: string, kind: string) => void
  onText: (parentSessionId: string, text: string) => void
  disposeEofGraceMs?: number
  disposeGraceMs?: number
}

class KiroAcpProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  }
  readonly inheritsParentContext = false

  constructor(private readonly ctx: Context, private readonly config: Required<Config>) {
    this.name = config.providerName
  }

  start(request: ResolvedSubagentStartRequest) {
    if (request.signal.aborted) {
      throw new Error('subagent request was aborted before the ACP child started')
    }
    const cwd = assertUsableCwd('dsh-kiro', 'child cwd', request.cwd)
    return startAcpRun(request, {
      command: this.config.command,
      args: this.config.args,
      cwd,
      permission: this.config.permission,
      env: this.config.env,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: (spawnSpec: SubprocessSpawnSpec) => this.ctx.subprocess.spawn(spawnSpec),
      onActivity: this.config.onActivity,
      onText: this.config.onText,
      onError: (error: Error, stopReason: SubagentStopReason) => {
        this.ctx.logger.warn(`dsh-kiro ACP child failed (${stopReason}): ${error.message}`)
      },
    })
  }
}

export function registerKiroAcp(ctx: Context, config: Config): void {
  const resolved = {
    ...config,
    disposeEofGraceMs: config.disposeEofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS,
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  for (const [name, value] of Object.entries({
    disposeEofGraceMs: resolved.disposeEofGraceMs,
    disposeGraceMs: resolved.disposeGraceMs,
  })) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-kiro ACP: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }
  ctx.subagents.registerProvider(new KiroAcpProvider(ctx, resolved))
}
