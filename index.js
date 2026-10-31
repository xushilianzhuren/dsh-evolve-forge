/**
 * 进化炉 · 插件（Host 侧，零依赖，无构建）
 *
 * 管"变强"：错题炉（issue log＋四链）、固化炉（能力账＋验收命令）、沉淀炉（能力离身）、
 * 校准炉（置信度vs命中率、异常好结果归因、事故→检查项）。
 *
 * 旧形态的死因：四链错题官/能力固化器/手感结晶器都把根目录写死在 <workspace>，
 * 本机没有那个目录——跑了不是报错就是静默建空账。故本插件直接读/写现有台账，
 * 动作拦截则转调本机活件 scripts/错题拦截器.py（它按相对路径取件，没写死根）。
 *
 * @module dsh-evolve-forge
 */

import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ql-evolve'

export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:evolve'

const DEFAULTS = Object.freeze({ order: 90, tool: true, enabled: true })

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('ql-evolve: config.enabled must be a boolean')
  }
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') {
    throw new Error('ql-evolve: config.tool must be a boolean')
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    throw new Error('ql-evolve: config.order must be a finite number')
  }
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) {
    throw new Error('ql-evolve: config.root must be a non-empty path string')
  }
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    root: raw.root === undefined ? undefined : raw.root.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

/** 工作区签名：AGENTS.md 与 scripts/ 双件齐（防命中 DSH 代码仓那种只有 AGENTS.md 的目录）。 */
/** 工作区签名：四文件＋scripts 三件齐（防命中 DSH 代码仓——它也有 AGENTS.md 和 scripts/）。 */
function isWorkspace(dir) {
  try {
    return existsSync(join(dir, 'AGENTS.md'))
      && existsSync(join(dir, 'scripts'))
      && (existsSync(join(dir, 'SOUL.md')) || existsSync(join(dir, 'USER.md')))
  } catch {
    return false
  }
}

/** 插件包所在目录的上一级（dirname 两次：import.meta.url 指向的是 index.js）。 */
function packageParent() {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}

/** 根目录：配置优先 → 插件包上一级（链接装法即工作区）→ 从进程目录往上找 → 本机默认。 */
function findRoot(configured) {
  const candidates = []
  if (configured !== undefined) candidates.push(configured)
  const self = packageParent()
  if (self !== undefined) candidates.push(self)
  let dir = process.cwd()
  for (let hop = 0; hop < 6; hop += 1) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push('~//Smart Agentharness')
  for (const candidate of candidates) {
    if (isWorkspace(candidate)) return candidate
  }
  return candidates[0]
}

function runPython(root, args, timeoutMs = 30000) {
  return new Promise(resolve => {
    execFile('python3', args, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : String(error?.message ?? ''),
      })
    })
  })
}

async function readJsonl(path) {
  try {
    const text = await readFile(path, 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        rows.push(JSON.parse(trimmed))
      } catch {
        rows.push({ _raw: trimmed })
      }
    }
    return rows
  } catch {
    return []
  }
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

function rowText(row) {
  if (typeof row._raw === 'string') return row._raw
  return row['案由'] ?? row['描述'] ?? row['错误'] ?? row['事件'] ?? row['名称'] ?? JSON.stringify(row)
}

function rowKind(row) {
  if (typeof row._raw === 'string') return '文本行'
  return row['类型'] ?? row['状态'] ?? '未分类'
}

/** 原子追加：读全量→加行→tmp→rename（对齐原子写令）。 */
async function appendJsonl(path, row) {
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  if (text !== '' && !text.endsWith('\n')) text += '\n'
  const next = text + JSON.stringify(row) + '\n'
  const tmp = `${path}.tmp`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, path)
  return text.split('\n').filter(line => line.trim() !== '').length + 1
}

function statsOfMistakes(rows) {
  const kinds = new Map()
  for (const row of rows) kinds.set(rowKind(row), (kinds.get(rowKind(row)) ?? 0) + 1)
  const ordered = [...kinds.entries()].sort((a, b) => b[1] - a[1])
  return ordered.map(([kind, count]) => `${kind} ${count}`).join('｜')
}

