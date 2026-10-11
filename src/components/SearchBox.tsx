import { Search, X } from "lucide-react"
import { useRef } from "react"

/**
 * 顶栏右上角那个搜索框：按**名称 / 地区 / 系统**把列表收窄到要看的那几台
 * （口径全在 `@/lib/search`，UI 只负责把词交出去）。
 *
 * 形态与手感：**收起时是一枚 36×36 的方形图标**，点它就地长开成输入框
 * （往左边长，右边那几枚图标一枚都不动）；失焦再收回去，**词留着**。
 * 词留着是刻意的：搜索是「这一眼看哪几台」，点开一台机器看清了再回来，那几台理应还在。
 * 清词只有两处：框里那枚 ×，或 Esc（Esc 两段式：有词先清词、框还开着；空框上再按才收起）。
 *
 * 窄屏（<640px）顶栏塞不下 240px 的输入框，长开那份只在 ≥640px 生效；窄屏点那枚图标
 * 是在顶栏**下面多一行**（`SearchRow`，由 App 摆成 header 的直接子节点，跟着 sticky 块吸顶）。
 *
 * 只长在列表页：搜索的对象就是下面那张列表，站在某台机器的详情页里按它没有落点。
 * 词不进 localStorage、也不进 hub：它是「这一眼要看哪几台」，不是偏好。
 */
export function SearchBox({ value, onChange, onActivate, onClose, hits }: {
  value: string
  onChange: (next: string) => void
  /** 焦点落到框里（＝点了那枚方形图标）：桌面上什么都不用做（CSS 自己长开）；窄屏＝把那一行开/关。 */
  onActivate: () => void
  /** 收起（Esc 在空框上按的那一下）。 */
  onClose: () => void
  /** 命中台数：只用在收起态的悬停说明里（`搜索：东京（2 台）`）。 */
  hits: number
}) {
  return (
    <Field
      value={value}
      onChange={onChange}
      onActivate={onActivate}
      onClose={onClose}
      className="dg-search"
      title={value === "" ? "搜索（名称 / 地区 / 系统）" : `搜索：${value}（${hits} 台）`}
    />
  )
}

/**
 * 窄屏展开后的那一整行，摆成 header 的直接子节点（它要占满宽度、也要跟着 header 吸顶）。
 * `autoFocus`：点开就是为了打字，不该再让访客点第二下。
 */
export function SearchRow({ value, onChange, onClose }: {
  value: string
  onChange: (next: string) => void
  onClose: () => void
}) {
  return (
    <div className="border-t-[1.5px] border-dashed border-line-strong px-4 py-2 sm:hidden">
      <Field value={value} onChange={onChange} onClose={onClose} autoFocus className="dg-search-row relative flex w-full items-center" />
    </div>
  )
}

/**
 * 输入框本体。左边一枚放大镜、右边一枚清空（有词**且框长开着**才出现）。
 * 颜色不给（继承顶栏那套前景色）：与旁边那几枚图标逐像素同色——「灰→前景色」
 * 曾用来当「正在筛」的信号，结果这一排里只有放大镜是灰的，一眼就看出来不一致，
 * 所以收起态不再靠颜色说话（命中数写在悬停说明里）。
 */
function Field({ value, onChange, onActivate, onClose, autoFocus, className, title }: {
  value: string
  onChange: (next: string) => void
  onActivate?: () => void
  onClose?: () => void
  autoFocus?: boolean
  className?: string
  title?: string
}) {
  const box = useRef<HTMLInputElement>(null)
  return (
    <span
      className={`tap ${className ?? ""}`}
      // 输入框是**替换元素**，`::before` 在它身上不生成 —— 命中区那圈只能挂在外层这个 span 上。
      // 所以补一手「点到圈上也算点进框里」：否则撑出来的那圈点下去没反应，等于白撑。
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        box.current?.focus()
      }}
    >
      <Search className="dg-search-ico" aria-hidden="true" />
      <input
        ref={box}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onFocus={onActivate}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          // Esc 两段式：有词先清词（这一步谁都用得上）；空框上再按一下才收起。
          if (value !== "") onChange("")
          else {
            box.current?.blur()
            onClose?.()
          }
        }}
        placeholder="搜索名称/地区/系统"
        title={title}
        aria-label="搜索节点：名称、地区、系统"
      />
      {value !== "" && (
        <button
          type="button"
          className="dg-search-clear dg-icon tap !h-7 !w-7"
          onClick={() => {
            onChange("")
            // 清完把焦点留在框里：接着打下一个词不用再点一次。
            box.current?.focus()
          }}
          title="清空"
          aria-label="清空搜索"
        >
          <X className="!size-3.5" />
        </button>
      )}
    </span>
  )
}
