// 浏览器半：**超频模式**开关（per-session）。
//
// 挂载点：官方槽位 `conversation.input.left`（kind:list，scope:session）
//   声明处 dsh-client-ui-conversation/lib/client.js:19896，渲染处同文件 :19072
//   —— 位于「+ / 权限 / 计划」之后、模型选择器之前，是 composer 工具栏的左组。
//   该槽位 scope=session，标准 props 里有 `sessionId`，而 sessionId 正是本插件的状态主键。
//
// 开关造型：**昼夜切换**。开 = 太阳，关 = 月亮。
//   * 关态：深蓝夜空 + 星星闪烁 + 银色月盘（带环形山）
//   * 开态：晴空蓝 + 白云 + 暖阳（带外发光与缓慢旋转的内高光）+ 星星飞散消失
//   * 圆盘用一个 CSS 变量 --dsh-oc-x 同时驱动位移与光晕，二者不可能走岔
//   * 行程时长与缓动收敛到 --dsh-oc-move / --dsh-oc-ease 两个变量：
//     只有"看得见的位移占时长的比例"够大，动效才不会被看成"啪地跳过去"。
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
    /** 白昼的云。云全部落在轨道左半边 —— 圆盘滑到右端（太阳升起）后露出来的正是那片天。 */
    const CLOUD_COUNT = 3

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
/* 行程时长与缓动：圆盘 / 光晕 / 星星共用一套，改一处就整体变快变慢。
   上一版是 .6s + cubic-bezier(.56,1.35,.52,1)，实测（getAnimations 擦洗时间线）
   可见位移只覆盖时长的 45%：600ms 里 240ms 就走完了 86% 的行程，看着像"啪"地跳过去。
   现在 1.1s + "长中间段"缓动，可见位移覆盖 67% ≈ 730ms，是原来的 2.7 倍。
   这里不用带回弹的曲线：19px 行程下 4% 的过冲只有 0.8px，肉眼看不见，
   却要多花掉近一半的时长（52% 处就到终点了）去收尾 —— 正是上一版"看着没动"的成因。 */
--dsh-oc-move:1.1s;
--dsh-oc-ease:cubic-bezier(.4,.15,.35,1);
box-shadow:inset 0 1px 3px rgba(0,0,0,.5),inset 0 -1px 1px rgba(255,255,255,.07);
transition:box-shadow .5s ease}

/* 夜空底色 + 晴空覆盖层。两层叠着做透明度交叉淡入：
   浏览器无法在两个 linear-gradient 之间插值，单层 background 只会"啪"地跳。 */
