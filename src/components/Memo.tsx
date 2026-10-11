import { Activity, ArrowDown, ArrowUp, Gauge, Server } from "lucide-react"

import { speedHistory, type Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"
import { wobblePoints } from "@/lib/sketch"
import { summarize } from "@/lib/summary"

/**
 * 列表页顶上那张「小抄」：一张贴在页首的便签，四块读数并排
 * （节点 / 最忙节点 / 今日流量 / 实时网速）。
 *
 * 数据都来自 `/api/nodes` 里本来就有的字段，开着它不会多发一个请求——唯一的例外是
 * 第四块下面那条走势线，它画的是访客打开页面之后自己攒下的实时速率（api.ts 的
 * `speedHistory`，每 2 秒一个采样、留最近 60 个 ≈ 2 分钟）：刷新页面就得重新攒，
 * 冷启动头几秒那里是空的。
 *
 * ★口径跟着分组标签走：传进来的是**当前分组筛选出的节点**（`group` 也跟着一起来，
 * 用来取那一条分组自己的速率走势线），与下面那批卡片是同一批机器。
 * 搜索也会收窄这一张便签（同一套口径，见 App）。
 */
export function Memo({ nodes, group, searching = false }: { nodes: Node[]; group: string | null; searching?: boolean }) {
  const fleet = summarize(nodes)
  // 模块级的采样缓冲：`useNodes` 每次收到推送（或轮询回来）就追加一个点，
  // 所以这里读到的是「打开页面到现在」的速率。按分组取（null = 全部）。
  const series = speedHistory.get(group) ?? []
  const offline = fleet.total - fleet.online

  return (
    <section data-memo="" className="dg-memo px-5 pb-5 pt-4" aria-label="概览便签">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 xl:grid-cols-4">
        <Block icon={<Server />} title="节点">
          <Big>
            {fleet.online} / {fleet.total}
          </Big>
          <Foot>
            {fleet.total === 0 ? (searching ? "没有匹配的节点" : "还没有节点") : offline === 0 ? "全部在线" : `${offline} 台离线`}
          </Foot>
        </Block>

        <Block icon={<Activity />} title="最忙节点">
          <Big>{fleet.busiest ? `${fleet.busiest.cpu.toFixed(1)}%` : "—"}</Big>
          <Foot>{fleet.busiest ? fleet.busiest.name : "无在线节点"}</Foot>
        </Block>

        <Block icon={<ArrowDown />} title="今日流量">
          <Big small>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="whitespace-nowrap"><Down /> {bytes(fleet.dayRx)}</span>
              <span className="whitespace-nowrap"><Up /> {bytes(fleet.dayTx)}</span>
            </span>
          </Big>
          <Foot className="text-[11.5px]">
            总流量 ↓ {bytes(fleet.totalRx)} ↑ {bytes(fleet.totalTx)}
          </Foot>
        </Block>

        <Block icon={<Gauge />} title="实时网速">
          <Big small>
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="whitespace-nowrap"><Down /> {rate(fleet.netRx)}</span>
              <span className="whitespace-nowrap"><Up /> {rate(fleet.netTx)}</span>
            </span>
          </Big>
          <Foot className="text-[11.5px]">
            <Sparkline series={series} />
          </Foot>
        </Block>
      </div>
    </section>
  )
}

function Down() {
  return <ArrowDown className="inline size-[13px] -translate-y-px text-ink-3" aria-hidden />
}
function Up() {
  return <ArrowUp className="inline size-[13px] -translate-y-px text-ink-3" aria-hidden />
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="dg-memo-block">
      <div className="dg-memo-label">
        {icon}
        {title}
      </div>
      {children}
    </div>
  )
}

function Big({ children, small = false }: { children: React.ReactNode; small?: boolean }) {
  return <div className={`dg-memo-big tnum ${small ? "text-[14.5px] sm:text-[16.5px]" : ""}`}>{children}</div>
}

function Foot({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`mt-1 flex min-h-[18px] min-w-0 items-center gap-2 text-[12px] text-ink-3 ${className}`}>
      {children}
    </div>
  )
}

// viewBox 与卡片实际尺寸无关：下面的 preserveAspectRatio 会把它拉满整行。
// 零基准——网速这种量没有上限可参照，不零基准会把「一直很忙」和「偶尔抖一下」
// 画成同一个形状。
const W = 100
const H = 20

/**
 * 实时网速下面那条走势线：下行 / 上行两条折线，无坐标轴、无填充——这一块只说
 * 「从打开页面到现在大概什么形状」，确切读数是它上面那一行。采样点少于两个
 * （冷启动的头几秒、或 hub 一直连不上）就只占位不画线。
 */
function Sparkline({ series }: { series: { rx: number; tx: number }[] }) {
  const ready = series.length > 1
  if (!ready) return <span className="block h-5" />
  const max = Math.max(1, ...series.map((s) => Math.max(s.rx, s.tx)))
  const line = (pick: (s: { rx: number; tx: number }) => number, seed: number) =>
    wobblePoints(
      series.map((s, i) => [
        (i / (series.length - 1)) * W,
        H - 1 - (pick(s) / max) * (H - 2),
      ] as [number, number]),
      seed,
      0.35,
    )
      .map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ")
  return (
    <svg className="h-5 w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={line((s) => s.rx, 3)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-ink-2" />
      <polyline points={line((s) => s.tx, 9)} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-ink-4" />
    </svg>
  )
}
