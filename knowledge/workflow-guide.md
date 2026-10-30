# n8n 工作流 JSON 参考（dsh-n8n-plugin 随附）

本文件供 Agent 在构建、更新工作流 JSON 时按需读取（`read` 工具）。它只描述**通过公开 API 提交**的工作流文档结构，不依赖 n8n 编辑器会话。结构之外，§8 收录实测踩坑清单，§9 提供可直接改用的开箱模板（与本文档同目录的 `templates/`）。

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

创建时 `active` 是只读派生字段：新工作流默认未发布，用 `n8n_workflow_publish` 或创建时 `publish: true` 发布。更新时把 `n8n_workflow_get` 读回的 `versionId` 原样留在文档里即可启用并发保护：实例当前版本已经变了，`n8n_workflow_update` 会拒绝写入并返回冲突，需要重新读取、合并后再提交。

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

以下四种模式都有可直接导入的开箱模板（§9）：读模板 → 改参数 → `n8n_workflow_validate` → 创建。

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
6. 表达式字符串以 `=` 开头（见 §8 第 2 条）。
7. 先跑 `n8n_workflow_validate`，再创建/更新，然后 `n8n_workflow_get` 读回核对。
8. 发布前确认触发器行为（webhook 路径、定时时区），发布/删除前征求用户同意。

## 8. 踩坑清单

以下条目来自真实使用中的返工，提交前逐条对照（其中多数已被 `n8n_workflow_validate` 自动检查）：

**结构与连接**

1. `connections` 的键是节点 **name**，不是 id。重命名节点后必须同步改 connections，否则整条链断开。
2. 已发布（active）的工作流不能直接 DELETE（API 返回 409）——先 `n8n_workflow_publish` 取消发布，再删除。
3. 更新工作流必须提交**完整文档**（PUT 全量替换语义）：只发改动字段会丢掉其余节点。务必保留读回的 `versionId`——插件用它做乐观并发校验，版本不一致时拒绝写入，而不是覆盖别人的改动。
4. `tags` 不能写进工作流文档（API 只读回填）——用 `n8n_workflow_tags` 的 `action:"set"` 设置标签。

**表达式**

5. 表达式字符串必须以 `=` 开头才会求值：写 `"{{ $json.a }}"` 是**字面文本**，写 `"={{ $json.a }}"` 才是表达式。手写 JSON 最常漏的就是这个 `=`。
6. 引用名称含空格或点的节点，必须用 `$node["Node Name"]` 方括号形式，不能用 `$node.Node Name`。

**节点行为**

7. 节点输出 **0 行**时，下游整条链**静默跳过**（HTTP 节点收到 200 空体）——给可能输出 0 行的节点（get 空表、deleteRows 0 匹配）设置 `alwaysOutputData: true`，空标记 `{}` 用 `id === undefined` 识别。
8. DataTable 节点的 `matchType` 是**节点级参数**（默认 `'anyCondition'` 即 OR 语义）：写在 filters 对象里会被忽略；多条件 AND 必须显式 `parameters.matchType = "allConditions"`，否则双条件按 OR 命中，可能误删/误改。
9. Code 节点运行在 task runner 沙箱，`$workflow.staticData` 为 **undefined**——工作流持久状态不要用 Code 节点读写 staticData，改用 DataTable 节点（`n8n-nodes-base.dataTable`）+ 公开 API `/api/v1/data-tables`。
10. SplitInBatches 的两个输出（loop/done）都要接线：loop 接回自身形成循环，done 接后续汇总；只接一个就会「只处理第一批」或「结束后无事发生」。

**版本与凭证**

11. `typeVersion` 必须是数字且以目标实例为准——拿不准时用 `n8n_workflow_get` 读一个同类现有工作流抄版本号。
12. 凭证只通过 `credentials: { "<type>": { id, name } }` 引用，先 `n8n_credentials` 确认存在；id 对不上时创建能成功、执行才报错。

## 9. 模板库

开箱模板与本文档同目录的 `templates/` 下（得到本文档绝对路径后，templates 目录就在它旁边）。用法：`read` 模板 → 按需改参数（url、path、凭证）→ `n8n_workflow_validate` → `n8n_workflow_create`。

| 模板文件 | 场景 | 要点 |
| --- | --- | --- |
| `templates/webhook-lead.json` | Webhook 接收线索：校验 → 写库 → 响应 | `responseNode` 模式 + 两个 Respond to Webhook（200/400） |
| `templates/scheduled-sync.json` | 定时拉取列表、分批逐条处理 | SplitInBatches 循环回边 + done 汇总（Code 节点） |
| `templates/error-notify.json` | 错误通知工作流 | 供其他工作流的 `settings.errorWorkflow` 指向 |
| `templates/ai-agent-chat.json` | Webhook → AI Agent（模型 + 记忆） | `responseMode: "lastNode"` 直接返回 Agent 输出；**创建前**把模型节点的 `credentials.id` 换成 `n8n_credentials` 查到的真实值 |