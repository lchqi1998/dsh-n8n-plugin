# n8n 工作流 JSON 参考（dsh-n8n-plugin 随附）

本文件供 Agent 在构建、更新工作流 JSON 时按需读取（`read` 工具）。它只描述**通过公开 API 提交**的工作流文档结构，不依赖 n8n 编辑器会话。

## 1. 顶层结构

```json
{
  "name": "线索接收",
  "nodes": [],
  "connections": {},
  "settings": { "executionOrder": "v1" },
  "staticData": null,
  "pinData": {},
  "tags": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 工作流名称 |
| `nodes` | 是 | 节点数组，至少一个 |
| `connections` | 是 | 以**源节点 name** 为键的连接表 |
| `settings` | 是 | 至少包含 `"executionOrder": "v1"` |
| `staticData` / `pinData` | 否 | 读取时可能返回，更新时原样保留 |
| `tags` | 否 | 只读：`[{ "id": "<tagId>" }]` 由 API 回填；创建/更新时设置标签用 `n8n_workflow_tags`（`action:"set"` + `tagIds`/`tagNames`），不能写进工作流文档 |

创建时 `active` 是只读派生字段：新工作流默认未发布，用 `n8n_workflow_publish` 或创建时 `publish: true` 发布。更新时若实例要求乐观锁，`n8n_workflow_update` 可通过 `n8n_api` 补充 `versionId`。

## 2. 节点

```json
{
  "id": "webhook1",
  "name": "Webhook",
  "type": "n8n-nodes-base.webhook",
  "typeVersion": 2,
  "position": [250, 300],
  "parameters": { "path": "lead-intake", "httpMethod": "POST", "responseMode": "onReceived" },
  "credentials": {},
  "disabled": false,
  "notes": ""
}
```

规则：

- `id` 与 `name` 在工作流内**都必须唯一**；`connections` 使用 `name`。
- `id` 用描述性短标识（`webhook1`、`code1`、`if1`），不要用随机 UUID 之外的怪字符。
- `position` 为 `[x, y]`，从 `[250, 300]` 起，水平间距约 200px。
- `typeVersion` 必须是数字；不确定时用该节点类型当前主版本（常见节点见 §4）。
- `parameters` 必须存在（可为 `{}`），内容按节点类型填写。
- 凭证通过 `credentials: { "<credentialType>": { "id": "<credId>", "name": "<credName>" } }` 引用，先用 `n8n_credentials` 确认已存在。

## 3. 连接

```json
{
  "Webhook": {
    "main": [[{ "node": "Normalize", "type": "main", "index": 0 }]]
  },
  "Check": {
    "main": [
      [{ "node": "Approve", "type": "main", "index": 0 }],
      [{ "node": "Reject", "type": "main", "index": 0 }]
    ]
  }
}
```

- 第一层键：源节点 **name**。
- 第二层键：输出类型，普通流是 `"main"`；AI 子节点使用 `ai_languageModel`、`ai_tool`、`ai_memory` 等。
- 第三层：按**输出索引**排列的数组；`outputs[0]` 是第一个输出，`outputs[1]` 是第二个（IF/Switch 的 false 分支、Switch 的各分支）。
- 第四层：该输出连到哪些目标 `{ node, type: "main", index: <目标输入索引> }`。
- 没有连接的节点不必出现在 `connections` 中。

## 4. 常用节点

| 用途 | type | 关键 parameters |
| --- | --- | --- |
| 手动触发 | `n8n-nodes-base.manualTrigger` | `{}` |
| Webhook | `n8n-nodes-base.webhook` | `path`、`httpMethod`、`responseMode`（`onReceived` / `lastNode` / `responseNode`） |
| 定时触发 | `n8n-nodes-base.scheduleTrigger` | `rule.interval`（如 `[{ "field": "hours", "hoursInterval": 1 }]`） |
| 条件分支 | `n8n-nodes-base.if` | `conditions`（v2 结构），输出 0=true / 1=false |
| 多路分支 | `n8n-nodes-base.switch` | `rules` / `mode` |
| 代码 | `n8n-nodes-base.code` | `jsCode` 或 `pythonCode`、`mode` |
| 赋值/映射 | `n8n-nodes-base.set` | `mode`、`assignments` |
| HTTP 请求 | `n8n-nodes-base.httpRequest` | `url`、`method`、`sendBody`、`options` |
| 循环 | `n8n-nodes-base.splitInBatches` | `batchSize`，输出 0=loop / 1=done |
| 等待 | `n8n-nodes-base.wait` | `amount`、`unit` |
| 响应 Webhook | `n8n-nodes-base.respondToWebhook` | `respondWith`、`responseBody` |
| 错误触发 | `n8n-nodes-base.errorTrigger` | `{}` |
| AI Agent | `@n8n/n8n-nodes-langchain.agent` | `promptType`、`text`、`options` |

`typeVersion` 以目标实例为准：新版本可能提升版本号。拿不准时先 `n8n_api` 读取一个同类现有工作流（`n8n_workflows` → `n8n_workflow_get`）作为模板。

## 5. 表达式

- 引用数据：`{{ $json.field }}`、`{{ $node["Webhook"].json.body.email }}`
- 引用执行上下文：`{{ $execution.id }}`、`{{ $now }}`、`{{ $today }}`
- 环境变量：`{{ $env.MY_VAR }}`（需实例允许）
- 表达式中字符串拼接：`{{ "Hi " + $json.name }}`

## 6. 常见模式

### 6.1 Webhook → 校验 → 写入 → 通知

```
Webhook → IF(必填字段齐全)
  true  → HTTP Request(写库) → Slack/邮件通知 → Respond to Webhook(200)
  false → Respond to Webhook(400)
