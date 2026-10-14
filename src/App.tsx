import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Map as MapIcon, Moon, Sun, Wrench } from "lucide-react"

import { CardStyleMenu } from "@/components/CardStyleMenu"
import { Checklist } from "@/components/Checklist"
import { FarmIcon } from "@/components/FarmIcon"
import { MapSheet } from "@/components/MapSheet"
import { Memo } from "@/components/Memo"
import { NodeCard } from "@/components/NodeCard"
import { SearchBox, SearchRow } from "@/components/SearchBox"
import { api, groupView, useNodes } from "@/lib/api"
import { searchNodes } from "@/lib/search"
import { hasGroupTabs, hasSummary, useCardStyle, useLocalFarm, useMapVisible, useThemeConfig } from "@/lib/theme-config"
import { isBeijingNight, resolveDark, type RemarkPlacement, type ThemeMode } from "@/lib/site-settings"

type Me = {
  authed: boolean
  github: boolean
  site_name: string
  public_page: boolean
  /** hub 的历史保留天数（1~365，1.3.2 起默认 30）。老 hub 不给：时间范围按 7 天算。 */
  history_days?: number
}

// The tab title cache key, shared with the inline script in index.html. Kept as the
// theme's own key so two themes on one origin cannot fight over it.
const TITLE_CACHE_KEY = "rakugaki-re:site_name"

// 页脚署名里指向的源码仓库 —— 与 theme.json 的 `url` 是同一个地址。
const REPO_URL = "https://github.com/akanotanin/monitor-theme-rakugaki-re"

// Split out because the list page draws no chart: the detail view (with its own
// hand-drawn charts) travels as its own chunk. 取它的时机见 App 里的 warmDetail：
// 列表画完之后空闲时取、指针落到卡片上时立刻取、开页就在详情页时立刻取。
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

/**
 * 详情页的骨架：按详情页真实的那几块摆（返回链接 + 标题行 + 规格格 + 页签行 + 图块），
 * 不是一枚 `h-96`。它露面的场景只有点开时 chunk 还没到的那一下，高度接近真实内容，
 * 就不会「先塌再撑」。
 */
