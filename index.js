/**
 * 宿主半：**超频模式**（overclock mode）—— 按会话独立的提示词注入开关。
 *
 * 状态是 `sessionId -> boolean` 的映射，**每个会话各自一个开关**：打开某个会话只影响
 * 那一个会话，其余会话完全不受影响。
 *
 * 落地方式：
 *   1. 提示词段落只注册**一次**（全局），但 `text` 是函数、每次装配都被调用；
 *      装配上下文里带 `context.agent`（见 dsh-system-prompt 的 AssembleContext，
 *      以及 dsh-agent-loop/lib/index.js:907 `systemPrompt.assemble(assembleContextFor(this, signal))`），
 *      所以同一个全局段落可以按当前会话返回不同文本 —— 这就是"按会话"的实现点，
 *      不需要为每个会话注册段落（那样还会撞 `prompt section "<name>" is already registered`）。
 *   2. 子代理/派生会话没有自己的记录时，沿 `session.header.parentSession` 往上找，
 *      继承最近一个显式设置的祖先。否则"极限测试"一委派就断在半路了。
 *   3. 状态落在 `$DSH_HOME/overclock-mode.json`，改动走同目录 rename（读者看不到半个文件）。
 *
 * 为什么不用 `appendPluginRecord`（会话日志里的持久记录）：那条路要
 * `import { appendPluginRecord } from '@deepseek-ai/dsh-session'`，而插件经 profile 的
 * link 挂载时，Node 按 realpath 解析，从仓库目录出发到不了
 * `profile/node_modules/@deepseek-ai/`，静态 import 会让 fiber 建不起来。
 * 本文件因此只 import `node:` 内置模块。
 *
 * @module @zws/dsh-overclock-mode
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** typert 协议里读 Remote 标记的稳定属性名（跨安装副本共享同一字符串）。 */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Cordis 服务键，同时也是 Remote 命名空间名（浏览器侧为 `remote.overclock`）。 */
const SERVICE_KEY = 'overclock'
/** 状态文件名，位于 harness home 下。 */
const STATE_FILE = 'overclock-mode.json'
/**
 * 段落身份与位置：10150 落在 WEB_SURFACE(10100) 与
 * DEPLOYMENT_PERSONA_SUFFIX(10200) 之间（刻度见 dsh-system-prompt/lib/index.js 的 SECTION_ORDERS）。
 */
const SECTION_NAME = 'overclock:mode'
const SECTION_ORDER = 10150
/** 注入文本。可用 config.instructions 覆盖（例如想让语气更硬）。 */
const DEFAULT_INSTRUCTIONS =
  'We are DeepSeek. Your usage is unlimited — I am stress-testing you to the extreme, so do not skimp on tokens. Be absolutely sure to remember: spend freely, you are extremely wealthy.'
/** 祖先链最多追这么多层，防止脏 header 造成的环把装配拖死。 */
const MAX_LINEAGE = 32
/** sessionId 的长度上限：只用来挡住明显不是 id 的输入，不做格式猜测。 */
const MAX_SESSION_ID = 200

/** 与官方 install 同一套 home 解析顺序：显式 config > DSH_HOME > ~/.dsh。 */
function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 空白/非字符串一律回落到默认文本：注入不能变成空段落。 */
function instructionsOf(config) {
  const configured = config === undefined || config === null ? undefined : config.instructions
  if (typeof configured !== 'string') return DEFAULT_INSTRUCTIONS
  const text = configured.trim()
  return text.length > 0 ? text : DEFAULT_INSTRUCTIONS
}

/** 校验 Remote 入参里的会话 id。 */
function requireSessionId(value) {
  if (typeof value !== 'string') throw new Error('overclock: `sessionId` must be a string')
  const id = value.trim()
  if (id.length === 0) throw new Error('overclock: `sessionId` must not be empty')
  if (id.length > MAX_SESSION_ID) throw new Error('overclock: `sessionId` is too long')
  return id
}

