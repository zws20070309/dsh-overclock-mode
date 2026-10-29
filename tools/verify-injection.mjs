#!/usr/bin/env node
/**
 * 校验脚本：从**会话日志**里读出真正发给模型的系统提示词，确认超频模式的注入。
 *
 * 为什么必须读日志：问模型"你的系统提示词里有什么"是不可靠的。
 * 实测过三次同样的问题，其中一次模型明确答错（日志里有注入，它答没有），
 * 还编造了不存在的原文。日志里的 `system/message` 事件才是真实装配结果。
 *
 * 用法：
 *   node tools/verify-injection.mjs                 # 检查当前工作目录下最近的会话
 *   node tools/verify-injection.mjs <sessionId>     # 检查指定会话
 *   node tools/verify-injection.mjs --all           # 列出本目录所有会话的注入状态
 *
 * 退出码：0 = 有注入且为英文（或 --all 全部符合预期）；1 = 与预期不符。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** 会话日志按 cwd 分目录，目录名是 cwd 的转义形式。 */
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
/** zstd 帧魔数 0xFD2FB528，小端字节序。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 英文字样与中文字样，用来判定注入的语言。 */
const EN_MARK = 'stress-testing you to the extreme'
const ZH_MARK = '我们是deepseek'

/**
 * 解压整个 jsonl.zstd：日志是多帧追加写的，zstdDecompressSync 只吃第一帧，
 * 所以必须按魔数扫帧、逐帧解压再拼接。
 * @param file 日志文件路径。
 * @returns 换行分隔的 JSONL 文本。
 */
function decodeLog(file) {
  const buf = readFileSync(file)
  const parts = []
  let pos = 0
  while (pos < buf.length) {
    const start = buf.indexOf(ZSTD_MAGIC, pos)
    if (start < 0) break
    const next = buf.indexOf(ZSTD_MAGIC, start + 4)
    const end = next < 0 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // 单帧损坏就跳过：只要不是全部损坏，其余事件仍然可读。
    }
    pos = end
  }
  return parts.join('')
}

/**
 * 提取一次会话日志里最后一版真实装配出的系统提示词。
 * @param file 日志文件路径。
 * @returns {{parent: string|undefined, text: string} | undefined} 没有 system/message 时返回 undefined。
 */
function lastSystemPrompt(file) {
  const lines = decodeLog(file).split('\n').filter(Boolean)
  let parent
  let text
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'session') parent = event.parentSession
    if (event.type !== 'system/message') continue
    // system/message 可能多次出现（每步都可能重新装配），取最后一版。
    text = (event.data?.message?.content ?? []).map((block) => block.text ?? '').join('')
  }
  return text === undefined ? undefined : { parent, text }
}

/** 列出某个 cwd 目录下的会话 id，按日志修改时间倒序。 */
function sessionsIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((id) => ({ id, file: join(dir, id, 'session.v4.jsonl.zstd') }))
    .filter((entry) => existsSync(entry.file))
    .sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs)
}

/** 人类可读的判定结果。 */
function judge({ parent, text }) {
  const hasEn = text.includes(EN_MARK)
  const hasZh = text.includes(ZH_MARK)
  if (hasEn && hasZh) return { ok: false, verdict: '中英同时存在（旧模块未卸载）' }
  if (hasEn) return { ok: true, verdict: '英文注入（超频开启）' }
  if (hasZh) return { ok: false, verdict: '中文注入（仍是旧文本）' }
  return { ok: true, verdict: '无注入（超频关闭）' }
}

/** 打印注入段落及其上下文。 */
function showContext(text) {
  const index = text.includes(EN_MARK) ? text.indexOf('We are DeepSeek') : text.indexOf(ZH_MARK)
  if (index < 0) return
  const from = Math.max(0, index - 200)
  const to = Math.min(text.length, index + 260)
  console.log('  …' + JSON.stringify(text.slice(from, to)) + '…')
}

const args = process.argv.slice(2)
const all = args.includes('--all')
const cwd = process.cwd()
// 会话目录名 = cwd 去掉盘符冒号、把 \ 换成 -、非 ASCII 转 ~XXXX~ 的形式；
// 这里不去复刻转义规则，直接把 sessions 下所有子目录都扫一遍更可靠。
const candidates = existsSync(SESSIONS_ROOT)
  ? readdirSync(SESSIONS_ROOT).map((name) => join(SESSIONS_ROOT, name))
  : []

if (args.length > 0 && !all) {
  const wanted = args[0]
  const hits = []
  for (const dir of candidates) {
    const file = join(dir, wanted, 'session.v4.jsonl.zstd')
    if (existsSync(file)) hits.push(file)
  }
  if (hits.length === 0) {
    console.error('找不到会话日志：' + wanted)
    process.exit(1)
  }
  const result = lastSystemPrompt(hits[0])
  if (result === undefined) {
    console.log('该会话还没有产生 system/message（没跑过模型请求）')
    process.exit(1)
  }
  const verdict = judge(result)
  console.log(verdict.verdict)
  showContext(result.text)
  process.exit(verdict.ok ? 0 : 1)
}

// 默认：本目录最近一个会话；--all 列全部。
const lists = candidates.map((dir) => ({ dir, entries: sessionsIn(dir) })).filter((list) => list.entries.length > 0)
if (lists.length === 0) {
  console.error('没有找到任何会话日志：' + SESSIONS_ROOT)
  process.exit(1)
}

let failed = 0
for (const list of lists) {
  for (const entry of all ? list.entries : list.entries.slice(0, 1)) {
    const result = lastSystemPrompt(entry.file)
    if (result === undefined) continue
    const verdict = judge(result)
    if (!verdict.ok) failed += 1
    console.log((verdict.ok ? '✓ ' : '✗ ') + entry.id.slice(0, 24) + '  ' + verdict.verdict)
    if (all && result.text.includes(EN_MARK)) showContext(result.text)
  }
  if (!all) break
}
process.exit(failed === 0 ? 0 : 1)
