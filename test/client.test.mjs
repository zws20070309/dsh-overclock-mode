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

// 子元素：闪电图标 + 文本 + 轨道（含滑块）。
const kinds = offTree.children.map((child) => child.props.className)
assert.deepEqual(plain(kinds), ['dsh-oc-bolt', 'dsh-oc-text', 'dsh-oc-track'])
const track = offTree.children[2]
assert.equal(track.children[0].props.className, 'dsh-oc-knob')

// 没有 sessionId 时禁用，且提示是"先进入会话"，不是空白 title。
const noSession = toggle({ t, api: () => remoteStub, sessionId: undefined })
assert.equal(noSession.props.disabled, true)
assert.equal(noSession.props.title, t('tipNoSession'))

// 组件里必须真的会调用 Remote：api 命名空间上的三个方法签名都被引用到。
const usedMethods = ['getState', 'setEnabled', 'toggle'].filter((name) => source.includes('api().' + name))
assert.deepEqual(usedMethods, ['getState', 'toggle'], 'component reads state and flips it')

// 样式表：开态靠 id + !important（主题会用 !important 重刷按钮），继承态有独立可见标记。
assert.ok(source.includes('#dsh-overclock-toggle[data-state="on"]'), 'on-state rule is id-scoped')
assert.ok(source.includes('[data-inherited="1"]'), 'inherited state has its own visual marker')
assert.ok(source.includes('prefers-reduced-motion'), 'respects reduced motion')
assert.ok(source.includes('data-plugin-css'), 'stylesheet is tagged for idempotent install')

console.log('client.test.mjs: ok')
