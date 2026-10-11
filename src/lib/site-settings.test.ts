// 站点设置的取值与收窄：Hub 存回来的是自由 JSON，任何一格都不许把页面带崩。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
//
// 重点在三处容易静默出错的地方：
//   1. cardStyle：两档（doodle / checklist），认不出的值必须回落默认而不是把整页画空；
//   2. listTop：四选一（none / groups / summary / both）；
//   3. 收窄的类型纪律：字符串 "false" 不算布尔、空串不算"没填过"（pingLines 留空是有意义的值）。
// 末尾双向断「theme.json 声明了没 / DEFAULTS 兜底了没」——半截状态（字段删了、对话框还画着一格）
// 最难发现。
import { readFileSync } from "node:fs"

import {
  CARD_STYLES, DEFAULTS, REMARK_PLACEMENTS, cardStyleOf, cardStyleOrNull, hasGroupTabs,
  hasSummary, isBeijingNight, listTopOf, normalizeConfig, remarksOnCards, remarksOnDetail, resolveDark,
} from "./site-settings.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

// ── cardStyle：两档 + 收窄 ────────────────────────────────────────────
eq(CARD_STYLES, ["doodle", "checklist"], "两档的顺序（顶栏菜单按它排）")
for (const v of CARD_STYLES) eq(cardStyleOf(v), v, `cardStyle 保留 ${v}`)
eq(cardStyleOf("nope"), "doodle", "cardStyle 认不出的值回落 DEFAULTS.cardStyle")
eq(cardStyleOf(undefined), "doodle", "cardStyle 没存过回落 DEFAULTS")
eq(cardStyleOrNull("nope"), null, "认不出的值 → null（访客那边=没选过，跟着站长走）")
eq(cardStyleOrNull(null), null, "没存过 → null")
eq(cardStyleOrNull(""), null, "空串 → null")
eq(cardStyleOrNull(3), null, "数字 → null（localStorage 里什么字符串都可能）")
eq(DEFAULTS.cardStyle, "doodle", "默认档是「涂鸦卡片」")

// ── listTop：四选一 ──────────────────────────────────────────────────
for (const v of ["none", "groups", "summary", "both"]) eq(listTopOf(v), v, `listTop 保留 ${v}`)
eq(listTopOf("budget"), "both", "上一枚主题的旧档位（budget/bothBudget）不在这套取值里 → 回落默认")
eq(listTopOf(undefined), "both", "没存过 → 默认「两个都显示」")
eq(DEFAULTS.listTop, "both", "默认是「两个都显示」")
eq(hasGroupTabs("groups"), true, "groups 有分组标签行")
eq(hasGroupTabs("summary"), false, "summary 没有分组标签行")
eq(hasGroupTabs("both"), true, "both 两组都有")
eq(hasSummary("summary"), true, "summary 有概览便签")
eq(hasSummary("none"), false, "none 两个都没有")

// ── 备注显示位置：白名单两处 ─────────────────────────────────────────
eq(REMARK_PLACEMENTS, ["both", "card", "detail", "none"], "备注四档")
eq(remarksOnCards("both") && remarksOnCards("card"), true, "卡片侧：both / card")
eq(remarksOnCards("detail") || remarksOnCards("none"), false, "卡片侧：detail / none 不摊")
eq(remarksOnDetail("both") && remarksOnDetail("detail"), true, "详情侧：both / detail")
eq(remarksOnDetail("card") || remarksOnDetail("none"), false, "详情侧：card / none 不摊")

// ── normalizeConfig：逐项收窄 ────────────────────────────────────────
eq(normalizeConfig({}), DEFAULTS, "空配置 → 全默认")
eq(normalizeConfig(null), DEFAULTS, "null → 全默认")
eq(normalizeConfig("junk"), DEFAULTS, "非对象 → 全默认")
eq(normalizeConfig({ mapOn: "false" }).mapOn, true, '布尔项只认真布尔："false" 字符串不算数')
eq(normalizeConfig({ mapOn: false }).mapOn, false, "真布尔 false 收下")
eq(normalizeConfig({ pingLines: "" }).pingLines, "", '留空是有意义的值：空串保留（= 自动取前几条）')
eq(normalizeConfig({ pingLines: null }).pingLines, "", "null → 回落默认（空串）")
eq(normalizeConfig({ pingLines: "广东电信\n北京联通" }).pingLines, "广东电信\n北京联通", "多行文本原样保留")
eq(normalizeConfig({ themeMode: "neon" }).themeMode, "system", "不认识的明暗档回落 system")
eq(normalizeConfig({ themeMode: "dark" }).themeMode, "dark", "合法明暗档保留")
eq(normalizeConfig({ remarkPlacement: "card" }).remarkPlacement, "card", "备注位置保留")
eq(normalizeConfig({ remarkPlacement: 7 }).remarkPlacement, "both", "备注位置类型不对回落 both")
eq(normalizeConfig({ cardStyle: "doodle", listTop: "both" }), DEFAULTS, "存过的合法值与默认一致")

// ── 时钟与明暗 ───────────────────────────────────────────────────────
eq(isBeijingNight(new Date("2026-10-11T12:00:00Z")), true, "北京时间 20:00 → 夜（UTC 12:00）")
eq(isBeijingNight(new Date("2026-10-11T00:00:00Z")), false, "北京时间 08:00 → 昼（UTC 0:00）")
eq(isBeijingNight(new Date("2026-10-11T18:59:00Z")), true, "UTC 18:59 → 北京时间 02:59，仍是夜")
eq(isBeijingNight(new Date("2026-10-11T23:00:00Z")), false, "UTC 23:00 → 北京时间 07:00，夜结束（边界值 07:00 不算夜）")
eq(resolveDark("light", true), false, "固定亮压过系统暗")
eq(resolveDark("dark", false), true, "固定暗压过系统亮")
eq(resolveDark("system", true), true, "system 跟系统")
eq(resolveDark("auto", false, new Date("2026-10-11T12:00:00Z")), true, "auto 按北京时间（20:00 → 暗）")

// ── theme.json ↔ DEFAULTS：两边逐项对得上 ────────────────────────────
const manifest = JSON.parse(readFileSync(new URL("../../theme.json", import.meta.url), "utf8")) as {
  config: { type: string; key?: string; default?: unknown }[]
}
const fields = manifest.config.filter((f) => f.type !== "title" && f.key)
eq(fields.length, 6, "设置项就是 6 个（>6 会切两列 + 分组导航）")
for (const field of fields) {
  eq(field.key! in DEFAULTS, true, `theme.json 的 ${field.key} 在 DEFAULTS 里有`)
  eq((DEFAULTS as Record<string, unknown>)[field.key!], field.default, `${field.key} 的默认值两边一致`)
}
eq(Object.keys(DEFAULTS).length, fields.length, "DEFAULTS 的键数与 theme.json 逐项对齐（不多不少）")

if (failed) {
  console.error(`\n${failed} 条失败`)
  process.exit(1)
}
console.log("site-settings：全部通过")
