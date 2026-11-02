/**
 * dsh-ptc-router
 *
 * Per-task tool presentation routing for DeepSeek Harness.
 *
 * The Harness picks one presentation per agent at assembly time: `native`
 * (every tool schema) or `ptc` (one `run_code` transport plus a generated
 * SDK). This plugin adds two things the composition never had:
 *
 * 1. A task-shape classifier that picks the presentation before an agent's
 *    first model request, and re-picks it when a new task replaces the old one.
 * 2. A live switch: `switch_tool_mode` for the model and `/mode` for the user,
 *    both effective from the next step.
 *
 * Mechanism: `ctx.tools.presentAs(mode)` is an effect — one declaration per
 * scope. Disposing it clears the scope's layer, and declaring again rebuilds
 * it, so a switch is (dispose, declare) on the agent's own scope. The agent
 * scope must inject `tools` first, because a bare `agent.ctx` has no service
 * access; the injected child context keeps the scope tag and owns the
 * declarations, so they unwind with the agent.
 *
 * @module dsh-ptc-router
 */
import {
  classifyTask,
  describeDecision,
  isContinuation,
  latestTaskText,
  messageText,
} from './classifier.js'

/** Cordis plugin name. */
export const name = 'dsh-ptc-router'

/** Required service: the registry owned by `@deepseek-ai/dsh-tools`. */
export const inject = ['tools']

/** Model-facing switch tool name. */
const SWITCH_TOOL = 'switch_tool_mode'

/** Prompt guidance registered once for the deployment. */
const GUIDANCE = [
  'Tool presentation can be switched mid-task with the switch_tool_mode tool, without asking the user.',
  '`native` lists every tool schema directly; prefer it for short, conversational, or few-call turns.',
  '`ptc` presents one run_code program whose generated SDK exposes every tool; prefer it when one step needs many iterative, batched, parallel, or data-heavy calls.',
  'In ptc mode the same tool is available as `tools.switch_tool_mode` inside run_code.',
].join(' ')

/** Defaults; every field is optional in the row config. */
const DEFAULTS = Object.freeze({
  auto: true,
  defaultMode: 'native',
  forceMode: 'auto',
  threshold: 2,
  guidance: true,
  applyToSubagents: false,
  extraPtc: [],
  extraNative: [],
})

/**
 * Validate and merge one row config. Kept dependency-free on purpose: the
 * bundle then loads from a profile without importing any harness package.
 * @param {Record<string, unknown> | undefined} raw
 */
function normalizeConfig(raw) {
  const value = raw ?? {}
  const mode = (input, fallback) => (input === 'native' || input === 'ptc' ? input : fallback)
  const list = (input) => (Array.isArray(input) ? input.filter((item) => typeof item === 'string' && item !== '') : [])
  const bool = (input, fallback) => (typeof input === 'boolean' ? input : fallback)
  const threshold = Number.isFinite(value.threshold) ? Math.max(0, Number(value.threshold)) : DEFAULTS.threshold
  return {
    auto: bool(value.auto, DEFAULTS.auto),
    defaultMode: mode(value.defaultMode, DEFAULTS.defaultMode),
    forceMode: value.forceMode === 'native' || value.forceMode === 'ptc' ? value.forceMode : DEFAULTS.forceMode,
    threshold,
    guidance: bool(value.guidance, DEFAULTS.guidance),
    applyToSubagents: bool(value.applyToSubagents, DEFAULTS.applyToSubagents),
    extraPtc: list(value.extraPtc),
    extraNative: list(value.extraNative),
  }
}

/** Short user-facing label. */
function modeLabel(mode) {
  return mode === 'ptc' ? 'PTC（run_code 程序化调用）' : '标准（原生函数调用）'
}

