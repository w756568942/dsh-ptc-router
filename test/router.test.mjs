import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const text = (value) => [{ type: 'text', text: value }]
const BATCH = '遍历所有文件，统计每个文件的行数并汇总成表格'

function createAgent({ id = 'agent-1', root = true, messages = [] } = {}) {
  let history = messages
  const presentations = []
  const agent = {
    id,
    __root: root,
    session: {
      deriveMessages: () => history,
    },
    ctx: {
      inject(deps, callback) {
        assert.deepEqual(deps, ['tools'])
        const scoped = {
          tools: {
            presentAs(mode) {
              const entry = { mode, disposed: false }
              presentations.push(entry)
              return () => {
                entry.disposed = true
              }
            },
          },
        }
        callback(scoped)
        return Promise.resolve(scoped)
      },
    },
  }
  return {
    agent,
    presentations,
    setHistory(next) {
      history = next
    },
  }
}

function createHarness(overrides = {}) {
  const handlers = new Map()
  const registeredTools = []
  const sections = []
  const commands = []
  const emitted = []
  const warnings = []
  const liveAgents = [...(overrides.liveAgents ?? [])]
  const services = {
    ptcRuntime: { language: 'typescript', programFormat: 'async-function' },
    agents: {
      list: () => liveAgents,
      roots: () => liveAgents.filter((agent) => agent.__root !== false),
    },
    ...overrides.services,
  }
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      error: () => {},
      info: () => {},
    },
    get: (name) => services[name],
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    emit: (event) => emitted.push(event),
    inject: (deps, callback) => {
      if (deps.includes('commands')) {
        callback({ commands: { register: (definition) => commands.push(definition) } })
      }
      return Promise.resolve()
    },
    tools: {
      register: (definition) => {
        registeredTools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
      getSectionOrder: () => 500,
    },
  }
  apply(ctx, {
    auto: true,
    defaultMode: 'native',
    threshold: 2,
    applyToSubagents: false,
    ...overrides.config,
  })
  const fire = async (event, payload) => {
    // `agent/created` implies the agent is already announced in the registry.
    if (event === 'agent/created' && payload?.agent && !liveAgents.includes(payload.agent)) {
      liveAgents.push(payload.agent)
    }
    for (const handler of handlers.get(event) ?? []) await handler(payload)
  }
  return { ctx, handlers, fire, registeredTools, sections, commands, emitted, warnings, liveAgents, services }
}

const activeMode = (presentations) => [...presentations].reverse().find((entry) => !entry.disposed)?.mode

test('registers one switch tool, one /mode command, and guidance', () => {
  const harness = createHarness()
  assert.equal(harness.registeredTools.filter((tool) => tool.name === 'switch_tool_mode').length, 1)
  assert.equal(harness.commands.filter((command) => command.name === 'mode').length, 1)
  assert.equal(harness.sections.filter((section) => section.name === 'dsh-ptc-router:guidance').length, 1)
})

test('a created agent with a batch task history starts in ptc', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent({
    messages: [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
  })
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'ptc')
})

test('a created agent without history starts in the configured default', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent()
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'native')
})

test('the first user message switches mode before the driver assembles a step', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent()
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'native')
  // The insert handler is synchronous; this simulates arriving before the turn wakes.
  harness.fire('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: text(BATCH) } })
  assert.equal(activeMode(presentations), 'ptc')
  assert.equal(presentations.filter((entry) => entry.disposed).length, 1)
})

test('a continuation does not re-classify the task', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent({
    messages: [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
  })
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'ptc')
  harness.fire('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: text('继续') } })
  assert.equal(activeMode(presentations), 'ptc')
  assert.equal(presentations.length, 1, 'no presentation was rebuilt for a continuation')
})

test('unchanged classification does not rebuild the presentation', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent()
  await harness.fire('agent/created', { agent })
  harness.fire('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: text('帮我看下 README') } })
  assert.equal(presentations.length, 1)
  assert.equal(activeMode(presentations), 'native')
})

