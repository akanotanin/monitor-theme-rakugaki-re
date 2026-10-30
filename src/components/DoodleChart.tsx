import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { ChartTooltip } from "@/components/ChartTooltip"
import { clockFor, innerTicks, quarters, timeTicks, zoomSpan } from "@/lib/format"
import { wobblePoints } from "@/lib/sketch"

/**
 * 零依赖的时间序列图（手绘版）：坐标轴 + 网格 + 几条折线/面积 + 一枚悬停 tooltip。
 * 几何口径与上一枚主题的自绘图表一致（那套经受过一整轮线上验收，别重新发明）：
 *   · Y 轴从 0 起、刻度就是 `quarters(top)`（top 由 `axisTop` 定，所以四格是整数）；
 *   · X 轴是**真时间轴**（`timeTicks` 给的显式刻度），不是按序号排的类别轴 ——
 *     否则 agent 掉线那段时间会被压成 0 宽，看着像什么都没发生；
 *   · 断点照断：某个采样是 null（那一段没数据）就断开重起一笔，不连桥；
 *   · 悬停时画一条竖线 + 那枚自绘 tooltip。
 *
 * 手绘化的三处（与几何无关、只动外观）：
 *   ① 每条线（与它的面积、区间）先用 @/lib/sketch 的确定性抖动过一遍 ——
 *      一条笔直的数据线看着是机器画的，微微起伏才像笔画的。点数很密时
 *      （横屏一整天的分钟桶）抖动幅度收小，否则会糊成毛边；
 *   ② 网格是稀疏的短虚线、刻度字用 Shantell Sans（手写体）；
 *   ③ 悬停竖线也是虚线（像用尺子比着划的那一道）。
 *
 * 交互（2026-10-30 与 rakugaki 同口径）：给了 `wheelZoom` 的那张图（整页详情的延迟图）
 * 能用**滚轮收放纵向范围**（锚点钉在光标压着的那个值上）、**按住左键拖着线上下平移**、
 * **双击复位**，右上角另有一枚「重置」。原来那套「横向拖选一段放大」下线 —— 延迟图的
 * 时间窗口归页签上方那排量程 chip 管，图内只调纵向。
 */
export type ChartSeries = {
  key: string
  name: string
  color: string
  /** 面积图：线下面填一层同色淡色；折线图不填。 */
  area?: boolean
  /** 区间（band）：这一列的值是 `[低, 高]`，画成两条边之间的一块淡色。 */
  band?: boolean
  dash?: string
}

export type ChartRow = { ts: number } & Record<string, number | [number, number] | null | undefined>

/** 左边留给 Y 轴刻度的宽度。 */
const LEFT = 68
const RIGHT = 8
const TOP = 6
const BOTTOM = 24
/** 刻度字号。 */
const FONT = 11.5
/** 11px 下大约的字符宽，用来判两个 X 刻度标签会不会撞上。 */
const CHAR = 6.4

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** 取值域（band 那一列是 [低, 高]，两条边都要算进去）。 */
function extentOf(view: ChartRow[], keys: string[]): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const row of view) {
    for (const key of keys) {
      const v = row[key]
      const pair = Array.isArray(v) ? v : [v]
      for (const one of pair) {
        const n = num(one)
        if (n === null) continue
        if (n < lo) lo = n
        if (n > hi) hi = n
      }
    }
  }
  return lo === Infinity ? null : [lo, hi]
}

/**
 * 自动刻度的整齐步长：把量程摊成 count 格，每格取「1 / 2 / 2.5 / 5 / 10 × 10^k」里第一个够大的，
 * 再把上下沿各向外扩到步长的整数倍（延迟轴不从 0 起：这些线路活在一条窄带里，锚到 0 会把起伏压平）。
 */
function niceScale(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (!(hi > lo)) {
    const pad = Math.abs(hi) > 1 ? Math.abs(hi) * 0.1 : 1
    lo -= pad
    hi += pad
  }
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, Number.MIN_VALUE)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((n) => n >= raw) ?? raw
  const low = Math.floor(lo / step) * step
  const high = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = low; v <= high + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { lo: low, hi: high, ticks }
}

