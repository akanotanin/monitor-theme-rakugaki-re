import { useLayoutEffect, useRef, useState } from "react"

import { ChartTooltip } from "@/components/ChartTooltip"
import { clockFor, quarters, timeTicks } from "@/lib/format"
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

export function TimeChart({
  rows,
  series,
  hours,
  top = 0,
  unit = "",
  format,
  yFormat,
  from = 0,
  to,
  label,
  domain = "zero",
  left = LEFT,
  onZoom,
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
  /** Y 轴刻度怎么印，默认按原样（最多一位小数）。 */
  yFormat?: (value: number) => string
  /** 只看 `rows[from..to]` 这一段（缩放窗口用，索引是**全量数组**里的下标）。 */
  from?: number
  to?: number
  /** 给读屏用的一句话（这张图画的是什么）。 */
  label?: string
  /** `zero`：Y 轴从 0 起；`auto`：按数据自身量程取整齐刻度、且至少摊开 `AUTO_MIN_SPAN_RATIO` 那么宽（延迟轴用——锚 0 会压平起伏、贴着数据缩放又会放大几 ms 的抖动，两头各一道护栏）。 */
  domain?: "zero" | "auto"
  /** 左边留给 Y 轴刻度的宽度。 */
  left?: number
  /** 给了它就能**在图上横向拖选一段缩放**（索引是全量数组里的下标）。 */
  onZoom?: (from: number, to: number) => void
  /** 自定义悬停内容（延迟图用它接 `PingTooltip`）。 */
  renderTooltip?: (row: ChartRow) => React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [tipH, setTipH] = useState(0)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

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

  const last = Math.max(0, rows.length - 1)
  const a = Math.min(Math.max(Math.round(from), 0), last)
  const b = Math.min(Math.max(to ?? last, a), last)
  const view = rows.slice(a, b + 1)

  const w = size.w
  const h = size.h
  const plotW = Math.max(1, w - left - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)

  // 刻度：零起点用 quarters(top)；自动档拿数据量程取整齐步长，但量程至少摊开
  // AUTO_MIN_SPAN_RATIO 那么宽（「最近视距」，见常量注释）——窄波动不再被怼满全高。
  const scale =
    domain === "auto"
      ? (() => {
          const [lo, hi] = extentOf(view, series.map((s) => s.key)) ?? [0, 1]
          const minSpan = Math.max(hi, 1) * AUTO_MIN_SPAN_RATIO
          if (hi - lo >= minSpan) return niceScale(lo, hi)
          const mid = (lo + hi) / 2
          return niceScale(mid - minSpan / 2, mid + minSpan / 2)
        })()
      : { lo: 0, hi: top > 0 ? top : 1, ticks: quarters(top) }
  const yRange = Math.max(1e-9, scale.hi - scale.lo)

  const x = (ts: number) => left + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - ((value - scale.lo) / yRange) * plotH

  const yLabel = yFormat ?? ((value: number) => String(Math.round(value * 10) / 10))
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
  const zoomed = !!onZoom && (a > 0 || b < last)
  const sel = drag ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) } : null

  return (
    // `data-chart`：给护栏一个稳定锚点（改版后按类名找的判据会静默变成 0）。
    <div ref={box} data-chart="" className="relative h-full w-full">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
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
          {/* Y 轴刻度（手写体）。 */}
          {scale.ticks.map((v) => (
            <text
              key={`y${v}`}
              x={left - 6}
              y={y(v)}
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
          {/* 悬停竖线。 */}
          {hovered && !sel && (
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
          {/* 拖选中的那一段（松手才真的缩放）。 */}
          {sel && view.length > 1 && (
            <rect
              x={x(view[sel.lo].ts)}
              y={TOP}
              width={Math.max(1, x(view[sel.hi].ts) - x(view[sel.lo].ts))}
              height={plotH}
              fill="var(--yellow)"
              opacity={0.22}
            />
          )}
          {/* 命中层：整块绘图区接指针，按 x 找最近的那个点；给了 onZoom 就能横向拖选缩放。 */}
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            // `pan-y`：手机上竖着划仍然滚页面，只有横向拖才被这里接走。
            style={onZoom ? { touchAction: "pan-y" } : undefined}
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
              if (!onZoom || view.length < 3) return
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 无所谓 */ }
              const at = indexAt(e.clientX, e.currentTarget)
              setDrag({ from: at, to: at })
            }}
            onPointerMove={(e) => {
              if (!drag) return
              setDrag({ ...drag, to: indexAt(e.clientX, e.currentTarget) })
            }}
            onPointerUp={() => {
              if (!drag || !onZoom) return
              const lo = Math.min(drag.from, drag.to)
              const hi = Math.max(drag.from, drag.to)
              setDrag(null)
              // 只是点了一下（没拖开）就不动：重置交给那枚「重置」。
              if (hi - lo >= 2) onZoom(a + lo, a + hi)
            }}
          />
        </svg>
      )}
      {/* 缩放着的时候给一枚重置。 */}
      {zoomed && onZoom && (
        <button
          type="button"
          onClick={() => onZoom(0, last)}
          className="dg-chip tap absolute right-1 top-0 !py-0.5 text-[11px]"
        >
          重置
        </button>
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
