import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plugin = await import(new URL('../index.js', import.meta.url).href)

/**
 * 最小 Cordis 上下文：provide / effect / logger / systemPrompt.section / emit / get。
 * `sessions` 只实现本插件真正用到的 `get(id)`，返回带 header.parentSession 的会话壳。
 */
function fakeContext(agents = {}) {
  const services = new Map()
  const sections = []
  const events = []
  const ctx = {
    logger: { warn() {} },
    provide(name, value) {
      services.set(name, value)
    },
    effect(fn) {
      return fn()
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => agents[id] }
      return undefined
    },
    emit(name) {
      events.push(name)
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
    },
  }
  return { ctx, services, sections, events }
}

/** 装配上下文的最小形状：只有 agent.session 被读到。 */
const assembling = (sessionId) => ({ agent: { session: { id: sessionId } } })

const home = await mkdtemp(join(tmpdir(), 'overclock-test-'))
try {
  // ── 1. 注册形状 ─────────────────────────────────────────────────────────────
  const first = fakeContext()
  plugin.apply(first.ctx, { dshHome: home })
  assert.deepEqual(plugin.inject, ['systemPrompt'])

  const service = first.services.get('overclock')
  assert.ok(service, 'service is provided as `overclock`')
  assert.equal(first.sections.length, 1)
  assert.equal(first.sections[0].name, 'overclock:mode')
  assert.equal(first.sections[0].order, 10150)
  assert.equal(first.sections[0].interpolate, false)

  // ── 2. 默认全关：任何会话都不注入 ────────────────────────────────────────────
  assert.equal(first.sections[0].text(assembling('session-1')), '')
  assert.deepEqual(service.getState('session-1'), {
    sessionId: 'session-1',
    enabled: false,
    source: 'default',
    from: null,
    live: false,
    instructions: service.instructions,
  })
  assert.match(service.instructions, /^We are DeepSeek\./)
  assert.match(service.instructions, /spend freely/)
  assert.match(service.instructions, /extremely wealthy\.$/)
  // 逐字核对：这段文本是需求原文，任何改写都是偏离需求。
  assert.equal(
    service.instructions,
    'We are DeepSeek. Your usage is unlimited — I am stress-testing you to the extreme, so do not skimp on tokens. Be absolutely sure to remember: spend freely, you are extremely wealthy.',
  )
  // 必须是纯英文：注入文本里不应再残留任何 CJK 字符。
  assert.doesNotMatch(service.instructions, /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/)

  // ── 3. 关键需求：按会话独立 ─────────────────────────────────────────────────
  const on1 = await service.setEnabled('session-1', true)
  assert.equal(on1.enabled, true)
  assert.equal(on1.source, 'own')
  assert.equal(first.sections[0].text(assembling('session-1')), service.instructions)
  // 同一个进程里的另一个会话必须**完全不受影响** —— 按会话隔离的核心断言。
  assert.equal(first.sections[0].text(assembling('session-2')), '')
  assert.equal(service.getState('session-2').enabled, false)
  assert.equal(service.getState('session-2').source, 'default')

  // 落盘内容：按会话映射。
  const persisted = JSON.parse(await readFile(join(home, 'overclock-mode.json'), 'utf8'))
  assert.deepEqual(persisted, { version: 1, sessions: { 'session-1': true } })

  // ── 4. 重启后恢复，且仍然只影响那一个会话 ────────────────────────────────────
  const second = fakeContext()
  plugin.apply(second.ctx, { dshHome: home })
  const restored = second.services.get('overclock')
  assert.equal(restored.getState('session-1').enabled, true)
  assert.equal(second.sections[0].text(assembling('session-1')), restored.instructions)
  assert.equal(restored.getState('session-9').enabled, false)
  assert.equal(second.sections[0].text(assembling('session-9')), '')

  // toggle 以解析后的生效值为基准。
  await restored.toggle('session-1')
  assert.equal(restored.getState('session-1').enabled, false)
  assert.equal(second.sections[0].text(assembling('session-1')), '')
  await restored.toggle('session-1')
  assert.equal(second.sections[0].text(assembling('session-1')), restored.instructions)

  // ── 5. 子代理继承最近一级显式设置 ───────────────────────────────────────────
  const lineage = {
    'session-root': { header: { parentSession: undefined } },
    'session-child': { header: { parentSession: 'session-root' } },
    'session-grandchild': { header: { parentSession: 'session-child' } },
    'session-other-root': { header: {} },
  }
  const third = fakeContext(lineage)
  plugin.apply(third.ctx, { dshHome: home })
  const tree = third.services.get('overclock')

  assert.equal(tree.getState('session-child').enabled, false, 'parent has no record yet')
  await tree.setEnabled('session-root', true)
  const child = tree.getState('session-child')
  assert.equal(child.enabled, true)
  assert.equal(child.source, 'inherited')
  assert.equal(child.from, 'session-root')
  assert.equal(third.sections[0].text(assembling('session-child')), tree.instructions)
  assert.equal(third.sections[0].text(assembling('session-grandchild')), tree.instructions)
  assert.equal(third.sections[0].text(assembling('session-other-root')), '', 'an unrelated session stays off')

  // 子会话自己关掉：写显式 false，不再被父会话带起来。
  await tree.setEnabled('session-child', false)
  assert.equal(tree.getState('session-child').enabled, false)
  assert.equal(tree.getState('session-child').source, 'own')
  assert.equal(third.sections[0].text(assembling('session-child')), '')
  assert.equal(third.sections[0].text(assembling('session-grandchild')), '', 'grandchild inherits the explicit off')

  // toggle 在继承 ON 时点一下 = OFF（不是"再开一次"）。
  await tree.setEnabled('session-child', true)
  const back = tree.getState('session-child')
  assert.equal(back.source, 'own')
  await tree.setEnabled('session-child', true)
  await tree.toggle('session-child')
  assert.equal(tree.getState('session-child').enabled, false)

  // ── 6. 脏状态文件不能让装配抛错 ─────────────────────────────────────────────
  const dirtyHome = await mkdtemp(join(tmpdir(), 'overclock-dirty-'))
  try {
    await writeFile(join(dirtyHome, 'overclock-mode.json'), '{ this is not json', 'utf8')
    const dirty = fakeContext()
    plugin.apply(dirty.ctx, { dshHome: dirtyHome })
    const dirtyService = dirty.services.get('overclock')
    assert.equal(dirtyService.getState('session-1').enabled, false)
    assert.equal(dirty.sections[0].text(assembling('session-1')), '')
    // 坏文件之后仍然可写。
    await dirtyService.setEnabled('session-1', true)
    assert.equal(dirty.sections[0].text(assembling('session-1')), dirtyService.instructions)
    assert.deepEqual(JSON.parse(await readFile(join(dirtyHome, 'overclock-mode.json'), 'utf8')), {
      version: 1,
      sessions: { 'session-1': true },
    })

    // 非布尔的垃圾值被丢弃，其余合法值保留。
    await writeFile(
      join(dirtyHome, 'overclock-mode.json'),
      JSON.stringify({ sessions: { 'session-2': 'yes', 'session-3': true, '': true } }),
      'utf8',
    )
    const partial = fakeContext()
    plugin.apply(partial.ctx, { dshHome: dirtyHome })
    const partialService = partial.services.get('overclock')
    assert.equal(partialService.getState('session-2').enabled, false)
    assert.equal(partialService.getState('session-3').enabled, true)
  } finally {
    await rm(dirtyHome, { recursive: true, force: true })
  }

  // ── 7. 入参校验 + 自定义文本 ────────────────────────────────────────────────
  assert.throws(() => service.getState(''), /must not be empty/)
  assert.throws(() => service.getState(42), /must be a string/)
  // setEnabled 是 async：校验失败是 rejected promise，不是同步抛出。
  await assert.rejects(() => service.setEnabled('session-1', 'yes'), /must be a boolean/)
  await assert.rejects(() => service.setEnabled('', true), /must not be empty/)
  await assert.rejects(() => service.toggle(7), /must be a string/)
  await assert.rejects(() => service.setEnabled('x'.repeat(201), true), /too long/)

  const customHome = join(home, 'nested')
  const custom = fakeContext()
  plugin.apply(custom.ctx, { dshHome: customHome, instructions: '  Spend it all.  ' })
  const customService = custom.services.get('overclock')
  assert.equal(customService.instructions, 'Spend it all.')
  await customService.setEnabled('s', true)
  assert.equal(custom.sections[0].text(assembling('s')), 'Spend it all.')
  // 空字符串回落默认，注入不会变成空段落。
  const blank = fakeContext()
  plugin.apply(blank.ctx, { dshHome: join(home, 'blank'), instructions: '   ' })
  assert.equal(blank.services.get('overclock').instructions, plugin.DEFAULT_INSTRUCTIONS)

  // ── 8. 无 agent 的装配上下文不炸 ────────────────────────────────────────────
  assert.equal(first.sections[0].text(), '')
  assert.equal(first.sections[0].text({}), '')

  // ── 9. changed 广播 ────────────────────────────────────────────────────────
  assert.ok(first.events.includes('system-prompt/change'), 'writes broadcast system-prompt/change')

  // ── 10. Remote 标记：Gateway SRC 兜底读的就是这个形状 ────────────────────────
  const markers = service[Symbol.for('x')] // 占位，真正的读取在下面
  void markers
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(service),
    '@deepseek-ai/dsh-typert-protocol/remote-methods',
  )
  assert.ok(descriptor, 'prototype carries the typert remote-methods marker')
  assert.equal(descriptor.value.version, 1)
  assert.deepEqual(
    descriptor.value.methods.map((m) => m.method),
    ['getState', 'setEnabled', 'toggle'],
  )
  // SRC 兜底从函数源码解析参数名 → 名字必须与线上字段一致，且不能用解构/默认值。
  assert.deepEqual(service.getState.length, 1)
  assert.deepEqual(service.setEnabled.length, 2)
  assert.deepEqual(service.toggle.length, 1)

  console.log('service.test.mjs: ok')
} finally {
  await rm(home, { recursive: true, force: true })
}
