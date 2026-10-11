import type { Node } from "./api.ts"
import { rand01, wobblePath } from "./sketch.ts"
import { CITY_HINTS, COUNTRY_LL, WORLD_OUTLINES } from "./world.ts"

/**
 * 地图这一块的纯函数：投影、海岸线路径、图钉落点。全部与 React 无关，方便单测。
 *
 * 为什么是**等距圆柱的平铺世界地图**而不是上一枚主题那颗会转的正射地球：
 * 这个主题的物理隐喻是「手绘笔记本」，而笔记本里贴的是一张**世界地图**——
 * 平铺的纸面可以直接用胶带贴住四角、用图钉钉住机器，转动的地球画在纸上反而奇怪。
 * 经度按整幅摊平，纬度裁掉两极（84°N ~ 60°S：数据中心不会开在南极，裁掉之后
 * 图幅比例接近 2.4:1，在宽屏上是一条正好放进「贴纸」这个角色的横幅）。
 */

export const MAP_VIEW = { w: 720, h: 300 } as const
/** 纬度范围：南纬 60° 以下与北纬 84° 以上的空白裁掉。 */
const LAT_TOP = 84
const LAT_BOTTOM = -60

/** 经纬度 → 画布坐标（等距圆柱）。 */
export function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * MAP_VIEW.w
  const clamped = Math.min(LAT_TOP, Math.max(LAT_BOTTOM, lat))
  const y = ((LAT_TOP - clamped) / (LAT_TOP - LAT_BOTTOM)) * MAP_VIEW.h
  return [x, y]
}

let base: { land: string; grid: string[] } | null = null

/**
 * 底图：海岸线（79 个环，抖过一遍的手绘线）与经纬网。
 * 模块级缓存 —— 1483 个点抖一次几毫秒，但没必要每次渲染都来一遍。
 */
export function mapBase(): { land: string; grid: string[] } {
  if (base) return base
  const land = WORLD_OUTLINES.map((ring, i) =>
    wobblePath(ring.map(([lon, lat]) => project(lon, lat)), 11 + i * 13, 1.0, true),
  ).join(" ")
  const grid: string[] = []
  // 经线：每 60° 一条（-120 .. 120）。
  for (let lon = -120; lon <= 120; lon += 60) {
    const pts: Array<[number, number]> = []
    for (let lat = LAT_TOP; lat >= LAT_BOTTOM; lat -= 12) pts.push(project(lon, lat))
    grid.push(wobblePath(pts, 90 + lon, 0.5))
  }
  // 纬线：每 30° 一条（-60 .. 60，含赤道）。
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts: Array<[number, number]> = []
    for (let lon = -180; lon <= 180; lon += 12) pts.push(project(lon, lat))
    grid.push(wobblePath(pts, 160 + lat, 0.5))
  }
  base = { land, grid }
  return base
}

export type Geo = { ll: [number, number]; city: string | null }

/**
 * 一台机器在地图上的位置：名字 / 分组里认得出城市就按城市（香港、东京、新加坡……，
 * 线索表见 world.ts 的 CITY_HINTS），否则退到 hub 给的国家的落点；都不认就不放图钉。
 */
export function geoOf(node: Node): Geo | null {
  const text = `${node.name} ${node.group ?? ""}`
  for (const hint of CITY_HINTS) {
    if (hint.match.test(text)) return { ll: hint.ll, city: hint.name }
  }
  const code = (node.country || "").trim().toUpperCase()
  const ll = COUNTRY_LL[code]
  return ll ? { ll, city: null } : null
}

export type Pin = {
  id: number
  name: string
  x: number
  y: number
  online: boolean
  /** 从未接入过的机器（连规格都没有）：图钉画成一枚空心圈。 */
  deployed: boolean
  /** 图钉自己的小歪头（每台一个固定值，看着像随手钉的）。 */
  tilt: number
}

export type MapPins = {
  pins: Pin[]
  /** 有位置、画在图上的台数。 */
  located: number
  /** 定位不出来（名字里没有城市线索、hub 也没给国家）的台数。 */
  missing: number
}

/**
 * 节点 → 图钉。同城的机器在一小圈上岔开（都钉在同一个点上会叠成一枚），
 * 岔开的偏移是确定性的（按 id 取角与半径），所以每次重渲染都钉在同一处。
 */
export function mapPins(nodes: Node[]): MapPins {
  const groups = new Map<string, { node: Node; ll: [number, number] }[]>()
  let missing = 0
  for (const node of nodes) {
    const geo = geoOf(node)
    if (!geo) {
      missing++
      continue
    }
    const key = `${geo.ll[0].toFixed(1)},${geo.ll[1].toFixed(1)}`
    const list = groups.get(key) ?? []
    list.push({ node, ll: geo.ll })
    groups.set(key, list)
  }
  const pins: Pin[] = []
  for (const list of groups.values()) {
    list.forEach(({ node, ll }, index) => {
      let [lon, lat] = ll
      if (list.length > 1) {
        const angle = (index / list.length) * Math.PI * 2 + rand01(node.id, 31) * 0.8
        const radius = 0.8 + rand01(node.id, 47) * 0.9
        lon += Math.cos(angle) * radius * 1.9
        lat += Math.sin(angle) * radius * 0.95
      }
      const [x, y] = project(lon, lat)
      pins.push({
        id: node.id,
        name: node.name,
        x,
        y,
        online: node.online,
        deployed: node.cpu_cores > 0 || node.mem_total > 0,
        tilt: (rand01(node.id, 7) - 0.5) * 26,
      })
    })
  }
  return { pins, located: pins.length, missing }
}
