/**
 * Task-shape heuristics for the tool-mode router.
 *
 * PTC mode (programmatic tool calling) presents one `run_code` tool whose
 * generated SDK exposes every visible tool as an async function. It pays off
 * when one step needs many tool calls — loops, batches, parallel fan-out,
 * filtering large intermediate results — because those calls stay inside one
 * program instead of becoming one model round-trip each.
 *
 * Native mode presents every tool schema directly. It pays off for short,
 * conversational, single-action turns, and for work where the next call
 * depends on what the model reads in the previous result (a few calls with
 * human-visible intermediate reasoning).
 *
 * These are heuristics, not a contract: the model can override the choice at
 * any time with `switch_tool_mode`, and the user can override it with `/mode`.
 * Keep the function pure so it is cheap to test and to tune.
 */

/** @typedef {'native' | 'ptc'} ToolMode */

/** Weighted signals that a task benefits from PTC. */
const PTC_RULES = [
  {
    re: /(批量|全量|逐个|逐一|逐行|遍历|每一个|每个文件|每个模块|所有文件|全部文件|所有项目|批量处理|批处理)/i,
    weight: 3,
    label: '批量/逐项处理',
  },
  {
    re: /\b(batch|bulk|for each|every file|all files|each file|iterate|loop over)\b/i,
    weight: 3,
    label: '批量/逐项处理',
  },
  {
    re: /(并行|并发|同时执行|同时运行|同时处理|parallel|concurrently|in parallel)/i,
    weight: 2,
    label: '并行执行',
  },
  {
    re: /(脚本|自动化|流水线|编排|pipeline|automation|orchestrat)/i,
    weight: 2,
    label: '脚本化/流水线',
  },
  {
    re: /(整个仓库|全库|全项目|代码库|仓库里|项目里|目录下|workspace|codebase|whole repo|entire repo)/i,
    weight: 2,
    label: '全仓范围',
  },
  {
    re: /(json|yaml|csv|tsv|xml|sql|正则|regex|解析|提取|统计|汇总|合并|去重|转换|格式化|比对|diff)/i,
    weight: 1,
    label: '数据加工',
  },
  {
    re: /(审查|审计|全面检查|迁移|重构|批量修改|测试全部|跑一遍测试|test suite|audit|review all|migrate|refactor)/i,
    weight: 1,
    label: '审查/迁移',
  },
  {
    re: /(多步骤|分步骤|分成.{0,6}步|第一步|第二步|首先|接着|最后再|step by step|step 1|first,|then,)/i,
    weight: 1,
    label: '多步流程',
  },
  {
    re: /(生成.{0,8}(报告|清单|表格|报表)|整理.{0,8}(报告|清单|表格)|汇总成)/i,
    weight: 1,
    label: '结构化产出',
  },
]

/** Weighted signals that a task is better served by native tool calls. */
const NATIVE_RULES = [
  {
    re: /(标准模式|原生模式|native mode|function calling)/i,
    weight: 4,
    label: '明确要求标准模式',
  },
  {
    re: /(什么|为什么|怎么|如何|多少|哪个|是否|能不能|可不可以).{0,20}[？?]?$/i,
    weight: 1,
    label: '问答',
  },
  {
    re: /(解释|说明一下|介绍一下|讲讲|有什么区别|是什么意思|why |what is|explain|difference|how do|how does)/i,
    weight: 1,
    label: '解释型',
  },
  {
    re: /^(请|帮我|麻烦)?\s*(打开|查看|读一下|看一下|显示|列出|运行一下|执行一下|删掉|改一下|修一下|重命名|移动|复制|截图|截个图)/,
    weight: 1,
    label: '单个动作',
  },
  {
    re: /^(你好|您好|谢谢|多谢|好的|收到|嗯+|ok|okay|hi|hello|thanks)[啊呀。.!！]*$/i,
    weight: 3,
    label: '寒暄/确认',
  },
  {
    re: /(截图|图片|界面|按钮|样式|颜色|布局|图标|screenshot|image|ui\b|css)/i,
    weight: 1,
    label: '视觉/界面',
  },
  {
    re: /(单个文件|一个文件|这一处|这个函数|这行|这个文件)/,
    weight: 1,
    label: '局部改动',
  },
]

/** Explicit PTC request; strong enough to outweigh most native signals. */
const EXPLICIT_PTC = /(ptc|programmatic tool)/i

/** Short replies that continue the current task rather than starting a new one. */
const CONTINUATION = /^(继续|接着|然后呢?|好的?|好|嗯+|可以|行|开始|执行吧?|下一步|go on|continue|ok|okay|yes|sure|next|do it)$/i

/** Tools mode for a task decision. @typedef {ToolMode} */
export const MODES = Object.freeze(['native', 'ptc'])

