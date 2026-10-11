/**
 * 手绘感的底层算法：确定性抖动（把直线画弯一点、把圆画歪一点）。
 *
 * 为什么要「确定性」：这些路径每次重渲染都会重算，抖动若带随机性，卡片每两秒一次的
 * 数据刷新会让地图与走势线整片抖个不停（看着像坏了）。下标 + 种子进、同一串数出，
 * 页面上的每一笔就都是画过的那一笔。
 */

/** 确定性伪随机：返回 [0, 1)。同一组 (n, seed) 永远同一个数。 */
export function rand01(n: number, seed: number): number {
  let x = (n + Math.imul(seed, 7919)) | 0
  x = Math.imul(x ^ (x >>> 15), 2246822507)
  x = Math.imul(x ^ (x >>> 13), 3266489909)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/**
 * 把一串点抖成「手画过的」那串：每个点加一点确定性偏移，偏移先低通一遍
 * （相邻点不能各抖各的，那看起来是噪点；低通之后是一条微微起伏的线）。
 *
 * @param close 闭合环（海岸线）：首尾也要参与低通，否则接缝处会有一个小折角。
 */
export function wobblePoints(
  pts: Array<[number, number]>,
  seed: number,
  amp = 0.8,
  close = false,
): Array<[number, number]> {
  const n = pts.length
  if (n === 0) return pts
  const raw = (k: number) => (rand01(k, seed) - 0.5) * 2
  const smooth = (get: (i: number) => number) => {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const a = get(i)
      const b = close ? get((i - 1 + n) % n) : get(Math.max(0, i - 1))
      const c = close ? get((i + 1) % n) : get(Math.min(n - 1, i + 1))
      out.push((a * 2 + b + c) / 4)
    }
    return out
  }
  const sx = smooth((i) => raw(i * 2))
  const sy = smooth((i) => raw(i * 2 + 1))
  return pts.map(([x, y], i) => [x + sx[i] * amp, y + sy[i] * amp] as [number, number])
}

/** 一串点 → SVG 路径（默认不闭合）。 */
export function polylinePath(pts: Array<[number, number]>, close = false): string {
  if (pts.length === 0) return ""
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("")
  return close ? `${d}Z` : d
}

/** 一串点 → 抖动过的手绘路径。 */
export function wobblePath(pts: Array<[number, number]>, seed: number, amp = 0.8, close = false): string {
  return polylinePath(wobblePoints(pts, seed, amp, close), close)
}
