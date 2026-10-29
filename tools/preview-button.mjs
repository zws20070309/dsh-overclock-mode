#!/usr/bin/env node
/**
 * 用**真实的 client.js** 生成一张预览页，供人眼检查开关造型。
 *
 * 为什么不在测试里断言颜色了事：这次改动的全部内容就是视觉，"属性对"不等于"看着对"。
 * 这里走的是同一条代码路径 —— 真的调用 exports.apply()（于是真的注册字典、真的挂
 * Remote、真的从槽位注册里拿到组件），再用一个把 createElement 直接映射到 DOM 的
 * 极简 React 替身渲染出来；样式表也是 installStyles() 自己插进 head 的。
 *
 * 用真实浏览器打开生成的 HTML 才能看到渐变、conic-gradient、遮罩这些效果。
 *
 * 用法：node tools/preview-button.mjs [输出路径]
 * 默认输出到 <仓库根>/preview-button.html
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 预览里要展示的行程节点：0 → 100%。每一格都是真实过渡被定格在该时刻的结果。 */
const FRAMES = [0, 0.25, 0.5, 0.75, 1]

const page = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>超频模式 · 开关预览</title>
<style>
  body{margin:0;padding:28px 32px;background:#f6f7f9;color:#111318;
       font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  h1{font-size:16px;margin:0 0 4px}
  p.note{margin:0 0 20px;color:#6b7280;font-size:12px}
  h2{font-size:13px;margin:26px 0 10px;color:#374151;font-weight:600}
  .row{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap}
  .stage{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;
         display:flex;align-items:center;gap:14px}
  .stage.dark{background:#1b1d21;border-color:#2c2f35}
  .tag{font-size:11px;color:#9ca3af;letter-spacing:.04em}
  .zoomwrap{display:flex;gap:0;padding:26px 30px}
  /* scale() 不改变布局盒，所以每个放大件都要有自己的固定尺寸格子，
     否则 4 倍渲染出来的内容会压到下一个按钮上（我第一版就踩了，裁图全对不准）。 */
  .zoomcell{position:relative;flex:none;width:560px;height:132px}
  .zoomcell > .dsh-oc{position:absolute;left:0;top:50%;transform:translateY(-50%) scale(4);
                      transform-origin:left center}
  .zoomcap{position:absolute;left:0;bottom:0;font-size:11px;color:#9ca3af;letter-spacing:.04em}
  .frames{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
  /* 轨道 42x23 放大 4 倍 = 168x92；这一行隐去文字只看轨道，所以格子按 168x92 留。
     按钮的内边距与药丸底色也在这里去掉：缩放不改变布局盒，留着的内边距会让
     4 倍按钮比格子还宽、压到下一格上（第一版就是这样，裁出来的"帧"里混进了邻居的底）。 */
  .framecell{position:relative;flex:none;width:180px;height:112px;background:#fff;
             border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}
  .framecell > .dsh-oc{position:absolute;left:6px;top:8px;padding:0;gap:0;
                       transform:scale(4);transform-origin:left top;
                       background:none!important;box-shadow:none!important}
  .framecell .dsh-oc-text{display:none}
  .framecap{position:absolute;left:9px;bottom:5px;font-size:11px;color:#9ca3af;
            font-variant-numeric:tabular-nums}
  .err{color:#c00;white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace}
</style>
</head>
<body>
  <h1>超频模式 · 开关预览</h1>
  <p class="note">用真实的 client.js 渲染（同一个 apply()、同一份样式表）。第 3 行定格的是浏览器真的跑过一遍的过渡。</p>

  <h2>1 · 实际大小（浅底 / 深底）</h2>
  <div class="row">
    <div class="stage" id="nat-light"></div>
    <div class="stage dark" id="nat-dark"></div>
  </div>

  <h2>2 · 放大 4 倍（看天空、星星、环形山、日晕）</h2>
  <div class="stage zoomwrap">
    <div class="zoomcell" id="zoom-off"></div>
    <div class="zoomcell" id="zoom-on"></div>
  </div>

  <h2>3 · 真实过渡帧（0% → 100%，放大 4 倍只留轨道）</h2>
  <p class="note" style="margin:0 0 10px">不是手画的中间态：每格先把按钮以关态放进 DOM，再真的翻到开态，
  然后用 <code>Animation.currentTime</code> 把它自己那一批过渡对象定格在 t 时刻 ——
  天空、星星、云、光晕、圆盘读的就是浏览器当时算出来的值。<code>t</code> 是"当前时刻"，
  所以云、环山这些时长更短的过渡会先走完，正是真实观感。</p>
  <div class="frames" id="frames"></div>

  <h2>4 · 其余状态（继承 / 忙碌 / 错误 / 无会话）</h2>
  <div class="row" id="states"></div>

  <h2>5 · 动效证明：把太阳内高光停在不同相位</h2>
  <p class="note" style="margin:0 0 10px">同一份 ON 渲染，只改 animation-delay。高光位置若随相位移动，说明旋转动画确实在跑（不是一张静态图）。</p>
  <div class="row" id="sheen"></div>

<script>
var CLIENT_SRC = ${JSON.stringify(source)};
var FRAMES = ${JSON.stringify(FRAMES)};

(function () {
  function noop() {}
  var hookIndex = 0
  // 强制三个 hook 的值：0=phase 1=source 2=busy。预览靠它把各状态摆出来。
  var forced = { 0: 'off', 1: 'default', 2: false }

  // ── 极简 React 替身：createElement 直接产出 DOM，静态渲染一次就够 ─────────────
  function makeEl(type, props) {
    var el = document.createElement(type)
    var p = props || {}
    Object.keys(p).forEach(function (k) {
      var v = p[k]
      if (k === 'key') return
      if (k === 'className') { el.className = v; return }
      if (k === 'disabled') { if (v) el.setAttribute('disabled', ''); return }
      if (/^on[A-Z]/.test(k)) return              // 静态渲染不挂事件
      if (v === undefined || v === null || v === false) return
      el.setAttribute(k, String(v))
    })
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i])
    return el
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return
    if (Array.isArray(kid)) { for (var i = 0; i < kid.length; i++) append(el, kid[i]); return }
    el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid)
  }

  var React = {
    createElement: makeEl,
    useState: function (initial) {
      var i = hookIndex++
      return [Object.prototype.hasOwnProperty.call(forced, i) ? forced[i] : initial, noop]
    },
    useEffect: noop,
    useCallback: function (fn) { return fn },
    useRef: function (v) { return { current: v } },
  }

  // ── 跑真实的插件代码 ───────────────────────────────────────────────────────
  var registration = null
  window.__ModuleLoader__ = { load: function (r) { registration = r } }
  try {
    ;(0, eval)(CLIENT_SRC)
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', '<pre class="err">client.js 执行失败：' + e + '</pre>')
    return
  }

  var dict = null
  var registered = null
  var t = function (k) { return (dict && dict.zh[k]) || k }

  var moduleExports = registration.factory(function (spec) {
    if (spec === 'react') return React
    throw new Error('unexpected require: ' + spec)
  })

  var ctx = {
    effect: function (fn) { return fn() },
    get: function () { return { getState: noop, setEnabled: noop, toggle: noop } },
    locale: {
      register: function (ns, d) { dict = d; return noop },
      bind: function () { return t },
    },
    remote: { $mount: function () { return Promise.resolve() } },
    slots: {
      inject: function (owner, cb) { return cb() },
      register: function (options, component) { registered = component; return noop },
    },
  }

  moduleExports.apply(ctx).then(function () {
    if (!registered) {
      document.body.insertAdjacentHTML('beforeend', '<pre class="err">槽位没有注册组件</pre>')
      return
    }
    function render(phase) {
      hookIndex = 0
      forced = { 0: phase, 1: 'default', 2: false }
      return registered({ t: t, api: ctx.get, sessionId: 'session-preview' })
    }
    /** 需要非默认的 source / busy / 无 session 时走这个。 */
    function renderState(overrides) {
      hookIndex = 0
      forced = {
        0: overrides.phase ?? 'off',
        1: overrides.source ?? 'default',
        2: overrides.busy ?? false,
      }
      return registered({
        t: t,
        api: ctx.get,
        sessionId: overrides.noSession ? undefined : 'session-preview',
      })
    }
    function tag(text) {
      var s = document.createElement('span')
      s.className = 'tag'
      s.textContent = text
      return s
    }
    function put(host, node, text) { host.appendChild(node); if (text) host.appendChild(tag(text)) }

    // 1 · 实际大小
    var nl = document.getElementById('nat-light')
    put(nl, render('off'), 'OFF')
    put(nl, render('on'), 'ON')
    var nd = document.getElementById('nat-dark')
    put(nd, render('off'), 'OFF')
    put(nd, render('on'), 'ON')

    // 2 · 放大。caption 单独绝对定位，不参与按钮的布局盒。
    function zoomInto(hostId, phase, text) {
      var host = document.getElementById(hostId)
      host.appendChild(render(phase))
      var cap = document.createElement('span')
      cap.className = 'zoomcap'
      cap.textContent = text
      host.appendChild(cap)
    }
    zoomInto('zoom-off', 'off', 'OFF · 月亮')
    zoomInto('zoom-on', 'on', 'ON · 太阳')

    // 3 · 真实过渡帧：让浏览器真的跑一次 off→on，再用 Animation.currentTime 定格。
    //     关键顺序：先以关态入 DOM → 强制一次布局 → 翻状态 → 再强制一次布局，
    //     否则"插入即改状态"会被合并进同一次样式计算，过渡根本不会建立。
    var host = document.getElementById('frames')
    var longest = 0
    var probed = []
    FRAMES.forEach(function (p) {
      var cell = document.createElement('div')
      cell.className = 'framecell'
      var btn = render('off')
      cell.appendChild(btn)
      host.appendChild(cell)

      void btn.offsetWidth
      btn.setAttribute('data-state', 'on')
      void btn.offsetWidth

      var anims = btn.getAnimations ? btn.getAnimations({ subtree: true }) : []
      anims.forEach(function (a) {
        try { a.pause() } catch (e) { return }
        var timing = a.effect.getTiming()
        if (a.transitionProperty !== undefined) longest = Math.max(longest, timing.duration)
      })
      // 用统一时刻（最长那条过渡的比例）定格，才是"同一瞬间"的真实截面。
      var at = Math.round(longest * p)
      anims.forEach(function (a) {
        try {
          if (a.transitionProperty !== undefined) a.currentTime = at
          else a.currentTime = 1200            // 关键帧动画（闪烁/自转/飘移）也固定相位，预览才可复现
        } catch (e) {}
      })
      if (p === 0) {
        probed = anims
          .filter(function (a) { return a.transitionProperty !== undefined })
          .map(function (a) { return a.transitionProperty })
      }

      var cap = document.createElement('span')
      cap.className = 'framecap'
      cap.textContent = Math.round(p * 100) + '% · t=' + at + 'ms'
      cell.appendChild(cap)
    })

    // 过渡对象数量自检：为 0 就说明这一行什么都没验证到，必须在页面上说出来。
    if (probed.length === 0) {
      document.body.insertAdjacentHTML('beforeend',
        '<pre class="err">第 3 行没有拿到任何过渡对象：off→on 没有建立过渡，这一行是无效的。</pre>')
    } else {
      document.body.insertAdjacentHTML('beforeend',
        '<p class="note">第 3 行实际定格到的过渡对象：' + probed.length + ' 条 — ' +
        probed.join(', ') + '（最长 ' + Math.round(longest) + 'ms）</p>')
    }

    document.title = '预览就绪'

    // 4 · 其余状态：继承态靠虚线描边区别于"亲自设的"，必须确认它没被新造型吃掉。
    var states = document.getElementById('states')
    ;[
      { phase: 'off', source: 'inherited', cap: '继承 · 关' },
      { phase: 'on', source: 'inherited', cap: '继承 · 开' },
      { phase: 'on', busy: true, cap: '忙碌' },
      { phase: 'error', cap: '错误' },
      { phase: 'off', noSession: true, cap: '无会话（禁用）' },
    ].forEach(function (spec) {
      var stage = document.createElement('div')
      stage.className = 'stage'
      stage.appendChild(renderState(spec))
      stage.appendChild(tag(spec.cap))
      states.appendChild(stage)
    })

    // 5 · 动效证明：用负的 animation-delay 把同一个旋转动画定格在不同相位。
    // 覆盖规则写在插件样式表之后，只作用于这一行，不碰生产 CSS。
    var sheenCss = document.createElement('style')
    sheenCss.textContent = [0, 0.85, 1.7, 2.55].map(function (s, i) {
      return '.sheenph' + i + ' .dsh-oc-knob::after{animation-delay:-' + s + 's!important}'
    }).join('')
    document.head.appendChild(sheenCss)

    var sheen = document.getElementById('sheen')
    ;[0, 0.85, 1.7, 2.55].forEach(function (sec, i) {
      var stage = document.createElement('div')
      stage.className = 'stage'
      var btn = render('on')
      btn.classList.add('sheenph' + i)
      stage.appendChild(btn)
      stage.appendChild(tag('delay -' + sec + 's'))
      sheen.appendChild(stage)
    })
  })
})()
</script>
</body>
</html>
`

const out = process.argv[2] ?? join(root, 'preview-button.html')
writeFileSync(out, page, 'utf8')
console.log(out)
