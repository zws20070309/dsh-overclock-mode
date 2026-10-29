// 浏览器半：**超频模式**开关（per-session）。
//
// 挂载点：官方槽位 `conversation.input.left`（kind:list，scope:session）
//   声明处 dsh-client-ui-conversation/lib/client.js:19896，渲染处同文件 :19072
//   —— 位于「+ / 权限 / 计划」之后、模型选择器之前，是 composer 工具栏的左组。
//   该槽位 scope=session，标准 props 里有 `sessionId`，而 sessionId 正是本插件的状态主键。
//
// 开关造型：**昼夜切换**。开 = 太阳，关 = 月亮。
//   * 关态：深蓝夜空 + 星星闪烁 + 银色月盘（带环形山）
//   * 开态：晴空蓝 + 暖阳（带外发光与缓慢旋转的内高光）+ 星星飞散消失
//   * 圆盘用一个 CSS 变量 --dsh-oc-x 同时驱动位移与光晕，二者不可能走岔
//   * 缓动用 cubic-bezier(.56,1.35,.52,1)：0.35 的过冲带来"弹一下"的手感
//
// 为什么这个文件长这样（三条都是踩过的坑，不是风格偏好）：
//   1. 所有 client bundle 会被拼成**一个脚本**执行，顶层 const 撞名会让整个拼合脚本
//      （含官方 bundle）起不来。所以顶层**零绑定**，注册内联成一条
//      `window.__ModuleLoader__.load({...})` 语句。
//   2. 没有构建步骤：`require` 只解析 `react`，不 import 任何 dsh 包。
//   3. 动效一律用**纯 CSS 动画**，不用 setInterval 去改内联样式：composer 里的常驻控件
//      不该持有定时器，否则每次重渲染都要清理，漏一个就泄漏。
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

    /** 场景几何。改这里就够了，下面的 CSS 用同一组数字。 */
    const TRACK_W = 42
    const TRACK_H = 23
    const KNOB = 17
    const INSET = 3
    /** 圆盘行程：轨道宽 - 盘径 - 两侧留白。 */
    const TRAVEL = TRACK_W - KNOB - INSET * 2

    /** 夜空的星星：位置在 CSS 里用 nth-child 给，这里只管数量与身份。 */
    const STAR_COUNT = 5
    /** 月盘上的环形山。 */
    const CRATER_COUNT = 3

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
     * 样式：昼夜切换开关。
     *
     * ⚠️ 状态类规则一律用 `#dsh-overclock-toggle[data-state=...]` 起头。
     * PRTS / dsh-claude-style 这类主题会把 composer 里的按钮用 !important 重刷背景与颜色，
     * 普通类选择器赢不了；id 作用域既够强，又只影响本按钮。
     * 场景元素（天空/星星/圆盘）都是内层 span，主题不会去点它们的名，所以不加 !important，
     * 免得把它们的 transition 一起打死。
     */
    const CSS = `
/* ── 按钮外壳 ───────────────────────────────────────────────────────── */
.dsh-oc{display:inline-flex;box-sizing:border-box;align-items:center;gap:6px;height:28px;
padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);flex:none;cursor:pointer;
background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-family:inherit;
font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;
transition:color .12s,background-color .12s,box-shadow .12s}
.dsh-oc:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
color:var(--dsw-alias-label-primary,inherit)}
.dsh-oc:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-brand-primary,#2563eb)}
.dsh-oc:disabled{cursor:default;opacity:.55}
.dsh-oc-text{pointer-events:none}

/* ── 轨道：一扇小小的天窗 ───────────────────────────────────────────── */
.dsh-oc-track{position:relative;display:inline-block;flex:none;box-sizing:border-box;
width:${TRACK_W}px;height:${TRACK_H}px;border-radius:999px;overflow:hidden;
--dsh-oc-x:0px;
box-shadow:inset 0 1px 3px rgba(0,0,0,.5),inset 0 -1px 1px rgba(255,255,255,.07);
transition:box-shadow .5s ease}

/* 夜空底色 + 晴空覆盖层。两层叠着做透明度交叉淡入：
   浏览器无法在两个 linear-gradient 之间插值，单层 background 只会"啪"地跳。 */
.dsh-oc-sky{position:absolute;inset:0;border-radius:inherit;
background:linear-gradient(180deg,#0a0f1e 0%,#141d38 58%,#1e2a4c 100%)}
.dsh-oc-sky::after{content:'';position:absolute;inset:0;border-radius:inherit;
background:linear-gradient(180deg,#2f8fd8 0%,#63b8ee 55%,#a6dbf8 100%);
opacity:0;transition:opacity .55s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-sky::after{opacity:1}

/* 星星：只在夜里出现，开态时向上飞散并缩小 */
.dsh-oc-stars{position:absolute;inset:0;border-radius:inherit;opacity:1;
transition:opacity .45s ease,transform .6s cubic-bezier(.56,1.35,.52,1)}
.dsh-oc-star{position:absolute;width:2px;height:2px;border-radius:50%;background:#fff;
box-shadow:0 0 2.5px rgba(255,255,255,.9);
animation:dsh-oc-twinkle 2.6s ease-in-out infinite}
.dsh-oc-star:nth-child(1){left:20px;top:5px;animation-duration:2.2s}
.dsh-oc-star:nth-child(2){left:28px;top:12px;animation-duration:3.1s;animation-delay:.4s}
.dsh-oc-star:nth-child(3){left:33px;top:6px;animation-duration:2.6s;animation-delay:.9s}
.dsh-oc-star:nth-child(4){left:24px;top:16px;animation-duration:3.4s;animation-delay:.2s}
.dsh-oc-star:nth-child(5){left:36px;top:15px;animation-duration:2.9s;animation-delay:1.2s}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-stars{opacity:0;
transform:translateY(-6px) scale(.4)}
@keyframes dsh-oc-twinkle{0%,100%{opacity:.28;transform:scale(.7)}50%{opacity:1;transform:scale(1.15)}}

/* 阳光外晕：与圆盘共用 --dsh-oc-x，理论上不可能错位 */
.dsh-oc-glow{position:absolute;left:${INSET}px;top:50%;width:${KNOB}px;height:${KNOB}px;
margin-top:${-KNOB / 2}px;border-radius:50%;
background:radial-gradient(circle,rgba(255,228,145,.95) 0%,rgba(255,196,64,.5) 42%,rgba(255,180,40,0) 72%);
opacity:0;transform:translateX(var(--dsh-oc-x));
transition:opacity .5s ease,transform .6s cubic-bezier(.56,1.35,.52,1)}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-glow{opacity:1}

/* 圆盘：关态月盘（银灰），开态暖阳（琥珀）。3D 质感靠"外投影 + 内侧暗边 + 内侧亮边"三层叠出来。 */
.dsh-oc-knob{position:absolute;left:${INSET}px;top:${INSET}px;width:${KNOB}px;height:${KNOB}px;
border-radius:50%;overflow:hidden;z-index:2;
background:linear-gradient(150deg,#f4f7fb 0%,#ccd3e0 52%,#a2acbf 100%);
box-shadow:0 1px 3px rgba(0,0,0,.5),inset -2px -3px 5px rgba(60,70,95,.35),
inset 2px 2px 4px rgba(255,255,255,.75);
transform:translateX(var(--dsh-oc-x));
transition:transform .6s cubic-bezier(.56,1.35,.52,1),background .5s ease,box-shadow .5s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob{
background:linear-gradient(150deg,#fff4c9 0%,#ffcc33 52%,#f29400 100%);
box-shadow:0 0 9px 1px rgba(255,190,60,.65),0 1px 3px rgba(0,0,0,.35),
inset -2px -3px 5px rgba(170,100,0,.35),inset 2px 2px 5px rgba(255,252,225,.9)}

/* 太阳内高光缓慢自转：让"开着"这件事有生命感，而不用定时器 */
.dsh-oc-knob::after{content:'';position:absolute;inset:-2px;border-radius:50%;
background:conic-gradient(from 0deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.75) 32deg,
rgba(255,255,255,0) 78deg,rgba(255,255,255,0) 360deg);
opacity:0;transition:opacity .4s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob::after{opacity:1;
animation:dsh-oc-sheen 3.4s linear infinite}
@keyframes dsh-oc-sheen{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

/* 环形山：关态可见，开态淡出 */
.dsh-oc-crater{position:absolute;border-radius:50%;background:rgba(118,130,152,.6);
box-shadow:inset 0 1px 1px rgba(40,50,70,.45);opacity:1;transition:opacity .35s ease}
.dsh-oc-crater:nth-child(1){width:5px;height:5px;left:3px;top:8px}
.dsh-oc-crater:nth-child(2){width:3px;height:3px;left:9.5px;top:3.5px}
.dsh-oc-crater:nth-child(3){width:2.5px;height:2.5px;left:10px;top:10px}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-crater{opacity:0}

/* ── 状态 ──────────────────────────────────────────────────────────── */
/* 开态：整颗药丸也染上暖色，工具栏里一眼可辨；--dsh-oc-accent 允许主题覆盖 */
#dsh-overclock-toggle[data-state="on"]{color:var(--dsh-oc-accent,#f5a524) !important;
background:color-mix(in srgb,var(--dsh-oc-accent,#f5a524) 14%,transparent) !important;
box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsh-oc-accent,#f5a524) 45%,transparent) !important}
/* 开态让圆盘滑到右端（唯一的状态开关，位移与光晕都读它） */
#dsh-overclock-toggle[data-state="on"] .dsh-oc-track{--dsh-oc-x:${TRAVEL}px}
/* 继承态：轨道描虚线，表明"这个值不是你亲自设的" */
.dsh-oc[data-inherited="1"] .dsh-oc-track{outline:1px dashed currentColor;outline-offset:1px}
/* 错误态：红色描边，点击即重试 */
#dsh-overclock-toggle[data-state="error"]{color:var(--dsw-alias-state-error-primary,#e5484d) !important}
#dsh-overclock-toggle[data-state="error"] .dsh-oc-track{
box-shadow:inset 0 0 0 1px currentColor !important}
/* 忙碌态：圆盘轻轻收放，表示请求在飞 */
#dsh-overclock-toggle[data-busy="1"] .dsh-oc-knob{animation:dsh-oc-breathe 1.1s ease-in-out infinite}
@keyframes dsh-oc-breathe{0%,100%{transform:translateX(var(--dsh-oc-x)) scale(1)}
50%{transform:translateX(var(--dsh-oc-x)) scale(.86)}}

/* 尊重"减少动态效果"：全部停掉，状态依然靠位置与配色可读 */
@media (prefers-reduced-motion:reduce){
.dsh-oc-track,.dsh-oc-sky::after,.dsh-oc-stars,.dsh-oc-star,.dsh-oc-glow,.dsh-oc-knob,
.dsh-oc-knob::after,.dsh-oc-crater{transition:none !important;animation:none !important}}
`

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

    /** 夜里那几颗星。位置交给 CSS 的 nth-child，标记里不塞内联几何。 */
    function stars() {
      const out = []
      for (let i = 0; i < STAR_COUNT; i += 1) out.push(h('span', { key: 'star' + i, className: 'dsh-oc-star' }))
      return out
    }

    /** 月盘上的环形山。 */
    function craters() {
      const out = []
      for (let i = 0; i < CRATER_COUNT; i += 1) out.push(h('span', { key: 'crater' + i, className: 'dsh-oc-crater' }))
      return out
    }

    /** 昼夜场景：一层夜空/晴空、一层星星、一团阳光、一轮日月。 */
    function scene() {
      return h(
        'span',
        { className: 'dsh-oc-track', 'aria-hidden': 'true' },
        h('span', { className: 'dsh-oc-sky' }),
        h('span', { className: 'dsh-oc-stars' }, stars()),
        h('span', { className: 'dsh-oc-glow' }),
        h('span', { className: 'dsh-oc-knob' }, craters()),
      )
    }

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
        h('span', { className: 'dsh-oc-text' }, t('label')),
        scene(),
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
