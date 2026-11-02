import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTask,
  describeDecision,
  isContinuation,
  latestTaskText,
  messageText,
} from '../classifier.js'

const text = (value) => [{ type: 'text', text: value }]

test('short greeting routes to native', () => {
  assert.equal(classifyTask('你好').mode, 'native')
  assert.equal(classifyTask('谢谢！').mode, 'native')
})

test('single-action and explanation requests stay native', () => {
  assert.equal(classifyTask('帮我看下 package.json').mode, 'native')
  assert.equal(classifyTask('解释一下 src/index.ts 里这个函数的作用').mode, 'native')
})

test('batch task over the whole repo routes to ptc', () => {
  const decision = classifyTask('遍历 src 下所有 ts 文件，找出所有 console.log，统计每个文件的数量并汇总成表格')
  assert.equal(decision.mode, 'ptc')
  assert.ok(decision.ptcScore > decision.nativeScore)
  assert.ok(decision.reasons.length > 0)
})

test('parallel fan-out routes to ptc', () => {
  assert.equal(classifyTask('并行下载这些 URL，然后合并结果').mode, 'ptc')
})

test('script plus batch routes to ptc', () => {
  assert.equal(classifyTask('写一个脚本，批量处理这些图片').mode, 'ptc')
})

test('long enumerated brief routes to ptc', () => {
  const brief = [
    '请完成以下重构，分步骤进行：',
    '1. 扫描整个仓库里的所有 TypeScript 文件',
    '2. 提取每个文件的导出符号并汇总成表格',
    '3. 逐个更新引用，跑一遍测试',
    '4. 生成迁移报告',
  ].join('\n')
  assert.equal(classifyTask(brief).mode, 'ptc')
})

test('explicit mode requests win', () => {
  assert.equal(classifyTask('用标准模式解释一下这个循环').mode, 'native')
  assert.equal(classifyTask('改用 ptc 处理').mode, 'ptc')
})

test('forceMode overrides scoring', () => {
  assert.equal(classifyTask('遍历所有文件', { forceMode: 'native' }).mode, 'native')
  assert.equal(classifyTask('你好', { forceMode: 'ptc' }).mode, 'ptc')
})

test('custom keywords bias the score', () => {
  const native = classifyTask('遍历这个表', { extraNative: ['表'] })
  assert.equal(native.mode, 'native')
  const ptc = classifyTask('遍历这个表', { extraPtc: ['表'] })
  assert.equal(ptc.mode, 'ptc')
})

test('continuation detection recognizes short acknowledgements only', () => {
  for (const value of ['继续', '继续。', '好', '好的', 'ok', 'go on', '可以', '下一步']) {
    assert.equal(isContinuation(value), true, value)
  }
  for (const value of ['继续重构整个仓库', '遍历所有文件', '为什么']) {
    assert.equal(isContinuation(value), false, value)
  }
})

test('messageText joins only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText(undefined), '')
})

test('latestTaskText keeps the substantive task behind a continuation', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: text('遍历所有文件，统计每个文件的行数并汇总') },
    { role: 'assistant', source: { kind: 'model' }, content: text('已经完成一部分') },
    { role: 'user', source: { kind: 'user' }, content: text('继续') },
  ]
  assert.match(latestTaskText(messages), /遍历所有文件/)
})

test('latestTaskText ignores runtime context', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: text('帮我看下 README') },
    { role: 'user', source: { kind: 'runtime-context' }, content: text('当前目录：/tmp') },
  ]
  assert.equal(latestTaskText(messages), '帮我看下 README')
})

test('describeDecision is stable and readable', () => {
  const line = describeDecision(classifyTask('遍历所有文件，统计每个文件的行数并汇总'))
  assert.match(line, /^ptc/)
  assert.match(line, /ptc \d+ : native \d+/)
})
