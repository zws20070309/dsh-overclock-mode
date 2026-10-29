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

// 轨道是「天空 / 星星 / 阳光 / 日月」四层，顺序即 z 序（天空最底、圆盘最后画）。
const track = offTree.children[1]
const layers = track.children.map((child) => child.props.className)
assert.deepEqual(plain(layers), ['dsh-oc-sky', 'dsh-oc-stars', 'dsh-oc-glow', 'dsh-oc-knob'])

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

const knob = track.children[3]
const craterClasses = flat(knob).map((c) => c.props.className)
assert.equal(craterClasses.length, 3, '三个环形山')
assert.ok(craterClasses.every((c) => c === 'dsh-oc-crater'), '环形山类名统一')

// 圆盘必须在最上层，否则要么被天空盖住、要么被星星穿透。
assert.equal(layers[layers.length - 1], 'dsh-oc-knob', 'knob paints last')

// ── 样式断言 ────────────────────────────────────────────────────────────────
// CSS 是模板字符串，规则体里有 ${INSET} 这类占位符，而 ${...} 自带一个 `}`；
// 直接对源码用 [^}]* 圈规则体会被那个 } 提前截断（我就踩了）。
// 先把占位符抹平成 `0`，花括号就恢复成"规则边界"这一个含义，再按规则取值。
const css = source.replace(/\$\{[^}]*\}/g, '0')
const ruleBody = (selector) => {
  const at = css.indexOf(selector + '{')
  assert.ok(at >= 0, '找不到规则 ' + selector)
  const from = at + selector.length + 1
  const to = css.indexOf('}', from)
  assert.ok(to > from, '规则没有闭合: ' + selector)
  return css.slice(from, to)
}

assert.ok(css.includes('--dsh-oc-x'), 'a single custom property drives the travel')
assert.ok(ruleBody('.dsh-oc-glow').includes('translateX(var(--dsh-oc-x))'), 'glow reads the shared travel var')
assert.ok(ruleBody('.dsh-oc-knob').includes('translateX(var(--dsh-oc-x))'), 'knob reads the shared travel var')
// 开态只改这一个变量，改别的都是重复真相。
assert.ok(ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-track').includes('--dsh-oc-x:'),
  'on-state only flips the travel var')
// 开态那条圆盘规则只管配色，不许再写一个 translateX（两处真相必然错位）。
assert.ok(!ruleBody('#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob').includes('translateX('),
  'on-state must not hardcode a second translateX for the knob')

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
assert.ok(css.includes('@keyframes dsh-oc-breathe'), 'busy state breathes')
// 回弹缓动：0.35 的过冲就是"弹一下"的来源。
assert.ok(css.includes('cubic-bezier(.56,1.35,.52,1)'), 'uses the overshoot easing')
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
// 减少动效里必须把动画也停掉，只停 transition 不够。
assert.ok(ruleBody('@media (prefers-reduced-motion:reduce)').includes('animation:none'),
  'reduced motion also stops animations')

console.log('client.test.mjs: ok')
