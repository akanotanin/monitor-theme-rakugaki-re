import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check } from "lucide-react"

import { PingTooltip } from "@/components/ChartTooltip"
import { TimeChart } from "@/components/DoodleChart"
import { Country, onlineText, deployed, RemarkChips, expiryText, priceText, cycleText } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { api } from "@/lib/api"
import { axisBytes, axisTop, bytes, despike, cpuName, osName, rate } from "@/lib/format"
import { hasDetailRemarks, remarkChips } from "@/lib/notes"
import { type RemarkPlacement } from "@/lib/site-settings"
import { rangesFor } from "@/lib/ranges"

type Point = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
}
// `latency` is the bucket's median round trip, null when every probe in it timed
// out. `band` is the range its answers spanned, absent when they spanned nothing.
// `loss` is the percentage that timed out, absent when none did.
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
/** Probe names by id, sent alongside the samples they label. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable.
 */
type Loss = Record<string, number>

const TABS = [
  { key: "resources", label: "资源" },
  { key: "latency", label: "网络延迟" },
] as const

/**
 * 延迟图最多同时画几条线：九个色相、每个再配一版短虚线，前九条走实线，
 * 第十条起色相重复、换线型。
 */
const COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"].map((n) => `var(${n})`)
const PALETTE = [
  ...COLORS.map((stroke) => ({ stroke, dash: undefined })),
  ...COLORS.map((stroke) => ({ stroke, dash: "6 3" })),
]

/** 在线时间那一格：没接入的写「未接入」，离线的写清楚已经离线多久。 */
function onlineFor(node: Node) {
  return onlineText(node)?.replace(/^已运行 /, "") ?? "—"
}

function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="dg-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/**
 * 时间范围 chip：一枚小纸片。
 */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`dg-chip tap !px-2.5 !py-0.5 text-[12px] ${active ? "dg-chip-on" : ""}`}
    >
      {children}
    </button>
  )
}

/**
 * 图上的手绘勾选框（削峰那一枚）：虚线小方块 + 手画的勾。
 */
export function SketchCheck({ checked, onChange, children }: { checked: boolean; onChange: (next: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="tap flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink"
    >
      <span className={`dg-check !h-[17px] !w-[17px] ${checked ? "" : "text-transparent"}`} aria-hidden="true">
        <Check />
      </span>
      {children}
    </button>
  )
}

/**
 * How many samples of a probe's own series make up seven minutes of neighbours.
 *
 * The window the filter judges against has to be a duration, not a count: the
 * hub buckets a window to the `points` asked for below, so the same day arrives
 * as one-minute buckets on a desktop and two-minute ones on a phone, and a fixed
 * count would clip a five-minute stall on the first while keeping it on the second.
 * Odd, so the window has a middle, and bounded so a sparse probe still has
 * neighbours and a dense one does not pay for a wide sort.
 */
function despikeWindow(points: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < points.length; i++) step = Math.min(step, points[i].ts - points[i - 1].ts)
  return Math.min(15, Math.max(3, Math.round(420 / step) | 1))
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="dg-hand mb-2 text-[13px] font-bold text-ink-2">{title}</h4>
      <div className="h-40 w-full text-ink-3">{children}</div>
    </div>
  )
}

/**
 * 整页详情：翻到这台机器的那一页 —— 页首是身份行与规格（像填过的一张表），
 * 下面是资源 / 网络延迟两个页签与时间范围。图表是手绘版自绘图表（见 DoodleChart）。
 */