function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="dg-skel h-5 w-24" />
      <div className="flex items-center gap-2.5">
        <div className="dg-skel size-[23px] shrink-0" />
        <div className="dg-skel h-7 w-44" />
      </div>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="dg-skel h-3.5 w-12" />
            <div className="dg-skel h-4 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t-[1.5px] border-dashed border-line-strong pt-4">
        <div className="flex gap-2">
          <div className="dg-skel h-6 w-14" />
          <div className="dg-skel h-6 w-16" />
        </div>
      </div>
      <div className="space-y-5">
        {[0, 1].map((i) => (
          <div key={i}>
            <div className="dg-skel mb-2 h-4 w-16" />
            <div className="dg-skel h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
function useNodeRoute() {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => setId(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    id,
    (next: number | null) => {
      history.pushState({}, "", next === null ? "/" : `/node/${next}`)
      setId(next)
      scrollTo(0, 0)
    },
  ] as const
}

const DARK_MEDIA = matchMedia("(prefers-color-scheme: dark)")

/**
 * 明暗：站长那一档（`themeMode`）是默认，访客点过顶栏那枚图标就以他的为准
 * （存 localStorage 的 `theme`）；选成与站长那一档一致时把记录删掉（= 重新跟着站长走）。
 * 「随北京时间自动」自己跨 19:00 / 07:00：每分钟问一次现在几点（几乎不要钱）。
 */
function useTheme(siteMode: ThemeMode) {
  const [saved, setSaved] = useState(() => {
    try {
      return localStorage.getItem("theme")
    } catch {
      return null
    }
  })
  const system = useSyncExternalStore(
    (notify) => {
      DARK_MEDIA.addEventListener("change", notify)
      return () => DARK_MEDIA.removeEventListener("change", notify)
    },
    () => DARK_MEDIA.matches,
  )
  const [night, setNight] = useState(() => isBeijingNight())
  useEffect(() => {
    if (siteMode !== "auto") return
    // oxlint-disable-next-line react/set-state-in-effect -- 「随北京时间自动」要跟外部时钟对表，正该放 effect
    setNight(isBeijingNight())
    const timer = setInterval(() => setNight(isBeijingNight()), 60_000)
    return () => clearInterval(timer)
  }, [siteMode])
  const fromSite = siteMode === "auto" ? night : resolveDark(siteMode, system)
  const dark = saved ? saved === "dark" : fromSite

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    /**
     * 手机浏览器那一圈（`theme-color`）跟着**页面实际用的**明暗走：
     * index.html 里那两份是静态值、按系统明暗挑的；「随北京时间自动」在夜里
     * 与系统相反时两边会打架 —— 所以摘掉那两份、换成一份没有 media 的。
     * 颜色取 `--paper` 的实际值（交给 canvas 读回 sRGB），不手抄 hex。
     */
    const head = document.head
    for (const old of head.querySelectorAll('meta[name="theme-color"]')) old.remove()
    const meta = document.createElement("meta")
    meta.name = "theme-color"
    let color = dark ? "#2c302e" : "#fffef5"
    const probe = document.createElement("canvas")
    probe.width = probe.height = 1
    const ctx = probe.getContext("2d")
    if (ctx) {
      ctx.fillStyle = color
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      color = `rgb(${r}, ${g}, ${b})`
    }
    meta.content = color
    head.append(meta)
  }, [dark])

  return [
    dark,
    () => {
      const next = dark ? "light" : "dark"
      const record = (next === "dark") === fromSite ? null : next
      try {
        if (record === null) localStorage.removeItem("theme")
        else localStorage.setItem("theme", record)
      } catch {
        // 存储被禁用（隐私模式）：这次会话照样切，只是记不住。
      }
      setSaved(record)
    },
  ] as const
}

export default function App() {
  const config = useThemeConfig()
  const [dark, toggleTheme] = useTheme(config.themeMode)
  // 顶栏那枚入口图标（没有设置项）：挂载即探一次本站约定的 `/chicken/`，
  // 装了那座小鸡农场才出现、没装不占位。
  const farmUrl = useLocalFarm()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  // The list's group tab, held here so it survives a visit to a node's page.
  const [group, setGroup] = useState<string | null>(null)
  // 访客自己的两个偏好（都只存在他自己浏览器里，见 @/lib/theme-config）：
  // 地图看不看，以及列表用哪种卡片形态 —— 后者没选过时跟着站长的设置走。
  const [mapOn, toggleMap] = useMapVisible(config.mapOn)
  const [cardStyle, chooseStyle] = useCardStyle(config.cardStyle)
  // 顶栏那个搜索框：词与「窄屏那一行展开了没」都留在这儿 —— 进详情页再回来，搜到的那几台还在。
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const collapseSearch = () => setSearchOpen(false)
  const onSearchActivate = () => {
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches
    setSearchOpen((was) => (narrow ? !was : false))
  }
  const closeSearchRow = () => {
    setSearchOpen(false)
    setQuery("")
  }

  const loadMe = useCallback(() => {
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  /**
   * 详情页那块 chunk 什么时候取：三条路，谁先到听谁的。
   *   ① 开页就在详情页（书签、刷新、分享链接）：立刻取 —— 它就是要画的那一块。
   *   ② 列表画出来之后：交给浏览器挑空闲时机取（别和首屏的入口包与第一批数据抢链路）。
   *   ③ 指针或键盘落到某张卡片上（悬停、聚焦、触摸）：立刻取 —— 真要打开的人多半已经摸过卡片。
   */
  const warmed = useRef(false)
  const warmDetail = useCallback(() => {
    warmed.current = true
    void loadDetail()
  }, [])
  const listReady = nodes !== null
  useEffect(() => {
    if (warmed.current) return
    if (open !== null) { warmDetail(); return }
    if (!listReady) return
    let idle = 0
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (typeof requestIdleCallback === "function") idle = requestIdleCallback(warmDetail, { timeout: 2000 })
        else warmDetail()
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      if (idle) cancelIdleCallback(idle)
    }
  }, [open, listReady, warmDetail])

  // The status page was closed while this tab was open: re-query, then redirect.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  // 在线优先：**离线的机器一律沉到列表最末尾**（站长 2026-10-14 的口径「离线服务器的卡片排到
  // 所有卡片的最末尾」）。组内仍按站长排序（`sort`，并列再按 `id`），所以这只是在排序键前面
  // 加了一层「在线 0 / 离线 1」——同一台机器在两次帧之间的位置是确定的，不会自己抖动。
  // 「离线」= hub 的 `online` 为假，包含「曾接入但掉线」与「从未接入」两种；它们在这里不再
  // 占在线机器前面的位置。分组/地区/搜索那几层筛选都从这份排好序的列表上切，所以每个页签里
  // 离线也都是垫底的。
  const sorted = [...(nodes ?? [])].sort(
    (a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1) || a.sort - b.sort || a.id - b.id,
  )
  const selected = sorted.find((n) => n.id === open)
  // 分组筛选只求值一次（@/lib/api 的 groupView）：概览便签与下面的列表吃的是同一份
  // 「该显示哪几台」，切分组时两边一起变。
  const view = groupView(sorted, group, hasGroupTabs(config.listTop))
  // 再叠一层搜索（口径见 @/lib/search）：便签与列表一起收窄。
  const found = searchNodes(view.shown, query)
  const listView = { ...view, shown: found.shown }

  // 详情页的标签页要写「节点名 · 站名」；数据没到就不要写（占位值只会多闪一跳）。
  useEffect(() => {
    if (!me) return
    const siteName = me.site_name || "Monitor"
    // oxlint-disable-next-line react/immutability -- 标题握手的门（__titleOwned）按约定长在 window 上，就是要写全局
    ;(window as unknown as { __titleOwned?: boolean }).__titleOwned = true
    // oxlint-disable-next-line react/immutability -- 换标题本来就是本组件的活儿，document 是它要同步的外部对象
    document.title = [selected?.name, siteName].filter(Boolean).join(" · ")
    try {
      localStorage.setItem(TITLE_CACHE_KEY, siteName)
    } catch {
      // 隐私模式 / 存储被禁用：标签页照常，刷新时退回占位值。
    }
  }, [selected?.name, me])

  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-[13px] text-ink-3">
      {meError ? (
        <div className="space-y-3 text-center">
          <p role="alert">加载失败：{meError}</p>
          <button type="button" className="dg-btn tap" onClick={loadMe}>重试</button>
        </div>
      ) : "加载中…"}
    </div>
  )

  if (!me.public_page && !me.authed) return null

  return (
    // 纵向排下来、页脚吊在最后（main 吃满剩余高度）：内容比一屏短时署名也落在最底下。
    <div className="flex min-h-svh flex-col">
      <header className="dg-header">
        {/* 站名优先展开、图标自己滑：站名那格 max-w-[55%]（正常名字完整显示，只有长到
            离谱才轮到 truncate），剩下几枚图标装进一条能横向滑动的条带里。 */}
        <div className="mx-auto flex max-w-[1280px] items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
          <button className="tap flex max-w-[55%] shrink-0 items-center gap-2.5" onClick={() => go(null)}>
            <SiteIcon />
            <span className="dg-name dg-hl truncate text-[17.5px]">{me.site_name || "Monitor"}</span>
          </button>
          <div className="flex-1" />
          {/* 搜索：只长在列表页 —— 它收窄的就是下面那张列表。 */}
          {open === null && (
            <SearchBox
              value={query}
              onChange={setQuery}
              onActivate={onSearchActivate}
              onClose={collapseSearch}
              hits={found.hit}
            />
          )}
          {/* 图标条带：装不下就横向滑动；间距 12px = 两枚图标各 ±6px 命中区正好相接。 */}
          <div className="header-tools -my-1.5 flex min-w-0 items-center gap-3 overflow-x-auto px-1.5 py-1.5">
            <a
              href="/admin/"
              className="dg-icon tap"
              title={me.authed ? "进入后台" : "登录"}
              aria-label={me.authed ? "进入后台" : "登录"}
            >
              <Wrench />
            </a>
            {open === null && (
              <CardStyleMenu value={cardStyle} siteDefault={config.cardStyle} onPick={chooseStyle} />
            )}
            {/* 地图开关：只长在列表页。站长关掉时整枚按钮都不挂（那一块是关着的）。 */}
            {open === null && config.mapOn && (
              <button
                type="button"
                className="dg-icon tap globe-toggle"
                aria-pressed={mapOn}
                onClick={toggleMap}
                title={mapOn ? "收起节点地图" : "展开节点地图"}
                aria-label={mapOn ? "收起节点地图" : "展开节点地图"}
              >
                <MapIcon />
              </button>
            )}
            {/* 入口图标：本站 `/chicken/` 上真装了那座小鸡农场才出现（自动探测）。 */}
            {farmUrl && (
              <a href={farmUrl} className="dg-icon tap" title="养鸡场" aria-label="养鸡场">
                <FarmIcon />
              </a>
            )}
            <button
              type="button"
              className="dg-icon tap"
              onClick={toggleTheme}
              title="切换主题"
              aria-label="切换主题"
            >
              {dark ? <Sun /> : <Moon />}
            </button>
          </div>
        </div>
        {/* 窄屏点开搜索后在顶栏下面多出来的那一行（header 的直接子节点 → 一起吸顶）。 */}
        {open === null && searchOpen && (
          <SearchRow value={query} onChange={setQuery} onClose={closeSearchRow} />
        )}
        {/* 顶栏下沿：一条手绘波浪线。 */}
        <div className="dg-squiggle" aria-hidden />
      </header>

      <main className="relative mx-auto w-full max-w-[1280px] flex-1 space-y-5 px-4 py-4 sm:px-6">
        {/* 纸面装饰：页边线与装订孔（够宽才出现，纯装饰）。 */}
        <i className="dg-margin-line" aria-hidden />
        <i className="dg-binding" aria-hidden />

        {error && <p className="text-[13px] text-red-ink">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <DetailSkeleton />
          ) : selected ? (
            <Suspense fallback={<DetailSkeleton />}>
              <NodeDetail
                node={selected}
                onBack={() => go(null)}
                historyDays={me.history_days}
                remarkPlacement={config.remarkPlacement}
              />
            </Suspense>
          ) : (
            <p className="dg-empty py-16 text-center">
              节点不存在或未公开。<button className="dg-wavy" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          // 还在等节点列表：骨架按当前形态画。
          cardStyle === "checklist" ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="dg-skel h-11" />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="dg-skel h-72" />
              ))}
            </div>
          )
        ) : (
          <>
            {/* 概览便签：设置里没选它时整个不挂载（不是藏起来）。 */}
            {hasSummary(config.listTop) && <Memo nodes={found.shown} group={view.current} searching={found.active} />}
            {/* 节点地图：便签之下、列表之上。 */}
            {mapOn && <MapSheet nodes={view.shown} onOpen={go} />}
            {/* 一台都剩不下时说清楚是谁把它筛没的，并指回去哪儿取消。 */}
            {found.active && found.shown.length === 0 ? (
              <p className="dg-empty py-2">
                当前筛选下没有匹配「{found.query.trim()}」的节点 —— 名称、地区、系统三处都能搜
                （多个词用空格隔开，要同时命中）；点搜索框里那枚 × 清掉。
              </p>
            ) : null}
            <NodeList
              view={listView}
              group={group}
              onGroup={setGroup}
              onOpen={go}
              onWarm={warmDetail}
              latencyLines={config.pingLines}
              historyDays={me.history_days}
              cardStyle={cardStyle}
              remarkPlacement={config.remarkPlacement}
            />
          </>
        )}
      </main>

      {/* 页脚：一条手绘波浪 + 一行署名。主题名那一截在仓库地址不为空时是链接
          （新标签页打开，别把访客从状态页带走）。 */}
      <footer className="mx-auto mt-2 w-full max-w-[1280px] px-4 pb-6 pt-3 sm:px-6">
        <div className="dg-squiggle mx-auto mb-4 max-w-[380px]" aria-hidden />
        <p className="dg-credit text-center">
          Theme:{" "}
          {REPO_URL ? (
            <a href={REPO_URL} target="_blank" rel="noreferrer">rakugaki re</a>
          ) : (
            <span>rakugaki re</span>
          )}
        </p>
      </footer>
    </div>
  )
}

