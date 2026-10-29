import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// ── 加载：顶层必须零绑定，只留一条 __ModuleLoader__.load ──────────────────────
let registration
const window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
vm.runInNewContext(source, { window, console })

assert.ok(registration, 'the bundle registers with window.__ModuleLoader__')
assert.equal(registration.id, '@zws/dsh-overclock-mode')

/** 极简 React 替身：只提供组件本身用到的 hooks。 */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial }
  },
  useState(initial) {
    return [initial, () => {}]
  },
}

const moduleExports = registration.factory((specifier) => {
  assert.equal(specifier, 'react', 'the browser half requires nothing but react')
  return React
})

// vm 里造出来的数组是**另一个 realm** 的 Array，deepEqual 会按原型判定不等 → 统一走 JSON。
const plain = (value) => JSON.parse(JSON.stringify(value))
assert.deepEqual(plain(moduleExports.inject), ['slots', 'locale', 'remote'])
assert.equal(typeof moduleExports.apply, 'function')

// ── apply：字典、Remote 贡献、槽位注册 ────────────────────────────────────────
let mounted
let registered
const locales = new Map()
const calls = []
const remoteStub = {
  async getState(sessionId) {
    calls.push(['getState', sessionId])
    return { ok: true, value: { sessionId, enabled: false, source: 'default', from: null, live: true, instructions: 'x' } }
  },
  async setEnabled(sessionId, enabled) {
    calls.push(['setEnabled', sessionId, enabled])
    return { ok: true, value: { sessionId, enabled, source: 'own', from: null, live: true, instructions: 'x' } }
  },
  async toggle(sessionId) {
    calls.push(['toggle', sessionId])
    return { ok: true, value: { sessionId, enabled: true, source: 'own', from: null, live: true, instructions: 'x' } }
  },
}

const ctx = {
  effect(fn) {
    return fn()
  },
  get(name) {
    return name === 'remote.overclock' ? remoteStub : undefined
  },
  locale: {
    register(namespace, dicts) {
      locales.set(namespace, dicts)
      return () => {}
    },
    bind(namespace) {
      const entry = locales.get(namespace)
      return (key) => (entry && entry.zh[key]) || key
    },
  },
  remote: {
    async $mount(contribution) {
      mounted = contribution
    },
  },
  slots: {
    inject(owner, callback) {
      assert.equal(owner, 'conversation.input.left')
      return callback()
    },
    register(options, component) {
      registered = { options, component }
      return () => {}
    },
  },
}

await moduleExports.apply(ctx)

// 字典两种语言都要在。
assert.ok(locales.get('overclock').zh && locales.get('overclock').en, 'both dictionaries are registered')
assert.equal(locales.get('overclock').zh.label, '超频模式')
assert.equal(locales.get('overclock').en.label, 'Overclock')

// Remote 贡献。
assert.equal(mounted.package, '@zws/dsh-overclock-mode')
assert.deepEqual(plain(mounted.descriptors.map((d) => d.method)), ['getState', 'setEnabled', 'toggle'])
for (const descriptor of mounted.descriptors) {
  assert.equal(descriptor.service, 'overclock')
  assert.equal(descriptor.namespace, 'overclock')
  assert.equal(descriptor.invocation.kind, 'direct')
  // Client 侧挂载会拒绝非 strict codec；每个参数与结果都必须带。
  for (const parameter of descriptor.parameters) {
    assert.equal(parameter.codec.mode, 'strict', descriptor.method + '/' + parameter.wire)
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.name, parameter.wire, 'SRC 兜底按参数名发字段，wire 必须等于 name')
  }
  assert.equal(descriptor.result.mode, 'strict')
}

// 每个方法都带 sessionId：这是"按会话"的线缆契约。
assert.deepEqual(plain(mounted.descriptors[0].parameters.map((p) => p.wire)), ['sessionId'])
assert.deepEqual(plain(mounted.descriptors[1].parameters.map((p) => p.wire)), ['sessionId', 'enabled'])
assert.deepEqual(plain(mounted.descriptors[2].parameters.map((p) => p.wire)), ['sessionId'])

