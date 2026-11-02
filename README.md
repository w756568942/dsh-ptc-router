# dsh-ptc-router

English | [中文](README.zh.md)

**Per-task tool-presentation routing for DeepSeek Harness.** Choose PTC or native for each task, and switch it mid-task without changing the session preset.

## Why

DeepSeek Harness renders an agent's tools in one of two forms:

| Form | The model sees | Best for |
|---|---|---|
| `native` | every visible tool as a JSON Schema | short, conversational, few-call turns |
| `ptc` | one `run_code` tool plus a generated SDK | batch, iterative, parallel, data-heavy work |

The form is chosen when the agent is assembled — normally by an agent preset — so a session usually stays in one form from start to finish. Real sessions mix both: a batch migration, then “why did that one fail?”.

This plugin adds the missing per-task choice:

- **Automatic routing** at the start of a task, and again when a new task replaces the old one.
- **Live switching** from the model or the user, effective on the next step.
- **Agent-scoped override** that beats the preset's form and unwinds with the agent; subagents keep their own composition.
- **Graceful fallback** to native when the deployment mounts no PTC runtime.

## Install

The plugin is a Host bundle: no build step, no runtime dependencies.

### Plugins page (recommended)

Open **Plugins**, install from GitHub (use this repository) or from a local checkout, then enable `dsh-ptc-router`.

### CLI

```sh
dsh plugin --profile web add github:<owner>/dsh-ptc-router   # <owner> = this repository's owner
```

Then enable `dsh-ptc-router` on the Plugins page. (The Plugins page updates the profile's bundle list for you; the bare CLI command only installs the package.)

### Development overlay

```sh
dsh --profile web --patch ./dev/dev.patch.yml
```

`dev/dev.patch.yml` loads `../index.js` from this checkout, so edits apply on the next boot/reload without installing anything into the profile.

## Usage

### Automatic

Nothing to do. At agent creation or resume the plugin reads the most recent substantive user message; each new user message is classified before its first model step. Short continuations (`继续`, `接着`, `ok`, …) inherit the current form instead of triggering a re-classification.

### `/mode`

```text
/mode                 show the current form, its source, and the last decision
/mode native          pin native (suspends automatic routing)
/mode ptc             pin PTC
/mode auto            resume automatic routing and re-classify the current task
```

### `switch_tool_mode`

The model calls it when the shape of the task changes:

```text
switch_tool_mode({ mode: "ptc" | "native" | "auto", reason?: string })
```

In PTC mode the same tool is available inside a program as `tools.switch_tool_mode`.

## How it decides

A weighted, bilingual heuristic over the task text.

- **Towards PTC:** batch / each / iterate, parallel work, scripts and pipelines, repository-wide scope, data processing, audits and migrations, multi-step briefs, long structured prompts, several file references.
- **Towards native:** short instructions, questions and explanations, single actions, greetings, visual/UI requests.

`ptcScore - nativeScore >= threshold` (default `2`) selects PTC. Examples:

| Task | Form |
|---|---|
| `遍历所有文件，统计每个文件的行数并汇总` | ptc |
| `并行下载这些 URL 然后合并结果` | ptc |
| `解释一下这个函数的作用` | native |
| `帮我看下 README 第一段` | native |
| `继续` | unchanged |

The classifier is deliberately small and testable. The model can always override it with `switch_tool_mode`, and the user with `/mode`.

## Configuration

Every field is optional; see `cordis.patch.yml` for inline comments.

| Field | Default | Meaning |
|---|---|---|
| `auto` | `true` | classify tasks automatically |
| `defaultMode` | `native` | form before any task text, and for `/mode auto` with no history |
| `forceMode` | `auto` | `native` / `ptc` forces one form for every session |
| `threshold` | `2` | score difference needed to pick PTC |
| `guidance` | `true` | one short prompt paragraph telling the model it may switch |
| `applyToSubagents` | `false` | also adopt subagents (root agents only by default) |
| `extraPtc` | `[]` | extra PTC keywords (+2 each) |
| `extraNative` | `[]` | extra native keywords (−2 each) |

Override in a profile patch:

```yaml
- id: dsh-ptc-router
  config:
    threshold: 3
    extraPtc: ['screenshot diff', '批量截图']
```

## How it works

`ctx.tools.presentAs(mode)` is a Cordis effect on the calling scope: one declaration per scope, and disposing it removes that scope's presentation layer. A switch is therefore “dispose, then declare again” on the agent's own scope — synchronous, and triggered from `agent/inbox/inserted`, which fires before the driver wakes and assembles the step.

A bare `agent.ctx` cannot access services, so the plugin injects a `tools`-scoped child (`agent.ctx.inject(['tools'], …)`) and declares there. The declaration keeps the agent's scope tag and unwinds with the agent. Because the agent scope is nearer than the preset scope, it overrides the preset's form while it lives. Disposal is synchronous for these effects, which is what makes the inbox path race-free; `tools/change` is emitted so other registries re-read the catalog.

## Development

```sh
npm test                          # classifier + router state machine
npm run classify -- "遍历所有文件并统计行数"
```

The two integration harnesses mount the real host services, so they need the `@deepseek-ai/*` packages resolvable from `dev/`:

```sh
ln -s /path/to/dsh/node_modules dev/node_modules
npm run spike          # presentAs dispose/redeclare round-trip
npm run integration    # router on the real ToolRuntime / SystemPrompt
```

## Limits

- A switch changes the tool catalog and the system prompt, so the next request rebuilds its prefix (one KV-cache miss). That is inherent to changing the form.
- A manual `/mode` pin is not persisted. After a restart the plugin re-classifies the latest task; use `forceMode` / `defaultMode` for deployment-wide policy.
- Root agents only by default; subagents keep their preset's form.
- `ptc` needs a mounted `ptcRuntime`. Without one the plugin stays native and says so in `/mode`.
- The live switch relies on `presentAs`'s dispose-and-redeclare semantics (verified on `0.2.1-rc.2`). Re-run `npm run spike` after upgrading the harness.

## Repository layout

```text
.
├── index.js                 # host plugin: events, /mode, switch_tool_mode
├── classifier.js            # pure weighted classifier
├── cordis.patch.yml         # bundle patch
├── package.json             # dsh.bundle manifest
├── locale/                  # plugin page title and description
├── icon.svg
├── bin/classify.mjs         # offline classifier CLI
├── test/                    # node:test suites
└── dev/                     # real-service harnesses and an overlay patch
```

## License

MIT
