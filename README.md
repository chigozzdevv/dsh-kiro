# dsh-kiro

A selectable Kiro entry for DeepSeek Harness. This fork calls Kiro CLI through its supported Agent Client Protocol (ACP) interface. It does not call Kiro's private model API.

## How it works

The plugin registers **Kiro via ACP** in the normal DSH model picker. A model request is passed to the existing DSH ACP subagent provider named `kiro`, which launches the configured Kiro CLI ACP process. Kiro uses its own model, tools, and signed-in account, then returns its final text to DSH.

Choose **Kiro CLI** in the model picker. The displayed model follows Kiro CLI's active agent/model configuration; this plugin does not expose a separate model menu.

## Requirements

- DeepSeek Harness with its ACP subagent package enabled.
- A DSH ACP provider named `kiro` configured to run `kiro-cli acp` (or the full path to that command).
- Kiro CLI installed and signed in.
- The DSH ACP permission policy must allow the Kiro CLI tools you want it to use.

Install from the DSH plugin manager with:

```text
github:chigozzdevv/dsh-kiro#acp-model-provider
```

## Limits

This is a selectable DSH model route backed by an ACP agent. It returns the child's final answer after the ACP run completes, so it does not show token-by-token output. DSH's tool schemas, image attachments, and file attachments are not forwarded; Kiro uses its own ACP tools and can work in the selected workspace when its permissions allow it.

ACP's result does not include Kiro token counts, so this adapter does not report per-request usage. Requests use the Kiro CLI account and may consume Kiro credits. They do not require DeepSeek credits.

## Upstream

- [Kiro CLI ACP documentation](https://kiro.dev/docs/cli/acp/)
- [DSH LLM adapter contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md)
- [DSH ACP subagent documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-acp/README.md)

The original project is [dat-lequoc/dsh-kiro](https://github.com/dat-lequoc/dsh-kiro). This fork replaces its direct Kiro API adapter with the ACP route. It is not affiliated with or endorsed by AWS, Kiro, or DeepSeek.