// strict codec 必须真的能校验：坏输入抛错，好输入原样通过。
const sessionCodec = mounted.descriptors[0].parameters[0].codec
assert.equal(sessionCodec.create().parse('session-1'), 'session-1')
assert.throws(() => sessionCodec.create().parse(''), /non-empty session id/)
const enabledCodec = mounted.descriptors[1].parameters[1].codec
assert.equal(enabledCodec.create().parse(true), true)
assert.throws(() => enabledCodec.create().parse('true'), /expected a boolean/)

// 槽位注册。
assert.equal(registered.options.name, 'conversation.input.left')
assert.equal(registered.options.id, 'overclock-toggle')
assert.equal(registered.options.locale, 'overclock')
assert.equal(registered.options.registrant, '@zws/dsh-overclock-mode')
assert.equal(typeof registered.component, 'function')

// inject 给出的 api 必须解析到同一个 Remote 命名空间，且缺命名空间时报错而不是静默。
const injection = registered.options.inject('session-1')
assert.equal(typeof injection.api, 'function')
assert.equal(injection.api(), remoteStub)
const brokenCtxGet = ctx.get
ctx.get = () => undefined
assert.throws(() => injection.api(), /Remote namespace is not mounted/)
ctx.get = brokenCtxGet

// ── 组件渲染：三种状态都要能画出可辨认的开关 ───────────────────────────────────
const toggle = registered.component
const t = (key) => locales.get('overclock').zh[key]

const offTree = toggle({ t, api: () => remoteStub, sessionId: 'session-1' })
assert.equal(offTree.type, 'button')
assert.equal(offTree.props.id, 'dsh-overclock-toggle')
assert.equal(offTree.props.role, 'switch')
assert.equal(offTree.props['aria-checked'], false)
assert.equal(offTree.props['aria-label'], '超频模式')
assert.equal(offTree.props['data-state'], 'off')

// 子元素：文本 + 昼夜场景轨道。
const kinds = offTree.children.map((child) => child.props.className)
assert.deepEqual(plain(kinds), ['dsh-oc-text', 'dsh-oc-track'])

// 轨道是「天空 / 星星 / 云 / 阳光 / 忙碌回声 / 日月」六层，顺序即 z 序（天空最底、圆盘最后画）。
const track = offTree.children[1]
const layers = track.children.map((child) => child.props.className)
assert.deepEqual(plain(layers), ['dsh-oc-sky', 'dsh-oc-stars', 'dsh-oc-clouds', 'dsh-oc-glow', 'dsh-oc-pulse', 'dsh-oc-knob'])

// 真实 React 会把数组子节点展开，替身不会 —— 这里统一拍平后再数。
const flat = (node) => (node.children ?? []).flat(Infinity).filter((c) => c !== null && c !== undefined)

// 星星与环形山的数量必须与 CSS 里的 nth-child 规则对得上，否则会有元素没有定位。
const starLayer = track.children[1]
const starClasses = flat(starLayer).map((c) => c.props.className)
assert.equal(starClasses.length, 5, '五颗星')
assert.ok(starClasses.every((c) => c === 'dsh-oc-star'), '星星类名统一')
// 每颗星都要有唯一的 key，否则 React 走的是按索引对齐，动画会串位。
// （key 由 createElement 从 props 里抽取，替身不抽，所以这里读 props.key。）
const starKeys = flat(starLayer).map((c) => c.props.key)
assert.equal(new Set(starKeys).size, starKeys.length, 'stars carry unique keys')

// 云层紧跟在星星之后。
const cloudLayer = track.children[2]
assert.equal(cloudLayer.props.className, 'dsh-oc-clouds')
const cloudClasses = flat(cloudLayer).map((c) => c.props.className)
assert.equal(cloudClasses.length, 3, '三朵云')
assert.ok(cloudClasses.every((c) => c === 'dsh-oc-cloud'), '云类名统一')
const cloudKeys = flat(cloudLayer).map((c) => c.props.key)
assert.equal(new Set(cloudKeys).size, cloudKeys.length, 'clouds carry unique keys')

const knob = track.children[5]
const craterClasses = flat(knob).map((c) => c.props.className)
assert.equal(craterClasses.length, 3, '三个环形山')
assert.ok(craterClasses.every((c) => c === 'dsh-oc-crater'), '环形山类名统一')

// 圆盘必须在最上层，否则要么被天空盖住、要么被星星穿透。
assert.equal(layers[layers.length - 1], 'dsh-oc-knob', 'knob paints last')

