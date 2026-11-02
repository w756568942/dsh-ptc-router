/**
 * Integration check: mount the real router against the real host services and
 * observe what the model would receive for one agent scope.
 *
 * Run: node dev/plugin-mount-harness.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentCarrier } from '@deepseek-ai/dsh-agent'
import { apply } from '../index.js'

class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'harness' }
  }
  resolve(request) {
    return { ...request, cwd: process.cwd(), timeoutMs: request.timeoutMs ?? 120000 }
  }
  async run(spec) {
    return { value: null, logs: [], error: undefined, sandbox: undefined, spec }
  }
}

const DEMO = {
  name: 'demo_tool',
  description: 'A demo tool.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', description: 'Text.' } },
    required: ['text'],
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async () => ({ ok: true }),
}

const text = (value) => [{ type: 'text', text: value }]
const BATCH = '遍历所有文件，统计每个文件的行数并汇总成表格'

let failures = 0
function assert(condition, message) {
  if (condition) console.log(`ok - ${message}`)
  else {
    failures += 1
    console.error(`FAIL: ${message}`)
  }
}

async function read(ctx, scope) {
  const assembly = await ctx.systemPrompt.assemble({ scope })
  return {
    tools: assembly.tools.map((tool) => tool.name),
    sections: assembly.sections.filter((section) => section.text !== '').map((section) => section.name),
  }
}

async function main() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(FakePtcRuntime)
  ctx.tools.register(DEMO)

  apply(ctx, { auto: true, defaultMode: 'native', guidance: true })

  const agent = {
    id: 'integration-agent',
    session: {
      deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: text(BATCH) }],
    },
  }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx

  // Use the driver's real scoped carrier + serial dispatch, so listener
  // filtering behaves exactly as in a session.
  await ctx.serial(agentCarrier(agent), 'agent/created', { agent, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const routed = await read(ctx, agent)
  console.log('after agent/created (batch history):', routed)
  assert(routed.tools.length === 1 && routed.tools[0] === RUN_CODE_NAME, 'batch history routes the agent to PTC')
  assert(routed.sections.includes('tools:sdk'), 'PTC carries the generated SDK')
  assert(routed.sections.includes('dsh-ptc-router:guidance'), 'guidance section is present')
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const sdk = assembly.sections.find((section) => section.name === 'tools:sdk')
  assert(typeof sdk?.text === 'string' && sdk.text.includes('switch_tool_mode'), 'the PTC SDK exposes switch_tool_mode as a binding')

  // A new short task re-classifies to native before the next step.
  ctx.emit(agentCarrier(agent), 'agent/inbox/inserted', {
    agent,
    message: { source: { kind: 'user' }, content: text('帮我看下 README 第一段') },
  })
  const native = await read(ctx, agent)
  console.log('after a short task:', native)
  assert(native.tools.includes('demo_tool') && !native.tools.includes(RUN_CODE_NAME), 'short task switches back to native')
  assert(!native.sections.includes('tools:sdk'), 'native drops the SDK section')

  // A preset that declares ptc must lose to this agent's own declaration, and
  // the agent can still move between the two.
  const presetKey = { id: 'preset-ptc' }
  const presetScope = createScope(ctx, presetKey)
  let presetCtx
  await presetScope.ctx.inject(['tools'], (injected) => { presetCtx = injected })
  presetCtx.tools.presentAs('ptc')
  const agent2 = {
    id: 'preset-agent',
    session: { deriveMessages: () => [] },
  }
  const scope2 = createScope(ctx, agent2, { parent: presetKey })
  agent2.ctx = scope2.ctx
  await ctx.serial(agentCarrier(agent2), 'agent/created', { agent: agent2, source: 'startup' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const overPreset = await read(ctx, agent2)
  console.log('agent under a ptc preset (default native):', overPreset)
  assert(overPreset.tools.includes('demo_tool'), 'the agent scope overrides the ptc preset')
  ctx.emit(agentCarrier(agent2), 'agent/inbox/inserted', {
    agent: agent2,
    message: { source: { kind: 'user' }, content: text(BATCH) },
  })
  const presetPtc = await read(ctx, agent2)
  console.log('agent under a ptc preset after a batch task:', presetPtc)
  assert(presetPtc.tools.length === 1 && presetPtc.tools[0] === RUN_CODE_NAME, 'the agent can move to ptc over a native preset decision')
  await scope2.dispose()

  const global = await read(ctx, undefined)
  console.log('global view:', global)
  assert(global.tools.includes('demo_tool'), 'the deployment default is untouched')

  await scope.dispose()
  ctx.dispose?.()

  if (failures > 0) {
    console.error(`${failures} integration check(s) failed`)
    process.exitCode = 1
  } else {
    console.log('integration checks passed')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
