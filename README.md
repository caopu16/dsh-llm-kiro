# dsh-llm-kiro

English | [中文](README.zh.md)

An [AWS Kiro](https://kiro.dev) (CodeWhisperer) adapter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM seam. It registers the `kiro` provider route, so a signed-in Kiro account serves Claude and open-weight models to the harness without a separate API key.

## Requirements

- A working `dsh` install (this package is a plugin, not a standalone tool).
- A Kiro sign-in on the same machine. The Kiro IDE or `kiro-cli` writes the tokens this adapter reads; it never stores a second copy of the credential.
- For Claude models: a permitted network egress. See [Why Claude needs a proxy](#why-claude-needs-a-proxy).

## Install

```sh
dsh plugin --profile web add github:caopu16/dsh-llm-kiro
```

That is the whole install, and upgrading is the same command again. Built `lib/` is committed to the repository precisely so a git-sourced install runs no build script: pnpm 10 and later block dependency build scripts until each is allowlisted by a key carrying its resolved commit, which would make every upgrade a manual allowlist edit.

The package declares its own patch layer, so installing it mounts the adapter — no `cordis.yml` editing required to make the route exist. Add configuration only for the facts this package deliberately leaves empty.

### Without the `dsh` command

`dsh` on PATH comes from an installed `@deepseek-ai/dsh`. When you are working from a harness source checkout instead, run the CLI from that checkout and every command above works unchanged:

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add github:caopu16/dsh-llm-kiro
pnpm dsh --profile web
```

A source checkout requires `pnpm run build` first, since the profile loads built `lib/` rather than TypeScript sources.

### Developing this plugin

`lib/` is committed, so a change to `src/` reaches consumers only after it is rebuilt and committed too:

```sh
npm install
npm run build
npm test
```

## Configure

Kiro authorizes Claude models by request egress, and the permitted egress differs per deployment, so no proxy is shipped as a default. Supply yours in the profile patch layer (`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: llm-kiro
  config:
    proxyUrl: http://proxy.example:1082
    reasoningEffort: medium
```

Every field is optional:

| Field | Default | Meaning |
|---|---|---|
| `proxyUrl` | none (direct) | Egress for every Kiro request, `http://` or `https://`, with optional `user:pass@`. An invalid value fails plugin loading. |
| `region` | the signed-in token's region | Selects the `q.<region>.amazonaws.com` endpoint. |
| `profileArn` | the account default | CodeWhisperer profile the account bills against. |
| `thinking` | `enabled` | `disabled` locks every request to effort `off`. |
| `reasoningEffort` | `off` | `off`, `low`, `medium`, or `high`. |
| `defaultContextWindow` | `200000` | Capacity used for a model with no exact value. |
| `models` | the verified account tier | Advisory catalog for model selectors; unlisted ids still reach the wire. |
| `streamIdleTimeoutMs` | `300000` | Maximum provider idle time while one read is outstanding. |
| `tokenExpiryBufferMs` | `300000` | Refresh the access token this long before expiry. |
| `retryPolicy` | bounded normal | Provider-owned retry policy, executed by `dsh-llm-retry`. |

The plugin also registers the `llm-kiro` settings namespace, so a `llm-kiro:` section in `$DSH_HOME/settings.yaml` overrides any field above without a restart — that is what the web Models page writes.

## Use

Select provider `kiro` and any model id it serves:

```
claude-opus-5     claude-opus-4.8    claude-opus-4.7   claude-opus-4.6  claude-opus-4.6-1m
claude-opus-4.5   claude-sonnet-5    claude-sonnet-4.6 claude-sonnet-4.6-1m
claude-sonnet-4.5 claude-sonnet-4    claude-haiku-4.5  auto
deepseek-3.2      glm-5              minimax-m2.5      qwen3-coder-next
```

Model ids are passed through as the wire `modelId`, so a model Kiro adds later works without upgrading this package. The shipped catalog is advisory only: an unlisted id still reaches the service, and the ids above are the ones one account tier was observed to accept. `minimax-m2.1` is omitted because the service reports it temporarily unavailable, and the `-1m` variants of Sonnet 4.5, Sonnet 5, and Opus 4.8 because it rejects them as unknown — another tier may differ.

## Why Claude needs a proxy

Kiro authorizes model families by request egress, not only by account entitlement. From an unauthorized egress every `claude-*` id is refused with `INVALID_MODEL` while the open-weight ids answer normally; through a permitted egress the same account and token reach the whole catalog. `proxyUrl` therefore exists for correctness, not performance, and the open-weight models need no proxy at all.

The proxy is opened as an HTTP `CONNECT` tunnel with TLS negotiated inside it, so the proxy sees only the target host name, never request contents or the bearer token.

## Credentials

The adapter reads `~/.aws/sso/cache/kiro-auth-token.json` plus the sibling device-registration file it names. When the stored access token is still valid it is used as-is; otherwise the adapter exchanges the refresh token for a fresh one and caches that **in memory only**. Kiro owns those files and writes them from its own sign-in, so writing back would race a process this plugin does not coordinate with.

A missing sign-in fails the first request with `MISSING_CREDENTIAL` naming the expected path, rather than failing at load or silently producing nothing.

## Model Experience

### Kiro request

**What the model sees.** Kiro has no system slot, so the harness system prompt is prepended to the earliest user turn, where thinking markers also go. History is folded into the strict user/assistant alternation the service requires; a gap becomes a `[system: conversation continues]` placeholder. Tool schemas ride on the current turn. A tool result whose issuing call is absent from history (compaction dropped it) is carried as text, because the service rejects the unmatched id.

**Token effect.** Provider tokenization governs exact input. The thinking markers add a fixed short prefix at any effort above `off`; placeholders add a few tokens per gap.

**KV Cache effect.** Kiro assigns a fresh `conversationId` per request and this adapter does not replay provider-side conversation state, so cache reuse is the service's own concern. Keeping the system prompt on the earliest turn preserves a stable prefix.

### Kiro response

**What the model sees.** The response is a `vnd.amazon.eventstream` frame sequence. Text and thinking share one channel delimited by `<thinking>` markers; the adapter routes them into harness text and reasoning blocks, holding back only a tail short enough to be a partial marker so a marker split across frames is still recognized. The open-weight routes additionally leak a `<｜DSML｜` tool-call preamble into that channel, which is suppressed as a prompt-format artifact.

**Token effect.** No token counts are available: the operation reports consumed account credits rather than usage, so no `usage` chunk is emitted and token-pressure consumers fall back to their own estimates.

**KV Cache effect.** Loop-retained blocks append to the next request like any other adapter's.

## Errors

`AUTH` (401, or a 403 naming an invalid bearer token), `FORBIDDEN` (other 403s, including an unentitled subscription), `RATE_LIMIT` (429), `INVALID_MODEL` (a 400 whose body names `INVALID_MODEL_ID` — usually an unauthorized egress), `INVALID_REQUEST` (other 400s), `SERVER` (5xx). Transport failures throw `TRANSPORT` naming the target host; caller aborts throw `ABORTED`. Protocol violations raise `STREAM_CLOSED` (a stream ending mid-frame) or `MALFORMED_RESPONSE` (a bad frame header or payload). A stream that completes with no content at all finishes as `EMPTY_RESPONSE`.

## Known Limitations and Deferred Work

- **No token usage.** Kiro reports credits, not tokens, so `usage` chunks are never emitted and pressure-sensitive plugins cannot measure this route exactly.
- **No image input.** Image content is refused with `UNSUPPORTED_CONTENT` rather than silently flattened, though the wire operation does accept images.
- **Tool names must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`.** Other names are refused with `UNSUPPORTED_TOOL_NAME` instead of being aliased.
- **SOCKS proxies are unsupported.** Only `http://` and `https://` egress; a SOCKS proxy would need a dependency this package avoids.
- **Thinking effort is a prompt marker, not a request field.** The budgets are fixed per effort level and the service may ignore them.
- **The shipped model catalog reflects one verified account tier.** Another tier may serve more or fewer ids; the catalog is advisory and unlisted ids pass through.

## License

MIT