/**
 * 顶栏那枚小圆标：**就是站点图标本身**，用的是**标签页那条 `<link rel="icon">` 的地址**
 * （hub 1.4.0 起由面板「设置 → 站点图标」管，没设时回落到主题自带的同名文件；hub 送
 * index.html 时会把它改写成带版本号的地址，站长换图浏览器自己会重取）。
 * 取不到就不占位：不留一枚破图。
 */
function SiteIcon() {
  const [href] = useState(() => document.querySelector('link[rel~="icon"]')?.getAttribute("href") || "/favicon.svg")
  const [broken, setBroken] = useState(false)
  if (broken) return null
  // 一块贴在标题左边的「小贴纸」：虚线外圈 + 一丝歪头。
  return (
    <span className="grid size-9 shrink-0 -rotate-3 place-items-center overflow-hidden rounded-[10px] border-[1.5px] border-dashed border-line-strong bg-card p-[3px]">
      <img src={href} alt="" className="size-full rounded-[6px] object-cover" onError={() => setBroken(true)} />
    </span>
  )
}

/**
 * 列表**分批挂载**：先画一屏的量，剩下的分帧补上（首屏那一次一次性挂 100 张卡
 * 会有 255ms 的长任务；每块 12 张、块间让浏览器先画一帧，效果一样、代价小得多）。
 * 少于一块的量（≤24 台）完全不改变行为。
 */
