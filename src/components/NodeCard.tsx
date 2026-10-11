import { useState } from "react"
import { Lock } from "lucide-react"

import { LatencyPanel } from "@/components/Latency"
import { Meter } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { CYCLES, FOREVER, bytes, daysUntil, money, pair, percent, rate, uptime } from "@/lib/format"
import { remarkChips, type RemarkChip } from "@/lib/notes"
import { remarksOnCards, type RemarkPlacement } from "@/lib/site-settings"

/**
 * 这台机器本期的用量（按套餐的计流量方式算）。hub 直接下发 `month_used`；
 * 下面那个 switch 只服务没有这个字段的旧 hub。
 */
export function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
export function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

/**
 * 离线了多久（秒）。优先用 hub 算好的 `last_seen_ago`——它按 **hub 的时钟**算，而拿
 * `last_seen` 减访客浏览器的时钟会在访客时钟偏了时报出错误的时长（快 8 小时就显示成
 * 「离线 8 小时」）。老 hub（1.4.0 之前）没有这个 key，退回按 `last_seen` 自己算；
 * 从未上报（last_seen 为 0）得 0，调用方按「不足一分钟」处理。
 */
export function offlineSeconds(node: Node): number {
  if (typeof node.last_seen_ago === "number") return Math.max(0, node.last_seen_ago)
  return node.last_seen ? Math.max(0, Date.now() / 1000 - node.last_seen) : 0
}

/**
 * 「在线 / 离线多久」那一句。没接入的节点没有时长可说，返回 null。
 * 卡片底部那行小字与详情页的「在线时间」共用一个口径。
 */
export function onlineText(node: Node): string | null {
  if (node.online) return node.metrics ? `已运行 ${uptime(node.metrics.uptime)}` : "在线"
  if (!deployed(node)) return null
  const down = offlineSeconds(node)
  return down >= 60 ? `离线 ${uptime(down)}` : "离线"
}

export function priceText(node: Node): string | null {
  return node.price > 0 ? money(node.price, node.currency) : null
}

export function cycleText(node: Node): string | null {
  if (node.price <= 0) return null
  return CYCLES[node.billing_cycle] ?? (node.billing_cycle || null)
}

/**
 * 到期还剩多少天。优先用 hub 算好的 `expires_in`：它按 hub 的时区算，还会给在线节点
 * 顺延到期日，访客自己按浏览器时钟算会在顺延前的那几个小时里显示成「已过期」。只有
 * 旧 hub 没这个 key 时，才退回按 `expires_at` 自己数。
 */
export function expiryText(node: Node): string | null {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null || days === undefined) return null
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return "今天到期"
  return `剩余 ${days} 天`
}

/**
 * Where the machine is: its flag sticker, or the bare code for one the set lacks.
 *
 * 旗子是主题自带的静态文件（`/flags/<CC>.svg`，按 ISO 3166-1 alpha-2 命名），
 * 按国家码现取一张：访客只会下载页面上真正出现的那几面旗。贴纸感：小圆角、
 * 一丝歪头、虚线外圈。取不到就退回文字标签，不留一枚破图。
 */
export function Country({ node }: { node: Node }) {
  const [missing, setMissing] = useState(false)
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  if (missing) {
    return <span className="dg-tag shrink-0 font-normal">{code}</span>
  }
  return (
    <img
      src={`/flags/${code}.svg`}
      alt={code}
      title={code}
      width={23}
      height={17}
      loading="lazy"
      className="h-[17px] w-[23px] shrink-0 -rotate-3 rounded-[4px] object-cover ring-[1.5px] ring-line-strong"
      onError={() => setMissing(true)}
    />
  )
}

/**
 * 备注小标签：**私有那几枚带锁 + 深一档的描边**（仅自己可见），公有那几枚浅描边。
 * 卡片、详情页共用这一套——写法只有一处，合并后的次序（私有在前、公有在后）由
 * `@/lib/notes` 的 `remarkChips` 一处决定。
 */
