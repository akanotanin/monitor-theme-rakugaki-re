import { useMemo } from "react"

import type { Node } from "@/lib/api"
import { MAP_VIEW, mapBase, mapPins, type Pin } from "@/lib/map"

/**
 * 「节点地图」：一张用胶带贴在页上的世界地图（等距圆柱平铺，手绘描过的海岸线），
 * 每台机器是一枚图钉 —— 在线的是标记笔颜色的实心钉、没定位/离线的画成空心圈 + 一道红杠。
 *
 * 为什么不是会转的地球：这个主题的本子是「手绘笔记本」，贴一张地图、钉几枚图钉
 * 才是这一页的物理隐喻（投影与抖动的口径见 @/lib/map）。
 * 交互就一条：点图钉去那台机器。悬停给原生 tooltip（<title>），不另做浮层。
 *
 * 窄屏：地图横向可拖（svg 有 640px 的最小宽度）—— 480 一列的图钉挤在 390 宽里
 * 会互相压住，宁可让访客拖一下。桌面整幅全宽显示。
 */
export function MapSheet({ nodes, onOpen }: { nodes: Node[]; onOpen: (id: number) => void }) {
  const base = useMemo(() => mapBase(), [])
  const { pins, located, missing } = useMemo(() => mapPins(nodes), [nodes])
  return (
    <section data-map="" className="dg-map px-4 pb-3.5 pt-3.5" aria-label="节点地图">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="dg-hand text-[15.5px] font-bold">它们都在哪儿</h2>
        <span className="dg-map-hint">
          {located} 枚图钉{missing > 0 ? ` · ${missing} 台没定位` : ""}
        </span>
        <span className="dg-map-hint ml-auto hidden sm:inline">点一枚图钉去看那台机器</span>
      </div>
      <div className="dg-map-scroll">
        <svg
          viewBox={`0 0 ${MAP_VIEW.w} ${MAP_VIEW.h}`}
          className="h-auto w-full min-w-[640px] sm:min-w-0"
          role="img"
          aria-label="世界地图上的节点位置"
        >
          {base.grid.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--map-grid)" strokeWidth="1" strokeDasharray="2 5" />
          ))}
          <path
            d={base.land}
            fill="var(--map-land)"
            stroke="var(--map-stroke)"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {pins.map((pin) => (
            <Pin key={pin.id} pin={pin} onOpen={onOpen} />
          ))}
        </svg>
      </div>
      <p className="dg-map-hint mt-1 sm:hidden">小屏可以左右拖动这张地图 →</p>
    </section>
  )
}

/** 图钉三色轮换（红 / 蓝绿 / 黄），与卡片的影子、胶带是同一套标记笔。 */
const PIN_COLORS = ["var(--red)", "var(--teal)", "var(--yellow)"]

function Pin({ pin, onOpen }: { pin: Pin; onOpen: (id: number) => void }) {
  return (
    <g
      className="dg-pin"
      transform={`translate(${pin.x.toFixed(1)} ${pin.y.toFixed(1)})`}
      role="button"
      tabIndex={0}
      aria-label={`${pin.name}（${pin.online ? "在线" : "离线"}）`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(pin.id)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(pin.id)
        }
      }}
    >
      <g transform={`rotate(${pin.tilt.toFixed(1)})`}>
        <title>{`${pin.name}（${pin.online ? "在线" : "离线"}）`}</title>
        {/* 透明的大圈：手感上的命中区（图钉本身只有 6px 半径）。 */}
        <circle r="10" fill="transparent" />
        <circle
          r="6"
          fill={pin.online ? PIN_COLORS[pin.id % PIN_COLORS.length] : "var(--paper)"}
          stroke="var(--map-stroke)"
          strokeWidth="1.6"
          strokeDasharray={pin.online ? undefined : "2.5 2.5"}
        />
        {pin.online ? (
          <circle r="1.7" cx="-1.7" cy="-1.7" fill="rgba(255,255,255,.75)" />
        ) : pin.deployed ? (
          // 离线：空心圈 + 一道红杠（红笔划掉的那一下）。
          <line x1="-3.4" y1="3.4" x2="3.4" y2="-3.4" stroke="var(--red-ink)" strokeWidth="1.7" strokeLinecap="round" />
        ) : (
          // 从未接入过：线圈中间一个小问号点，比红杠轻一档。
          <circle r="1.5" fill="var(--ink-4)" />
        )}
      </g>
    </g>
  )
}