/**
 * Install the router in one composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  /** @type {WeakMap<object, ReturnType<typeof createState>>} */
  const states = new WeakMap()
  const classifierOptions = () => ({
    threshold: config.threshold,
    forceMode: config.forceMode,
    extraPtc: config.extraPtc,
    extraNative: config.extraNative,
  })
  const ptcAvailable = () => ctx.get('ptcRuntime') !== undefined

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`dsh-ptc-router: ${message}`)
    } catch {
      /* logging is best effort */
    }
  }

  function createState() {
    return {
      /** @type {import('@deepseek-ai/cordis').Context | undefined} */
      toolCtx: undefined,
      /** @type {(() => void) | undefined} */
      dispose: undefined,
      /** @type {'native' | 'ptc' | undefined} */
      mode: undefined,
      /** @type {'default' | 'auto' | 'model' | 'user'} */
      source: 'default',
      /** The user pinned a mode through /mode; auto classification stands down. */
      forced: false,
      /** @type {ReturnType<typeof classifyTask> | undefined} */
      lastDecision: undefined,
      ready: false,
      /** @type {Promise<unknown> | undefined} */
      setup: undefined,
      failed: false,
    }
  }

  function stateOf(agent) {
    let state = states.get(agent)
    if (state === undefined) {
      state = createState()
      states.set(agent, state)
    }
    return state
  }

  function readMessages(agent) {
    try {
      return agent?.session?.deriveMessages?.() ?? []
    } catch {
      return []
    }
  }

  function isRootAgent(agent) {
    const agents = ctx.get('agents')
    if (agents === undefined) return true
    try {
      return agents.roots().some((candidate) => candidate.id === agent.id)
    } catch {
      return true
    }
  }

  function shouldHandle(agent) {
    return config.applyToSubagents || isRootAgent(agent)
  }

  /**
   * Create the agent-scoped, tools-injected context that owns the presentation
   * declaration. Idempotent; the callback runs one microtask after `inject`.
   */
  function prepare(agent) {
    const state = stateOf(agent)
    if (state.ready) return Promise.resolve(state)
    if (state.setup !== undefined) return state.setup
    state.setup = (async () => {
      try {
        let injected
        const fiber = agent.ctx.inject(['tools'], (scoped) => {
          injected = scoped
        })
        await fiber
        if (injected === undefined) throw new Error('the tools service is unavailable in the agent scope')
        state.toolCtx = injected
        state.ready = true
      } catch (error) {
        state.failed = true
        warn(`cannot prepare agent ${String(agent.id)}: ${String(error)}`)
      }
      return state
    })()
    return state.setup
  }

  /**
   * Apply one presentation to one agent. Synchronous once `prepare` finished,
   * which is what lets an inbox insertion switch the mode before the driver
   * assembles the first step.
   * @returns {{mode: 'native' | 'ptc', changed: boolean, fallback: boolean, deferred?: boolean}}
   */
  function setModeNow(agent, desired, source, decision) {
    const state = stateOf(agent)
    const next = desired === 'ptc' && !ptcAvailable() ? 'native' : desired
    const fallback = next !== desired
    if (!state.ready) {
      state.mode = next
      state.source = source
      if (source === 'user') state.forced = true
      if (decision !== undefined) state.lastDecision = decision
      return { mode: next, changed: true, fallback, deferred: true }
    }
    const changed = state.mode !== next
    if (changed) {
      try {
        state.dispose?.()
      } catch (error) {
        warn(`disposing the previous presentation failed: ${String(error)}`)
      }
      state.dispose = undefined
      try {
        state.dispose = state.toolCtx.tools.presentAs(next)
        state.mode = next
        try {
          ctx.emit('tools/change')
        } catch {
          /* notification is best effort */
        }
      } catch (error) {
        state.mode = undefined
        warn(`presentAs(${next}) failed for agent ${String(agent.id)}: ${String(error)}`)
        return { mode: next, changed: false, fallback }
      }
    }
    state.source = source
    if (source === 'user') state.forced = true
    if (decision !== undefined) state.lastDecision = decision
    return { mode: next, changed, fallback }
  }

  /** Decide and apply for one task text. */
  function route(agent, text, source, decision) {
    const chosen = decision ?? classifyTask(text, classifierOptions())
    const state = stateOf(agent)
    if (state.mode === chosen.mode) {
      state.lastDecision = chosen
      return { mode: chosen.mode, changed: false, fallback: false, decision: chosen }
    }
    return { ...setModeNow(agent, chosen.mode, source, chosen), decision: chosen }
  }

  /** Initial routing for an agent that was just created (or adopted). */
  async function bootstrap(agent) {
    if (!shouldHandle(agent)) return
    const state = stateOf(agent)
    if (state.forced) return
    await prepare(agent)
    if (state.forced) return
    if (config.forceMode !== 'auto') {
      setModeNow(agent, config.forceMode, 'default')
      return
    }
    const text = latestTaskText(readMessages(agent))
    if (text === '') {
      setModeNow(agent, config.defaultMode, 'default')
      return
    }
    const decision = classifyTask(text, classifierOptions())
    setModeNow(agent, decision.mode, 'auto', decision)
  }

  // ── event wiring ──────────────────────────────────────────────────────────

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await bootstrap(agent)
    } catch (error) {
      warn(`bootstrap failed for agent ${String(agent?.id)}: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!config.auto || config.forceMode !== 'auto') return
    if (!agent || !message) return
    if (message.source?.kind !== 'user') return
    if (!shouldHandle(agent)) return
    const text = messageText(message)
    if (text === '') return
    const state = stateOf(agent)
    if (state.forced) return
    if (!state.ready) {
      void prepare(agent).then(() => {
        if (!state.forced) route(agent, text, 'auto')
      })
      return
    }
    if (state.mode !== undefined && isContinuation(text)) return
    route(agent, text, 'auto')
  })

  // ── user-facing /mode command ─────────────────────────────────────────────

  function statusText(agent) {
    const state = stateOf(agent)
    const mode = state.mode ?? config.defaultMode
    const source = state.source === 'user' ? '手动固定' : state.source === 'model' ? '模型切换' : '自动判定'
    const auto = state.forced ? '关闭（已手动固定）' : config.auto ? '开启' : '关闭'
    const decision = state.lastDecision
      ? `\n最近判定：${describeDecision(state.lastDecision)}`
      : ''
    const runtime = ptcAvailable() ? '' : '\n注意：当前 profile 未挂载 PTC 运行时，ptc 不可用，会回退到标准模式。'
    return `工具模式：${modeLabel(mode)}\n来源：${source}\n自动判定：${auto}${decision}${runtime}`
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'mode',
      description: '查看或切换工具呈现模式（标准 / PTC / 自动）',
      input: { hint: '[native|ptc|auto]' },
      handler: async ({ agent, rawInput }) => {
        const argument = String(rawInput ?? '').trim().toLowerCase()
        if (argument === '') return { kind: 'success', text: statusText(agent) }
        if (argument === 'auto' || argument === '自动') {
          const state = stateOf(agent)
          state.forced = false
          await prepare(agent)
          const text = latestTaskText(readMessages(agent))
          if (text === '') {
            setModeNow(agent, config.defaultMode, 'auto')
            return { kind: 'success', text: `已恢复自动判定（暂无任务文本，使用默认 ${modeLabel(config.defaultMode)}）。` }
          }
          const result = route(agent, text, 'auto')
          return {
            kind: 'success',
            text: `已恢复自动判定：${modeLabel(result.mode)}\n判定依据：${describeDecision(result.decision)}`,
          }
        }
        if (argument === 'native' || argument === '标准' || argument === '原生') {
          await prepare(agent)
          setModeNow(agent, 'native', 'user')
          return { kind: 'success', text: '已切换到标准模式（原生函数调用），从下一步生效。' }
        }
        if (argument === 'ptc' || argument === '程序化') {
          await prepare(agent)
          const result = setModeNow(agent, 'ptc', 'user')
          return {
            kind: 'success',
            text: result.fallback
              ? '当前 profile 未挂载 PTC 运行时，无法切换；保持标准模式。'
              : '已切换到 PTC 模式（run_code 程序化调用），从下一步生效。',
          }
        }
        return { kind: 'error', text: '用法：/mode 查看状态；/mode native|ptc|auto 切换。' }
      },
    })
  })

  // ── model-facing switch tool ──────────────────────────────────────────────

  try {
    ctx.tools.register({
      name: SWITCH_TOOL,
      description: [
        'Switch how your tools are presented to you, effective from your next step.',
        '`native` lists every tool schema directly: best for short, conversational, or few-call turns.',
        '`ptc` presents a single run_code program whose generated SDK exposes every tool: best for many iterative, batched, parallel, or data-heavy calls, or when large intermediate results should stay inside one program.',
        '`auto` hands the choice back to the task classifier.',
        'Use it whenever the shape of the task changes; no user confirmation is needed.',
        'In ptc mode call it as `tools.switch_tool_mode` inside run_code.',
      ].join(' '),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: {
            type: 'string',
            enum: ['native', 'ptc', 'auto'],
            description: 'The presentation to use from the next step.',
          },
          reason: {
            type: 'string',
            description: 'Optional one-line reason, shown in logs.',
          },
        },
        required: ['mode'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['native', 'ptc'] },
            changed: { type: 'boolean' },
            auto: { type: 'boolean' },
            fallback: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['mode', 'changed', 'auto', 'fallback', 'message'],
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args, exec) => {
        const agent = exec.agent
        if (agent === undefined) throw new Error(`${SWITCH_TOOL} requires a calling agent`)
        const state = stateOf(agent)
        if (!state.ready) await prepare(agent)
        if (args.mode === 'auto') {
          state.forced = false
          const text = latestTaskText(readMessages(agent))
          if (text === '') {
            const result = setModeNow(agent, config.defaultMode, 'auto')
            return {
              mode: result.mode,
              changed: result.changed,
              auto: true,
              fallback: result.fallback,
              message: `Automatic routing restored; no task text yet, using ${result.mode}.`,
            }
          }
          const result = route(agent, text, 'auto')
          return {
            mode: result.mode,
            changed: result.changed,
            auto: true,
            fallback: result.fallback,
            message: `Automatic routing restored: ${result.mode} (${describeDecision(result.decision)}).`,
          }
        }
        const result = setModeNow(agent, args.mode, 'model')
        const reason = typeof args.reason === 'string' && args.reason !== '' ? ` Reason: ${args.reason}` : ''
        return {
          mode: result.mode,
          changed: result.changed,
          auto: false,
          fallback: result.fallback,
          message: result.changed
            ? `Tool presentation switched to ${result.mode}, effective from the next step.${reason}`
            : `Tool presentation is already ${result.mode}.${result.fallback ? ' ptc is unavailable in this deployment.' : ''}${reason}`,
        }
      },
    })
  } catch (error) {
    warn(`cannot register ${SWITCH_TOOL}: ${String(error)}`)
  }

  // ── prompt guidance and adoption of already-live agents ──────────────────

  if (config.guidance && ctx.systemPrompt !== undefined) {
    try {
      ctx.systemPrompt.section({
        name: 'dsh-ptc-router:guidance',
        order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
        text: GUIDANCE,
      })
    } catch (error) {
      warn(`cannot register the guidance section: ${String(error)}`)
    }
  }

  const liveAgents = ctx.get('agents')
  if (liveAgents !== undefined) {
    for (const agent of liveAgents.list()) {
      if (!shouldHandle(agent)) continue
      void bootstrap(agent)
    }
  }
}