export function RemarkChips({ chips, max }: { chips: RemarkChip[]; max?: string }) {
  return (
    <>
      {chips.map((c, i) => (
        <span
          key={i + "-" + c.text}
          className={"dg-tag min-w-0 " + (c.own ? "dg-tag-own" : "")}
          style={max ? { maxWidth: max } : undefined}
          title={c.own ? "仅自己可见：" + c.text : c.text}
        >
          {c.own && <Lock aria-hidden />}
          <span className="min-w-0 truncate">{c.text}</span>
        </span>
      ))}
    </>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

/**
 * 涂鸦卡片：一台一张「随手画在卡纸上」的卡片 —— 顶上一条胶带、虚线描边、标记笔硬影子，
 * 整块轻微歪头（逐张轮换，见 index.css 的 .dg-cards）。
 *
 * 卡面一块一块从上到下：
 *   ① 身份行：旗子贴纸 + 名字 + 状态印章（在线 / 离线 / 未接入）；
 *   ② 备注标签（站长把备注摊在卡片那一侧、且这台写了才有）；
 *   ③ 2×2 读数格：CPU / 内存 / 硬盘 / 流量；
 *   ④ 速率・总量一行（↓ ↑ 用文字，整段可原样复制）；
 *   ⑤ 三网延迟三条（站长在后台指定了哪几条就哪几条，留空取前三条）；
 *   ⑥ 纸角一行小字：在线时长 · 价格/周期 · 到期。
 *
 * 没接入过的机器（连规格都没有）只画①+一行说明，卡片保持矮，不去撑成邻居那么高。
 */
export function NodeCard({ node, onOpen, onWarm, latencyLines, remarkPlacement }: {
  node: Node
  onOpen: () => void
  /** 指针或键盘刚落到这张卡片上：先把详情那块 chunk 取回来。 */
  onWarm?: () => void
  /** 卡面延迟块要显示哪几条线路（ping 任务名，换行分隔）；空串 = 自动取前三条。 */
  latencyLines: string
  /** 「备注显示位置」：`detail` 时卡片这一侧一枚都不摊（整页详情照旧，见 NodeDetail）。 */
  remarkPlacement?: RemarkPlacement
}) {
  const m = node.metrics
  const chips = remarksOnCards(remarkPlacement ?? "both") ? remarkChips(node) : []
  // 纸角那一行小字的几截：在线时长 · 价格/周期 · 到期（有哪截写哪截）。
  const price = priceText(node)
  const cycle = cycleText(node)
  const note = [
    onlineText(node),
    price ? `${price}${cycle ? ` / ${cycle}` : ""}` : null,
    expiryText(node),
  ].filter(Boolean).join(" · ")

  return (
    <article
      data-card="doodle"
      data-node={node.id}
      onClick={onOpen}
      // 摸到卡片（悬停 / 键盘 Tab 到它 / 手指按下）就先取详情那块 chunk：真要打开的人，
      // 鼠标按下去之前多半已经碰过这张卡了。
      onPointerOver={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // name line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways.
      className="dg-card min-w-0 cursor-pointer p-4"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Country node={node} />
        <h3 className="dg-hand min-w-0 flex-1 truncate text-[15.5px] font-bold">{node.name}</h3>
        {node.online ? (
          <span className="dg-stamp dg-stamp-on">在线</span>
        ) : deployed(node) ? (
          <span className="dg-stamp dg-stamp-off">离线</span>
        ) : (
          <span className="dg-stamp dg-stamp-idle">未接入</span>
        )}
      </div>

      {chips.length > 0 && (
        <div data-remark="card" className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
          <RemarkChips chips={chips} />
        </div>
      )}

      {/* One layout for both states: a disconnected node still knows its cores,
          memory, disk size and traffic totals, and showing those with the live
          figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3.5">
            {/* Core count belongs beside the word CPU: it is what the percentage
                and the load averages are both measured against. */}
            <Meter
              tone="red"
              label={<>CPU <span className="text-ink-4">{node.cpu_cores} 核</span></>}
              pct={m ? m.cpu : null}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
            <Meter
              tone="teal"
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              tone="blue"
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              tone="olive"
              label="流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
          </div>

          <div data-net="row" className="tnum mt-3.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t-[1.5px] border-dashed border-line-strong pt-3 text-[12px]">
            <span className="truncate">{m ? `↓ ${rate(m.net_rx)} ↑ ${rate(m.net_tx)}` : "—"}</span>
            <span className="truncate text-ink-3">{`↓ ${bytes(node.total_rx)} ↑ ${bytes(node.total_tx)}`}</span>
          </div>

          {/* 三网延迟：每条线路一行，数据来自 hub 的 ping 历史（见 Latency.tsx）。 */}
          <LatencyPanel node={node} lines={latencyLines} />

          {note && <div className="dg-note mt-2 truncate text-[13px] leading-snug text-ink-3">{note}</div>}
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. */
        <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
          还没有接入。在后台生成安装命令并执行一次。
        </p>
      )}
    </article>
  )
}
