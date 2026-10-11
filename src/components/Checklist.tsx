import { lazy, Suspense, useState } from "react"
import { Check, X } from "lucide-react"

import { Country, deployed, monthUsage } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { FOREVER, bytes, percent, rate } from "@/lib/format"
import { cn } from "@/lib/utils"

// 展开块（延迟面板）与详情页共用**同一个懒加载 chunk** —— 清单悬停预热的就是它。
const LatencyFold = lazy(() => import("@/components/NodeDetail").then((m) => ({ default: m.LatencyFold })))

/**
 * 「清单表格」形态：一页撕下来的待办清单 —— 一台机器一行，勾选框 + 名称 +
 * 三根小读数条 + 网速 + 状态；鼠标扫过时整行被黄高亮笔划一道（见 .dg-row:hover）。
 * 宽度不够时（<768px）读数条与网速列收起，收进名称下面那行小字里 —— 与卡片形态
 * 同一套「一台机器至少还有名字与状态」的取舍。
 *
 * 两种点法分别去两处（站长定的交互）：
 *   ① 点整行 = 选中这一行、在它下面翻出「延迟面板」——时间范围 + 延迟走势图 + 丢包图例
 *      （与详情页同一套零件，见 LatencyFold）。数据点开才取，不展开的行一个字节都不发；
 *   ② 点**名字** = 进这台机器的详情页（名字是真链接：新标签/中键打开照常，站内导航走 onOpen）。
 */
export function Checklist({ nodes, onOpen, onWarm, historyDays }: {
  nodes: Node[]
  onOpen: (id: number) => void
  onWarm?: () => void
  /** hub 的历史保留天数：展开块里那排时间范围的档位按它生成（见 @/lib/ranges）。 */
  historyDays?: number
}) {
  // 单开：一次只翻一行 —— 开着十行延迟的清单就不再是「一屏扫完」的清单了。
  const [openId, setOpenId] = useState<number | null>(null)
  return (
    <div className="dg-list" data-card="checklist">
      <div className="dg-row-head" aria-hidden="true">
        <span />
        <span className="dg-hand">名称</span>
        <span className="dg-hand">CPU</span>
        <span className="dg-hand">内存</span>
        <span className="dg-hand">硬盘</span>
        <span className="dg-hand">网速 ↓ / ↑</span>
        <span className="dg-hand">状态</span>
      </div>
      {nodes.map((node) => (
        <Row
          key={node.id}
          node={node}
          onOpen={() => onOpen(node.id)}
          onWarm={onWarm}
          historyDays={historyDays}
          open={openId === node.id}
          onToggle={() => setOpenId((cur) => (cur === node.id ? null : node.id))}
        />
      ))}
    </div>
  )
}

/** 一格小读数条：槽 + 填色（与卡片的 Meter 同一套 token，只是更窄更薄）。 */
function MiniBar({ pct, tone }: { pct: number | null; tone: "red" | "teal" | "blue" }) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  const hot = pct !== null && filled >= 85
  return (
    <div className="dg-col-wide flex items-center gap-2">
      <div className="dg-track h-2 w-12 shrink-0">
        <div
          className={cn("dg-fill", hot && "dg-fill-hot")}
          style={{ width: `${filled}%`, ["--fill"]: `var(--${tone})` } as React.CSSProperties}
        />
      </div>
      <span className="tnum w-10 shrink-0 text-[11.5px] text-ink-2">
        {pct === null ? "—" : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
      </span>
    </div>
  )
}

function Row({ node, onOpen, onWarm, historyDays, open, onToggle }: {
  node: Node
  onOpen: () => void
  onWarm?: () => void
  historyDays?: number
  /** 这一行展开着没有（同一时刻最多一行，由 Checklist 的 openId 决定）。 */
  open: boolean
  onToggle: () => void
}) {
  const m = node.metrics
  const live = deployed(node)
  const cpuPct = m ? m.cpu : null
  const memPct = m ? percent(m.mem_used, m.mem_total) : null
  const diskPct = m ? percent(m.disk_used, m.disk_total) : null
  const traffic = node.traffic_limit > 0 ? `${bytes(monthUsage(node))}/${bytes(node.traffic_limit)}` : `${bytes(monthUsage(node))}/${FOREVER}`
  return (
    <>
      <div
        className="dg-row"
        data-node={node.id}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onPointerOver={onWarm}
        onFocus={onWarm}
        onTouchStart={onWarm}
        // 键盘：Enter/空格敲在行本身上才展开 —— 焦点在名字链接里时让浏览器去开详情
        //（不拦的话两个都会触发：链接开详情、冒泡上来的这行又把它展开）。
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <span className={cn("dg-check", node.online ? "" : live ? "dg-check-off" : "text-ink-4")} aria-hidden="true">
          {node.online ? <Check /> : live ? <X /> : <span className="text-[11px] font-bold">?</span>}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Country node={node} />
            {/* 名字 = 进详情的那一处（整行是「展开延迟」）。真链接，但站内点击走 SPA 路由。 */}
            <a
              href={`/node/${node.id}`}
              className="dg-hand dg-name-link min-w-0 truncate text-[14px] font-bold"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onOpen()
              }}
            >
              {node.name}
            </a>
            {!live && <span className="shrink-0 text-[11px] text-ink-4">未接入</span>}
          </div>
          {/* 窄屏才出现的那两行：读数与网速收成小字，列都藏起来（见 index.css）。 */}
          {live && (
            <div className="dg-only-narrow tnum mt-0.5 text-[11px] leading-snug text-ink-3">
              CPU {cpuPct === null ? "—" : `${cpuPct.toFixed(0)}%`} · 内存 {memPct === null ? "—" : `${memPct.toFixed(0)}%`} · 硬盘 {diskPct === null ? "—" : `${diskPct.toFixed(0)}%`}
              <br />
              {m ? `↓ ${rate(m.net_rx)} ↑ ${rate(m.net_tx)}` : "—"} · 流量 {traffic}
            </div>
          )}
        </div>
        {live ? (
          <>
            <MiniBar pct={cpuPct} tone="red" />
            <MiniBar pct={memPct} tone="teal" />
            <MiniBar pct={diskPct} tone="blue" />
            <span className="dg-col-wide tnum truncate text-[11.5px] text-ink-2">
              {m ? `↓ ${rate(m.net_rx)} ↑ ${rate(m.net_tx)}` : "—"}
            </span>
          </>
        ) : (
          <>
            <span className="dg-col-wide" />
            <span className="dg-col-wide" />
            <span className="dg-col-wide" />
            <span className="dg-col-wide" />
          </>
        )}
        <span className="dg-col-wide text-[11.5px]">
          {node.online ? <span className="text-teal-ink">在线</span> : live ? <span className="text-red-ink">离线</span> : <span className="text-ink-4">未接入</span>}
        </span>
      </div>
      {/* 展开的下拉部分：延迟面板（时间范围 + 走势图 + 图例，见 LatencyFold）。挂载即取数、
          收起即卸载；chunk 与详情页共用（悬停这一行时预热的就是它）。 */}
      {open && (
        <div data-fold="" className="dg-fold">
          <Suspense fallback={<div className="dg-skel mt-1 h-40" aria-busy="true" />}>
            <LatencyFold node={node} historyDays={historyDays} onOpenDetail={onOpen} />
          </Suspense>
        </div>
      )}
    </>
  )
}