export function NodeDetail({ node, onBack, historyDays, remarkPlacement }: {
  node: Node
  /** 「← 回到列表」：回列表页。 */
  onBack: () => void
  /** hub 的历史保留天数（`/api/me` 的 `history_days`）；老 hub 不给，按 7 天算（见 @/lib/ranges）。 */
  historyDays?: number
  /** 「备注显示位置」：整页详情那一块摊不摊备注。 */
  remarkPlacement?: RemarkPlacement
}) {
  const chips = remarkChips(node)
  const detailChips = hasDetailRemarks(node, remarkPlacement ?? "both") ? chips : []
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [ranges, setRanges] = useState({ resources: 6, latency: 6 })
  // 可选窗口按保留天数生成（老 hub 按 7 天）。
  const RANGES = rangesFor(historyDays)
  const hours = ranges[tab]
  const [smooth, setSmooth] = useState(false)
  // Probes switched off. Hiding a slow one is what makes the fast ones readable,
  // as the axis rescales to what remains.
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss } | null>(null)
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one.
  const [failed, setFailed] = useState("")
  // Where the brush has been dragged, so the axis reticks for the visible span
  // rather than retaining the whole window's ticks.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  // 延迟图那块的高度：**撑到视口底**（比一个死高度好看，图例行也刚好落在视口里）。
  // ★必须是定值：容器只靠 min-height 撑的话，里面那层 `h-full` 的百分比高度解析成 0，
  //   整张图一片空白（实测；资源页签那四张用的是固定 h-40，所以不踩这个坑）。
  const [chartH, setChartH] = useState(0)
  useEffect(() => {
    if (tab !== "latency" || !data || failed) return
    const fit = () => {
      const el = tipRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      const h = Math.max(288, Math.round(window.innerHeight - top - 16))
      // oxlint-disable-next-line react/set-state-in-effect -- 量真实 DOM 的活儿只能在 effect/事件里干
      setChartH((prev) => (prev === h ? prev : h))
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [tab, data, failed])

  useEffect(() => {
    let active = true
    // The charts must not continue drawing the old range while the new one is in flight.
    // oxlint-disable-next-line react/set-state-in-effect -- 换范围/页签时先清掉上一档数据，这是取数的既有语义
    setData(null)
    setZoom(null)
    setFailed("")
    // What this screen can resolve, in device pixels, which is the unit the line is drawn in.
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }>(
      `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
    )
      .then((next) => { if (active) setData(next) })
      .catch((e: Error) => {
        // `|| "..."`: HTTP/2 dropped statusText, so a bodiless failure arrives as "".
        if (active) { setFailed(e.message || "网络错误"); setData({ metrics: [], ping: [], probes: {} }) }
      })
    return () => { active = false }
  }, [node.id, hours, tab])

  const m = node.metrics
  // One series per probe that reported, labelled from the names the samples arrived with.
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half its
          // packets as an unbroken line, and one that never answered not at all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above.
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  // The hub answers in seconds; the time axis requires milliseconds.
  const metricRows = useMemo(
    () => (data?.metrics ?? []).map((mm) => ({ ...mm, ts: mm.ts * 1_000 })),
    [data],
  )

  // Axis tops for the two panels with no capacity to measure against.
  const tops = useMemo(() => {
    const max = (pick: (mm: Point) => number) => metricRows.reduce((hi, mm) => Math.max(hi, pick(mm)), 0)
    return {
      cpu: axisTop(max((mm) => mm.cpu), 4, 10, 100),
      rate: axisTop(max((mm) => Math.max(mm.net_rx, mm.net_tx)), 1024, 1024),
    }
  }, [metricRows])

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // Keyed on the full list, so a line keeps its shade when others are hidden.
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // The hub stamps every sample with its bucket, so probes reporting at the
  // bucket's rate share rows instead of each contributing its own.
  const pingRows = useMemo(() => {
    const rows = new Map<number, { ts: number } & Record<string, number | [number, number] | null>>()
    for (const s of pingSeries) {
      const windowSize = despikeWindow(s.points)
      const smoothed = despike(s.points.map((p) => p.latency), windowSize)
      const lo = despike(s.points.map((p) => p.band?.[0] ?? p.latency), windowSize)
      const hi = despike(s.points.map((p) => p.band?.[1] ?? p.latency), windowSize)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i]
        row[`l${s.id}`] = p.loss ?? 0
        // A bucket with a single answer carries no band and spans only that answer.
        row[`b${s.id}`] = p.band ?? (p.latency === null ? null : [p.latency, p.latency])
        const [low, high] = [lo[i], hi[i]]
        row[`c${s.id}`] =
          low === null || high === null
            ? null
            : [Math.min(low, high, smoothed[i] ?? low), Math.max(low, high, smoothed[i] ?? high)]
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // 延迟 tooltip 要按时间戳回查整行（丢包率挂在同一行的另一列上）。
  const rowByTs = useMemo(() => new Map(pingRows.map((row) => [row.ts, row])), [pingRows])

  return (
    <div data-detail="" className="space-y-4">
      {/* 「翻回上一页」：回列表。 */}
      <button type="button" onClick={onBack} className="dg-hand tap flex items-center gap-1.5 text-[14px] text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        <span className="dg-wavy">回到列表</span>
      </button>

      {/* 身份行：旗子在前、名字在后，与卡片上的次序一致。 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Country node={node} />
        <h2 className="dg-hand min-w-0 truncate text-[21px] font-bold leading-tight">{node.name}</h2>
        {node.online ? (
          <span className="dg-stamp dg-stamp-on">在线</span>
        ) : deployed(node) ? (
          <span className="dg-stamp dg-stamp-off">离线</span>
        ) : (
          <span className="dg-stamp dg-stamp-idle">未接入</span>
        )}
      </div>

      {/* 规格：一台机器的一张表 —— 每格底下一道虚线，像手填过的横线。 */}
      <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        <Fact label="系统" value={[osName(node.os), node.kernel].filter(Boolean).join(" · ")} />
        <Fact
          label="CPU"
          value={node.cpu_name ? `${cpuName(node.cpu_name)} × ${node.cpu_cores}` : `${node.cpu_cores} 核`}
        />
        <Fact label="内存 / 硬盘" value={`${bytes(node.mem_total)} / ${bytes(node.disk_total)}`} />
        <Fact
          label="架构"
          value={[node.arch, node.virt !== "none" ? node.virt : "", m ? `${m.procs} 进程` : ""]
            .filter(Boolean)
            .join(" · ")}
        />
        <Fact label="今日流量" value={`↓ ${bytes(node.day_rx)} · ↑ ${bytes(node.day_tx)}`} />
        <Fact label="在线时间" value={onlineFor(node)} />
        {/* 续费信息只在填过价格/到期时出现（与卡面底部那行同一份口径）。 */}
        <Fact label="计费" value={(() => {
          const price = priceText(node)
          if (!price) return null
          const cycle = cycleText(node)
          return `${price}${cycle ? ` / ${cycle}` : ""}`
        })()} />
        <Fact label="到期" value={expiryText(node)} />
      </dl>

      {/* 备注：私有 + 公有合并成一串小标签（私有在前、带锁）。没写备注时一个像素都不占。 */}
      {detailChips.length > 0 && (
        <div data-remark-block="" className="flex min-w-0 flex-wrap items-center gap-1">
          <RemarkChips chips={detailChips} />
        </div>
      )}

      <hr className="dg-hr" />

      <div className="space-y-2">
        <div className="dg-tabs" role="group" aria-label="页签">
          {TABS.map((t) => (
            <Chip key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          <div className="dg-tabs" role="group" aria-label="时间范围">
            {RANGES.map((r) => (
              <Chip key={r.hours} active={hours === r.hours} onClick={() => setRanges((all) => ({ ...all, [tab]: r.hours }))}>
                {r.label}
              </Chip>
            ))}
          </div>
          {tab === "latency" && (
            <SketchCheck checked={smooth} onChange={setSmooth}>
              削峰
            </SketchCheck>
          )}
        </div>
      </div>

      <div ref={tipRef}>
        {!data ? (
          <div className="space-y-4" aria-busy="true">
            <div className="dg-skel h-4 w-16" />
            <div className="dg-skel h-40 w-full" />
          </div>
        ) : failed ? (
          <p className="py-8 text-center text-[13px] text-red-ink" role="alert">读取历史数据失败：{failed}</p>
        ) : tab === "latency" ? (
          pingSeries.length === 0 ? (
            <p className="dg-empty py-8 text-center">这段时间没有延迟数据</p>
          ) : (
            // 高度由上面的 chartH 定（撑到视口底；测量还没跑时先用 62svh 垫着 —— 两者都是定值）。
            <div
              className="flex min-h-72 flex-col gap-3"
              style={{ height: chartH ? `${chartH}px` : "62svh" }}
            >
              <div className="min-h-0 w-full flex-1 text-ink-3">
                {shownProbes.length === 0 ? (
                  <p className="py-8 text-center text-[13px]">没有选中任何探测</p>
                ) : (
                  <TimeChart
                    rows={pingRows}
                    series={[
                      // 区间（band）只在屏上只有一个探测时画：几条叠在一起会糊成一片。
                      ...(shownProbes.length === 1
                        ? shownProbes.map((s) => ({
                            key: `${smooth ? "c" : "b"}${s.id}`,
                            name: s.name,
                            color: style(s.id).stroke,
                            band: true,
                          }))
                        : []),
                      ...shownProbes.map((s) => ({
                        key: `${smooth ? "s" : "t"}${s.id}`,
                        name: s.name,
                        color: style(s.id).stroke,
                        dash: style(s.id).dash,
                      })),
                    ]}
                    hours={hours}
                    // 延迟轴不从 0 起：这些线路活在一条窄带里，锚到 0 会把起伏压平。
                    domain="auto"
                    unit="ms"
                    left={52}
                    from={Math.min(zoom?.[0] ?? 0, pingRows.length - 1)}
                    to={Math.min(zoom?.[1] ?? pingRows.length - 1, pingRows.length - 1)}
                    // 「在图上横向拖选一段」+ 一枚「重置」。
                    onZoom={(from, to) => setZoom([from, to])}
                    label="节点延迟走势"
                    renderTooltip={(row) => (
                      <PingTooltip active label={row.ts} rowByTs={rowByTs} probes={shownProbes} smooth={smooth} style={style} />
                    )}
                  />
                )}
              </div>

              {/* 图下面那排：哪几条线在屏上（点一下藏/显），丢包率挂在名字后面。 */}
              {(pingSeries.length > 1 || pingSeries.some((s) => s.loss > 0)) && (
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {pingSeries.map((s) => {
                    const shown = !hiddenProbes.includes(s.id)
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={shown}
                        onClick={() => setHiddenProbes((h) => (shown ? [...h, s.id] : h.filter((id) => id !== s.id)))}
                        className={`dg-chip tap !px-2 !py-0.5 text-[12px] ${shown ? "" : "opacity-40"}`}
                      >
                        <svg width="14" height="6" className="shrink-0" aria-hidden>
                          <line
                            x1="0"
                            y1="3"
                            x2="14"
                            y2="3"
                            stroke={style(s.id).stroke}
                            strokeDasharray={style(s.id).dash}
                            strokeWidth="2.4"
                          />
                        </svg>
                        {s.name}
                        {/* The line is only what answered, so a probe dropping half its packets draws like a healthy one. */}
                        {s.loss > 0 && (
                          <span className="tnum opacity-70">丢 {s.loss < 1 ? "<1" : Math.round(s.loss)}%</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        ) : metricRows.length === 0 ? (
          <p className="dg-empty py-8 text-center">这段时间没有历史数据</p>
        ) : (
          <div className="space-y-5">
            <Panel title="CPU">
              <TimeChart
                rows={metricRows}
                series={[{ key: "cpu", name: "CPU", color: "var(--c1)", area: true }]}
                hours={hours}
                top={tops.cpu}
                unit="%"
                format={(v) => `${v.toFixed(1)}%`}
                label="CPU 使用率走势"
              />
            </Panel>

            {/* 轴的顶就是这台机器的内存：线的位置＝用了多少比例（按窗口自己的最大值
                取轴，会把 457MB 里用 127MB 画到顶）。 */}
            <Panel title={`内存 · ${bytes(node.mem_total)}`}>
              <TimeChart
                rows={metricRows}
                series={[{ key: "mem_used", name: "内存", color: "var(--c2)", area: true }]}
                hours={hours}
                top={node.mem_total}
                yFormat={axisBytes}
                format={(v) => bytes(v)}
                label="内存使用量走势"
              />
            </Panel>

            {/* 速率没有「总量」，所以它像 CPU 那样爬梯子，而不是钉在一个容量上。 */}
            <Panel title="网络速率">
              <TimeChart
                rows={metricRows}
                series={[
                  { key: "net_rx", name: "下行", color: "var(--c4)" },
                  { key: "net_tx", name: "上行", color: "var(--c3)" },
                ]}
                hours={hours}
                top={tops.rate}
                unit="/s"
                yFormat={axisBytes}
                format={(v) => rate(v)}
                label="网络速率走势"
              />
            </Panel>

            <Panel title={`硬盘 · ${bytes(node.disk_total)}`}>
              <TimeChart
                rows={metricRows}
                series={[{ key: "disk_used", name: "硬盘", color: "var(--c5)", area: true }]}
                hours={hours}
                top={node.disk_total}
                yFormat={axisBytes}
                format={(v) => bytes(v)}
                label="硬盘使用量走势"
              />
            </Panel>
          </div>
        )}
      </div>
    </div>
  )
}
