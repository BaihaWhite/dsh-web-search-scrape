// web-search-scrape-ui client bundle: registers a settings card for the
// `web-search-scrape` host settings namespace into the Plugins page
// (`settings.plugin.item` slot). Hand-written in the client module system's
// lazy-factory format — no build step.
window.__ModuleLoader__.load({
  id: 'web-search-scrape',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-runtime/client')

    const NAMESPACE = 'web-search-scrape'

    const FIELDS = [
      { field: 'engines', kind: 'list', label: 'P0 搜索引擎池', hint: '逗号分隔，顺序即优先级，如 duckduckgo, bing, baidu, google, yandex（各档位取前 N 个）' },
      { field: 'socials', kind: 'list', label: 'P1 社媒池', hint: '逗号分隔，如 weixin, bilibili, weibo, x, zhihu, douyin, reddit' },
      { field: 'defaultTier', kind: 'number', label: '缺省档位', hint: '0=自动启发式；1-6 强制档位（1 极速 ~4s / 2 快速 / 3 标准 / 4 增强+子代理 / 5 深度验证 / 6 研究）' },
      { field: 'verify', kind: 'boolean', label: '消息甄别', hint: 'true / false，开启后输出可信度分级与多源验证摘要' },
      { field: 'subagentVerify', kind: 'boolean', label: 'WebSearch 子代理甄别', hint: 'true / false，T4+ 由 LLM 子代理执行甄别' },
      { field: 'toolBudgetMs', kind: 'number', label: '工具总预算 (ms)', hint: 'web_search 工具层强制超时，各档子代理预算据此自适应钳制' },
    ]

    function formatValue(kind, value) {
      if (value === undefined || value === null) return ''
      if (kind === 'list') return Array.isArray(value) ? value.join(', ') : String(value)
      if (kind === 'boolean') return value === true ? 'true' : 'false'
      return String(value)
    }

    function parseValue(kind, text) {
      const trimmed = String(text ?? '').trim()
      if (trimmed === '') return { kind: 'clear' }
      if (kind === 'list') {
        const value = trimmed.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
        return { kind: 'set', value }
      }
      if (kind === 'number') {
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
      }
      if (kind === 'boolean') {
        const lower = trimmed.toLowerCase()
        if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return { kind: 'set', value: true }
        if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return { kind: 'set', value: false }
        return undefined
      }
      return { kind: 'set', value: trimmed }
    }

    /** Minimal staged form over the settings scope (mirrors CardForm's model). */
    class ScrapeCardController {
      constructor(scope) {
        this.scope = scope
        this.staged = new Map()
        this.saving = false
        this.failed = false
        this.broken = null
        try {
          this.store = createSnapshotStore(this.projection())
          scope.subscribe(() => this.publish())
        } catch (error) {
          // A scope failure must not kill the slot registration: publish a
          // broken card so the Plugins page shows the reason instead of nothing.
          this.broken = String(error?.message ?? error)
          this.store = createSnapshotStore(this.brokenProjection())
        }
      }

      brokenProjection() {
        return {
          available: false,
          status: 'broken',
          writable: false,
          dirty: false,
          invalid: false,
          saving: false,
          failed: false,
          broken: this.broken,
          fields: FIELDS.map((field) => ({ ...field, text: '', stored: false, invalid: false })),
        }
      }

      publish() {
        this.store.set(this.projection())
      }

      snapshot() {
        return this.scope.getSnapshot()
      }

      userLayer() {
        return this.snapshot().user
      }

      sectionValue(field) {
        return this.snapshot().value?.[field]
      }

      stored(field) {
        const user = this.userLayer()
        return user !== undefined && Object.hasOwn(user, field)
      }

      spec(field) {
        const spec = FIELDS.find((entry) => entry.field === field)
        if (spec === undefined) throw new Error(`web-search-scrape card has no field ${field}`)
        return spec
      }

      draftText(field) {
        const staged = this.staged.get(field)
        if (staged !== undefined) return staged
        return formatValue(this.spec(field).kind, this.sectionValue(field))
      }

      fieldInvalid(field) {
        const staged = this.staged.get(field)
        if (staged === undefined || staged.trim() === '') return false
        return parseValue(this.spec(field).kind, staged) === undefined
      }

      projection() {
        const snapshot = this.snapshot()
        return {
          available: snapshot.status === 'ready',
          status: snapshot.status,
          writable: snapshot.writable === true,
          dirty: this.staged.size > 0,
          invalid: FIELDS.some((field) => this.fieldInvalid(field.field)),
          saving: this.saving,
          failed: this.failed,
          fields: FIELDS.map((field) => ({
            ...field,
            text: this.draftText(field.field),
            stored: this.stored(field.field),
            invalid: this.fieldInvalid(field.field),
          })),
        }
      }

      inject() {
        return {
          edit: (field, text) => {
            this.staged.set(field, String(text ?? ''))
            this.failed = false
            this.publish()
          },
          save: () => this.save(),
          discard: () => {
            this.staged.clear()
            this.failed = false
            this.publish()
          },
          hooks: { scrapeCard: this.store },
        }
      }

      async save() {
        const plan = []
        for (const field of FIELDS) {
          const staged = this.staged.get(field.field)
          if (staged === undefined) continue
          const trimmed = staged.trim()
          if (trimmed === '') {
            if (this.stored(field.field)) plan.push(() => this.clear(field.field))
            continue
          }
          const write = parseValue(field.kind, trimmed)
          if (write === undefined) return // invalid draft blocks the save
          if (trimmed === formatValue(field.kind, this.sectionValue(field.field))) continue
          plan.push(() => this.storeValue(field.field, write.value))
        }
        if (plan.length === 0 || this.saving) return
        this.saving = true
        this.failed = false
        this.publish()
        let landed = true
        for (const run of plan) landed = (await run()) && landed
        if (landed) this.staged.clear()
        this.saving = false
        this.failed = !landed
        this.publish()
      }

      async storeValue(field, value) {
        await this.scope.set(field, value)
        return this.userLayer()?.[field] !== undefined
      }

      async clear(field) {
        await this.scope.unset(field)
        return !this.stored(field)
      }
    }

    // ---- styles ------------------------------------------------------------------

    if (typeof document !== 'undefined') {
      const css = [
        '.wssc-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:16px;background:var(--dsw-alias-bg-layer-3)}',
        '.wssc-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;gap:12px}',
        '.wssc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.wssc-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:right}',
        '.wssc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
        '.wssc-field+.wssc-field{border-top:1px solid var(--dsw-alias-border-l2)}',
        '.wssc-field-head{display:flex;align-items:center;gap:8px}',
        '.wssc-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);flex:1}',
        '.wssc-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
        '.wssc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
        '.wssc-hint-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
        '.wssc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}',
        '.wssc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
        '.wssc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
        '.wssc-input-invalid{border-color:var(--dsw-alias-label-error)}',
        '.wssc-actions{display:flex;gap:8px;padding-top:12px;align-items:center}',
        '.wssc-error{color:var(--dsw-alias-label-error);font-size:12px;flex:1}',
        '.wssc-btn{font:inherit;font-size:13px;padding:6px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}',
        '.wssc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
        '.wssc-btn:disabled{opacity:.45;cursor:default}',
      ].join('')
      const tagId = 'web-search-scrape-ui/card.css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'web-search-scrape-ui'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
      }
    }

    // ---- component ----------------------------------------------------------------

    function renderField(props, field, disabled) {
      return React.createElement('div', { key: field.field, className: 'wssc-field' },
        React.createElement('div', { className: 'wssc-field-head' },
          React.createElement('span', { className: 'wssc-label' }, field.label),
          field.stored ? React.createElement('span', { className: 'wssc-badge' }, '已覆盖') : null,
        ),
        React.createElement('input', {
          className: field.invalid ? 'wssc-input wssc-input-invalid' : 'wssc-input',
          disabled,
          value: field.text,
          onChange: (event) => props.edit(field.field, event.target.value),
        }),
        field.invalid
          ? React.createElement('p', { className: 'wssc-hint-invalid' }, '格式无效，保存被阻止')
          : React.createElement('p', { className: 'wssc-hint' }, field.hint),
      )
    }

    function ScrapeCard(props) {
      // Guard: a missing hook must never take down the whole Plugins tab.
      if (typeof props.useScrapeCard !== 'function') {
        return React.createElement('div', { className: 'wssc-card' },
          React.createElement('div', { className: 'wssc-head' },
            React.createElement('span', { className: 'wssc-title' }, '网页搜索 · web-search-scrape'),
            React.createElement('span', { className: 'wssc-meta' }, '卡片注入异常（useScrapeCard 缺失）'),
          ),
          React.createElement('p', { className: 'wssc-hint' }, '刷新页面重试；若仍异常请检查 web-search-scrape 客户端插件加载。'),
        )
      }
      const state = props.useScrapeCard((snapshot) => snapshot)
      if (!state.available) {
        // Visible status instead of a silent null: shows why the panel is absent.
        return React.createElement('div', { className: 'wssc-card' },
          React.createElement('div', { className: 'wssc-head' },
            React.createElement('span', { className: 'wssc-title' }, '网页搜索 · web-search-scrape'),
            React.createElement('span', { className: 'wssc-meta' }, `配置段未就绪（${String(state.status ?? 'unknown')}）`),
          ),
          React.createElement('p', { className: 'wssc-hint' },
            state.broken
              ? `卡片初始化异常：${state.broken}`
              : '设置服务尚未把 web-search-scrape 命名空间下发到本页，请稍候或刷新页面。'),
        )
      }
      const disabled = !state.writable || state.saving
      return React.createElement('div', { className: 'wssc-card' },
        React.createElement('div', { className: 'wssc-head' },
          React.createElement('span', { className: 'wssc-title' }, '网页搜索 · web-search-scrape'),
          React.createElement('span', { className: 'wssc-meta' }, '分层检索 + WebSearch 子代理甄别'),
        ),
        ...state.fields.map((field) => renderField(props, field, disabled)),
        React.createElement('div', { className: 'wssc-actions' },
          state.failed ? React.createElement('span', { className: 'wssc-error' }, '保存未完全生效，请重试') : null,
          React.createElement('button', {
            className: 'wssc-btn',
            disabled: !state.dirty || state.invalid || disabled,
            onClick: () => props.save(),
          }, state.saving ? '保存中…' : '保存'),
          React.createElement('button', {
            className: 'wssc-btn',
            disabled: !state.dirty || disabled,
            onClick: () => props.discard(),
          }, '放弃修改'),
        ),
      )
    }

    // ---- plugin -------------------------------------------------------------------

    const inject = ['slots', 'settingsScope']

    function apply(ctx) {
      const card = new ScrapeCardController(ctx.settingsScope.bind({ namespace: NAMESPACE }))
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          id: 'web-search-scrape',
          order: 30,
          label: () => '网页搜索 · web-search-scrape',
          inject: () => card.inject(),
        }, ScrapeCard)
      })
    }

    return { apply, inject }
  },
})
