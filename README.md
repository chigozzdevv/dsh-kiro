# dsh-kiro

A selectable Kiro entry for DeepSeek Harness. This fork calls Kiro CLI through its supported Agent Client Protocol (ACP) interface. It does not call Kiro's private model API.

## How it works

The plugin registers Kiro in DSH's normal model picker and reads the signed-in account's available models, context sizes, and credit rates from `kiro-cli chat --list-models`. It also reads the current balance from Kiro CLI's `/usage` command. The model catalog is cached for up to one minute; the balance is cached for up to five minutes and refreshed after a Kiro response when that cache expires.

Choose a Kiro model in the picker. DSH exposes effort levels for models whose supported options are documented by Kiro. The selected model and effort are passed to Kiro's ACP server at startup. Kiro runs its own tools in the selected workspace, then returns its final text to DSH.

## Requirements

- DeepSeek Harness with its ACP subagent package enabled.
- DSH's subprocess and ACP subagent services.
- Kiro CLI installed and signed in.
- Kiro tool permission requests are automatically allowed by this adapter, matching the configured DSH `allow` policy.

Install from the DSH plugin manager with:

```text
github:chigozzdevv/dsh-kiro#acp-model-provider
```

## Limits

This is a selectable DSH model route backed by an ACP agent. It returns the child's final answer after the ACP run completes, so it does not show token-by-token output. DSH's tool schemas, image attachments, and file attachments are not forwarded; Kiro uses its own ACP tools in the selected workspace.

ACP's result does not include per-request token counts. The model picker shows Kiro's account balance and each model's credit-rate multiplier when Kiro CLI reports them. Requests use the Kiro CLI account and may consume Kiro credits. They do not require DeepSeek credits.

Kiro exposes only some effort choices for some models. This adapter lists the choices documented by Kiro and leaves the control out for models without documented effort support.

## Upstream

- [Kiro CLI ACP documentation](https://kiro.dev/docs/cli/acp/)
- [DSH LLM adapter contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md)
- [DSH ACP subagent documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-acp/README.md)

The original project is [dat-lequoc/dsh-kiro](https://github.com/dat-lequoc/dsh-kiro). This fork replaces its direct Kiro API adapter with the ACP route. It is not affiliated with or endorsed by AWS, Kiro, or DeepSeek.
