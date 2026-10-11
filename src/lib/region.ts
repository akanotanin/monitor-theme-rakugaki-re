import type { Node } from "./api.ts"
import { CITY_HINTS, COUNTRY_CITY_FALLBACK, COUNTRY_LL } from "./world.ts"

/**
 * 「一台机器属于哪个地区」——搜索的「地区」那一处就用它（名称 / 地区 / 系统三处都能搜）。
 *
 * 从上一枚主题的 globe.ts 原样搬出来的两个口径，别丢：
 *   ① 城名的来源有**两层**：名字/分组里的城市线索优先，认不出时按
 *      `COUNTRY_CITY_FALLBACK` 兜一个国家级的城名（HK → Hong Kong 那几条）。
 *      兜底这层漏掉的话，HK 会裂成「HK」与「HK · Hong Kong」两种说法。
 *   ② 认不出国家就 `null`（不给兜底落点）——搜索里这类机器只按名字与系统匹配。
 */

/** 节点名/分组里认出的城市线索。 */
export function cityHint(node: Pick<Node, "name" | "group">): { ll: [number, number]; name: string } | null {
  const text = [node.name, node.group].filter(Boolean).join(" ")
  for (const hint of CITY_HINTS) if (hint.match.test(text)) return { ll: hint.ll, name: hint.name }
  return null
}

export type Region = {
  /** 地区键（`CC` 或 `CC · 城市名`）。 */
  key: string
  /** ISO 3166-1 alpha-2；空串 = 认不出国家。 */
  code: string
  /** 城市英文名（线索没命中时按国家兜底；两者都没有才是空串）。 */
  city: string
  /** 地区列表里显示的文字：有城名用城名，否则用国家码。 */
  label: string
  /** 这一地区的落点（经度, 纬度）。 */
  base: [number, number]
}

export function regionOf(node: Node): Region | null {
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  const hint = cityHint(node)
  const base = hint?.ll ?? COUNTRY_LL[code]
  if (!base) return null
  const city = hint?.name ?? COUNTRY_CITY_FALLBACK[code] ?? ""
  return { key: city ? `${code} · ${city}` : code, code, city, label: city || code, base: [base[0], base[1]] }
}