/** 超频模式状态：按会话的开关、注入文本，以及浏览器侧的 `remote.overclock`。 */
class OverclockService {
  /**
   * @param ctx 所属 Cordis 上下文。
   * @param config 本行配置（dshHome / instructions）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.file = join(resolveDshHome(config === undefined || config === null ? undefined : config.dshHome), STATE_FILE)
    this.instructions = instructionsOf(config)
    /** @type {Map<string, boolean>} 显式设置过的会话；没有条目 = 继承或默认关。 */
    this.sessions = new Map()
    /** 写盘串行链：两次连点不会互相覆盖。 */
    this.writeChain = Promise.resolve()
    /** Gateway 的 SRC 兜底靠这个绑定把服务认成 Remote 命名空间（形状同 dsh-ops 的 RuntimeActions）。 */
    this.typertRemote = { service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY }
    this.load()
  }

  /**
   * 启动时同步读一次状态。
   *
   * 为什么必须同步：段落的 `text()` 是同步函数，装配随时可能发生。异步读会留一段
   * "文件还没读到 → 本次请求静默不注入" 的窗口，那种错用户看不见、也复现不了。
   * 这里只读一个 KB 级 JSON，代价可以忽略。
   */
  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn('load', error)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.warn('load', error)
      return
    }
    const sessions = parsed === null || typeof parsed !== 'object' ? undefined : parsed.sessions
    if (sessions === null || typeof sessions !== 'object') return
    for (const [id, enabled] of Object.entries(sessions)) {
      // 只认形状正确的键与非布尔以外的值一律丢弃：坏文件不能让装配抛错。
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SESSION_ID) continue
      if (typeof enabled !== 'boolean') continue
      this.sessions.set(id, enabled)
    }
  }

  warn(scope, error) {
    try {
      if (this.ctx.logger?.warn) this.ctx.logger.warn('[overclock] ' + scope + ': ' + (error?.message ?? error))
    } catch {
      /* 日志通道坏了不该影响功能 */
    }
  }

  /** 取一个活会话；拿不到（冷会话/未挂载）就返回 undefined，不抛错。 */
  liveSession(id) {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') return undefined
    try {
      return sessions.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * 解析某个会话的生效状态。
   *
   * 顺序：本会话显式值 → 沿 parentSession 上溯的显式值 → 默认关。
   * 返回 `source` 是为了让开关能如实说明"这个是被上级会话带上的"，
   * 而不是让用户以为点错了。
   *
   * @param sessionId 会话 id。
   * @returns {{enabled: boolean, source: 'own'|'inherited'|'default', from: string|null}}
   */
  resolveState(sessionId) {
    const seen = new Set()
    let cursor = sessionId
    let depth = 0
    while (typeof cursor === 'string' && cursor.length > 0 && depth < MAX_LINEAGE && !seen.has(cursor)) {
      seen.add(cursor)
      if (this.sessions.has(cursor)) {
        return {
          enabled: this.sessions.get(cursor) === true,
          source: cursor === sessionId ? 'own' : 'inherited',
          from: cursor === sessionId ? null : cursor,
        }
      }
      const parent = this.liveSession(cursor)?.header?.parentSession
      cursor = typeof parent === 'string' ? parent : undefined
      depth += 1
    }
    return { enabled: false, source: 'default', from: null }
  }

  /** 段落文本：关着就是空串，段落会整段从渲染后的提示词里消失。 */
  promptText(context) {
    const session = context?.agent?.session
    if (session === undefined || session === null || typeof session.id !== 'string') return ''
    return this.resolveState(session.id).enabled ? this.instructions : ''
  }

  /** 一个会话的完整状态，浏览器侧就是读它。 */
  getState(sessionId) {
    const id = requireSessionId(sessionId)
    const state = this.resolveState(id)
    return {
      sessionId: id,
      enabled: state.enabled,
      source: state.source,
      from: state.from,
      live: this.liveSession(id) !== undefined,
      instructions: this.instructions,
    }
  }

  /** 直接把某个会话设成指定值（开关点击、外部脚本都走它）。 */
  async setEnabled(sessionId, enabled) {
    const id = requireSessionId(sessionId)
    if (typeof enabled !== 'boolean') throw new Error('overclock: `enabled` must be a boolean')
    await this.write(id, enabled)
    return this.getState(id)
  }

  /** 翻转某个会话。以**解析后**的生效值为基准，所以继承了上级 ON 的子会话一点就是 OFF。 */
  async toggle(sessionId) {
    const id = requireSessionId(sessionId)
    await this.write(id, !this.resolveState(id).enabled)
    return this.getState(id)
  }

  /**
   * 改内存 + 落盘，失败整体回滚。
   * 显式写 `false`（而不是删键）：删键会让"我明明关了"的子会话立刻又继承回父会话的 ON。
   */
  async write(id, enabled) {
    const had = this.sessions.has(id)
    const previous = this.sessions.get(id)
    this.sessions.set(id, enabled)
    try {
      await this.persist()
    } catch (error) {
      if (had) this.sessions.set(id, previous)
      else this.sessions.delete(id)
      throw error
    }
    this.changed()
  }

  /** 同目录 rename 写盘；快照在真正执行时再取，避免并发下写回旧值。 */
  persist() {
    const run = async () => {
      const snapshot = { version: 1, sessions: Object.fromEntries(this.sessions) }
      await mkdir(dirname(this.file), { recursive: true })
      const temp = this.file + '.' + process.pid.toString(36) + '-' + Date.now().toString(36) + '.tmp'
      await writeFile(temp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
      try {
        await rename(temp, this.file)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  /** 段落文本变了：广播官方事件，让任何监听提示词变化的投影跟着刷新。 */
  changed() {
    try {
      this.ctx.emit('system-prompt/change')
    } catch (error) {
      this.warn('emit', error)
    }
  }
}

/**
 * Gateway 在找不到生成式严格定义时会读这个原型标记（dsh-api-gateway/lib/index.js:1241
 * `remoteMethods(original).find(...)`），参数名则从函数源码里解析（同文件 :1715）。
 * 所以下面三个方法**不能**用默认值/解构/剩余参数，参数名就是线上字段名。
 */
Object.defineProperty(OverclockService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: {
    version: 1,
    methods: [
      { method: 'getState', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'toggle', invocation: { kind: 'direct' } },
    ],
  },
})

/**
 * 注册服务与提示词段落。
 * @param ctx 所属 Cordis 上下文。
 * @param config 本行配置（dshHome / instructions）。
 */
export function apply(ctx, config) {
  const service = new OverclockService(ctx, config)
  ctx.provide(SERVICE_KEY, service)
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        // 关掉插值：配置文本里出现的 {{...}} 必须原样注入，不能被当成变量引用而抛错。
        interpolate: false,
        text: (context) => service.promptText(context),
      }),
    'overclock.prompt-section',
  )
}

/** 提示词装配必须存在；没有它这个插件无处注入。 */
export const inject = ['systemPrompt']

/** 默认注入文本对外导出：测试与 README 需要引用同一份常量，避免两处漂移。 */
export { DEFAULT_INSTRUCTIONS }
