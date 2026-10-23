/**
 * dsh-n8n-plugin — browser half.
 *
 * Registers one Settings section ("n8n 实例") listing every configured n8n
 * instance with its alias, base URL, API-key state and default flag. Create,
 * edit, delete and connection-test all ride the host's /api/dsh-n8n-plugin routes, so
 * the page and the agent tools always share one store.
 *
 * This module is loaded by the DSH web client module host (window.__ModuleLoader__)
 * and only requires the React the shell already provides — no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-n8n-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Locale namespace this plugin owns. */
    const NS = 'dsh-n8n-plugin'

    /** Section order next to the family settings sections. */
    const SECTION_ORDER = 120

    /** API paths (mirrors lib/routes.js). */
    const API = {
      instances: '/api/dsh-n8n-plugin/instances',
      test: '/api/dsh-n8n-plugin/test',
    }

    /** Theme tokens with neutral fallbacks. */
    const C = {
      primary: 'var(--dsw-alias-label-primary, #1f2329)',
      secondary: 'var(--dsw-alias-label-secondary, #5f6673)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a919c)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      borderStrong: 'var(--dsw-alias-border-l3, #d0d5dd)',
      layer2: 'var(--dsw-alias-bg-layer-2, #ffffff)',
      layer3: 'var(--dsw-alias-bg-layer-3, #fafafa)',
      brand: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      danger: 'var(--dsw-alias-label-danger, #b42318)',
      success: 'var(--dsw-alias-state-success-primary, #1d7a4a)',
      warn: 'var(--dsw-alias-state-warn-primary, #b54708)',
    }

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      title: 'n8n 实例',
      description: '管理本插件的 n8n 实例：每个实例一个别名、实例地址与 API Key，Agent 通过别名选择实例。',
      security: 'API Key 以明文保存在本机 ~/.dsh/dsh-n8n-plugin.json（权限 0600），只在回环地址上传输；页面只显示末四位。',
      loading: '加载中…',
      empty: '还没有配置任何 n8n 实例，点击「添加实例」开始。',
      add: '添加实例',
      editTitle: '编辑实例',
      createTitle: '添加实例',
      alias: '别名',
      baseUrl: '实例地址',
      apiKey: 'API Key',
      descriptionLabel: '说明（可选）',
      defaultLabel: '默认',
      defaultHint: '新工作流默认使用的实例；只能有一个默认实例。',
      actions: '操作',
      test: '测试',
      edit: '编辑',
      delete: '删除',
      save: '保存',
      cancel: '取消',
      saving: '保存中…',
      testing: '测试中…',
      testOk: '连接成功',
      testFail: '连接失败',
      aliasHint: '字母或数字开头，仅含字母、数字、点、下划线、连字符，例如 prod / staging / local',
      baseUrlHint: '例如 https://n8n.example.com 或 http://localhost:5678（可省略末尾的 /api/v1）',
      apiKeyHint: '在 n8n 的 设置 → n8n API → 创建 API Key 获取',
      apiKeyKeep: '已配置（{masked}），留空保持不变',
      apiKeyRequired: 'API Key 不能为空',
      required: '请填写必填项',
      confirmDelete: '确定删除实例「{alias}」？该操作只移除本地配置，不影响 n8n 上的工作流。',
      created: '已添加实例「{alias}」',
      updated: '已更新实例「{alias}」',
      deleted: '已删除实例「{alias}」',
      errorPrefix: '操作失败：',
      loadFailed: '无法读取实例配置',
      defaultBadge: '默认',
      emptyValue: '—',
      reload: '重新加载',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      title: 'n8n instances',
      description: 'Manage this plugin\'s n8n instances: one alias, base URL and API key per instance. Agents select an instance by alias.',
      security: 'API keys are stored in plaintext in ~/.dsh/dsh-n8n-plugin.json (mode 0600) and only travel over loopback; this page shows the last four characters.',
      loading: 'Loading…',
      empty: 'No n8n instance configured yet. Use “Add instance” to start.',
      add: 'Add instance',
      editTitle: 'Edit instance',
      createTitle: 'Add instance',
      alias: 'Alias',
      baseUrl: 'Base URL',
      apiKey: 'API key',
      descriptionLabel: 'Description (optional)',
      defaultLabel: 'Default',
      defaultHint: 'The instance new workflows default to; only one can be the default.',
      actions: 'Actions',
      test: 'Test',
      edit: 'Edit',
      delete: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      saving: 'Saving…',
      testing: 'Testing…',
      testOk: 'Connected',
      testFail: 'Connection failed',
      aliasHint: 'Start with a letter or digit; letters, digits, dots, underscores and hyphens only — e.g. prod / staging / local',
      baseUrlHint: 'e.g. https://n8n.example.com or http://localhost:5678 (a trailing /api/v1 may be omitted)',
      apiKeyHint: 'Create one in n8n under Settings → n8n API',
      apiKeyKeep: 'Configured ({masked}) — leave blank to keep it',
      apiKeyRequired: 'API key is required',
      required: 'Please fill in the required fields',
      confirmDelete: 'Delete instance “{alias}”? This only removes the local entry; workflows on n8n are untouched.',
      created: 'Added instance “{alias}”',
      updated: 'Updated instance “{alias}”',
      deleted: 'Deleted instance “{alias}”',
      errorPrefix: 'Failed: ',
      loadFailed: 'Could not load the instance registry',
      defaultBadge: 'default',
      emptyValue: '—',
      reload: 'Reload',
    }

    /** Module-level translate fallback, rewired by {@link apply}. */
    let fallbackT = (key) => (zh[key] !== undefined ? zh[key] : key)

    /** Interpolate `{name}` placeholders. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
    }

    /** Read one JSON response, surfacing the server's own error message. */
    async function readJson(response) {
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const message = body !== null && typeof body === 'object' && typeof body.error === 'string'
          ? body.error
          : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body ?? {}
    }

    /** Load the instance registry. */
    async function fetchInstances() {
      return readJson(await fetch(API.instances, { headers: { accept: 'application/json' } }))
    }

    /** Create one instance. */
    async function createInstance(payload) {
      return readJson(await fetch(API.instances, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }))
    }

    /** Patch one instance (keyed by its current alias). */
    async function updateInstance(alias, payload) {
      return readJson(await fetch(`${API.instances}?alias=${encodeURIComponent(alias)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }))
    }

    /** Delete one instance. */
    async function deleteInstance(alias) {
      return readJson(await fetch(`${API.instances}?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' }))
    }

    /** Test one instance's connectivity and credentials. */
    async function testInstance(alias) {
      return readJson(await fetch(API.test, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias }),
      }))
    }

    /** The shared button. */
    function Button({ children, onClick, variant = 'secondary', disabled = false, type = 'button', title }) {
      const [hover, setHover] = useState(false)
      const base = {
        font: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        borderRadius: 8,
        padding: '5px 12px',
        fontSize: 12.5,
        lineHeight: '18px',
        border: '1px solid ' + C.borderStrong,
        background: 'transparent',
        color: C.primary,
        opacity: disabled ? 0.5 : 1,
        transition: 'background .12s',
      }
      const variants = {
        primary: {
          borderColor: C.brand,
          background: C.brand,
          color: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
        },
        danger: { borderColor: 'transparent', color: C.danger },
        ghost: { borderColor: 'transparent', color: C.secondary },
      }
      const style = { ...base, ...(variants[variant] ?? {}) }
      if (hover && !disabled) {
        style.background = variant === 'primary' ? C.brand : 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))'
      }
      return h('button', {
        type,
        title,
        style,
        disabled,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    /** One labelled form row. */
    function Field({ label, hint, children }) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 } }, [
        h('span', { key: 'label', style: { color: C.primary, fontWeight: 500 } }, label),
        children,
        hint !== undefined ? h('span', { key: 'hint', style: { color: C.tertiary, fontSize: 11.5, lineHeight: '16px' } }, hint) : null,
      ])
    }

    /** One text input styled for the settings page. */
    function TextInput(props) {
      return h('input', {
        ...props,
        style: {
          font: 'inherit',
          fontSize: 13,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid ' + C.borderStrong,
          background: C.layer2,
          color: C.primary,
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
        },
      })
    }

    /** A status pill (test result / default flag). */
    function Pill({ tone = 'neutral', children }) {
      const tones = {
        neutral: { color: C.secondary, background: C.layer3, borderColor: C.border },
        success: { color: C.success, background: 'transparent', borderColor: C.success },
        danger: { color: C.danger, background: 'transparent', borderColor: C.danger },
        brand: { color: C.brand, background: 'transparent', borderColor: C.brand },
      }
      return h('span', {
        style: {
          display: 'inline-block',
          padding: '1px 8px',
          borderRadius: 999,
          border: '1px solid ' + tones[tone].borderColor,
          background: tones[tone].background,
          color: tones[tone].color,
          fontSize: 11,
          lineHeight: '17px',
          whiteSpace: 'nowrap',
        },
      }, children)
    }

    /** Empty editable form state. */
    function blankForm() {
      return {
        mode: 'create',
        originalAlias: '',
        alias: '',
        baseUrl: '',
        apiKey: '',
        apiKeyMasked: '',
        description: '',
        isDefault: false,
      }
    }

    /** The Settings section component. */
    function InstancesSection(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const [state, setState] = useState({ status: 'loading', instances: [], defaultAlias: null, error: null })
      const [form, setForm] = useState(null)
      const [formError, setFormError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [tests, setTests] = useState({})

      const applyRegistry = useCallback((body) => {
        setState({
          status: 'ready',
          instances: Array.isArray(body.instances) ? body.instances : [],
          defaultAlias: typeof body.defaultAlias === 'string' ? body.defaultAlias : null,
          error: null,
        })
      }, [])

      const load = useCallback(async () => {
        setState((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'loading', error: null }))
        try {
          applyRegistry(await fetchInstances())
        } catch (error) {
          setState({ status: 'error', instances: [], defaultAlias: null, error: error instanceof Error ? error.message : String(error) })
        }
      }, [applyRegistry])

      useEffect(() => {
        load()
      }, [load])

      const openCreate = () => {
        setFormError(null)
        setNotice(null)
        setForm(blankForm())
      }

      const openEdit = (instance) => {
        setFormError(null)
        setNotice(null)
        setForm({
          mode: 'edit',
          originalAlias: instance.alias,
          alias: instance.alias,
          baseUrl: instance.baseUrl,
          apiKey: '',
          apiKeyMasked: instance.apiKeyMasked ?? '',
          description: instance.description ?? '',
          isDefault: instance.isDefault === true,
        })
      }

      const closeForm = () => {
        if (busy) return
        setForm(null)
        setFormError(null)
      }

      const submit = async () => {
        if (form === null || busy) return
        const alias = form.alias.trim()
        const baseUrl = form.baseUrl.trim()
        if (alias === '' || baseUrl === '' || (form.mode === 'create' && form.apiKey.trim() === '')) {
          setFormError(form.mode === 'create' && form.apiKey.trim() === '' ? t('apiKeyRequired') : t('required'))
          return
        }
        setBusy(true)
        setFormError(null)
        try {
          const payload = { alias, baseUrl, isDefault: form.isDefault === true }
          if (form.apiKey.trim() !== '') payload.apiKey = form.apiKey.trim()
          if (form.description.trim() !== '') payload.description = form.description.trim()
          else if (form.mode === 'edit') payload.description = ''
          const body = form.mode === 'create'
            ? await createInstance(payload)
            : await updateInstance(form.originalAlias, payload)
          applyRegistry(body)
          setNotice(format(t(form.mode === 'create' ? 'created' : 'updated'), { alias }))
          setForm(null)
        } catch (error) {
          setFormError(String(error instanceof Error ? error.message : error))
        } finally {
          setBusy(false)
        }
      }

      const remove = async (instance) => {
        if (!window.confirm(format(t('confirmDelete'), { alias: instance.alias }))) return
        try {
          applyRegistry(await deleteInstance(instance.alias))
          setNotice(format(t('deleted'), { alias: instance.alias }))
          if (form !== null && form.originalAlias === instance.alias) setForm(null)
        } catch (error) {
          setNotice(format(t('errorPrefix'), {}) + String(error instanceof Error ? error.message : error))
        }
      }

      const test = async (instance) => {
        setTests((current) => ({ ...current, [instance.alias]: { status: 'running' } }))
        try {
          const result = await testInstance(instance.alias)
          setTests((current) => ({
            ...current,
            [instance.alias]: { status: 'ok', text: `${t('testOk')} · ${result.latencyMs ?? 0}ms` },
          }))
        } catch (error) {
          setTests((current) => ({
            ...current,
            [instance.alias]: { status: 'fail', text: String(error instanceof Error ? error.message : error) },
          }))
        }
      }

      const title = h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: '22px', color: C.primary } }, t('title'))
      const description = h('p', { style: { margin: 0, color: C.secondary, fontSize: 12.5, lineHeight: '19px' } }, t('description'))
      const security = h('p', {
        style: {
          margin: 0,
          padding: '8px 10px',
          borderRadius: 8,
          background: C.layer3,
          border: '1px solid ' + C.border,
          color: C.secondary,
          fontSize: 11.5,
          lineHeight: '17px',
        },
      }, t('security'))

      const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
        title,
        h('span', { key: 'spacer', style: { flex: 1 } }),
        h(Button, { key: 'add', variant: 'primary', onClick: openCreate, disabled: busy }, t('add')),
      ])

      let body
      if (state.status === 'loading') {
        body = h('p', { style: { margin: 0, color: C.tertiary, fontSize: 12.5 } }, t('loading'))
      } else if (state.status === 'error') {
        body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('p', { key: 'label', style: { margin: 0, color: C.danger, fontSize: 12.5 } }, `${t('loadFailed')}: ${state.error}`),
          h('div', { key: 'reload' }, h(Button, { onClick: load }, t('reload'))),
        ])
      } else if (state.instances.length === 0) {
        body = h('p', { style: { margin: 0, color: C.tertiary, fontSize: 12.5 } }, t('empty'))
      } else {
        const headCells = [t('alias'), t('baseUrl'), t('apiKey'), t('defaultLabel'), t('actions')]
        const head = h('tr', null, headCells.map((label, index) => h('th', {
          key: label + index,
          style: {
            textAlign: index === 4 ? 'right' : 'left',
            padding: '7px 8px',
            borderBottom: '1px solid ' + C.border,
            color: C.tertiary,
            fontSize: 11.5,
            fontWeight: 500,
            whiteSpace: 'nowrap',
          },
        }, label)))
        const rows = state.instances.map((instance) => {
          const testState = tests[instance.alias]
          const cells = [
            h('td', { key: 'alias', style: { padding: '8px', borderBottom: '1px solid ' + C.border, fontSize: 12.5, color: C.primary } }, [
              h('span', { key: 'a', style: { fontWeight: 500 } }, instance.alias),
              testState !== undefined
                ? h('div', { key: 't', style: { marginTop: 2 } }, h(Pill, {
                  tone: testState.status === 'ok' ? 'success' : testState.status === 'fail' ? 'danger' : 'neutral',
                }, testState.status === 'running' ? t('testing') : testState.status === 'ok' ? (testState.text ?? t('testOk')) : String(testState.text).slice(0, 120)))
                : null,
            ]),
            h('td', { key: 'url', style: { padding: '8px', borderBottom: '1px solid ' + C.border, fontSize: 12.5, color: C.secondary, wordBreak: 'break-all' } }, instance.baseUrl),
            h('td', { key: 'key', style: { padding: '8px', borderBottom: '1px solid ' + C.border, fontSize: 12.5, color: C.secondary, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' } }, instance.apiKeyMasked || t('emptyValue')),
            h('td', { key: 'default', style: { padding: '8px', borderBottom: '1px solid ' + C.border, fontSize: 12.5 } }, instance.isDefault ? h(Pill, { tone: 'brand' }, t('defaultBadge')) : h('span', { style: { color: C.tertiary } }, t('emptyValue'))),
            h('td', { key: 'actions', style: { padding: '8px', borderBottom: '1px solid ' + C.border, textAlign: 'right', whiteSpace: 'nowrap' } }, [
              h(Button, { key: 'test', variant: 'ghost', disabled: busy || testState?.status === 'running', onClick: () => test(instance) }, t('test')),
              h(Button, { key: 'edit', variant: 'ghost', disabled: busy, onClick: () => openEdit(instance) }, t('edit')),
              h(Button, { key: 'delete', variant: 'danger', disabled: busy, onClick: () => remove(instance) }, t('delete')),
            ]),
          ]
          return h('tr', { key: instance.alias }, cells)
        })
        body = h('div', { style: { overflowX: 'auto' } }, h('table', {
          style: { width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' },
        }, [h('thead', { key: 'head' }, head), h('tbody', { key: 'body' }, rows)]))
      }

      let editor = null
      if (form !== null) {
        editor = h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 14,
            borderRadius: 10,
            border: '1px solid ' + C.border,
            background: C.layer3,
          },
        }, [
          h('div', { key: 'title', style: { fontSize: 13, fontWeight: 600, color: C.primary } }, t(form.mode === 'create' ? 'createTitle' : 'editTitle')),
          h('div', { key: 'fields', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 } }, [
            h(Field, { key: 'alias', label: t('alias'), hint: t('aliasHint') },
              h(TextInput, {
                value: form.alias,
                placeholder: 'prod',
                onChange: (event) => setForm({ ...form, alias: event.target.value }),
              })),
            h(Field, { key: 'url', label: t('baseUrl'), hint: t('baseUrlHint') },
              h(TextInput, {
                value: form.baseUrl,
                placeholder: 'https://n8n.example.com',
                onChange: (event) => setForm({ ...form, baseUrl: event.target.value }),
              })),
            h(Field, {
              key: 'key',
              label: t('apiKey'),
              hint: form.mode === 'edit' && form.apiKeyMasked !== ''
                ? format(t('apiKeyKeep'), { masked: form.apiKeyMasked })
                : t('apiKeyHint'),
            }, h(TextInput, {
              value: form.apiKey,
              type: 'password',
              placeholder: form.mode === 'edit' ? '••••••••' : 'n8n_api_...',
              autoComplete: 'new-password',
              onChange: (event) => setForm({ ...form, apiKey: event.target.value }),
            })),
            h(Field, { key: 'desc', label: t('descriptionLabel') }, h(TextInput, {
              value: form.description,
              onChange: (event) => setForm({ ...form, description: event.target.value }),
            })),
          ]),
          h('label', { key: 'default', style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: C.secondary } }, [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: form.isDefault,
              onChange: (event) => setForm({ ...form, isDefault: event.target.checked }),
              style: { marginTop: 3 },
            }),
            h('span', { key: 'text' }, [
              h('span', { key: 'label', style: { color: C.primary, fontWeight: 500 } }, t('defaultLabel')),
              h('span', { key: 'hint', style: { display: 'block', color: C.tertiary, fontSize: 11.5 } }, t('defaultHint')),
            ]),
          ]),
          formError !== null ? h('p', { key: 'error', style: { margin: 0, color: C.danger, fontSize: 12, lineHeight: '17px', wordBreak: 'break-word' } }, `${t('errorPrefix')}${formError}`) : null,
          h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } }, [
            h(Button, { key: 'cancel', variant: 'ghost', onClick: closeForm, disabled: busy }, t('cancel')),
            h(Button, { key: 'save', variant: 'primary', onClick: submit, disabled: busy }, busy ? t('saving') : t('save')),
          ]),
        ])
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxWidth: 860,
          color: C.primary,
        },
      }, [
        header,
        description,
        security,
        notice !== null
          ? h('p', { key: 'notice', style: { margin: 0, color: C.success, fontSize: 12, lineHeight: '17px' } }, notice)
          : null,
        h('div', { key: 'body' }, body),
        editor,
      ])
    }

    /** Client services this plugin waits for. */
    const inject = ['slots', 'locale']

    /**
     * Mount the settings section.
     * @param ctx - client root context (slots + locale services).
     */
    function apply(ctx) {
      try {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return () => {}
          }
        }, 'dsh-n8n-plugin: dictionaries')
      } catch {
        // A locale-less shell keeps the built-in Chinese copy.
      }
      try {
        const t = ctx.locale.bind(NS)
        fallbackT = (key) => t(key)
      } catch {
        // keep the zh fallback
      }
      try {
        ctx.slots.inject('settings.section', () => {
          try {
            return ctx.slots.register({
              name: 'settings.section',
              id: NS,
              order: SECTION_ORDER,
              label: () => fallbackT('title'),
              locale: NS,
            }, InstancesSection)
          } catch (error) {
            console.warn('[dsh-n8n-plugin] settings section registration failed:', error)
            return () => {}
          }
        })
      } catch (error) {
        console.warn('[dsh-n8n-plugin] settings slot unavailable:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})