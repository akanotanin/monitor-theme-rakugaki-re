import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * 一格读数：表名与百分比在上、手绘进度条在中、原始数字在下。
 *
 * 条是「马克笔画的一格」：虚线的槽 + 斜细纹的填色（见 index.css 的 .dg-track /
 * .dg-fill），填色的色相按读数种类分（CPU 红 / 内存蓝绿 / 硬盘蓝 / 流量橄榄）。
 * 快满了（≥85%）一律换成红笔 —— 四种读数都是「越满越该看一眼」，这一条与上一枚
 * 主题同口径。
 */
export function Meter({ label, pct, foot, empty = "—", tone = "teal" }: {
  label: ReactNode
  /** null = 这格没有上限可填（没指标 / 无限流量），条留空、读数位显示 `empty`。 */
  pct: number | null
  foot: ReactNode
  empty?: ReactNode
  tone?: "red" | "teal" | "blue" | "olive"
}) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  const hot = pct !== null && filled >= 85
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] text-ink-2">{label}</span>
        <span className="tnum shrink-0 text-[12.5px] font-semibold">
          {pct === null ? empty : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
        </span>
      </div>
      <div className="dg-track mt-1.5 w-full">
        <div
          className={cn("dg-fill", hot && "dg-fill-hot")}
          style={{ width: `${filled}%`, ["--fill"]: `var(--${tone})` } as CSSProperties}
        />
      </div>
      <div className="tnum mt-1 truncate text-[11px] text-ink-4">{foot}</div>
    </div>
  )
}
