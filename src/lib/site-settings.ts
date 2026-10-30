/**
 * 站点级设置的「值」这一层：类型、默认值，以及 Hub 存回来的自由 JSON 怎么收窄成它们。
 *
 * 单独一个文件是为了能脱开 React 与 `@/` 别名直接跑测试（见 site-settings.test.ts）：
 * 这边最容易悄悄错的是**收窄**——Hub 存的是自由 JSON，站长清空输入框可能留下空串或
 * null，一个空串就能把默认值顶掉（图片类设置因此变成一枚破图）。
 *
 * 两边必须逐字一致的两处：theme.json 的表单（面板画什么）、这里的 DEFAULTS（页面兜底什么），
 * `scripts/check-config.mjs` 在打包前对一遍。
 */

export type ThemeConfig = {
  /**
   * 列表页顶部显示什么：none = 都不显示；groups = 分组标签行；summary = 概览便签；
   * both = 两个都显示（默认）。
   */
  listTop: "none" | "groups" | "summary" | "both"
  /** 卡片「三网延迟」要显示的线路，按名字指定（ping 任务名），一行一个。 */
  pingLines: string
  /** 「备注显示位置」：备注小标签摊在哪儿（卡片 / 整页详情 / 两边都摊 / 都不显示）。 */
  remarkPlacement: RemarkPlacement
  /** 站点用哪一档明暗：随系统 / 随北京时间自动 / 固定亮（纸面）/ 固定暗（黑板）。 */
  themeMode: ThemeMode
}

/** 四档明暗：`system` 随系统、`auto` 按北京时间自动、`light`/`dark` 固定。 */
export type ThemeMode = "system" | "auto" | "light" | "dark"

/** 四档的取值与顺序（后台那格下拉、`normalizeConfig` 都照它）。 */
export const THEME_MODES: ThemeMode[] = ["system", "auto", "light", "dark"]

/** 「备注显示位置」：`both` 卡片与详情页（默认）/ `card` 只在卡片 / `detail` 只在整页详情 / `none` 都不显示。 */
export type RemarkPlacement = "both" | "card" | "detail" | "none"

/** 四档取值（`normalizeConfig` 认这四样，别的都回落到 `both`）。 */
export const REMARK_PLACEMENTS: RemarkPlacement[] = ["both", "card", "detail", "none"]

/**
 * 「列表页顶部」四档（后台那格下拉、`normalizeConfig` 都照它）。
 * 上一个主题里这个键有六档（概览卡片还分「原版 / 价值版」两副面孔）；
 * 这一版把概览收成一张便签，四档正好覆盖「显示哪两行」的全部组合。
 */
export const LIST_TOPS: ThemeConfig["listTop"][] = ["none", "groups", "summary", "both"]

/**
 * 卡片那一侧（涂鸦卡片标题行、备注小标签）要不要摊备注。
 * 与 `remarksOnDetail` 是一对，两处合起来恰好覆盖「备注的落点」那四档口径。
 *
 * ★写成**白名单**（只认 `both`/`card`）而不是「不等于 detail」：后者在新增第四档
 * 「都不显示」时会悄悄把卡片侧漏开（备注没关掉），是那种「看着改了、其实没生效」的坏实现。
 */
export function remarksOnCards(p: RemarkPlacement): boolean {
  return p === "both" || p === "card"
}

/** 整页详情（点进去那一页）要不要摊备注。同样写成白名单。 */
export function remarksOnDetail(p: RemarkPlacement): boolean {
  return p === "both" || p === "detail"
}

export const DEFAULTS: ThemeConfig = {
  // 默认「两个都显示」：分组标签行 + 概览便签。
  listTop: "both",
  // 延迟线路：留空 = 按后台顺序自动显示前几条；填了名字就只显示这些（一行一个）。
  pingLines: "",
  // 备注显示位置：默认两边都摊。
  remarkPlacement: "both",
  // 明暗默认「随系统」。
  themeMode: "system",
}

/** 「列表页顶部」这一档的取值，认不出来就 `null`。 */
export function listTopOrNull(v: unknown): ThemeConfig["listTop"] | null {
  return LIST_TOPS.includes(v as ThemeConfig["listTop"]) ? (v as ThemeConfig["listTop"]) : null
}

export function listTopOf(v: unknown): ThemeConfig["listTop"] {
  return listTopOrNull(v) ?? DEFAULTS.listTop
}

/** 表单是四选一，页面只关心这两个布尔：分组标签行、概览便签。 */
export function hasGroupTabs(top: ThemeConfig["listTop"]): boolean {
  return top === "groups" || top === "both"
}

export function hasSummary(top: ThemeConfig["listTop"]): boolean {
  return top === "summary" || top === "both"
}

/** 收窄 Hub 存回来的设置。逐项收窄类型；认不出来的值一律回落默认值。 */
export function normalizeConfig(saved: unknown): ThemeConfig {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>
  // ★卡片形态与节点地图已从主题里拿掉（2026-10-30）：库里还留着 cardStyle / mapOn 两个旧键，
  // 这里**不认**它们 —— 收窄时只挑自己认识的键，旧值自然被忽略，不用清理数据库。
  return {
    listTop: listTopOf(s.listTop),
    // 留空是有意义的值（= 自动取前几条），空串不能当「没填过」；只有类型不对时才回落。
    pingLines: typeof s.pingLines === "string" ? s.pingLines : DEFAULTS.pingLines,
    // 「备注显示位置」只认那四档。
    remarkPlacement: REMARK_PLACEMENTS.includes(s.remarkPlacement as RemarkPlacement)
      ? (s.remarkPlacement as RemarkPlacement)
      : DEFAULTS.remarkPlacement,
    // 四档明暗：认不出来的取值回落默认，别让页面卡在一个不存在的档上。
    themeMode: THEME_MODES.includes(s.themeMode as ThemeMode) ? (s.themeMode as ThemeMode) : DEFAULTS.themeMode,
  }
}

/**
 * 北京时间（UTC+8）现在是几点（0–23）。
 *
 * 用固定偏移而不是 `Intl`：中国全境不实行夏令时，UTC+8 就是北京时间；`Intl` 那套在
 * 少数老浏览器/精简 ICU 上会抛，而这里要的只是一个钟点。
 */
export function beijingHour(at: Date = new Date()): number {
  return (at.getUTCHours() + 8) % 24
}

/** 「随北京时间自动切换」的夜间窗口：**19:00 起、次日 07:00 止**（用暗色）。 */
export const NIGHT_FROM = 19
export const NIGHT_TO = 7

/** 按北京时间算，现在是不是夜里（该用暗色）。 */
export function isBeijingNight(at: Date = new Date()): boolean {
  const h = beijingHour(at)
  return h >= NIGHT_FROM || h < NIGHT_TO
}

/**
 * 站点设置 + 系统的明暗偏好 → 最终该不该用暗色。
 *
 * `auto` 只按钟点走（不查日出日落：那要经纬度与天文算法，而站长要的是「白天亮、晚上暗」）；
 * 访客自己点过那枚太阳/月亮图标的话，组件会拿他的选择**压过**这里的结论。
 */
export function resolveDark(mode: ThemeMode, systemDark: boolean, at: Date = new Date()): boolean {
  if (mode === "dark") return true
  if (mode === "light") return false
  if (mode === "auto") return isBeijingNight(at)
  return systemDark
}