function useProgressive(total: number, first = 24, step = 12): number {
  const [limit, setLimit] = useState(() => Math.min(total, first))
  const [seenTotal, setSeenTotal] = useState(total)
  if (seenTotal !== total) {
    setSeenTotal(total)
    setLimit(Math.min(total, first))
  }
  useEffect(() => {
    if (limit >= total) return
    const timer = setTimeout(() => setLimit((n) => Math.min(total, n + step)), 0)
    return () => clearTimeout(timer)
  }, [limit, total, step])
  return limit
}

function NodeList({ view, group, onGroup, onOpen, onWarm, latencyLines, historyDays, cardStyle, remarkPlacement }: {
  view: ReturnType<typeof groupView>
  group: string | null
  onGroup: (group: string | null) => void
  onOpen: (id: number) => void
  onWarm: () => void
  latencyLines: string
  /** hub 的历史保留天数：清单展开块那排时间范围按它生成。 */
  historyDays?: number
  cardStyle: "doodle" | "checklist"
  remarkPlacement: RemarkPlacement
}) {
  const { groups, current, shown, tabs, total, showTabs } = view
  const list = shown.slice(0, useProgressive(shown.length))
  // 归一化后的值回写给 App（悬空的选中态被回落时纠正一次，见 groupView 的注释）。
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  return (
    <>
      {/* 分组标签行：一行手写便签。上下间距收紧（它是下面那张列表的筛选条）。 */}
      {showTabs && groups.length > 0 && (
        <div role="group" aria-label="分组" className="dg-tabs -mx-1 -mt-2 mb-1 overflow-x-auto px-1 pb-1">
          {tabs.map(([value, label, count]) => (
            <button
              key={value === null ? "*" : `=${value}`}
              type="button"
              aria-pressed={current === value}
              className={`dg-chip tap ${current === value ? "dg-chip-on" : ""}`}
              onClick={() => onGroup(value)}
            >
              {label}
              <span className="dg-count tnum text-ink-4">{count}</span>
            </button>
          ))}
        </div>
      )}
      {total === 0 ? (
        <p className="dg-empty py-16 text-center">还没有节点</p>
      ) : cardStyle === "checklist" ? (
        <Checklist nodes={list} onOpen={onOpen} onWarm={onWarm} historyDays={historyDays} />
      ) : (
        <div data-card-style="doodle" className="dg-cards grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              onOpen={() => onOpen(n.id)}
              onWarm={onWarm}
              latencyLines={latencyLines}
              remarkPlacement={remarkPlacement}
            />
          ))}
        </div>
      )}
    </>
  )
}