function renderSection() {
  return [
    '## 进化炉令 · 常驻（学·迭代·进化·错题四炉同烧）',
    '',
    '**吃过一次亏要变成抗体，做过一次对要变成零件**。四炉缺一炉＝空转。',
    '',
    '**一、错题炉**（issue log＝病历，不是耻辱柱）',
    '①同错二犯必立案——一行五件：时间／类型／源／错误／案由；',
    '②每案走四链：根因→教训→复盘→顿悟＋泛化场景，缺一环＝未结丹；',
    '③动手前先跑动作拦截（对"拟做什么"过一遍错题硬规则），交付前跑文件扫；',
    '④issue log只增不删。',
    '',
    '**二、固化炉**（一次掌握，永不遗忘）',
    '能力落账三件：名称＋可机械复现的验收命令＋状态（稳固／回炉中）。定期抽验：退步即转回炉，修好再登记迭代次数。'
      + '声称"会了"却没有验收命令＝没会。',
    '',
    '**三、沉淀炉**（能力离身）',
    '①能脚本化的不留在对话里；②同类问题第二次出现＝强制抽象成件；③会话收尾抽"本轮可复用动作"，'
      + '落脚本／落条款／标一次性，三选一，禁空手。',
    '',
    '**四、校准炉**（把自我感觉降级为读数）',
    '①重要判断带置信度，事后核账；②预期与结果不符（好坏同级）强制归因，防蒙对的胜利固化成错方法；'
      + '③事故后必须产出至少一个机械检查项，否则学费白交。',
    '',
    '**判据**：每轮收尾自问"这轮学到什么可复用的、落哪了"——答不出＝白跑。',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-evolve：主开关关着，未挂载')
    return
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(),
  }), 'ql-evolve.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_evolve',
      description: '进化炉闸：错题统计／错题查／错题立案／固化账／动作拦截／文件扫。'
        + '错题立案按原子写追加一行到issue log；动作拦截与文件扫转调本机活件 scripts/错题拦截器.py。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['错题统计', '错题查', '错题立案', '固化账', '动作拦截', '文件扫'],
            description: '要执行的动作。',
          },
          query: {
            type: 'string',
            description: '错题查＝关键词；动作拦截＝拟执行动作描述；文件扫＝目标路径。',
          },
          note: {
            type: 'string',
            description: '错题立案的案由（action=错题立案 时必填）。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const root = findRoot(cfg.root)
        const action = typeof args?.action === 'string' ? args.action : '错题统计'
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        const note = typeof args?.note === 'string' ? args.note.trim() : ''
        try {
          if (action === '错题统计') {
            const rows = await readJsonl(join(root, 'scripts', 'issue log.jsonl'))
            const chains = await readJsonl(join(root, 'scripts', '错题四链.jsonl'))
            const lines = [
              '【错题炉·统计】',
              `issue log：${rows.length} 条（${statsOfMistakes(rows)}）`,
              `四链账：${chains.length} 条${chains.length < rows.length ? '（少于issue log→有案未走四链）' : ''}`,
              '',
              '末五条：',
            ]
            for (const row of rows.slice(-5)) lines.push(`  · ${clip(rowText(row), 76)}`)
            return { report: lines.join('\n') }
          }

          if (action === '错题查') {
            if (query === '') return { report: '错题查需要 query（关键词）。' }
            const rows = await readJsonl(join(root, 'scripts', 'issue log.jsonl'))
            const chains = await readJsonl(join(root, 'scripts', '错题四链.jsonl'))
            const hit = rows.filter(row => JSON.stringify(row).includes(query))
            const chainHit = chains.filter(row => JSON.stringify(row).includes(query))
            const lines = [`【错题炉·查「${query}」】issue log命中 ${hit.length}／四链命中 ${chainHit.length}`]
            for (const row of hit.slice(-8)) lines.push(`  · ${clip(rowText(row), 90)}`)
            for (const row of chainHit.slice(-3)) lines.push(`  · 四链｜${clip(row['event'] ?? rowText(row), 80)}｜${clip(row['判读'] ?? '', 40)}`)
            return { report: lines.join('\n') }
          }

          if (action === '错题立案') {
            if (note === '') return { report: '错题立案需要 note（案由，一句话说清错在哪）。' }
            const path = join(root, 'scripts', 'issue log.jsonl')
            const stamp = new Date().toISOString().slice(0, 19)
            const total = await appendJsonl(path, {
              时间: stamp,
              类型: '会话立案',
              源: 'ql_evolve',
              错误: note.slice(0, 120),
              案由: 'Agent手动立案（错题炉）',
            })
            return { report: `已立案（第 ${total} 条）：${clip(note, 80)}\n提醒：四链未走＝未结丹——根因／教训／复盘／顿悟＋泛化，缺一环要补。` }
          }

          if (action === '固化账') {
            const rows = await readJsonl(join(root, 'scripts', '能力固化账.jsonl'))
            if (rows.length === 0) return { report: '【固化炉】能力固化账无账——视同没跑（claimed=0）。' }
            const steady = rows.filter(row => row['状态'] === '稳固').length
            const bake = rows.filter(row => row['状态'] === '回炉中').length
            const regress = rows.reduce((sum, row) => sum + (Number(row['退步次数']) || 0), 0)
            const lines = [
              '【固化炉·统计】',
              `总数 ${rows.length}｜稳固 ${steady}｜回炉中 ${bake}｜稳固率 ${(steady / rows.length * 100).toFixed(0)}%｜累计退步 ${regress} 次`,
              '',
              '末三条：',
            ]
            for (const row of rows.slice(-3)) {
              lines.push(`  · #${row['编号'] ?? '?'} ${clip(row['名称'] ?? '', 30)}｜${row['状态'] ?? '?'}｜验收：${clip(row['验收命令'] ?? '', 40)}`)
            }
            return { report: lines.join('\n') }
          }

          if (action === '动作拦截') {
            if (query === '') return { report: '动作拦截需要 query（描述你打算做什么）。' }
            const result = await runPython(root, ['scripts/错题拦截器.py', '--拦', query], 20000)
            const body = `${result.stdout}${result.stderr}`.trim()
            return { report: `【错题炉·动作拦截】\n${body === '' ? `（无输出·exit ${result.code}）` : body}` }
          }

          if (action === '文件扫') {
            if (query === '') return { report: '文件扫需要 query（文件或目录路径）。' }
            const result = await runPython(root, ['scripts/错题拦截器.py', '--查', query], 30000)
            const body = `${result.stdout}${result.stderr}`.trim()
            return { report: `【错题炉·文件扫 ${query}】\n${body === '' ? `（无输出·exit ${result.code}）` : body}` }
          }

          return { report: `未知动作：${action}` }
        } catch (error) {
          return { report: `进化炉内部错：${clip(error?.message ?? error, 200)}` }
        }
      },
    }), 'ql-evolve.tool()')
  }

  ctx.logger?.info?.('ql-evolve：区块 %s 已注册（order=%d）', SECTION_NAME, cfg.order)
}
