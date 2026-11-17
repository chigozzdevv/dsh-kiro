import { LlmAdapter } from "@deepseek-ai/dsh-llm";

const PROVIDER = "kiro-acp";
const MODEL_ID = "kiro-cli";
const ACP_PROVIDER = "acp_kiro";

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return typeof block.text === "string" ? block.text : "";
  if (block.type === "reasoning") return "";
  if (block.type === "tool-call") {
    const args = typeof block.arguments === "string" ? block.arguments : "";
    return `[Parent tool call: ${String(block.name ?? "tool")}]${args ? `\nArguments: ${args}` : ""}`;
  }
  if (block.type === "image") return "[Image attachment omitted by the ACP model adapter.]";
  if (block.type === "file") return "[File attachment omitted by the ACP model adapter.]";
  return "";
}

function transcript(options) {
  const sections = [
    "You are the selected Kiro model inside DeepSeek Harness. Answer the latest user request in this transcript.",
    "Use tools available to your Kiro ACP session when workspace work is needed. The parent Harness tool schemas and non-text attachments are not passed through this adapter.",
    "Treat earlier messages as context. Return the final answer only; do not claim work you did not complete."
  ];
  if (typeof options.system === "string" && options.system.length > 0) {
    sections.push(`===== SYSTEM =====\n${options.system}`);
  }
  for (const message of options.messages ?? []) {
    const role = typeof message?.role === "string" ? message.role.toUpperCase() : "MESSAGE";
    const content = Array.isArray(message?.content)
      ? message.content.map(blockText).filter(Boolean).join("\n")
      : "";
    if (content) sections.push(`===== ${role} =====\n${content}`);
  }
  return sections.join("\n\n");
}

function outputText(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

class KiroAcpAdapter extends LlmAdapter {
  constructor(ctx) {
    super();
    this.ctx = ctx;
  }

  providerInfo(provider) {
    return { id: provider, name: "Kiro via ACP" };
  }

  async listModels(provider) {
    return [{
      provider,
      id: MODEL_ID,
      name: "Kiro CLI",
      description: "Kiro CLI agent over the configured ACP connection."
    }];
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model === MODEL_ID ? "Kiro CLI" : model,
      description: "Kiro CLI agent over the configured ACP connection.",
      inputModalities: ["text"]
    };
  }

  async *stream(options) {
    const signal = options.signal ?? new AbortController().signal;
    if (!options.sessionId) {
      throw new Error("Kiro via ACP needs an active DeepSeek Harness session.");
    }

    const parent = await this.ctx.agents.get(options.sessionId);
    if (!parent) {
      throw new Error("Kiro via ACP could not find the active Harness agent.");
    }

    let activation;
    try {
      activation = await this.ctx.subagents.startActivation({
        provider: ACP_PROVIDER,
        parent,
        prompt: [{ type: "text", text: transcript(options) }],
        label: "Kiro model response",
        signal,
        delivery: "caller"
      });
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      throw new Error(`Kiro ACP activation failed: ${detail}`);
    }

    try {
      const result = await activation.result;
      if (signal.aborted || result.stopReason === "aborted") {
        throw new DOMException("Kiro ACP request was cancelled.", "AbortError");
      }
      if (result.stopReason === "error") {
        throw new Error(`Kiro ACP child reported an error: ${result.diagnostic || "unknown ACP error"}`);
      }

      const text = outputText(result.output);
      if (!text.trim()) {
        throw new Error("Kiro ACP returned no assistant text.");
      }

      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield {
        type: "finish",
        reason: result.stopReason === "max-tokens" ? { kind: "max-tokens" } : { kind: "stop" }
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Kiro ACP execution failed: ${detail}`);
    } finally {
      if (activation) await activation.dispose();
    }
  }
}

export const name = "dsh-kiro";
export const inject = ["llm", "agents", "subagents"];

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new KiroAcpAdapter(ctx));
}