/**
 * 自动量程的「最近视距」：Y 轴跨度至少摊开顶端值的这个比例，再窄的波动不再往里怼。
 * 延迟活在几十~几百 ms 的窄带里，自动量程若贴着数据自身量程缩放，130ms 上下只抖 8ms
 * 的线会被画成满屏地震波；给量程加个下限，这种病态放大就停了，而本来就抖开了的线路
 * （跨度超过下限）一点不受影响。与「不从 0 起」是同一取舍的两头：不贴 0、也不无限放大。
 * 卡片走势线（Latency.tsx）共用这一个数。
 */
export const AUTO_MIN_SPAN_RATIO = 0.25

/** 滚轮缩放的跨度下限（单位跟图表走；当前只有延迟图开，= 1ms）：再近就没信息了。 */
const ZOOM_MIN_SPAN = 1
/** 滚轮缩放的顶端封顶：1000 与「数据顶端 × 2」取大——爆表值（超时 3000ms 之类）也留得下余地。 */
const zoomCapOf = (dataHi: number) => Math.max(1000, dataHi * 2)

export function TimeChart({
  rows,
  series,
  hours,
  top = 0,
  unit = "",
  format,
  yFormat,
  label,
  domain = "zero",
  left = LEFT,
  wheelZoom,
  renderTooltip,
}: {
  rows: ChartRow[]
  series: ChartSeries[]
  /** 窗口宽度，决定 X 轴标签的粒度（`clockFor`）。 */
  hours: number
  /** `domain="zero"` 时的 Y 轴顶端；刻度是它的四等分。 */
  top?: number
  /** 拼在 Y 轴刻度后面的单位（`%` / `/s` / `ms`），空字符串就不拼。 */
  unit?: string
  /** 悬停 tooltip 里那个值怎么印（用自绘 tooltip 时可以不传）。 */
  format?: (value: number) => string
  /** Y 轴刻度怎么印，默认按刻度步长定小数位。 */
  yFormat?: (value: number) => string
  /** 给读屏用的一句话（这张图画的是什么）。 */
  label?: string
  /** `zero`：Y 轴从 0 起；`auto`：按数据自身量程取整齐刻度、且至少摊开 `AUTO_MIN_SPAN_RATIO` 那么宽（延迟轴用——锚 0 会压平起伏、贴着数据缩放又会放大几 ms 的抖动，两头各一道护栏）。 */
  domain?: "zero" | "auto"
  /** 左边留给 Y 轴刻度的宽度。 */
  left?: number
  /**
   * 给了它（且 `domain="auto"`）就能**用滚轮调整 Y 轴（纵向）范围**：以光标压着的那个
   * 值为锚点收放（缩放后那个值还钉在同一行像素上）、按住左键拖着线上下平移、双击图表复位；
   * 夹子两道——跨度最小 `ZOOM_MIN_SPAN`（1ms）、顶端最高 `zoomCapOf(数据顶端)`。
   * 监听是**非 passive** 的：光标在图上时滚轮归这张图，页面不跟着滚（页面别处照常滚）。
   * 当前只有整页详情的延迟图开（清单里就地展开的那张不开——列表里滚轮要留给翻列表）。
   */
  wheelZoom?: boolean
  /** 自定义悬停内容（延迟图用它接 `PingTooltip`）。 */
  renderTooltip?: (row: ChartRow) => React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [tipH, setTipH] = useState(0)
  // 拖着线平移的基准：按下那一刻的指针 y 与量程（整段拖动都按它算，不跟着每次移动累加）。
  const panRef = useRef<{ y0: number; lo: number; hi: number; moved: boolean } | null>(null)
  // 滚轮缩放出来的手动 Y 范围（null = 自动量程）。
  const [yZoom, setYZoom] = useState<{ lo: number; hi: number } | null>(null)
  // clipPath 的 id：每张图一个（详情页里五张图会同页共存），`useId` 的冒号等字符剔掉。
  const cid = useId().replace(/[^a-zA-Z0-9_-]/g, "")

  // 换量程（`hours`）＝整页重新取数：纵向缩放跟它一起回自动（横向由页签上那排 chip 管）。
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- 换量程时把上一档的手动量程复位，与取数语义同步
    setYZoom(null)
  }, [hours])

  useLayoutEffect(() => {
    const h = tip.current?.offsetHeight ?? 0
    if (h && h !== tipH) setTipH(h)
  }, [hover, tipH])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  const view = rows

  const w = size.w
  const h = size.h
  const plotW = Math.max(1, w - left - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)

  // 刻度：零起点用 quarters(top)；自动档拿数据量程取整齐步长，但量程至少摊开
  // AUTO_MIN_SPAN_RATIO 那么宽（「最近视距」，见常量注释）——窄波动不再被怼满全高。
  const autoExtent = extentOf(view, series.map((s) => s.key))
  const autoScale =
    domain === "auto"
      ? (() => {
          const [lo, hi] = autoExtent ?? [0, 1]
          const minSpan = Math.max(hi, 1) * AUTO_MIN_SPAN_RATIO
          if (hi - lo >= minSpan) return niceScale(lo, hi)
          const mid = (lo + hi) / 2
          return niceScale(mid - minSpan / 2, mid + minSpan / 2)
        })()
      : { lo: 0, hi: top > 0 ? top : 1, ticks: quarters(top) }
  // 手动档（滚轮缩放）：边界就是滚出来的精确值、刻度只挑范围内的整齐数（见 innerTicks）——
  // 自动档那套「向外扩到整步长」会把锚点随每次滚动蹭走，滚轮手感靠的就是锚点不漂。
  const scale = yZoom ? { lo: yZoom.lo, hi: yZoom.hi, ticks: innerTicks(yZoom.lo, yZoom.hi) } : autoScale
  const yRange = Math.max(1e-9, scale.hi - scale.lo)

  const x = (ts: number) => left + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - ((value - scale.lo) / yRange) * plotH

  // 滚轮监听器只装一次，量程与几何从 ref 里现读（渲染期间写 ref 是「最新值」的标准做法，
  // 放 layout effect 里保证每次渲染后都对齐）。
  const wheelRef = useRef({ lo: 0, hi: 0, plotH: 0, dataLo: 0, dataHi: 0 })
  useLayoutEffect(() => {
    wheelRef.current = { lo: scale.lo, hi: scale.hi, plotH, dataLo: autoExtent?.[0] ?? 0, dataHi: autoExtent?.[1] ?? 0 }
  })
  // 滚轮缩放（`wheelZoom` 且 domain=auto）：非 passive（要 preventDefault 住页面滚动），
  // 光标压着的那个值当锚点收放；夹子两道（跨度 ≥ ZOOM_MIN_SPAN、顶端 ≤ zoomCapOf）。
  useEffect(() => {
    const el = box.current
    if (!el || !wheelZoom || domain !== "auto") return
    const onWheel = (e: WheelEvent) => {
      const st = wheelRef.current
      if (st.plotH <= 0) return
      e.preventDefault()
      // deltaMode：0=像素（绝大多数）、1=行、2=页；先归一到「像素」口径。
      let d = e.deltaY
      if (e.deltaMode === 1) d *= 16
      else if (e.deltaMode === 2) d *= 100
      // 单次事件封顶 ±240：每 100 个滚动单位收放约 14%（e^±0.15），一格滚轮（±100/±120）
      // 的观感正好，触控板的小步长也顺；猛甩一下最多按 1.43× 走，不会一步飞天。
      d = Math.max(-240, Math.min(240, d))
      const f = Math.exp(d * 0.0015)
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(Math.max((e.clientY - rect.top - TOP) / st.plotH, 0), 1)
      // 锚点 = 光标当前压着的那个值。缩放后它还钉在同一行像素上——滚轮「手感」的全部就是这一条。
      const anchor = st.hi - ratio * (st.hi - st.lo)
      // 跨度下限：min(1ms, 自动量程的 1/4)。亚毫秒线路的自动量程本来就窄于 1ms，固定 1ms 会把
      // 第一格滚轮变成「放大 + 锚点跳走」、下沿贴 0 时更会双向卡死（量程数学与三道夹子都挪进
      // format.ts 的 zoomSpan，配了单测）。
      const floor = Math.min(ZOOM_MIN_SPAN, Math.max((st.dataHi - st.dataLo) * 0.25, 1e-9))
      setYZoom(zoomSpan({ lo: st.lo, hi: st.hi, anchor, ratio, factor: f, floor, cap: zoomCapOf(st.dataHi) }))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [wheelZoom, domain])

  // 默认刻度印法：小数位**跟着刻度步长走**（步长 0.25 就印两位）—— 一位小数会把 0.25 印成
  // 「0.3」，网格线画在真值上、标签却对不上。
  const yDigits = (() => {
    const t = scale.ticks
    if (t.length < 2) return 1
    const stepV = Math.abs(t[1] - t[0])
    for (let d = 0; d <= 3; d++) if (Math.abs(Math.round(stepV * 10 ** d) / 10 ** d - stepV) < stepV * 1e-9) return d
    return 3
  })()
  const yLabel = yFormat ?? ((value: number) => String(Math.round(value * 10 ** yDigits) / 10 ** yDigits))
  const xTicks = view.length > 1 ? timeTicks(t0, t1).filter((t) => t >= t0 && t <= t1) : []
  const clock = clockFor(hours)
  // 撞在一起的刻度标签直接丢掉：按 11px 的近似字宽排一遍，与前一个标签的右沿重叠就不画。
  const keptX: number[] = []
  let edge = -Infinity
  for (const t of xTicks) {
    const half = (clock(t).length * CHAR) / 2
    const cx = x(t)
    if (cx - half < edge + 6) continue
    keptX.push(t)
    edge = cx + half
  }

  // 抖动幅度按每条曲线自己的点距收；点很密时（横屏一整天的分钟桶）另加一点**低频漂移**
  // ——手画的线不会那么直，纯白噪声又只会把线糊成毛边。
  const gapPx = plotW / Math.max(1, view.length - 1)
  const amp = Math.max(0.18, Math.min(0.9, gapPx * 0.5))
  const drift = view.length > 260 ? 0.9 : 0
  const sketch = (run: Array<[number, number]>, seed: number): Array<[number, number]> => {
    const pts = wobblePoints(run, seed, amp)
    return drift
      ? pts.map(([px, py], k) => [px, py + Math.sin(k * 0.16 + seed) * drift] as [number, number])
      : pts
  }

  /** 一条曲线：null 断开重起一笔（不连桥），每一段抖过一遍。 */
  const runsOf = (pick: (row: ChartRow) => number | null): Array<Array<[number, number]>> => {
    const runs: Array<Array<[number, number]>> = []
    let run: Array<[number, number]> = []
    for (const row of view) {
      const v = pick(row)
      if (v === null) {
        if (run.length) runs.push(run)
        run = []
        continue
      }
      run.push([x(row.ts), y(v)])
    }
    if (run.length) runs.push(run)
    return runs
  }

  const pathOf = (runs: Array<Array<[number, number]>>, seed: number) =>
    runs
      .map((run, i) => {
        const pts = run.length > 2 ? sketch(run, seed + i * 37) : run
        return pts.map(([px, py], k) => `${k === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join("")
      })
      .join(" ")

  /** 面积：每一段连续的点各自闭合成一块（同样不跨断点）。 */
  const areaOf = (s: ChartSeries, seed: number) =>
    runsOf((row) => num(row[s.key]))
      .map((run, i) => {
        if (run.length < 2) return ""
        const pts = run.length > 2 ? sketch(run, seed + i * 37) : run
        const base = TOP + plotH
        return (
          `M${pts[0][0].toFixed(1)},${base.toFixed(1)}` +
          pts.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join("") +
          `L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)}Z`
        )
      })
      .join(" ")

  /** 区间（band）：上沿去、下沿回的一块；同样不跨断点、同种子抖动。 */
  const bandOf = (s: ChartSeries, seed: number) => {
    type BandRun = Array<[number, number, number]>
    const runs: BandRun[] = []
    let run: BandRun = []
    for (const row of view) {
      const pair = row[s.key]
      const lo = num(Array.isArray(pair) ? pair[0] : null)
      const hi = num(Array.isArray(pair) ? pair[1] : null)
      if (lo === null || hi === null) {
        if (run.length) runs.push(run)
        run = []
        continue
      }
      run.push([x(row.ts), y(hi), y(lo)])
    }
    if (run.length) runs.push(run)
    return runs
      .map((seg, i) => {
        if (seg.length < 2) return ""
        const up = sketch(seg.map(([px, py]) => [px, py] as [number, number]), seed + i * 37)
        const down = sketch(seg.map(([px, , py]) => [px, py] as [number, number]), seed + i * 37)
        return (
          `M${up.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}` +
          `L${down.reverse().map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join("L")}Z`
        )
      })
      .join(" ")
  }

  const indexAt = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.min(view.length - 1, Math.max(0, Math.round(ratio * (view.length - 1))))
  }

  const hovered = hover === null ? null : view[Math.min(Math.max(hover, 0), view.length - 1)]
  const payload = hovered
    ? series.map((s) => ({
        dataKey: s.key,
        name: s.name,
        color: s.color,
        value: num(Array.isArray(hovered[s.key]) ? null : hovered[s.key]),
        payload: hovered as unknown as Record<string, unknown>,
      }))
    : []
  const zoomed = yZoom !== null

  return (
    // `data-chart`：给护栏一个稳定锚点（改版后按类名找的判据会静默变成 0）。
    /* `select-none`：拖动平移时浏览器会顺手起一个选区、把扫过的文字（右上那枚「重置」）划成
       黄底。图表这一块没有可选的正文，整块关掉最省事。 */
    <div ref={box} data-chart="" className="relative h-full w-full select-none">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
          {/* 绘图区的裁剪框：滚轮把量程缩窄后，超出范围的值不再画到轴外去（留一点溢出到
              tooltip / 刻度那一圈才要 `overflow-visible`，曲线本身必须夹在框里）。自动档
              本来就装得下，有它也不变样。折线 / 面积 / 区间三块共用这一条。 */}
          <defs>
            <clipPath id={cid}>
              <rect x={left} y={TOP} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          {/* 网格：只画横线，短虚线（像用尺子比着点的）。 */}
          {scale.ticks.map((v) => (
            <line
              key={`g${v}`}
              x1={left}
              x2={left + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line-weak)"
              strokeDasharray="2 5"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          {/* Y 轴刻度（手写体）。纵向夹在绘图区里：滚轮缩到很窄时，最上/最下那枚标签
              不再被顶到图外去（自动档本来就在框内，这一夹对它没有影响）。 */}
          {scale.ticks.map((v) => (
            <text
              key={`y${v}`}
              x={left - 6}
              y={Math.min(Math.max(y(v), TOP + 8), TOP + plotH - 8)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={FONT}
              fill="var(--ink-3)"
              style={{ fontFamily: "var(--family-hand)" }}
            >
              {`${yLabel(v)}${unit}`}
            </text>
          ))}
          {/* X 轴刻度。 */}
          {keptX.map((t) => (
            <text
              key={`x${t}`}
              x={x(t)}
              y={TOP + plotH + 14}
              textAnchor="middle"
              fontSize={FONT}
              fill="var(--ink-3)"
              style={{ fontFamily: "var(--family-hand)" }}
            >
              {clock(t)}
            </text>
          ))}
          <g clipPath={`url(#${cid})`}>
          {series.map((s, si) =>
            s.band ? (
              <path key={`b${s.key}`} d={bandOf(s, 500 + si * 11)} fill={s.color} fillOpacity={0.15} stroke="none" />
            ) : null,
          )}
          {series.map((s, si) =>
            s.area ? (
              <path key={`a${s.key}`} d={areaOf(s, 300 + si * 11)} fill={s.color} fillOpacity={0.13} stroke="none" />
            ) : null,
          )}
          {/* 线：band 那一列没有线（它的值是 [低, 高]，画成一块区间）。
              每条线画两笔：先一枚错位 +0.9,+0.8 的淡笔影（二次描边的感觉），
              再画正笔 —— 一笔写下去的线不会有那么准。 */}
          {series.filter((s) => !s.band).map((s, si) => {
            const d = pathOf(runsOf((row) => num(row[s.key])), 100 + si * 11)
            return (
              <g key={`l${s.key}`}>
                <path
                  d={d}
                  transform="translate(0.9 0.8)"
                  fill="none"
                  stroke={s.color}
                  strokeOpacity={0.3}
                  strokeWidth={1.6}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2.25}
                  strokeDasharray={s.dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            )
          })}
          </g>
          {/* 悬停竖线。 */}
          {hovered && (
            <line
              x1={x(hovered.ts)}
              x2={x(hovered.ts)}
              y1={TOP}
              y2={TOP + plotH}
              stroke="var(--line-strong)"
              strokeDasharray="3 4"
              strokeWidth={1.2}
            />
          )}
          {/* 命中层：整块绘图区接指针，按 x 找最近的那个点；`wheelZoom` 那档还能拖着线上下平移。 */}
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            // `pan-y`：手机上竖着划仍然滚页面（平移是鼠标手势，触屏不抢）。
            style={{ touchAction: "pan-y" }}
            onMouseMove={(e) => {
              if (view.length === 0) return
              setHover(indexAt(e.clientX, e.currentTarget))
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              setPointerY(Math.min(Math.max(e.clientY - rect.top, 0), rect.height))
            }}
            onMouseLeave={() => {
              setHover(null)
              setPointerY(null)
            }}
            onPointerDown={(e) => {
              if (!wheelZoom || e.button !== 0 || plotH <= 0) return
              // 捕获失败不该让整段拖动失效（指针已经消失、或合成事件没有有效 id 时会抛）。
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 无所谓 */ }
              // 基准取**当前显示中的**量程：没缩过就是自动档那一段（照样能拖，拖完即手动档）。
              panRef.current = { y0: e.clientY, lo: scale.lo, hi: scale.hi, moved: false }
            }}
            onPointerMove={(e) => {
              const st = panRef.current
              if (!st) return
              // 没按住左键却还挂在拖动里（捕获失败 + 松手落在图外那条路径）就当场清掉。
              if ((e.buttons & 1) === 0) { panRef.current = null; return }
              const dy = e.clientY - st.y0
              // 3px 死区：只是点一下不该把量程挪走。
              if (!st.moved && Math.abs(dy) < 3) return
              st.moved = true
              const spanY = st.hi - st.lo
              // 1px = span/plotH：像素位移原样换算成值位移 —— 线就钉在光标上跟着走。
              let shift = (dy / plotH) * spanY
              // 整段一起停（夹的是**位移**，不是各自收边）：下沿不越 0、顶端不越封顶。
              const cap = Math.max(zoomCapOf(autoExtent?.[1] ?? 0), st.hi)
              shift = Math.min(Math.max(shift, -st.lo), cap - st.hi)
              setYZoom({ lo: st.lo + shift, hi: st.hi + shift })
            }}
            onPointerCancel={() => {
              // ★触屏竖划时浏览器接管手势、对这层派发的是 pointercancel（不会再有 pointerup）：
              //   这里顺手把平移状态也清掉。
              panRef.current = null
            }}
            onPointerUp={() => {
              panRef.current = null
            }}
            onDoubleClick={() => {
              // 双击 = 复位：量程回到自动档，与那枚「重置」按钮同效。
              setYZoom(null)
            }}
          />
        </svg>
      )}
      {/* 缩放着的时候给一枚重置（滚轮纵缩 + 拖线平移都归位，双击图表同效）。
          ★不能把 `absolute` 直接挂在按钮上：`.tap { position: relative }` 是**未分层** CSS，
          按级联层规则它压过分层的工具类 —— 按钮会掉进正常流、跑到图下面去（实测：跑成了
          左下角一枚被裁掉半截的小纸片）。所以位置交给外面这层 span。 */}
      {zoomed && (
        <span className="absolute top-0 right-1">
          <button
            type="button"
            onClick={() => setYZoom(null)}
            title="重置缩放（双击图表同效）"
            className="dg-chip tap !py-0.5 text-[11px]"
          >
            重置
          </button>
        </span>
      )}
      {hovered && (
        <div
          ref={tip}
          className="pointer-events-none absolute z-30"
          // 纵向跟着鼠标走，再夹在绘图区里；横向贴着光标那条竖线（靠右时翻到左边）。
          style={{
            top: Math.min(Math.max((pointerY ?? plotH / 2) - tipH / 2 + TOP, TOP), Math.max(TOP, TOP + plotH - tipH)),
            ...(x(hovered.ts) > left + plotW - 150
              ? { right: w - x(hovered.ts) + 8 }
              : { left: x(hovered.ts) + 8 }),
          }}
        >
          {renderTooltip ? (
            renderTooltip(hovered)
          ) : (
            <ChartTooltip active label={hovered.ts} payload={payload} format={format ?? ((v: number) => String(v))} />
          )}
        </div>
      )}
    </div>
  )
}