/**
 * Concatenate the text blocks of one message.
 * @param {{content?: readonly unknown[]} | undefined | null} message
 * @returns {string}
 */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Whether a reply continues the open task instead of restating it.
 * Continuations never trigger a re-classification; they inherit the mode the
 * task already runs in.
 * @param {string} text
 * @returns {boolean}
 */
export function isContinuation(text) {
  const value = String(text ?? '').trim().replace(/[。.!！?？~～\s]+$/g, '')
  if (value === '') return true
  if (value.length > 16) return false
  return CONTINUATION.test(value)
}

/**
 * Pick the task text that best represents what this session is working on.
 * The newest substantive user message wins; short continuations ("继续") fall
 * back to the previous substantive message so a resume keeps the task shape.
 * @param {readonly {role?: string, source?: {kind?: string}, content?: readonly unknown[]}[]} messages
 * @param {number} [lookback]
 * @returns {string}
 */
export function latestTaskText(messages, lookback = 6) {
  if (!Array.isArray(messages)) return ''
  const texts = []
  for (let index = messages.length - 1; index >= 0 && texts.length < lookback; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (message.source && message.source.kind !== undefined && message.source.kind !== 'user') continue
    const text = messageText(message)
    if (text !== '') texts.push(text)
  }
  if (texts.length === 0) return ''
  const substantive = texts.filter((text) => !isContinuation(text))
  return substantive.find((text) => text.length >= 16) ?? substantive[0] ?? texts[0]
}

/**
 * Classify one task text into a tool presentation mode.
 * @param {string} text
 * @param {{threshold?: number, forceMode?: string, extraPtc?: readonly string[], extraNative?: readonly string[]}} [options]
 * @returns {{mode: ToolMode, ptcScore: number, nativeScore: number, delta: number, confidence: number, reasons: string[]}}
 */
export function classifyTask(text, options = {}) {
  const value = String(text ?? '')
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 2
  const reasons = []
  let ptcScore = 0
  let nativeScore = 0

  for (const rule of PTC_RULES) {
    if (rule.re.test(value)) {
      ptcScore += rule.weight
      reasons.push(`+${rule.weight} ${rule.label}`)
    }
  }
  if (EXPLICIT_PTC.test(value)) {
    ptcScore += 4
    reasons.push('+4 明确要求 PTC')
  }
  for (const rule of NATIVE_RULES) {
    if (rule.re.test(value)) {
      nativeScore += rule.weight
      reasons.push(`-${rule.weight} ${rule.label}`)
    }
  }

  // Length is a coarse but reliable proxy: short prompts are rarely worth a
  // program, long ones usually enumerate several things to do.
  const length = [...value].length
  if (length >= 180) {
    ptcScore += 1
    reasons.push('+1 长任务描述')
  }
  if (length >= 500) {
    ptcScore += 1
    reasons.push('+1 超长任务描述')
  }
  if (length <= 30) {
    nativeScore += 1
    reasons.push('-1 短指令')
  }

  // Structure: enumerated requirements and multi-line briefs imply several
  // tool calls rather than one.
  const numbered = (value.match(/(^|\n)\s*(\d+[.、)]|[-*+]\s|#{1,6}\s)/g) ?? []).length
  if (numbered >= 3) {
    ptcScore += 1
    reasons.push('+1 结构化清单')
  }
  if ((value.match(/\n/g) ?? []).length >= 7) {
    ptcScore += 1
    reasons.push('+1 多行描述')
  }
  const inlineRefs = (value.match(/`[^`\n]+`/g) ?? []).length
  if (inlineRefs >= 3) {
    ptcScore += 1
    reasons.push('+1 多处文件引用')
  }

  // Caller-supplied tuning, checked last so deployments can bias either side.
  for (const keyword of options.extraPtc ?? []) {
    if (keyword && value.toLowerCase().includes(String(keyword).toLowerCase())) {
      ptcScore += 2
      reasons.push(`+2 自定义 PTC 关键词「${keyword}」`)
    }
  }
  for (const keyword of options.extraNative ?? []) {
    if (keyword && value.toLowerCase().includes(String(keyword).toLowerCase())) {
      nativeScore += 2
      reasons.push(`-2 自定义标准关键词「${keyword}」`)
    }
  }

  const forced = options.forceMode
  const delta = ptcScore - nativeScore
  const mode = forced === 'native' || forced === 'ptc' ? forced : delta >= threshold ? 'ptc' : 'native'
  const confidence = Math.min(1, Math.abs(delta) / 6)

  return {
    mode,
    ptcScore,
    nativeScore,
    delta,
    confidence: Number(confidence.toFixed(2)),
    reasons,
  }
}

/**
 * Human-readable one-liner used by `/mode` output and logs.
 * @param {ReturnType<typeof classifyTask>} decision
 * @returns {string}
 */
export function describeDecision(decision) {
  const reason = decision.reasons.length > 0 ? `；${decision.reasons.join('，')}` : ''
  return `${decision.mode}（ptc ${decision.ptcScore} : native ${decision.nativeScore}${reason}）`
}