// ── 样式断言 ────────────────────────────────────────────────────────────────
// 两个坑都在这里踩过，所以解析不图省事：
//   1. CSS 是模板字符串，规则体里有 ${INSET} 这类占位符，而 ${...} 自带一个 `}`；
//      用 [^}]* 圈规则体会被那个 } 提前截断。
//   2. `.dsh-oc-cloud::after` 不能用 indexOf(选择器 + '{') 找 ——
//      分组规则 `.dsh-oc-cloud::before,.dsh-oc-cloud::after{...}` 的后半截正好长一样，
//      会静默拿到公共声明（content/position…），后面算出一堆 undefined 也不报错。
// 所以先**只把 CSS 那段模板字符串取出来**（整份源码里 JS 的花括号会把深度算歪，
// 第一版按整份源码扫描，CSS 规则全都落在 depth 2 上，`.dsh-oc-glow` 直接找不到），
// 剥掉注释与占位符，再老老实实扫描花括号（带嵌套深度），
// 最后按"选择器列表里的精确一项 + 同深度"匹配。
const CSS_HEAD = 'const CSS = `'
const cssStart = source.indexOf(CSS_HEAD) + CSS_HEAD.length
const cssRaw = source
  .slice(cssStart, source.indexOf('`', cssStart))
  .replace(/\/\*[\s\S]*?\*\//g, '')
// 占位符要按**真实值**代入，不能一律抹成 0：否则 `${TRAVEL}` 变成 `translateX(0px)`，
// 和关态的起点一模一样，测试就再也分不出"有没有终点值"了（踩过）。
// 几何常量与 client.js 顶部保持一致。
const GEO = { TRACK_W: 42, TRACK_H: 23, KNOB: 17, INSET: 3 }
GEO.TRAVEL = GEO.TRACK_W - GEO.KNOB - GEO.INSET * 2
const css = cssRaw.replace(/\$\{([^}]+)\}/g, (whole, expr) => {
  // 目前只有两种形态：单个常量名，以及 ${-KNOB / 2} 这种一行算式。
  const value = /^-?[A-Z_]+(\s*\/\s*-?[\d.]+)?$/.test(expr.trim())
    ? eval(expr.replace(/\b([A-Z_]+)\b/g, (m) => {
        assert.ok(m in GEO, '测试不认识这个占位符：' + m)
        return String(GEO[m])
      })) // eslint-disable-line no-eval
    : NaN
  assert.ok(Number.isFinite(value), '无法展开的占位符：${' + expr + '}')
  return String(value)
})
assert.ok(!css.includes('${'), 'CSS 里不应再有未展开的占位符')
assert.ok(css.includes('.dsh-oc-track{'), 'CSS 模板字符串被成功截取')
const rules = []
{
  const stack = []
  let buf = ''
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '{') {
      stack.push({ sel: buf.trim(), start: i + 1 })
      buf = ''
    } else if (ch === '}') {
      const open = stack.pop()
      // 深度必须一起记：早退的 @media 里也有一份 `.dsh-oc-track,...{transition:none}`
      // 的选择器列表，只按"最后一条匹配"取就会把生产声明换成这条兜底声明。
      if (open !== undefined) rules.push({ sel: open.sel, body: css.slice(open.start, i), depth: stack.length })
      buf = ''
    } else {
      buf += ch
    }
  }
}
/** 取同深度下最后一条精确匹配的规则：简写规则在前、逐条细化的在后，后者才是最终值。 */
const ruleBody = (selector, depth = 0) => {
  let found
  for (const rule of rules) {
    if (rule.depth !== depth) continue
    if (rule.sel.split(',').map((s) => s.trim()).includes(selector)) found = rule.body
  }
  assert.ok(found !== undefined, '找不到规则 ' + selector + '（depth ' + depth + '）')
  return found
}
/** 规则体 → 声明表。用 split 解析，不写正则：反斜杠在多层转义里太容易写错。 */
const decls = (text) => {
  const out = {}
  for (const part of text.split(';')) {
    const i = part.indexOf(':')
    if (i >= 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}
const num = (value) => parseFloat(value)

// ── 位移：三处必须写同一对端点值，不经过自定义属性中转 ─────────────────────────
// 先更正一条我自己写错、后来被实测推翻的说法：
//   曾经以为"未注册的自定义属性不插值"，所以把位移改成直接写 translateX 端点值。
//   实测（同页 A/B，逐帧采样两个方向）后发现：新旧写法逐帧**完全相同**，
//   现代 Chromium 对 var() 引用的未注册属性也能逐帧插值。那个结论是错的。
// 保留这个改写是因为它本身更直白（少一层间接、端点一眼可见），而不是因为"修好了什么"。
// 真正的掉帧根因见下面的 will-change 与文件头的说明。
assert.ok(!css.includes('--dsh-oc-x'), '位移不再经过自定义属性中转')
const TRAVEL_PX = 42 - 17 - 3 * 2
assert.equal(TRAVEL_PX, 19, '几何常量没被改坏')
// 起点：三个会跟着圆盘走的层，关态都必须是 translateX(0)。
for (const selector of ['.dsh-oc-glow', '.dsh-oc-knob', '.dsh-oc-pulse']) {
  assert.ok(ruleBody(selector).includes('transform:translateX(0)'),
    selector + ' 关态起点必须是 translateX(0)')
  // 终点：开态规则里写死 TRAVEL（19px），三处必须一致，否则会走岔。
  const onRule = ruleBody('#dsh-overclock-toggle[data-state="on"] ' + selector)
  assert.ok(onRule.includes('transform:translateX(19px)'),
    selector + ' 开态终点必须是 translateX(19px)，当前：' + onRule)
}
// 光晕与回声的开态规则只该有位移（+ 光晕的 opacity），不该混进别的 transform。
assert.ok(!ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob').includes('scale('),
  '圆盘开态不许混入 scale（会和位移互相覆盖）')

// ── will-change：位移必须走合成器 ───────────────────────────────────────────
// 实测（真实 DSH、真实鼠标点击、逐帧采样）：
//   页面加载后的**第一次**点击 ON→OFF：104ms→201ms 有 97ms 空档，期间动画时间轴照常前进，
//     屏幕却只更新了 2 帧，恢复后位移"追上来" → 人眼读作"卡一下再猛冲"（这就是瞬移的来源）。
//   紧接着的第 2、3 次点击：每 6ms 一帧、无任何 >40ms 的空档，完全平滑。
//   同时 PerformanceObserver 的长任务列表是**空的** —— 不是 JS 卡，是首次现建合成层/上传纹理。
// will-change:transform 把这笔开销提前到布局阶段，首次点击就不用现付。
// 三个跟着位移走的层都必须声明，漏一个那一层就仍会在首次掉帧。
for (const selector of ['.dsh-oc-knob', '.dsh-oc-glow', '.dsh-oc-pulse']) {
  assert.ok(ruleBody(selector).includes('will-change:transform'),
    selector + ' 需要 will-change:transform 提前建层，否则首次点击会掉帧')
}

// 没有 sessionId 时禁用，且提示是"先进入会话"，不是空白 title。
const noSession = toggle({ t, api: () => remoteStub, sessionId: undefined })
assert.equal(noSession.props.disabled, true)
assert.equal(noSession.props.title, t('tipNoSession'))

// 组件里必须真的会调用 Remote：api 命名空间上的三个方法签名都被引用到。
const usedMethods = ['getState', 'setEnabled', 'toggle'].filter((name) => source.includes('api().' + name))
assert.deepEqual(usedMethods, ['getState', 'toggle'], 'component reads state and flips it')

// 样式表：开态靠 id + !important（主题会用 !important 重刷按钮），继承态有独立可见标记。
assert.ok(css.includes('#dsh-overclock-toggle[data-state="on"]'), 'on-state rule is id-scoped')
assert.ok(css.includes('[data-inherited="1"]'), 'inherited state has its own visual marker')
assert.ok(source.includes('data-plugin-css'), 'stylesheet is tagged for idempotent install')

// ── 昼夜动效：开态必须是"动"的，不能只是换个颜色 ──────────────────────────────
assert.ok(css.includes('@keyframes dsh-oc-twinkle'), 'stars twinkle at night')
assert.ok(css.includes('@keyframes dsh-oc-sheen'), 'sun has a rotating highlight')
assert.ok(css.includes('@keyframes dsh-oc-pulse'), 'busy state shows a pulse')
assert.ok(css.includes('@keyframes dsh-oc-drift'), 'clouds drift slowly')
// 天空交叉淡入：两个渐变之间无法插值，必须两层叠透明度。
assert.ok(css.includes('.dsh-oc-sky::after'), 'day sky is a cross-fading overlay')
assert.ok(ruleBody('.dsh-oc-sky').includes('linear-gradient'), 'night sky is a gradient')
assert.ok(ruleBody('.dsh-oc-sky::after').includes('opacity:0'), 'day sky starts hidden')
assert.ok(ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-sky::after').includes('opacity:1'),
  'day sky fades in when on')
assert.ok(css.includes('conic-gradient'), 'sun highlight is a conic sweep')
assert.ok(ruleBody('.dsh-oc-glow').includes('radial-gradient'), 'sun halo is a radial glow')
// 关态可见 / 开态隐藏：星星与环形山都要有明确的开态规则。
assert.ok(ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-stars').includes('opacity:0'),
  'stars are hidden when on')
assert.ok(ruleBody('.dsh-oc-stars').includes('opacity:1'), 'stars are visible at night')
assert.ok(ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-crater').includes('opacity:0'),
  'craters are hidden when on')
assert.ok(ruleBody('.dsh-oc-crater').includes('opacity:1'), 'craters are visible on the moon')
// 每一颗星、每一个环形山都要在 CSS 里有定位，否则会叠在左上角。
for (let i = 1; i <= 5; i += 1) {
  assert.ok(css.includes('.dsh-oc-star:nth-child(' + i + ')'), 'star ' + i + ' is positioned')
}
for (let i = 1; i <= 3; i += 1) {
  assert.ok(css.includes('.dsh-oc-crater:nth-child(' + i + ')'), 'crater ' + i + ' is positioned')
}
assert.ok(css.includes('prefers-reduced-motion'), 'respects reduced motion')
// 减少动效里必须把动画也停掉，只停 transition 不够，而且新增的层不能漏掉。
const reduced = ruleBody('@media (prefers-reduced-motion:reduce)')
assert.ok(reduced.includes('animation:none'), 'reduced motion also stops animations')
for (const layer of ['.dsh-oc-sky::after', '.dsh-oc-stars', '.dsh-oc-clouds', '.dsh-oc-cloud',
  '.dsh-oc-glow', '.dsh-oc-pulse', '.dsh-oc-knob', '.dsh-oc-crater']) {
  assert.ok(reduced.includes(layer), '减少动效要覆盖 ' + layer)
}

// ── 回归：动画不许抢走圆盘的 transform ───────────────────────────────────────
// 这是最贵的一个坑，代价是"整个过渡完全消失"：
// 真实点击时 React 在同一次提交里同时置 data-busy="1" 与 data-state="on"，
// 于是 animation 和 transition 同时命中 .dsh-oc-knob 的 transform；
// CSS 级联里**动画压过过渡**，动画第一帧直接把 translateX 写成终点值，
// 过渡根本没机会开始 —— 用户看到的就是"太阳瞬间跳到右边，一点过渡都没有"。
// 实测（把过渡对象定格到 t=0/50%/100%）：
//   修前 真实点击 t=0 位移就已经是 19.00px；修后是 0.00 → 13.64 → 19.00。
// 所以这条断言必须存在：任何 data-busy / data-state 规则都不许给圆盘加 animation。
const knobAnimationRules = rules.filter((rule) => {
  const sels = rule.sel.split(',').map((s) => s.trim())
  return sels.some((s) => s.endsWith('.dsh-oc-knob') || s.endsWith('.dsh-oc-knob::after'))
    && /(^|;)animation\s*:/.test(rule.body.replace(/^\s+/, ''))
})
for (const rule of knobAnimationRules) {
  // 唯一允许的是"开态的高光自转"，它动的是 ::after（伪元素），且不碰 translateX。
  assert.ok(rule.sel.includes('::after'),
    '圆盘本体不许挂 animation（会压掉位移过渡）：' + rule.sel)
  assert.ok(!/translateX/.test(rule.body),
    '圆盘上的动画不许碰 translateX（会压掉位移过渡）：' + rule.sel)
}
// 忙碌态的回声必须是独立一层，且它自己只做 transition。
assert.ok(ruleBody('.dsh-oc-pulse').includes('transition:transform var(--dsh-oc-move)'),
  '忙碌回声跟着圆盘走，但只靠 transition')
assert.ok(!ruleBody('.dsh-oc-pulse').includes('animation:'),
  '忙碌回声本体不许有 animation，动画放在它的 ::after 上')
// 忙碌态任何一条规则都不许给 .dsh-oc-pulse 本体加 animation：
// 它的 transform 是位移过渡的唯一载体，一旦被动画接管，回声和圆盘就会错位。
// 注意用 endsWith 而不是"选择器里含有"：真实的规则是
// `#dsh-overclock-toggle[data-busy="1"] .dsh-oc-pulse`，用精确相等会漏掉（试过，漏了）。
// （@media (prefers-reduced-motion) 里的 animation:none 是"关掉动画"，要放行。）
for (const rule of rules) {
  if (rule.depth > 0) continue
  const targetsPulse = rule.sel.split(',').map((s) => s.trim()).some((s) => s.endsWith('.dsh-oc-pulse'))
  if (!targetsPulse) continue
  assert.ok(!/(^|;)animation\s*:/.test(rule.body.replace(/^\s+/, '')),
    '忙碌回声本体不许挂 animation（会和位移过渡抢 transform）：' + rule.sel)
}
assert.ok(ruleBody('#dsh-overclock-toggle[data-busy="1"] .dsh-oc-pulse::after').includes('animation:'),
  '扩散动画挂在 ::after 上，不和位移抢 transform')

// ── 行程时长：用户明确提过"太快了，跟没有一样"，所以这条要能被测出来 ─────────────
// 上一版是 .6s + cubic-bezier(.56,1.35,.52,1)。实测（把每条过渡的 currentTime 手动擦洗）
// 可见位移只覆盖时长的 45%：600ms 里 240ms 就走完 86% 的行程，剩下 360ms 在收 4% 的尾。
// 所以这里既钉"时长够长"，也钉"位移铺得开"，还钉"三层读同一个变量"。
const trackRule = decls(ruleBody('.dsh-oc-track'))
const moveMs = num(trackRule['--dsh-oc-move']) * 1000
assert.ok(Number.isFinite(moveMs) && moveMs >= 1000, '共享行程时长要 ≥1000ms，当前 ' + moveMs + 'ms')
const ease = trackRule['--dsh-oc-ease']
assert.ok(ease.startsWith('cubic-bezier('), '共享缓动是一个 cubic-bezier，当前 ' + ease)
for (const selector of ['.dsh-oc-knob', '.dsh-oc-glow', '.dsh-oc-stars']) {
  const transition = decls(ruleBody(selector)).transition
  assert.ok(transition.includes('var(--dsh-oc-move)'), selector + ' 的位移要读共享时长')
  assert.ok(transition.includes('var(--dsh-oc-ease)'), selector + ' 的位移要读共享缓动')
}
assert.ok(!css.includes('.56,1.35,.52,1'), '不再使用"半程就到终点"的旧缓动')
assert.ok(ruleBody('.dsh-oc-knob').includes('transform var(--dsh-oc-move)'),
  '圆盘位移走共享时长')
// "可见位移窗口"：把缓动的横轴（时间）在纵轴 5%~95%（行程）处取出来，
// 窗口占时长的比例就是动效"能被看见"的比例。旧的只有 0.45，新的要 ≥0.6。
const bezierAt = (x1, y1, x2, y2, target) => {
  const yAt = (t) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3
  const xAt = (t) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2
    if (yAt(mid) < target) lo = mid
    else hi = mid
  }
  return xAt((lo + hi) / 2)
}
const [b1, b2, b3, b4] = ease.slice('cubic-bezier('.length, -1).split(',').map((v) => parseFloat(v))
assert.ok([b1, b2, b3, b4].every(Number.isFinite), '缓动的四个参数要能解析：' + ease)
const window95 = bezierAt(b1, b2, b3, b4, 0.95) - bezierAt(b1, b2, b3, b4, 0.05)
assert.ok(window95 >= 0.6,
  '可见位移要铺开到 60% 以上的时长，当前 ' + Math.round(window95 * 100) + '%')
assert.ok(moveMs * window95 >= 700,
  '可见运动总时长要 ≥700ms，当前 ' + Math.round(moveMs * window95) + 'ms')

// ── 白云：只属于白昼，而且必须完整落在胶囊形轨道里 ─────────────────────────────
assert.ok(ruleBody('.dsh-oc-cloud').includes('opacity:0'), '云默认（夜间）不可见')
assert.ok(ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-cloud').includes('opacity:'),
  '云只在开态显形')
for (let i = 1; i <= 3; i += 1) {
  assert.ok(css.includes('.dsh-oc-cloud:nth-child(' + i + ')'), '云 ' + i + ' 有定位')
}
// 轨道左端是半径 11.5 的圆角，云一旦越界就会被 overflow:hidden 切掉一块。
// 云在夜里本来不可见，但"太阳左边"的云全都落在左半边 —— 正是圆角那一侧，
// 所以必须按几何算，不能靠肉眼看（最早那版 left:3,top:5 的凸起顶端离边界只有 0.24px，
// 放大 16 倍才看出来被切了）。
const TRACK_W = 42
const TRACK_H = 23
const RADIUS = TRACK_H / 2
const bumpRatio = ['.dsh-oc-cloud::before', '.dsh-oc-cloud::after'].map((sel) => {
  const d = decls(ruleBody(sel))
  return { left: num(d.left) / 100, bottom: num(d.bottom) / 100, width: num(d.width) / 100, height: num(d.height) / 100 }
})
assert.ok(bumpRatio.every((b) => Number.isFinite(b.width) && b.width > 0), '凸起比例能解析')
const inCapsule = (x, y, margin) => {
  const r = RADIUS - margin
  if (x < RADIUS) return (x - RADIUS) ** 2 + (y - RADIUS) ** 2 <= r * r
  if (x > TRACK_W - RADIUS) return (x - (TRACK_W - RADIUS)) ** 2 + (y - RADIUS) ** 2 <= r * r
  return Math.abs(y - RADIUS) <= r
}
for (let i = 1; i <= 3; i += 1) {
  const d = decls(ruleBody('.dsh-oc-cloud:nth-child(' + i + ')'))
  const L = num(d.left)
  const T = num(d.top)
  const w = num(d.width)
  const h = num(d.height)
  assert.ok([L, T, w, h].every(Number.isFinite), '云 ' + i + ' 的几何能解析')
  const corner = Math.min(3, h / 2)
  const inBase = (x, y) => {
    if (x < L || x > L + w || y < T || y > T + h) return false
    const dx = Math.max(L + corner - x, 0, x - (L + w - corner))
    const dy = Math.max(T + corner - y, 0, y - (T + h - corner))
    return dx * dx + dy * dy <= corner * corner + 1e-9
  }
  const ellipses = bumpRatio.map((b) => ({
    cx: L + b.left * w + (b.width * w) / 2,
    cy: T + h - b.bottom * h - (b.height * h) / 2,
    rx: (b.width * w) / 2,
    ry: (b.height * h) / 2,
  }))
  const inSilhouette = (x, y) =>
    inBase(x, y) ||
    ellipses.some((e) => ((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2 <= 1 + 1e-9)
  let minMargin = Infinity
  for (let x = Math.min(L, ...ellipses.map((e) => e.cx - e.rx)); x <= Math.max(L + w, ...ellipses.map((e) => e.cx + e.rx)); x += 0.1) {
    for (let y = Math.min(T, ...ellipses.map((e) => e.cy - e.ry)); y <= Math.max(T + h, ...ellipses.map((e) => e.cy + e.ry)); y += 0.1) {
      if (!inSilhouette(x, y)) continue
      let lo = 0
      let hi = RADIUS
      for (let k = 0; k < 34; k += 1) {
        const mid = (lo + hi) / 2
        if (inCapsule(x, y, mid)) lo = mid
        else hi = mid
      }
      if (lo < minMargin) minMargin = lo
    }
  }
  assert.ok(minMargin >= 1, '云 ' + i + ' 的剪影离圆角边界只有 ' + minMargin.toFixed(2) + 'px，会被切角')
}
// 云的飘移幅度必须小于"云右缘到太阳左缘"的余量，否则飘着飘着就钻到太阳底下了。
const driftPx = num(/translateX\((-?[\d.]+)px\)/.exec(ruleBody('@keyframes dsh-oc-drift'))?.[1] ?? 'NaN')
assert.ok(Number.isFinite(driftPx) && driftPx > 0, '云有横向飘移')
assert.ok(driftPx <= 3, '飘移幅度不要超过 3px，当前 ' + driftPx + 'px')

console.log('client.test.mjs: ok')
