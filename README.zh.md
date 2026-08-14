# dsh-llm-kiro

[English](README.md) | 中文

[AWS Kiro](https://kiro.dev)(CodeWhisperer)在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) LLM 接缝上的适配器。它注册 `kiro` provider 路由,让一个已登录的 Kiro 账号向 harness 提供 Claude 与开放权重模型,无需另配 API key。

## 前置条件

- 可用的 `dsh` 安装(本包是插件,不是独立工具)。
- 本机已登录 Kiro。Kiro IDE 或 `kiro-cli` 写入的 token 就是本适配器读取的凭据,它不会另存一份。
- 使用 Claude 模型还需要一个获授权的网络出口,见[为什么 Claude 需要代理](#为什么-claude-需要代理)。

## 安装

```sh
dsh plugin --profile web add github:caopu16/dsh-llm-kiro
```

这就是全部安装步骤,升级也是同一条命令。构建产物 `lib/` 被提交进仓库,正是为了让 git 源安装不执行任何构建脚本:pnpm 10 及以上会拦截依赖的构建脚本,直到你用一个带该次 commit 的 key 逐一放行,那会让每次升级都变成一次手工编辑放行名单。

本包自带 patch 层,安装即挂载适配器,不需要编辑 `cordis.yml` 来让路由存在。只有本包故意留空的那些事实才需要你配置。

### 没有 `dsh` 命令时

PATH 上的 `dsh` 来自已安装的 `@deepseek-ai/dsh`。如果你用的是 harness 源码 checkout,那就在该 checkout 里运行 CLI,上面每条命令都照样可用:

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add github:caopu16/dsh-llm-kiro
pnpm dsh --profile web
```

源码 checkout 需要先执行 `pnpm run build`,因为 profile 加载的是构建产物 `lib/`,不是 TypeScript 源码。

### 开发本插件

`lib/` 是提交进仓库的,所以改动 `src/` 之后必须重新构建并一并提交,使用者才能拿到:

```sh
npm install
npm run build
npm test
```

## 配置

Kiro 按请求出口授权 Claude 模型,而获授权的出口因部署而异,所以本包不预置任何代理。请在 profile 的 patch 层(`~/.dsh/profiles/<名称>/cordis.patch.yml`)提供你自己的:

```yaml
- id: llm-kiro
  config:
    proxyUrl: http://proxy.example:1082
    reasoningEffort: medium
```

这条配置是按 id 命中已存在的行。**不要**把它包在 `insert:` 列表里——本包自带的 patch 层已经 insert 了 `llm-kiro`,同一个 id 再 insert 一次会让整个 profile 启动失败,报 `duplicate loader entry id: llm-kiro`。

每个字段都是可选的:

| 字段 | 默认值 | 含义 |
|---|---|---|
| `proxyUrl` | 无(直连) | 所有 Kiro 请求的出口,`http://` 或 `https://`,可带 `user:pass@`。取值非法时插件加载失败。 |
| `region` | 跟随已登录 token | 选择 `q.<region>.amazonaws.com` 端点。 |
| `profileArn` | 账号默认值 | 计费所用的 CodeWhisperer profile。 |
| `thinking` | `enabled` | `disabled` 会把每个请求锁定在 `off`。 |
| `reasoningEffort` | `off` | `off`、`low`、`medium` 或 `high`。 |
| `defaultContextWindow` | `200000` | 模型无确切容量时使用的容量。 |
| `models` | 已验证的账号档位 | 供模型选择器使用的建议目录;未列出的 id 同样能发往服务端。 |
| `streamIdleTimeoutMs` | `300000` | 单次读取未完成时允许的最长服务端空闲时间。 |
| `tokenExpiryBufferMs` | `300000` | 在过期前多久刷新 access token。 |
| `retryPolicy` | 有界的常规策略 | provider 自有的重试策略,由 `dsh-llm-retry` 执行。 |

插件还注册了 `llm-kiro` 设置命名空间,因此 `$DSH_HOME/settings.yaml` 里的 `llm-kiro:` 段可以覆盖上述任意字段而无需重启——web 端的 Models 页面写的就是这里。

## 使用

provider 选 `kiro`,模型 id 用它提供的任意一个:

```
claude-opus-5     claude-opus-4.8    claude-opus-4.7   claude-opus-4.6  claude-opus-4.6-1m
claude-opus-4.5   claude-sonnet-5    claude-sonnet-4.6 claude-sonnet-4.6-1m
claude-sonnet-4.5 claude-sonnet-4    claude-haiku-4.5  auto
deepseek-3.2      glm-5              minimax-m2.5      qwen3-coder-next
```

模型 id 直接作为 `modelId` 透传,所以 Kiro 日后新增的模型无需升级本包即可使用。内置目录仅为建议:未列出的 id 同样能发往服务端,上面这些是在一个账号档位上实测被接受的。`minimax-m2.1` 未列入是因为服务端报其暂时不可用,Sonnet 4.5、Sonnet 5、Opus 4.8 的 `-1m` 变体未列入是因为服务端拒其为未知 id——其他档位可能不同。

## 为什么 Claude 需要代理

Kiro 按请求出口授权模型系列,而不仅仅看账号权益。从未授权的出口发起请求时,每个 `claude-*` id 都会被拒为 `INVALID_MODEL`,而开放权重的 id 正常应答;换到获授权的出口后,同一个账号、同一个 token 就能触达整个目录。因此 `proxyUrl` 是为正确性存在的,不是为性能,而开放权重模型完全不需要代理。

代理以 HTTP `CONNECT` 隧道打开,TLS 在隧道内协商,所以代理只看到目标主机名,看不到请求内容和 bearer token。

## 凭据

适配器读取 `~/.aws/sso/cache/kiro-auth-token.json` 以及它指名的同级 device-registration 文件。当已存的 access token 仍然有效时直接使用;否则用 refresh token 换取新的,并**只缓存在内存中**。那些文件由 Kiro 自己的登录流程拥有并写入,回写会与本插件无法协调的进程发生竞争。

未登录时,首个请求以 `MISSING_CREDENTIAL` 失败并指明预期路径,而不是在加载期失败或静默不产出。

## Model Experience

### Kiro 请求

**模型看到什么。** Kiro 没有 system 槽位,所以 harness 的 system 提示词前置到最早的 user 轮次,thinking 标记也放在那里。历史被折叠成服务端要求的 user/assistant 严格交替;缺口用 `[system: conversation continues]` 占位。工具 schema 随当前轮次发送。若某个工具结果对应的调用已不在历史中(被压缩丢弃),它会以文本形式携带,因为服务端会拒绝无法匹配的 id。

**Token 影响。** 确切输入由服务端分词决定。任何高于 `off` 的 effort 都会加上一段固定的简短前缀;每个缺口占位增加少量 token。

**KV Cache 影响。** Kiro 为每个请求分配新的 `conversationId`,且本适配器不回放服务端会话状态,因此缓存复用由服务自身负责。把 system 提示词固定在最早轮次可保持前缀稳定。

### Kiro 响应

**模型看到什么。** 响应是 `vnd.amazon.eventstream` 帧序列。文本与 thinking 共用一个通道,以 `<thinking>` 标记分隔;适配器将它们分流为 harness 的 text 与 reasoning 块,只保留短到可能是残缺标记的尾部,因此跨帧断开的标记仍能被识别。开放权重路由还会把 `<｜DSML｜` 工具调用前导码泄漏进该通道,它作为提示词格式产物被抑制。

**Token 影响。** 拿不到 token 计数:该操作报告消耗的账号 credits 而非 usage,所以不会发出 `usage` chunk,依赖 token 压力的消费方只能自行估算。

**KV Cache 影响。** 被循环保留的块会追加到下一个请求,与其他适配器一致。

## 错误

`AUTH`(401,或 403 且指明 bearer token 无效)、`FORBIDDEN`(其他 403,包括订阅无权益)、`RATE_LIMIT`(429)、`INVALID_MODEL`(响应体指明 `INVALID_MODEL_ID` 的 400——通常是出口未获授权)、`INVALID_REQUEST`(其他 400)、`SERVER`(5xx)。传输失败抛 `TRANSPORT` 并指明目标主机;调用方取消抛 `ABORTED`。协议违规抛 `STREAM_CLOSED`(流在帧中途结束)或 `MALFORMED_RESPONSE`(帧头或载荷损坏)。完整结束但完全没有内容的流以 `EMPTY_RESPONSE` 终止。

## 已知限制与待办

- **没有 token 用量。** Kiro 报告 credits 而非 token,所以永不发出 `usage` chunk,对压力敏感的插件无法精确度量此路由。
- **不支持图片输入。** 图片内容以 `UNSUPPORTED_CONTENT` 拒绝而非静默压平,尽管服务端操作本身接受图片。
- **工具名必须匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$`。** 其他名称以 `UNSUPPORTED_TOOL_NAME` 拒绝,不做别名映射。
- **不支持 SOCKS 代理。** 仅 `http://` 与 `https://` 出口;SOCKS 需要引入本包刻意避免的依赖。
- **thinking effort 是提示词标记,不是请求字段。** 每档的预算是固定值,服务端可能忽略。
- **内置模型目录反映的是一个已验证的账号档位。** 其他档位可能多于或少于这些 id;目录仅为建议,未列出的 id 同样透传。

## 许可

MIT
