import { assertUsableCwd } from '@deepseek-ai/dsh-subagent';
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
import { DEFAULT_DISPOSE_EOF_GRACE_MS, DEFAULT_DISPOSE_GRACE_MS, startAcpRun } from './run.js';
class KiroAcpProvider {
    ctx;
    config;
    name;
    capabilities = {
        agentOptions: false,
        agentPreset: false,
        outputSchema: false,
        depthLimit: false
    };
    inheritsParentContext = false;
    constructor(ctx, config){
        this.ctx = ctx;
        this.config = config;
        this.name = config.providerName;
    }
    start(request) {
        if (request.signal.aborted) {
            throw new Error('subagent request was aborted before the ACP child started');
        }
        const cwd = assertUsableCwd('dsh-kiro', 'child cwd', request.cwd);
        return startAcpRun(request, {
            command: this.config.command,
            args: this.config.args,
            cwd,
            permission: this.config.permission,
            env: this.config.env,
            disposeEofGraceMs: this.config.disposeEofGraceMs,
            disposeGraceMs: this.config.disposeGraceMs,
            spawn: (spawnSpec)=>this.ctx.subprocess.spawn(spawnSpec),
            onActivity: this.config.onActivity,
            onText: this.config.onText,
            onError: (error, stopReason)=>{
                this.ctx.logger.warn(`dsh-kiro ACP child failed (${stopReason}): ${error.message}`);
            }
        });
    }
}
export function registerKiroAcp(ctx, config) {
    const resolved = {
        ...config,
        disposeEofGraceMs: config.disposeEofGraceMs ?? DEFAULT_DISPOSE_EOF_GRACE_MS,
        disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
    };
    for (const [name, value] of Object.entries({
        disposeEofGraceMs: resolved.disposeEofGraceMs,
        disposeGraceMs: resolved.disposeGraceMs
    })){
        if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
            throw new Error(`dsh-kiro ACP: ${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
        }
    }
    ctx.subagents.registerProvider(new KiroAcpProvider(ctx, resolved));
}


//# sourceURL=src/acp/provider.ts