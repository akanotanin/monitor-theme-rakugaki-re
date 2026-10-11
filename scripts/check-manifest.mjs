// 校验 theme.json 里几条 hub 面板会「静默失败」的规则（家族仓库标配）：
//   ① 两个 title 挨着 —— 前一个被静默丢掉；结尾孤零零一个 title 也不画；
//   ② select 的 default 不在 options 里 —— 面板选中项会是空的；
//   ③ theme.json 与 package.json 的 version 必须一致（release 的 tag 闸门也查，这里更早）；
//   ④ url 非空时必须以 "/" + package.json 的 name 结尾 —— 改过仓库名却忘了同步 url 时，
//      面板的「从 GitHub 更新」会指向旧地址。
// 用法：node scripts/check-manifest.mjs（挂在 npm run check 里，打包与 CI 都会调）
import { readFileSync } from 'node:fs'

const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const problems = []

const cfg = meta.config || []
if (!cfg.length) problems.push('theme.json 的 config 是空的')
cfg.forEach((entry, i) => {
  if (entry.type !== 'title') return
  if (i === cfg.length - 1) problems.push(`结尾孤零零一个标题「${entry.label}」不会画出来`)
  else if (cfg[i + 1]?.type === 'title') problems.push(`两个标题挨着：「${entry.label}」会被静默丢掉`)
})

for (const entry of cfg) {
  if (entry.type !== 'select') continue
  const values = (entry.options || []).map((o) => o.value)
  if (!values.includes(entry.default)) {
    problems.push(`${entry.key}: default「${entry.default}」不在 options 里（面板选中项会是空的）`)
  }
}

if (meta.version !== pkg.version) {
  problems.push(`版本不一致：theme.json ${meta.version}、package.json ${pkg.version}`)
}

if (meta.url) {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(meta.url)) problems.push(`url 形状不对：${meta.url}`)
  else if (!meta.url.endsWith('/' + pkg.name)) problems.push(`url 应以 /${pkg.name} 结尾（当前 ${meta.url}）`)
}

if (problems.length) throw new Error(`manifest 检查不过：\n  ${problems.join('\n  ')}`)
console.log(`manifest OK：${cfg.filter((c) => c.type !== 'title').length} 个设置项、版本 ${meta.version}、url ${meta.url || '(空)'}`)