test('/mode pins a mode and /mode auto restores classification', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent({
    messages: [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
  })
  await harness.fire('agent/created', { agent })
  const command = harness.commands.find((entry) => entry.name === 'mode')
  assert.equal(activeMode(presentations), 'ptc')

  const pinned = await command.handler({ agent, rawInput: 'native' })
  assert.equal(pinned.kind, 'success')
  assert.equal(activeMode(presentations), 'native')

  // A forced mode ignores new task classification.
  harness.fire('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: text(BATCH) } })
  assert.equal(activeMode(presentations), 'native')

  const restored = await command.handler({ agent, rawInput: 'auto' })
  assert.equal(restored.kind, 'success')
  assert.equal(activeMode(presentations), 'ptc')
})

test('/mode without an argument reports the state', async () => {
  const harness = createHarness()
  const { agent } = createAgent()
  await harness.fire('agent/created', { agent })
  const command = harness.commands.find((entry) => entry.name === 'mode')
  const status = await command.handler({ agent, rawInput: '' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /工具模式/)
  assert.match(status.text, /标准/)
  const invalid = await command.handler({ agent, rawInput: 'bogus' })
  assert.equal(invalid.kind, 'error')
})

test('the switch tool applies a mode and reports whether it changed', async () => {
  const harness = createHarness()
  const { agent, presentations, setHistory } = createAgent()
  await harness.fire('agent/created', { agent })
  const tool = harness.registeredTools.find((entry) => entry.name === 'switch_tool_mode')

  const first = await tool.execute({ mode: 'ptc' }, { agent })
  assert.equal(first.mode, 'ptc')
  assert.equal(first.changed, true)
  assert.equal(activeMode(presentations), 'ptc')

  const second = await tool.execute({ mode: 'ptc' }, { agent })
  assert.equal(second.changed, false)

  // `auto` without task text falls back to the configured default.
  const empty = await tool.execute({ mode: 'auto' }, { agent })
  assert.equal(empty.auto, true)
  assert.equal(empty.mode, 'native')

  // With a batch task in the committed history, `auto` re-classifies to ptc.
  setHistory([{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }])
  const auto = await tool.execute({ mode: 'auto', reason: 'test' }, { agent })
  assert.equal(auto.auto, true)
  assert.equal(auto.mode, 'ptc')
})

test('without a PTC runtime ptc degrades to native', async () => {
  const harness = createHarness({
    config: { defaultMode: 'ptc' },
    services: { ptcRuntime: undefined },
  })
  const { agent, presentations } = createAgent()
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'native')

  const tool = harness.registeredTools.find((entry) => entry.name === 'switch_tool_mode')
  const result = await tool.execute({ mode: 'ptc' }, { agent })
  assert.equal(result.mode, 'native')
  assert.equal(result.fallback, true)
})

test('subagents are left on their preset presentation by default', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent({ root: false })
  harness.liveAgents.push(agent)
  await harness.fire('agent/created', { agent })
  harness.fire('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: text(BATCH) } })
  assert.equal(presentations.length, 0)
})

test('applyToSubagents adopts subagents too', async () => {
  const harness = createHarness({ config: { applyToSubagents: true } })
  const { agent, presentations } = createAgent({ root: false })
  harness.liveAgents.push(agent)
  await harness.fire('agent/created', { agent })
  assert.equal(activeMode(presentations), 'native')
})

test('already-live agents are adopted when the plugin mounts', async () => {
  const { agent, presentations } = createAgent({
    messages: [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
  })
  createHarness({ liveAgents: [agent] })
  // bootstrap for live agents is fire-and-forget at mount time.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(activeMode(presentations), 'ptc')
})

test('runtime context messages are ignored', async () => {
  const harness = createHarness()
  const { agent, presentations } = createAgent({
    messages: [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
  })
  await harness.fire('agent/created', { agent })
  harness.fire('agent/inbox/inserted', {
    agent,
    message: { source: { kind: 'runtime-context' }, content: text('当前目录：/tmp') },
  })
  assert.equal(activeMode(presentations), 'ptc')
})

test('switching emits tools/change', async () => {
  const harness = createHarness()
  const { agent } = createAgent()
  await harness.fire('agent/created', { agent })
  const tool = harness.registeredTools.find((entry) => entry.name === 'switch_tool_mode')
  await tool.execute({ mode: 'ptc' }, { agent })
  assert.ok(harness.emitted.includes('tools/change'))
})
