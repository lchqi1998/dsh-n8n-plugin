/**
 * Model-facing guidance for the n8n plugin, rendered as one system-prompt
 * section while `announceToAgent` is on.
 *
 * The text names every tool this plugin registers (so a restriction that hides
 * the tools also hides this guidance) and carries the workflow-JSON rules that
 * prevent the most common n8n API rejections. It deliberately says nothing
 * about the instance API keys beyond where they live: the model never needs
 * them and must never ask for them.
 */

/** The tool names this guidance describes. */
export const N8N_TOOL_NAMES = [
  'n8n_instances',
  'n8n_workflows',
  'n8n_workflow_get',
  'n8n_workflow_create',
  'n8n_workflow_update',
  'n8n_workflow_delete',
  'n8n_workflow_publish',
  'n8n_workflow_validate',
  'n8n_workflow_clone',
  'n8n_workflow_tags',
  'n8n_executions',
  'n8n_execution_get',
  'n8n_execution_cancel',
  'n8n_wait_execution',
  'n8n_webhook_call',
  'n8n_tags',
  'n8n_tag_create',
  'n8n_tag_update',
  'n8n_tag_delete',
  'n8n_credentials',
  'n8n_api',
]

/** The announcement body (simplified Chinese, matching this deployment). */
export const N8N_GUIDANCE = '本机已安装 dsh-n8n-plugin（DSH 的 n8n 工作流运维插件）：设置 → n8n 实例 里由用户配置实例（别名 + 实例地址 + API Key），配置文件在 $DSH_HOME/dsh-n8n-plugin.json（默认 ~/.dsh/dsh-n8n-plugin.json，权限 0600）；agent 只能读取实例清单，创建/修改实例只能由用户在 GUI 完成。工具：n8n_instances 列出实例与默认别名；n8n_workflows 列出工作流（可按 active/name/tags 过滤并分页）；n8n_workflow_get 读取完整工作流 JSON；n8n_workflow_create/update/delete 增改删（update 保留读回的 versionId 即启用并发保护：版本已变会拒绝写入，需重新读取合并）；n8n_workflow_publish 发布（activate）或取消发布；n8n_workflow_validate 离线校验工作流 JSON；n8n_workflow_clone 克隆工作流（复制节点/连线/设置，默认连标签一起复制且保持未发布）；n8n_workflow_tags 读取或替换工作流标签（tagIds 或 tagNames，工作流文档里的 tags 是只读的）；n8n_executions/n8n_execution_get 查询执行记录与每个节点的输入输出；n8n_execution_cancel 取消运行中的执行；n8n_webhook_call 经 Webhook 触发器手动运行工作流（自动定位 webhook 节点，默认等待执行结束并返回逐节点结构化结果，生产 URL 要求工作流已发布；同时出现多条新执行时会列出候选项并告警，不会静默猜一条）；n8n_wait_execution 轮询等待一条执行记录结束；n8n_tags 列标签，n8n_tag_create/update/delete 增改删标签；n8n_credentials 列凭证名称与类型（不返回密钥）；n8n_api 直接调用任意 /api/v1 接口。所有工具都需要实例别名 alias。工作流 JSON 规则：必须含 name、nodes[]、connections{}、settings{}；settings.executionOrder 用 "v1"；节点需 id/name/type/typeVersion/position/parameters；节点 id 与 name 在工作流内唯一，connections 以源节点 name 为键；IF/Switch 节点从 0 开始按输出索引连线；webhook 的 responseMode 为 responseNode 时必须加 Respond to Webhook 节点；节点坐标从 [250,300] 起、水平间距约 200。检查凭证：n8n_credentials；写入前先用 n8n_workflow_validate 校验（覆盖结构、常见节点参数、拓扑、表达式四类问题），再用 n8n_workflow_get 读回确认。限制与安全：发布（publish）会让 webhook/定时触发器在生产环境生效，删除工作流会停止其触发器，删除标签会从所有工作流上移除该标签，取消执行会中止运行中的流程，执行记录可能含业务敏感数据——这些操作先向用户确认；API Key 只在用户本机文件中，绝不要在对话里索取或回显；用 n8n_api 时路径必须相对 /api/v1（如 "/workflows"），不要调用需要 Cookie 会话的编辑器私有接口。用户提到「n8n / 工作流 / 自动化 / webhook / 定时任务 / 节点」时即指本插件，请据此协作。'

/**
 * Build a section text provider that renders the guidance only while at least
 * one of the named tools is reachable (the same convention the official tool
 * packages use: guidance for a removed tool must not survive its removal).
 * @param tools - the scoped tool registry.
 * @param text - guidance body.
 * @param names - tool names the body describes.
 * @returns the section text provider.
 */
export function visibleToolText(tools, text, names = N8N_TOOL_NAMES) {
  if (tools === undefined) return () => text
  return (context = {}) => {
    for (const name of names) {
      try {
        if (tools.get(name, context.scope) !== undefined) return text
      } catch {
        return text
      }
    }
    return ''
  }
}