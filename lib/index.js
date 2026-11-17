import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { apply as applyAcp } from '@deepseek-ai/dsh-subagent-acp';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PROVIDER = 'kiro-acp';
const KIRO_CLI = join(homedir(), '.local', 'bin', 'kiro-cli');
const CATALOG_TTL_MS = 60_000;
const USAGE_TTL_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 15_000;
const effortLevels = {
    'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4.8': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4.7': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4.6': ['low', 'medium', 'high', 'max'],
    'claude-sonnet-5.5': ['low', 'medium', 'high'],
    'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-4.6': ['low', 'medium', 'high', 'max'],
    'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
};
function blockText(block) {
    if (!block || typeof block !== 'object')
        return '';
    if (block.type === 'text')
        return typeof block.text === 'string' ? block.text : '';
    if (block.type === 'reasoning')
        return '';
    if (block.type === 'tool-call') {
        const args = typeof block.arguments === 'string' ? block.arguments : '';
        return `[Parent tool call: ${String(block.name ?? 'tool')}]${args ? `\nArguments: ${args}` : ''}`;
    }
    if (block.type === 'image')
        return '[Image attachment omitted by the ACP model adapter.]';
    if (block.type === 'file')
        return '[File attachment omitted by the ACP model adapter.]';
    return '';
}
function transcript(options) {
    const sections = [
        'You are the selected Kiro model inside DeepSeek Harness. Answer the latest user request in this transcript.',
        'Use tools available to your Kiro ACP session when workspace work is needed. The parent Harness tool schemas and non-text attachments are not passed through this adapter.',
        'Treat earlier messages as context. Return the final answer only; do not claim work you did not complete.'
    ];
    if (typeof options.system === 'string' && options.system.length > 0) {
        sections.push(`===== SYSTEM =====\n${options.system}`);
    }
    for (const message of options.messages ?? []) {
        const role = typeof message?.role === 'string' ? message.role.toUpperCase() : 'MESSAGE';
        const content = Array.isArray(message?.content)
            ? message.content.map(blockText).filter(Boolean).join('\n')
            : '';
        if (content)
            sections.push(`===== ${role} =====\n${content}`);
    }
    return sections.join('\n\n');
}
function outputText(blocks) {
    return (blocks ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
}
function parseCredits(output) {
    const number = (value) => Number(value.replaceAll(',', ''));
    let bonusRemaining = 0;
    let bonusFound = false;
    for (const match of output.matchAll(/^\s*[^:\n]+:\s*([\d,.]+)\s*\/\s*([\d,.]+)\s*credits used\b/gim)) {
        const used = number(match[1] ?? '');
        const total = number(match[2] ?? '');
        if (Number.isFinite(used) && Number.isFinite(total)) {
            bonusRemaining += Math.max(0, total - used);
            bonusFound = true;
        }
    }
    const planMatch = output.match(/Credits\s*\(\s*([\d,.]+)\s+of\s+([\d,.]+)\s+covered in plan\s*\)/i);
    const planUsed = planMatch ? number(planMatch[1] ?? '') : 0;
    const planTotal = planMatch ? number(planMatch[2] ?? '') : 0;
    const planRemaining = planMatch && Number.isFinite(planUsed) && Number.isFinite(planTotal)
        ? Math.max(0, planTotal - planUsed)
        : 0;
    if (!bonusFound && !planMatch)
        return undefined;
    const header = output.match(/Estimated Usage\s*\|\s*(?:resets on\s+([^|]+?)\s*\|\s*)?([^\n]+)/i);
    const tier = header?.[2]?.trim();
    const resets = header?.[1]?.trim();
    return {
        ...(tier ? { tier } : {}),
        ...(resets ? { resets } : {}),
        bonusRemaining,
        planRemaining,
        totalRemaining: bonusRemaining + planRemaining,
    };
}
function formatCredits(value) {
    return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function modelLabel(id) {
    if (id === 'auto')
        return 'Auto';
    if (id.startsWith('claude-'))
        return `Claude ${id.slice(7).replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`;
    if (id.startsWith('gpt-'))
        return `GPT-${id.slice(4).replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`;
    if (id.startsWith('deepseek-'))
        return `DeepSeek ${id.slice(9).replaceAll('-', ' ').toUpperCase()}`;
    if (id.startsWith('minimax-'))
        return `MiniMax ${id.slice(8).toUpperCase()}`;
    if (id.startsWith('qwen'))
        return id.replaceAll('-', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (id.startsWith('glm-'))
        return `GLM-${id.slice(4).toUpperCase()}`;
    if (id.startsWith('grok-'))
        return `Grok ${id.slice(5)}`;
    if (id.startsWith('kimi-'))
        return `Kimi ${id.slice(5).toUpperCase()}`;
    return id;
}
function modelDescription(model, usage) {
    const details = [model.description];
    if (typeof model.context_window_tokens === 'number') {
        details.push(`${formatCredits(model.context_window_tokens / 1_000_000)}M context`);
    }
    if (typeof model.rate_multiplier === 'number') {
        details.push(`${model.rate_multiplier}× credit rate`);
    }
    if (usage) {
        const balance = [
            `${formatCredits(usage.totalRemaining)} credits remaining`,
            ...(usage.bonusRemaining > 0 ? [`${formatCredits(usage.bonusRemaining)} bonus`] : []),
            ...(usage.planRemaining > 0 ? [`${formatCredits(usage.planRemaining)} plan`] : []),
        ].join(' · ');
        details.push(`${usage.tier ? `${usage.tier} · ` : ''}${balance}${usage.resets ? ` · resets ${usage.resets}` : ''}`);
    }
    return details.filter(Boolean).join(' · ');
}
function modelPickerName(model, usage) {
    const name = modelLabel(model.model_id);
    return usage ? `${name} · ${formatCredits(usage.totalRemaining)} credits left` : name;
}
async function readStream(stream) {
    if (!stream)
        return '';
    const chunks = [];
    for await (const chunk of stream)
        chunks.push(String(chunk));
    return chunks.join('');
}
async function runKiroCommand(ctx, args) {
    const controller = new AbortController();
    const child = ctx.subprocess.spawn({
        argv: [KIRO_CLI, ...args],
        cwd: homedir(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
        graceMs: 1_000,
        signal: controller.signal,
    });
    const stdout = readStream(child.stdout).catch(() => '');
    let timeout;
    try {
        const result = await Promise.race([
            child.done.then((outcome) => ({ outcome })),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve({ timedOut: true }), COMMAND_TIMEOUT_MS);
            }),
        ]);
        if ('timedOut' in result) {
            controller.abort();
            await child.waitForExit().catch(() => undefined);
            throw new Error('Kiro CLI command timed out.');
        }
        const text = await stdout;
        if (result.outcome.exitCode !== 0)
            throw new Error(`Kiro CLI command exited with code ${result.outcome.exitCode ?? 'unknown'}.`);
        return text;
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
function fallbackSnapshot() {
    return {
        models: [{
                model_id: 'auto',
                model_name: 'auto',
                description: 'Kiro CLI model catalog is unavailable. Check that Kiro is installed and signed in.',
            }],
    };
}
class KiroAcpAdapter extends LlmAdapter {
    ctx;
    snapshot;
    loading;
    usageSnapshot;
    usageLoading;
    registeredAcpProviders = new Set();
    constructor(ctx) {
        super();
        this.ctx = ctx;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Kiro via ACP' };
    }
    async discover() {
        if (this.snapshot && this.snapshot.expiresAt > Date.now())
            return this.snapshot.value;
        if (this.loading)
            return this.loading;
        this.loading = (async () => {
            try {
                const catalogText = await runKiroCommand(this.ctx, ['chat', '--list-models', '--format', 'json-pretty']);
                const catalog = JSON.parse(catalogText);
                const models = Array.isArray(catalog?.models)
                    ? catalog.models.filter((item) => typeof item?.model_id === 'string' && typeof item?.model_name === 'string')
                    : [];
                const usage = this.usageSnapshot && this.usageSnapshot.expiresAt > Date.now()
                    ? this.usageSnapshot.value
                    : undefined;
                const value = models.length > 0
                    ? { models: models, ...(usage ? { usage } : {}) }
                    : fallbackSnapshot();
                this.snapshot = { expiresAt: Date.now() + CATALOG_TTL_MS, value };
                // Keep the picker responsive if Kiro's separate usage command takes
                // longer than model discovery. A later update refreshes the picker.
                void this.discoverUsage();
                return value;
            }
            catch {
                const value = this.snapshot?.value ?? fallbackSnapshot();
                this.snapshot = { expiresAt: Date.now() + CATALOG_TTL_MS, value };
                return value;
            }
            finally {
                this.loading = undefined;
            }
        })();
        return this.loading;
    }
    async discoverUsage() {
        if (this.usageSnapshot && this.usageSnapshot.expiresAt > Date.now())
            return this.usageSnapshot.value;
        if (this.usageLoading)
            return this.usageLoading;
        this.usageLoading = (async () => {
            try {
                const output = await runKiroCommand(this.ctx, ['chat', '--no-interactive', '/usage']);
                const value = parseCredits(output);
                this.usageSnapshot = { expiresAt: Date.now() + USAGE_TTL_MS, ...(value ? { value } : {}) };
                if (value && this.snapshot) {
                    this.snapshot = {
                        ...this.snapshot,
                        value: { ...this.snapshot.value, usage: value },
                    };
                    this.ctx.emit?.('llm/models-updated', PROVIDER);
                }
                return value;
            }
            catch (error) {
                this.usageSnapshot = { expiresAt: Date.now() + 60_000 };
                this.ctx.logger?.warn?.(`dsh-kiro: Kiro credit lookup failed: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
            finally {
                this.usageLoading = undefined;
            }
        })();
        return this.usageLoading;
    }
    async listModels(provider) {
        const snapshot = await this.discover();
        return snapshot.models.map((model) => ({
            provider,
            id: model.model_id,
            name: modelPickerName(model, snapshot.usage),
            description: modelDescription(model, snapshot.usage),
            inputModalities: ['text'],
            ...(snapshot.usage ? {
                badge: { text: `${formatCredits(snapshot.usage.totalRemaining)} credits left`, tone: 'info' },
            } : {}),
        }));
    }
    async resolveModel(provider, model) {
        const snapshot = await this.discover();
        const entry = snapshot.models.find((candidate) => candidate.model_id === model);
        const efforts = effortLevels[model];
        return {
            provider,
            id: model,
            name: modelPickerName(entry ?? { model_id: model, model_name: model }, snapshot.usage),
            description: entry ? modelDescription(entry, snapshot.usage) : 'Kiro CLI agent over the configured ACP connection.',
            inputModalities: ['text'],
            ...(typeof entry?.context_window_tokens === 'number'
                ? { context: { contextWindow: entry.context_window_tokens } }
                : {}),
            ...(efforts ? {
                reasoning: {
                    efforts: efforts.map((id) => ({ id: id, name: id === 'xhigh' ? 'Extra high' : `${id[0]?.toUpperCase()}${id.slice(1)}` })),
                },
            } : {}),
        };
    }
    acpProvider(model, effort) {
        const providerName = `kiro-acp-${model}-${effort ?? 'default'}`;
        if (!this.registeredAcpProviders.has(providerName)) {
            applyAcp(this.ctx, {
                providerName,
                command: KIRO_CLI,
                args: [
                    'acp',
                    '--model', model,
                    ...(effort ? ['--effort', effort] : []),
                ],
                permission: 'allow',
                env: {},
                disposeEofGraceMs: 6_000,
                disposeGraceMs: 3_000,
            });
            this.registeredAcpProviders.add(providerName);
        }
        return providerName;
    }
    async *stream(options) {
        const signal = options.signal ?? new AbortController().signal;
        if (!options.sessionId)
            throw new Error('Kiro via ACP needs an active DeepSeek Harness session.');
        const parent = await this.ctx.agents.get(options.sessionId);
        if (!parent)
            throw new Error('Kiro via ACP could not find the active Harness agent.');
        const provider = this.acpProvider(options.model || 'auto', options.reasoningEffort);
        let activation;
        try {
            activation = await this.ctx.subagents.startActivation({
                provider,
                label: `Kiro ${modelLabel(options.model || 'auto')} response`,
                request: {
                    prompt: [{ type: 'text', text: transcript(options) }],
                    parent
                },
                signal,
                delivery: 'caller'
            });
        }
        catch (error) {
            const detail = error instanceof Error ? error.stack ?? error.message : String(error);
            throw new Error(`Kiro ACP activation failed: ${detail}`);
        }
        try {
            const result = await activation.result;
            if (signal.aborted || result.stopReason === 'aborted') {
                throw new DOMException('Kiro ACP request was cancelled.', 'AbortError');
            }
            if (result.stopReason === 'error') {
                throw new Error(`Kiro ACP child reported an error: ${result.diagnostic || 'unknown ACP error'}`);
            }
            const text = outputText(result.output);
            if (!text.trim())
                throw new Error('Kiro ACP returned no assistant text.');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield { type: 'block-end', index: 0, block: { type: 'text', text } };
            yield {
                type: 'finish',
                reason: result.stopReason === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' }
            };
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Kiro ACP execution failed: ${detail}`);
        }
        finally {
            if (activation)
                await activation.dispose();
            this.snapshot = undefined;
            this.ctx.emit?.('llm/models-updated', PROVIDER);
        }
    }
}
export const name = 'dsh-kiro';
export const inject = ['llm', 'agents', 'subagents', 'subprocess'];
export function apply(ctx) {
    ctx.llm.registerAdapter([PROVIDER], new KiroAcpAdapter(ctx));
}
//# sourceMappingURL=index.js.map
