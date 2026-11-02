#!/usr/bin/env node
/**
 * Inspect the router's task classification without booting a Harness.
 *
 *   node bin/classify.mjs "遍历 src 下所有文件并统计行数"
 *   echo "explain this function" | node bin/classify.mjs
 *   node bin/classify.mjs --threshold 3 "长任务文本..."
 */
import { readFileSync } from 'node:fs'
import { classifyTask, describeDecision } from '../classifier.js'

const args = process.argv.slice(2)
let threshold
if (args[0] === '--threshold') {
  threshold = Number(args[1])
  args.splice(0, 2)
}
const text = args.length > 0 ? args.join(' ') : readFileSync(0, 'utf8')
const decision = classifyTask(text, { threshold })
console.log(describeDecision(decision))
console.log(JSON.stringify({ ...decision, threshold: threshold ?? 2 }, null, 2))
