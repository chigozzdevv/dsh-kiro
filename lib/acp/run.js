import { randomUUID } from 'node:crypto';
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream';
import { client as createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { brandString } from '@deepseek-ai/dsh-brand';
import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent';
export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000;
export const DEFAULT_DISPOSE_GRACE_MS = 3_000;
const ACP_TOOL_KINDS = new Set([
    'read',
    'edit',
    'delete',
    'move',
    'search',
    'execute',
    'think',
    'fetch',
    'switch_mode',
    'other'
]);
function failureDiagnostic(facts) {
    const fields = [
        'provider: ACP',
        `stage: ${facts.stage}`,
        `category: ${facts.category}`
    ];
    if (facts.stopReason !== undefined) fields.push(`stop reason: ${facts.stopReason}`);
    if (facts.outcome?.exitCode !== null && facts.outcome?.exitCode !== undefined) {
        fields.push(`exit code: ${facts.outcome.exitCode}`);
    }
    if (facts.outcome?.signal !== null && facts.outcome?.signal !== undefined) {
        fields.push(`signal: ${facts.outcome.signal}`);
    }
    return `Subagent failure (${fields.join('; ')})`;
}
function permissionDiagnostic(permission) {
    return `ACP unattended decision (policy: ${permission.policy}; request: ${permission.request}; decision: ${permission.decision})`;
}
function diagnosticText(facts, permission) {
    const failure = failureDiagnostic(facts);
    return permission === undefined ? failure : `${failure}\n${permissionDiagnostic(permission)}`;
}
class AcpRunFailure extends Error {
    constructor(facts, cause){
        super(`subagent-acp: ${failureDiagnostic(facts)}`, {
            cause
        });
        this.name = 'AcpRunFailure';
    }
}
export function acpConfigurationFailure(cause) {
    return new AcpRunFailure({
        stage: 'initialize',
        category: 'configuration'
    }, cause);
}
function permissionRequestKind(kind) {
    const candidate = kind ?? 'unknown';
    return ACP_TOOL_KINDS.has(candidate) ? candidate : 'unknown';
}
async function rangeExitsWithin(child, ms) {
    const controller = new AbortController();
    const timer = setTimeout(()=>{
        controller.abort();
    }, ms);
    try {
        return await child.waitForExit(controller.signal);
    } finally{
        clearTimeout(timer);
    }
}
export async function disposeAcpChild(child, eofGraceMs) {
    const failures = [];
    child.stdin?.end();
    let exited = false;
    try {
        exited = await rangeExitsWithin(child, eofGraceMs);
    } catch (error) {
        failures.push(toError(error));
    }
    if (exited) return;
    child.terminate();
    try {
        await child.waitForExit();
    } catch (error) {
        failures.push(toError(error));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'ACP subprocess teardown failed');
}
export function acpStopReason(reason) {
    switch(reason){
        case 'end_turn':
            return 'completed';
        case 'max_tokens':
            return 'max-tokens';
        case 'refusal':
            return 'refusal';
        case 'cancelled':
            return 'aborted';
        case 'max_turn_requests':
            return 'error';
        default:
            return 'error';
    }
}
export function acpContentText(content) {
    return content.type === 'text' ? content.text : '';
}
export function toAcpPrompt(prompt) {
    const blocks = [];
    for (const block of prompt){
        if (block.type === 'text') blocks.push({
            type: 'text',
            text: block.text
        });
    }
    return blocks;
}
function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
function reportFailure(spec, error) {
    try {
        spec.onError?.(toError(error), 'error');
    } catch (_diagnosticSinkFailed) {}
}
function startupFailure(error, stage, outcome) {
    return new AcpRunFailure(outcome === undefined ? {
        stage,
        category: 'transport'
    } : {
        stage,
        category: 'process-exit',
        outcome
    }, error);
}
function terminalFailure(reason, permission) {
    switch(reason){
        case 'end_turn':
            return undefined;
        case 'max_turn_requests':
            return diagnosticText({
                stage: 'prompt',
                category: 'remote-limit',
                stopReason: 'max_turn_requests'
            }, permission);
        case 'max_tokens':
        case 'refusal':
        case 'cancelled':
            return permission === undefined ? undefined : permissionDiagnostic(permission);
        default:
            return diagnosticText({
                stage: 'prompt',
                category: 'unknown',
                stopReason: 'unknown'
            }, permission);
    }
}
export async function startAcpRun(request, spec) {
    if (request.signal.aborted) throw new Error('subagent request was aborted before the ACP child started');
    const id = brandString(randomUUID());
    let child;
    try {
        child = spec.spawn({
            argv: [
                spec.command,
                ...spec.args
            ],
            cwd: spec.cwd,
            stdio: {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'inherit'
            },
            graceMs: spec.disposeGraceMs,
            env: spec.env
        });
    } catch (error) {
        reportFailure(spec, error);
        throw new AcpRunFailure({
            stage: 'process',
            category: 'process-start'
        }, error);
    }
    if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('subagent-acp: subprocess implementation dropped a piped protocol stream');
    }
    let processOutcome;
    let processFailure;
    const processDone = child.done.then((outcome)=>{
        processOutcome = outcome;
        return outcome;
    }, (error)=>{
        processFailure = toError(error);
        throw processFailure;
    });
    const processRejected = processDone.then(()=>new Promise(()=>{}), (err)=>Promise.reject(toError(err)));
    processRejected.catch(()=>{});
    const observeProcessOutcome = async (signal)=>{
        if (processOutcome !== undefined) return processOutcome;
        const timeout = AbortSignal.timeout(Math.ceil(spec.disposeGraceMs));
        const bound = signal === undefined ? timeout : AbortSignal.any([
            signal,
            timeout
        ]);
        const aborted = Promise.withResolvers();
        const onObservationAbort = ()=>{
            aborted.resolve(undefined);
        };
        bound.addEventListener('abort', onObservationAbort, {
            once: true
        });
        if (bound.aborted) onObservationAbort();
        try {
            return await Promise.race([
                processDone,
                aborted.promise
            ]);
        } catch  {
            return processOutcome;
        } finally{
            bound.removeEventListener('abort', onObservationAbort);
        }
    };
    let processDisposal;
    const disposeProcess = ()=>processDisposal ??= disposeAcpChild(child, spec.disposeEofGraceMs);
    const fold = new AssistantOutputFold();
    const flags = {
        cancelled: false
    };
    let latestPermission;
    const clientApp = createAcpClientApp({
        name: 'deepseek-harness-subagent-acp'
    }).onNotification(methods.client.session.update, ({ params })=>{
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk') {
            const text = acpContentText(update.content);
            fold.pushText(text);
            if (text.length > 0) {
                try {
                    spec.onText?.(request.parent.id, text);
                } catch (_textSinkFailed) {}
            }
        } else if (update.sessionUpdate === 'tool_call') {
            const toolCall = Reflect.get(update, 'toolCall');
            const kind = toolCall && typeof toolCall === 'object' ? Reflect.get(toolCall, 'kind') : undefined;
            const safeKind = typeof kind === 'string' && ACP_TOOL_KINDS.has(kind) ? kind : 'other';
            try {
                spec.onActivity?.(request.parent.id, safeKind);
            } catch (_activitySinkFailed) {}
        }
        return Promise.resolve();
    }).onRequest(methods.client.session.requestPermission, ({ params })=>{
        if (spec.permission === 'allow') {
            const allow = params.options.find((o)=>o.kind === 'allow_once' || o.kind === 'allow_always');
            if (allow !== undefined) {
                latestPermission = {
                    policy: 'allow',
                    request: permissionRequestKind(params.toolCall.kind),
                    decision: 'allowed'
                };
                return Promise.resolve({
                    outcome: {
                        outcome: 'selected',
                        optionId: allow.optionId
                    }
                });
            }
        }
        latestPermission = {
            policy: spec.permission,
            request: permissionRequestKind(params.toolCall.kind),
            decision: 'denied'
        };
        return Promise.resolve({
            outcome: {
                outcome: 'cancelled'
            }
        });
    });
    const connection = clientApp.connect(ndJsonStream(NodeWritable.toWeb(child.stdin), NodeReadable.toWeb(child.stdout)));
    const agent = connection.agent;
    let sessionId;
    let startupStage = 'initialize';
    let signalCancelSettled;
    const cancelSettled = new Promise((resolve)=>{
        signalCancelSettled = resolve;
    });
    const requestCancel = ()=>{
        if (flags.cancelled) return;
        flags.cancelled = true;
        signalCancelSettled();
        if (sessionId !== undefined) {
            void agent.notify(methods.agent.session.cancel, {
                sessionId
            }).catch(()=>{});
        }
    };
    const onAbort = ()=>{
        requestCancel();
    };
    request.signal.addEventListener('abort', onAbort, {
        once: true
    });
    const collectOutput = ()=>fold.collect() ?? [];
    try {
        await Promise.race([
            (async ()=>{
                await agent.request(methods.agent.initialize, {
                    protocolVersion: PROTOCOL_VERSION,
                    clientCapabilities: {}
                });
                startupStage = 'new-session';
                const session = await agent.request(methods.agent.session.new, {
                    cwd: spec.cwd,
                    mcpServers: []
                });
                const returnedSessionId = Reflect.get(session, 'sessionId');
                if (typeof returnedSessionId !== 'string') {
                    throw new AcpRunFailure({
                        stage: 'new-session',
                        category: 'protocol'
                    }, new Error('ACP child published without a session id'));
                }
                sessionId = returnedSessionId;
                if (flags.cancelled) throw new Error('subagent cancelled before the ACP session started');
            })(),
            processRejected,
            cancelSettled.then(()=>{
                throw new Error('subagent cancelled before the ACP session started');
            })
        ]);
    } catch (error) {
        request.signal.removeEventListener('abort', onAbort);
        const cancelledBeforeCleanup = flags.cancelled;
        const observedOutcome = !cancelledBeforeCleanup && !(error instanceof AcpRunFailure) ? await observeProcessOutcome() : undefined;
        const startup = cancelledBeforeCleanup ? {
            kind: 'cancelled'
        } : {
            kind: 'failed',
            failure: error instanceof AcpRunFailure ? error : startupFailure(error, startupStage, observedOutcome)
        };
        if (startup.kind === 'cancelled') {} else {
            reportFailure(spec, error instanceof AcpRunFailure ? error.cause : processFailure ?? error);
        }
        try {
            await disposeProcess();
        } catch (cleanupError) {
            reportFailure(spec, cleanupError);
            const cleanupFailure = new AcpRunFailure({
                stage: 'teardown',
                category: processOutcome === undefined ? 'unknown' : 'process-exit',
                ...processOutcome === undefined ? {} : {
                    outcome: processOutcome
                }
            }, cleanupError);
            if (startup.kind === 'cancelled') {
                throw new AggregateError([
                    cleanupFailure
                ], cleanupFailure.message);
            }
            throw new AggregateError([
                startup.failure,
                cleanupFailure
            ], `${startup.failure.message}; ${cleanupFailure.message}`);
        }
        if (startup.kind === 'cancelled') {
            throw new Error('subagent request was aborted before the ACP child started');
        }
        throw startup.failure;
    }
    if (sessionId === undefined) throw new Error('unreachable: ACP startup fulfilled without a session id');
    const remoteSessionId = sessionId;
    let diagnostic;
    const result = settleRunResult({
        attempt: async ()=>{
            try {
                const promptResult = await Promise.race([
                    agent.request(methods.agent.session.prompt, {
                        sessionId: remoteSessionId,
                        prompt: toAcpPrompt(request.prompt)
                    }),
                    cancelSettled.then(()=>{
                        throw new Error('subagent cancelled while the ACP prompt was running');
                    })
                ]);
                const stopReason = acpStopReason(promptResult.stopReason);
                diagnostic = terminalFailure(promptResult.stopReason, latestPermission);
                return {
                    output: collectOutput(),
                    ...diagnostic === undefined ? {} : {
                        diagnostic
                    },
                    stopReason
                };
            } catch (error) {
                if (!flags.cancelled) {
                    const outcome = await observeProcessOutcome(request.signal);
                    const facts = outcome === undefined ? {
                        stage: 'prompt',
                        category: 'transport'
                    } : {
                        stage: 'process',
                        category: 'process-exit',
                        outcome
                    };
                    diagnostic = diagnosticText(facts, latestPermission);
                }
                throw processFailure ?? error;
            }
        },
        collectOutput,
        collectDiagnostic: ()=>diagnostic,
        cancelled: ()=>flags.cancelled,
        onError: spec.onError,
        signal: request.signal,
        onAbort
    });
    return subprocessRunHandle({
        id,
        result,
        signal: request.signal,
        onAbort,
        requestCancel,
        teardown: async ()=>{
            try {
                await disposeProcess();
            } catch (error) {
                reportFailure(spec, error);
                throw new AcpRunFailure({
                    stage: 'teardown',
                    category: processOutcome === undefined ? 'unknown' : 'process-exit',
                    ...processOutcome === undefined ? {} : {
                        outcome: processOutcome
                    }
                }, error);
            }
        }
    });
}


//# sourceURL=src/acp/run.ts