```

- `responseMode: "responseNode"` 时**必须**有 `respondToWebhook` 节点，否则请求会挂起到超时。
- 对外接口把 `Respond to Webhook` 放在两条分支末尾。

### 6.2 定时任务 → 查询 → 逐条处理

```
Schedule Trigger → HTTP Request / Postgres(查询) → Split In Batches → 处理 → 汇总
```

- 逐条处理时 `Split In Batches` 的 `loop` 输出接回自身；`done` 输出接汇总/通知。
- 批量写库优先用批量节点，避免每条一个事务。

### 6.3 错误处理

- 在关键节点设置 `onError: "continueErrorOutput"`，把错误输出接到通知分支。
- 或为工作流设置 `settings.errorWorkflow` 指向一个带 `errorTrigger` 的工作流。
- HTTP 节点建议显式设置超时与重试：`options.timeout`、`retryOnFail`、`maxTries`。

### 6.4 AI Agent

```
Chat/Webhook → AI Agent(langchain.agent)
  ├── ai_languageModel → OpenAI/DeepSeek Chat Model
  ├── ai_memory → Simple Memory
  └── ai_tool → HTTP Request Tool / Custom Code Tool
```

- AI 子节点连接使用 `ai_languageModel`、`ai_memory`、`ai_tool` 输出类型，`index` 通常为 0。
- 需要模型凭证时先用 `n8n_credentials` 确认类型与名称。

## 7. 交付前检查清单

1. `name`、`nodes`、`connections`、`settings.executionOrder="v1"` 齐全。
2. 节点 `id`/`name` 唯一，`typeVersion` 是数字，`position` 是两元素数字数组。
3. `connections` 只引用存在的节点名；IF 的 true/false 索引正确。
4. `responseNode` 模式有响应节点。
5. 引用凭证先确认存在；引用标签先取 tagId。
6. 先跑 `n8n_workflow_validate`，再创建/更新，然后 `n8n_workflow_get` 读回核对。
7. 发布前确认触发器行为（webhook 路径、定时时区），发布/删除前征求用户同意。