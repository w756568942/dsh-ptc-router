/**
 * Technical spike: can one agent's tool presentation be switched at runtime?
 *
 * This mounts the real host-plane services (SystemPrompt + ToolRuntime) from the
 * installed DSH packages, declares a scoped presentation with
 * `ctx.tools.presentAs()`, disposes it, and declares the other one — then reads
 * the prompt assembly the model would receive for that scope.
 *
 * Run: node dev/presentation-harness.mjs
 */
import { Service } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

/** Minimal PTC runtime seam: presentation only needs language + programFormat. */
class FakePtcRuntime extends Service {
  constructor(ctx) {
    super(ctx, 'ptcRuntime')
    this.language = 'typescript'
    this.programFormat = 'async-function'
    this.timeout = { defaultMs: 120000, maxMs: 600000 }
    this.executionInstructions = 'Write a TypeScript async function body.'
    this.isolation = { kind: 'process', detail: 'harness' }
    this.sandboxMode = undefined
  }
  resolve(request) {
    return { ...request, cwd: process.cwd(), timeoutMs: request.timeoutMs ?? 120000 }
  }
  async run(spec) {
    return { value: null, logs: [], error: undefined, sandbox: undefined, spec }
  }
}

const TOOL = {
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

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function assert(condition, message) {
  if (!condition) fail(message)
  else console.log(`ok - ${message}`)
}

async function main() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(FakePtcRuntime)
  ctx.tools.register(TOOL)
  await ctx.loader?.await?.()

  const agentKey = { id: 'harness-agent' }
  const scope = createScope(ctx, agentKey)
  let toolCtx
  const toolFiber = scope.ctx.inject(['tools'], (injected) => { toolCtx = injected })
  await toolFiber

  const read = async () => {
    const assembly = await ctx.systemPrompt.assemble({ scope: agentKey })
    return {
      tools: assembly.tools.map((t) => t.name),
      sections: assembly.sections.filter((s) => s.text !== '').map((s) => s.name),
    }
  }

  const native = await read()
  console.log('default (deployment native):', native)
  assert(native.tools.includes('demo_tool'), 'deployment default presents the native tool schema')
  assert(!native.tools.includes(RUN_CODE_NAME), 'deployment default hides run_code')

  // 1. Declare PTC for this agent scope (the same call our plugin makes).
  let dispose = toolCtx.tools.presentAs('ptc')
  const ptc = await read()
  console.log('after presentAs(ptc):', ptc)
  assert(ptc.tools.length === 1 && ptc.tools[0] === RUN_CODE_NAME, 'ptc scope presents only run_code')
  assert(ptc.sections.includes('tools:sdk'), 'ptc scope carries the generated SDK section')
  assert(ptc.sections.includes('tools:ptc-only'), 'ptc scope carries the one-transport rule')

  // 2. Switch back to native by disposing and re-declaring (synchronous).
  const result = dispose()
  assert(result === undefined, 'presentAs disposer is synchronous (no promise to await)')
  dispose = toolCtx.tools.presentAs('native')
  const back = await read()
  console.log('after dispose + presentAs(native):', back)
  assert(back.tools.includes('demo_tool') && !back.tools.includes(RUN_CODE_NAME), 'native restored after re-declaration')
  assert(!back.sections.includes('tools:sdk'), 'SDK section removed when native')

  // 3. And back again, proving the declaration can be rebuilt repeatedly.
  dispose()
  dispose = toolCtx.tools.presentAs('ptc')
  const again = await read()
  console.log('after second rebuild to ptc:', again)
  assert(again.tools.length === 1 && again.tools[0] === RUN_CODE_NAME, 'presentation can be rebuilt repeatedly')

  // 4. Mid-step semantics: the declared layer is read on every assembly.
  dispose()
  await scope.dispose()
  ctx.dispose?.()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
