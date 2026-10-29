// 浏览器半：**超频模式**开关（per-session）。
//
// 挂载点：官方槽位 `conversation.input.left`（kind:list，scope:session）
//   声明处 dsh-client-ui-conversation/lib/client.js:19896，渲染处同文件 :19072
//   —— 位于「+ / 权限 / 计划」之后、模型选择器之前，是 composer 工具栏的左组。
//   该槽位 scope=session，标准 props 里有 `sessionId`，而 sessionId 正是本插件的状态主键。
//
// 为什么这个文件长这样（三条都是踩过的坑，不是风格偏好）：
//   1. 所有 client bundle 会被拼成**一个脚本**执行，顶层 const 撞名会让整个拼合脚本
//      （含官方 bundle）起不来。所以顶层**零绑定**，注册内联成一条
//      `window.__ModuleLoader__.load({...})` 语句。
//   2. 没有构建步骤：`require` 只解析 `react`，不 import 任何 dsh 包。
//   3. 所有注册与远端调用都包 try/catch：apply 里抛错会连带炸掉整个 bundle。
//
// 状态判定口径（与宿主半一致）：
//   own       = 这个会话自己设过，开关就是它
//   inherited = 这个会话没设过，但它的上级（parentSession 链）设过 —— 委派出去的子代理
//               因此能继承"极限测试"的预算，不会一委派就断
//   default   = 整条链都没设过，关
// 继承态在界面上必须能看出来，否则用户会以为"我明明没开它却亮着"。
window.__ModuleLoader__.load({
  id: '@zws/dsh-overclock-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PACKAGE = '@zws/dsh-overclock-mode'
    const NS = 'overclock'
    const SLOT = 'conversation.input.left'
    const ENTRY_ID = 'overclock-toggle'
    const BUTTON_ID = 'dsh-overclock-toggle'

    const DICTIONARY = {
      zh: {
        label: '超频模式',
        tipOff: '超频模式已关闭。点击开启：本会话的系统提示词会追加一段英文指令（We are DeepSeek… 用量无限、正在极限测试、不要吝惜 token）',
        tipOn: '超频模式已开启（本会话）。点击关闭',
        tipInheritedOn: '本会话继承上级会话的超频模式，当前开启。点击可在本会话单独关闭',
        tipInheritedOff: '本会话继承上级会话的超频模式，当前关闭。点击可在本会话单独开启',
        tipNoSession: '请先进入一个会话',
        loading: '正在读取超频模式状态…',
        error: '读取超频模式状态失败，点击重试',
      },
      en: {
        label: 'Overclock',
        tipOff: 'Overclock is off for this session. Click to append an unlimited-budget instruction to this session system prompt',
        tipOn: 'Overclock is on for this session. Click to turn it off',
        tipInheritedOn: 'Inherited from a parent session; currently on. Click to turn it off for this session only',
        tipInheritedOff: 'Inherited from a parent session; currently off. Click to turn it on for this session only',
        tipNoSession: 'Open a session first',
        loading: 'Reading overclock state…',
        error: 'Could not read overclock state; click to retry',
      },
    }

    /**
     * 严格 codec 占位。浏览器不执行参数 schema，宿主会逐字段校验；
     * 这个对象只用来通过 Client 侧的 strict-input 检查（非 strict 的 codec 会被拒绝挂载）。
     */
    const codec = (name, parse) => ({
      mode: 'strict',
      typeSymbol: PACKAGE + '#' + name,
      create: () => ({ parse: parse ?? ((value) => value) }),
    })

    const sessionIdCodec = codec('SessionId', (value) => {
      if (typeof value !== 'string' || value.length === 0) throw new Error('expected a non-empty session id')
      return value
    })
    const booleanCodec = codec('Enabled', (value) => {
      if (typeof value !== 'boolean') throw new Error('expected a boolean')
      return value
    })
    const resultCodec = codec('State')

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: [
        {
          id: PACKAGE + '#overclock/getState',
          service: 'overclock',
          namespace: 'overclock',
          method: 'getState',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
          result: resultCodec,
        },
        {
          id: PACKAGE + '#overclock/setEnabled',
          service: 'overclock',
          namespace: 'overclock',
          method: 'setEnabled',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec },
            { name: 'enabled', wire: 'enabled', source: 'json', codec: booleanCodec },
          ],
          result: resultCodec,
        },
        {
          id: PACKAGE + '#overclock/toggle',
          service: 'overclock',
          namespace: 'overclock',
          method: 'toggle',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: sessionIdCodec }],
          result: resultCodec,
        },
      ],
    }

    /**
     * 样式。全部走宿主 alias 令牌（浅/深色自动翻转），带十六进制兜底。
     *
     * ⚠️ 开态用 id 作用域的 !important：PRTS / dsh-claude-style 这类主题会把
     * composer 里的按钮用 !important 重刷背景与颜色，普通类选择器赢不了。
     * id + !important 是唯一稳定的写法，同时只影响本按钮。
     */
    const CSS = [
      '.dsh-oc{display:inline-flex;box-sizing:border-box;align-items:center;gap:6px;height:28px;',
      'padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);flex:none;cursor:pointer;',
      'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-family:inherit;',
      'font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;',
      'transition:color .12s,background-color .12s,box-shadow .12s}',
      '.dsh-oc:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));',
      'color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-oc:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#2563eb)}',
      '.dsh-oc:disabled{cursor:default;opacity:.55}',
      '.dsh-oc-bolt{display:inline-flex;flex:none}',
      '.dsh-oc-bolt svg{display:block;width:14px;height:14px}',
      '.dsh-oc-text{pointer-events:none}',
      // 迷你轨道开关：轨道 24x13，滑块 9x9，靠 translateX 表达开/关。
      '.dsh-oc-track{box-sizing:border-box;position:relative;display:inline-flex;flex:none;',
      'align-items:center;width:24px;height:13px;padding:2px;border-radius:999px;',
      'background:var(--dsw-alias-border-l2,rgba(128,128,128,.45));',
      'transition:background-color .14s}',
      '.dsh-oc-knob{display:block;width:9px;height:9px;border-radius:50%;',
      'background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.25);',
      'transform:translateX(0);transition:transform .14s}',
      // 继承态：轨道描边虚线，表明"这个值不是你亲自设的"。
      '.dsh-oc[data-inherited="1"] .dsh-oc-track{outline:1px dashed currentColor;outline-offset:1px}',
      // 开态。--dsh-oc-accent 可被主题覆盖。
      '#dsh-overclock-toggle[data-state="on"]{',
      'color:var(--dsh-oc-accent,#f5a524) !important;',
      'background:color-mix(in srgb,var(--dsh-oc-accent,#f5a524) 16%,transparent) !important;',
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsh-oc-accent,#f5a524) 55%,transparent) !important}',
      '#dsh-overclock-toggle[data-state="on"] .dsh-oc-track{background:currentColor !important}',
      '#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob{transform:translateX(11px) !important;',
      'box-shadow:0 1px 2px rgba(0,0,0,.3) !important}',
      '#dsh-overclock-toggle[data-state="on"] .dsh-oc-bolt svg{filter:drop-shadow(0 0 3px currentColor)}',
      // 错误态：红色，点击即重试。
      '#dsh-overclock-toggle[data-state="error"]{color:var(--dsw-alias-state-error-primary,#e5484d) !important}',
      '#dsh-overclock-toggle[data-state="error"] .dsh-oc-track{background:currentColor !important;opacity:.5}',
      // 忙碌态：轨道呼吸一下，表示请求在飞。
      '#dsh-overclock-toggle[data-busy="1"] .dsh-oc-track{animation:dsh-oc-pulse .9s ease-in-out infinite}',
      '@keyframes dsh-oc-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dsh-oc-track,.dsh-oc-knob{transition:none}',
      '#dsh-overclock-toggle[data-busy="1"] .dsh-oc-track{animation:none}}',
    ].join('')

    /** 只插一次样式表；class 名带插件前缀，不会碰官方样式。 */
    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = PACKAGE + '/overclock.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const BOLT = h(
      'svg',
      { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M8.9 1 3 9.1h3.3L5.6 15l6.3-8.4H8.4L8.9 1Z', fill: 'currentColor' }),
    )

    /** 让 composer 的光标留在编辑器里：不抢焦点。 */
    function keepFocus(event) {
      event.preventDefault()
    }

    /** Remote 结果统一是 { ok, value } | { ok, error } 判别联合。 */
    function unwrap(result) {
      if (result !== null && typeof result === 'object') {
        if (result.ok === true) return result.value
        if (result.ok === false) throw new Error(result.error && result.error.message ? result.error.message : 'remote call failed')
      }
      throw new Error('remote returned a non-Result shape')
    }

    /**
     * 开关本体。
     * 乐观翻转 + 宿主答案为准：点下去立刻动，失败回滚到点之前的状态。
     */
    function OverclockToggle(props) {
      const { t, api, sessionId } = props
      const id = typeof sessionId === 'string' ? sessionId : ''
      /** 'loading' | 'on' | 'off' | 'error' */
      const [phase, setPhase] = React.useState('loading')
      /** 'own' | 'inherited' | 'default' */
      const [source, setSource] = React.useState('default')
      const [busy, setBusy] = React.useState(false)
      /** 每次点击递增，用来丢掉过期的响应（快速切会话/连点时）。 */
      const seq = React.useRef(0)

      const apply = React.useCallback((state) => {
        setPhase(state.enabled ? 'on' : 'off')
        setSource(state.source === 'inherited' ? 'inherited' : 'default')
      }, [])

      const read = React.useCallback(() => {
        if (id === '') {
          setPhase('off')
          setSource('default')
          return undefined
        }
        const ticket = ++seq.current
        setPhase('loading')
        let pending
        try {
          pending = Promise.resolve(api().getState(id))
        } catch (error) {
          pending = Promise.reject(error)
        }
        let alive = true
        pending
          .then((remote) => {
            if (!alive || ticket !== seq.current) return
            apply(unwrap(remote))
          })
          .catch(() => {
            if (alive && ticket === seq.current) setPhase('error')
          })
        return () => {
          alive = false
        }
      }, [api, id, apply])

      React.useEffect(() => read(), [read])

      const click = () => {
        if (busy || id === '') return
        if (phase === 'error') {
          read()
          return
        }
        if (phase === 'loading') return
        const before = { phase, source }
        const ticket = ++seq.current
        setBusy(true)
        // 乐观翻转：超频是"多花 token"，先亮起来比先等一次往返更符合直觉。
        setPhase(phase === 'on' ? 'off' : 'on')
        let pending
        try {
          pending = Promise.resolve(api().toggle(id))
        } catch (error) {
          pending = Promise.reject(error)
        }
        pending
          .then((remote) => {
            if (ticket !== seq.current) return
            apply(unwrap(remote))
          })
          .catch(() => {
            if (ticket !== seq.current) return
            setPhase(before.phase)
            setSource(before.source)
          })
          .then(() => {
            if (ticket === seq.current) setBusy(false)
          })
      }

      const on = phase === 'on'
      const inherited = source === 'inherited'
      const title =
        id === ''
          ? t('tipNoSession')
          : phase === 'loading'
            ? t('loading')
            : phase === 'error'
              ? t('error')
              : inherited
                ? on
                  ? t('tipInheritedOn')
                  : t('tipInheritedOff')
                : on
                  ? t('tipOn')
                  : t('tipOff')

      return h(
        'button',
        {
          type: 'button',
          id: BUTTON_ID,
          className: 'dsh-oc',
          'data-state': phase === 'loading' ? 'off' : phase,
          'data-inherited': inherited ? '1' : '0',
          'data-busy': busy ? '1' : '0',
          role: 'switch',
          'aria-checked': on,
          'aria-label': t('label'),
          title,
          disabled: busy || phase === 'loading' || id === '',
          onMouseDown: keepFocus,
          onClick: click,
        },
        h('span', { className: 'dsh-oc-bolt' }, BOLT),
        h('span', { className: 'dsh-oc-text' }, t('label')),
        h(
          'span',
          { className: 'dsh-oc-track', 'aria-hidden': 'true' },
          h('span', { className: 'dsh-oc-knob' }),
        ),
      )
    }

    async function apply(ctx) {
      installStyles()
      ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'overclock:dictionary')
      await ctx.remote.$mount(CONTRIBUTION)
      const t = ctx.locale.bind(NS)
      const namespaceApi = () => {
        const namespace = ctx.get('remote.overclock')
        if (namespace === undefined || namespace === null) throw new Error('the overclock Remote namespace is not mounted')
        return namespace
      }
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: ENTRY_ID,
                // 40：与 skillhub 同档，排在「+ / 权限 / 计划」之后，靠左组内靠后。
                order: 40,
                locale: NS,
                registrant: PACKAGE,
                inject: () => ({ api: namespaceApi }),
              },
              OverclockToggle,
            ),
          ),
        'overclock.slot',
      )
    }

    exports.inject = ['slots', 'locale', 'remote']
    exports.apply = apply
    return module.exports
  },
})