.dsh-oc-sky{position:absolute;inset:0;border-radius:inherit;
background:linear-gradient(180deg,#0a0f1e 0%,#141d38 58%,#1e2a4c 100%)}
.dsh-oc-sky::after{content:'';position:absolute;inset:0;border-radius:inherit;
background:linear-gradient(180deg,#2f8fd8 0%,#63b8ee 55%,#a6dbf8 100%);
opacity:0;transition:opacity 1s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-sky::after{opacity:1}

/* 星星：只在夜里出现，开态时向上飞散并缩小 */
.dsh-oc-stars{position:absolute;inset:0;border-radius:inherit;opacity:1;
transition:opacity .8s ease,transform var(--dsh-oc-move) var(--dsh-oc-ease)}
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

/* ── 白云：只属于白昼 ───────────────────────────────────────────────────
   1. 位置全部落在轨道左半边。轨道只有 42px 宽，两个状态各占一半：
      月亮在左（x 3~20）时右半边才是天，太阳在右（x 22~39）时左半边才是天。
      所以"太阳左边的云"= 左半边的云，也只有这里放得下 —— 放到右半边会被太阳整块盖住。
   2. 云在夜里必须整体 opacity:0，不能指望月亮去挡：月亮只盖到 y 3~20，
      云的凸起会从月亮上边缘和右边冒出来，夜里飘着几朵白云就假了。
   3. 形状 = 一条扁圆底 + 两个圆凸起（::before/::after 用 background:inherit 继承底色）。
      百分比尺寸让三朵不同大小的云共用同一套比例。 */
.dsh-oc-clouds{position:absolute;inset:0;border-radius:inherit}
.dsh-oc-cloud{position:absolute;border-radius:3px;background:#fff;opacity:0;
transition:opacity .9s ease;
animation:dsh-oc-drift 14s ease-in-out infinite}
.dsh-oc-cloud::before,.dsh-oc-cloud::after{content:'';position:absolute;border-radius:50%;
background:inherit}
.dsh-oc-cloud::before{left:12%;bottom:48%;width:60%;height:145%}
.dsh-oc-cloud::after{left:52%;bottom:48%;width:38%;height:115%}
/* 三朵云各自错开，互不相邻：C1 左上、C2 右中、C3 左下。
   坐标不是拍脑袋定的：轨道是 42x23 的胶囊，左侧是个半径 11.5 的圆角，
   把云的整个剪影（圆角底座 ∪ 两个椭圆凸起）按 0.05px 网格扫一遍，
   离边界的最小余量是 1.75px（test/client.test.mjs 会重算这条）。
   最早那版 C1 放在 left:3,top:5，凸起顶端离边界只有 0.24px，
   渲染出来被 overflow:hidden 切掉一块，放大 16 倍才看得出来。 */
.dsh-oc-cloud:nth-child(1){left:4px;top:6.5px;width:9px;height:4px;animation-duration:14s}
.dsh-oc-cloud:nth-child(2){left:14px;top:9.5px;width:7px;height:3px;animation-duration:18s;animation-delay:-4s}
.dsh-oc-cloud:nth-child(3){left:4px;top:15px;width:9px;height:3px;animation-duration:11s;animation-delay:-7s}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-cloud{opacity:.94}
/* 由远及近：三朵错开淡入，云是"飘进来"的，不是一起"啪"地出现。
   transition-delay 写在开态规则里 → 只在淡入方向错开，淡出时一起走。
   延后到 .2s 起：天空交叉淡入还没把底色提亮时，半透明的白云压在深蓝上会是一团灰，
   等天亮了再让云浮出来才干净。 */
#dsh-overclock-toggle[data-state="on"] .dsh-oc-cloud:nth-child(1){transition-delay:.2s}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-cloud:nth-child(2){transition-delay:.32s}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-cloud:nth-child(3){transition-delay:.44s}
/* 极小的横向飘移（3px）。不能再大：云再往右就滑到太阳底下去了。 */
@keyframes dsh-oc-drift{0%,100%{transform:translateX(0)}50%{transform:translateX(3px)}}

/* 阳光外晕：与圆盘共用 --dsh-oc-x，理论上不可能错位 */
.dsh-oc-glow{position:absolute;left:${INSET}px;top:50%;width:${KNOB}px;height:${KNOB}px;
margin-top:${-KNOB / 2}px;border-radius:50%;
background:radial-gradient(circle,rgba(255,228,145,.95) 0%,rgba(255,196,64,.5) 42%,rgba(255,180,40,0) 72%);
opacity:0;transform:translateX(var(--dsh-oc-x));
transition:opacity .85s ease,transform var(--dsh-oc-move) var(--dsh-oc-ease)}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-glow{opacity:1}

/* 圆盘：关态月盘（银灰），开态暖阳（琥珀）。3D 质感靠"外投影 + 内侧暗边 + 内侧亮边"三层叠出来。 */
.dsh-oc-knob{position:absolute;left:${INSET}px;top:${INSET}px;width:${KNOB}px;height:${KNOB}px;
border-radius:50%;overflow:hidden;z-index:2;
background:linear-gradient(150deg,#f4f7fb 0%,#ccd3e0 52%,#a2acbf 100%);
box-shadow:0 1px 3px rgba(0,0,0,.5),inset -2px -3px 5px rgba(60,70,95,.35),
inset 2px 2px 4px rgba(255,255,255,.75);
transform:translateX(var(--dsh-oc-x));
transition:transform var(--dsh-oc-move) var(--dsh-oc-ease),background .9s ease,box-shadow .9s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob{
background:linear-gradient(150deg,#fff4c9 0%,#ffcc33 52%,#f29400 100%);
box-shadow:0 0 9px 1px rgba(255,190,60,.65),0 1px 3px rgba(0,0,0,.35),
inset -2px -3px 5px rgba(170,100,0,.35),inset 2px 2px 5px rgba(255,252,225,.9)}

/* 太阳内高光缓慢自转：让"开着"这件事有生命感，而不用定时器 */
.dsh-oc-knob::after{content:'';position:absolute;inset:-2px;border-radius:50%;
background:conic-gradient(from 0deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.75) 32deg,
rgba(255,255,255,0) 78deg,rgba(255,255,255,0) 360deg);
opacity:0;transition:opacity .6s ease}
#dsh-overclock-toggle[data-state="on"] .dsh-oc-knob::after{opacity:1;
animation:dsh-oc-sheen 3.4s linear infinite}
@keyframes dsh-oc-sheen{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}

/* 环形山：关态可见，开态淡出。用 .7s 让它们在前半程化掉，而不是"啪"地消失。 */
.dsh-oc-crater{position:absolute;border-radius:50%;background:rgba(118,130,152,.6);
box-shadow:inset 0 1px 1px rgba(40,50,70,.45);opacity:1;transition:opacity .7s ease}
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
/* 忙碌态：请求在飞时给圆盘套一圈向外扩散的"回声"。
   ⚠️ 这里**绝对不能**去动画圆盘本身的 transform —— 踩过，代价是"整个过渡消失"：
   真实点击时 React 会在同一次提交里同时置 data-busy 和 data-state，于是
   animation 和 transition 同时命中 .dsh-oc-knob 的 transform。
   CSS 级联里**动画压过过渡**（animation 属于 Cascade Origin 里更高的一档），
   动画的第一帧立刻把 translateX 写成终点值，过渡根本没有机会开始 ——
   表现就是"点一下太阳瞬移到右边，一点过渡都没有"。
   所以：会动的层单独一个元素（.dsh-oc-pulse 负责跟着圆盘走，它只做 transition），
   扩散动画放在它的 ::after 上（只做 transform/opacity，没人跟它抢）。
   （注意 CSS 模板字符串里不能出现反引号，注释也一样 —— 会提前把模板关掉。） */
.dsh-oc-pulse{position:absolute;left:${INSET}px;top:${INSET}px;width:${KNOB}px;height:${KNOB}px;
border-radius:50%;z-index:1;pointer-events:none;opacity:0;
transform:translateX(var(--dsh-oc-x));
transition:transform var(--dsh-oc-move) var(--dsh-oc-ease),opacity .3s ease}
.dsh-oc-pulse::after{content:'';position:absolute;inset:0;border-radius:50%;
box-shadow:0 0 0 1.5px currentColor;opacity:0}
#dsh-overclock-toggle[data-busy="1"] .dsh-oc-pulse{opacity:1}
#dsh-overclock-toggle[data-busy="1"] .dsh-oc-pulse::after{
animation:dsh-oc-pulse 1.1s ease-out infinite}
@keyframes dsh-oc-pulse{0%{transform:scale(1);opacity:.85}100%{transform:scale(2);opacity:0}}

/* 尊重"减少动态效果"：全部停掉，状态依然靠位置与配色可读 */
@media (prefers-reduced-motion:reduce){
.dsh-oc-track,.dsh-oc-sky::after,.dsh-oc-stars,.dsh-oc-star,.dsh-oc-clouds,.dsh-oc-cloud,
.dsh-oc-glow,.dsh-oc-pulse,.dsh-oc-pulse::after,.dsh-oc-knob,.dsh-oc-knob::after,.dsh-oc-crater{
transition:none !important;animation:none !important}}
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

    /** 白昼的云。位置交给 CSS 的 nth-child，标记里不塞内联几何。 */
    function clouds() {
      const out = []
      for (let i = 0; i < CLOUD_COUNT; i += 1) out.push(h('span', { key: 'cloud' + i, className: 'dsh-oc-cloud' }))
      return out
    }

    /** 昼夜场景：天空 / 星星 / 云 / 阳光 / 忙碌回声 / 日月。顺序即 z 序，圆盘最后画。 */
    function scene() {
      return h(
        'span',
        { className: 'dsh-oc-track', 'aria-hidden': 'true' },
        h('span', { className: 'dsh-oc-sky' }),
        h('span', { className: 'dsh-oc-stars' }, stars()),
        h('span', { className: 'dsh-oc-clouds' }, clouds()),
        h('span', { className: 'dsh-oc-glow' }),
        h('span', { className: 'dsh-oc-pulse' }),
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
