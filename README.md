# dsh-ptc-router

按任务自动选择 **PTC（程序化工具调用）** 或 **标准模式（原生函数调用）**，并允许模型或用户在一个任务进行中随时切换。

这是 DeepSeek Harness 的 Host 插件（bundle），零依赖，不需要构建。

---

## 为什么需要它

DSH 的工具呈现方式（presentation）原本在 agent 组装时固定：

- `native`：模型直接看到每个工具的 JSON Schema；
- `ptc`：模型只看到 `run_code`，其他工具以生成 SDK 的形式在程序里调用。

官方目前只能通过 **agent preset**（`standard` / `ptc`）为整个会话二选一，运行中无法改变。本插件补上两件事：

1. **按任务判定**：新任务开始时根据任务形态选择模式；
2. **随时切换**：模型用工具、用户用 `/mode` 命令，都在下一步生效。

## 两种模式怎么选

| | 标准模式（native） | PTC 模式（ptc） |
|---|---|---|
| 模型看到 | 每个工具的完整 schema | 一个 `run_code` + 生成的 SDK |
| 适合 | 短问答、单个动作、少量工具调用、需要逐步看中间结果 | 批量 / 遍历、并行、脚本化、数据加工、一次需要大量工具调用、中间结果很大 |
| 代价 | 工具多时 schema 占 token，调用多时往返多 | 一次程序内完成；但模型要写代码，简单任务反而更重 |

自动判定基于可解释的加权评分（见 `classifier.js`），例如：

- `遍历 / 批量 / 每个文件 / all files / for each` → PTC
- `并行 / parallel / pipeline / 脚本 / 自动化` → PTC
- `整个仓库 / codebase / 所有文件` → PTC
- `审查 / 迁移 / 重构 / 跑一遍测试` → PTC
- 长文本、结构化清单、多处文件引用 → PTC
- `解释 / 是什么 / 为什么 / 帮我看下 / 打开`、短指令、寒暄 → 标准
- 明确写“用标准模式” / “ptc” → 直接采信

`ptc 分 - native 分 >= threshold`（默认 2）时选 PTC，否则标准。可以先离线调参：

```sh
node bin/classify.mjs "遍历 src 下所有 ts 文件并统计行数"
node bin/classify.mjs --threshold 3 "把 README 第一段翻译成中文"
```

## 切换方式

### 用户：`/mode`

```text
/mode                 查看当前模式、来源和最近一次判定
/mode native          固定为标准模式（自动判定暂停）
/mode ptc             固定为 PTC 模式
/mode auto            恢复自动判定（立即按最近任务重新判定）
```

### 模型：`switch_tool_mode`

工具描述会告诉模型何时切换；它可以在任务中直接调用，不需要用户确认。
PTC 模式下同一工具以 SDK 绑定的形式出现：`tools.switch_tool_mode({ mode: "native" })`。

### 自动判定的时机

- **agent 创建 / 恢复时**：读取会话里最近一条实质性用户消息判定；恢复会话不会丢模式。
- **新用户消息进入收件箱时**：在下一步组装之前重新判定。`继续 / 好 / ok / 下一步` 这类短回复不会触发重判，沿用当前模式。
- 用户 `/mode` 固定后，自动判定暂停，直到 `/mode auto`。

## 安装

### 方式 A：插件页（推荐）

在 Web 侧边栏 **插件** → 安装插件 → 选择「本地目录」→ 填入本目录的绝对路径：

```text
/vol1/@appshare/dsh/dsh_home/工作区/插件
```

（页面走 `install_bundle`，会自行处理依赖、bundle 列表与加载；装完在插件列表里启用 `dsh-ptc-router`。）

### 方式 B：CLI 装入 profile

```sh
dsh plugin --profile web add "file:/绝对路径/插件"
```

`dsh plugin` 只负责安装依赖；还需要把 `"dsh-ptc-router"` 追加到
`$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 数组末尾，然后重启 `dsh web`。
（插件页的 `install_bundle` 会一次完成这两步，所以优先用方式 A。）

安装后可以用 `dsh --profile web --dump-config | grep -A5 dsh-ptc-router` 确认条目已进入组合树。

### 方式 C：开发期 overlay（不改 profile）

```sh
dsh --profile web --patch "/绝对路径/插件/dev/dev.patch.yml"
```

`dev/dev.patch.yml` 用相对路径直接加载 `../index.js`，适合改代码后快速验证。
也可以把该 patch 的 row 复制进 profile 的 `cordis.patch.yml`（会写入 profile，需自行备份）。

## 配置

`cordis.patch.yml` 里的 `config` 全部可选：

| 字段 | 默认 | 含义 |
|---|---|---|
| `auto` | `true` | 是否按任务自动判定 |
| `defaultMode` | `native` | 还没有任务文本时使用的模式；`/mode auto` 无历史时也用它 |
| `forceMode` | `auto` | `native` / `ptc` 强制所有会话使用同一模式；`auto` 才启用判定 |
| `threshold` | `2` | PTC 与标准分差达到多少才选 PTC |
| `guidance` | `true` | 是否注入一小段提示词，告诉模型可以切换 |
| `applyToSubagents` | `false` | 是否也接管子 agent；关闭时子 agent 保持 preset 的选择 |
| `extraPtc` | `[]` | 追加的 PTC 关键词（+2 分） |
| `extraNative` | `[]` | 追加的标准关键词（-2 分） |

覆盖示例：

```yaml
- id: dsh-ptc-router
  config:
    threshold: 3
    extraPtc: ['截图对比', '批量截图']
```

## 实现机制（给维护者）

`ctx.tools.presentAs(mode)` 是挂在 **调用作用域** 上的 Cordis effect：一个作用域只能声明一次；撤销声明会移除该作用域的呈层，再次声明即重建。因此切换 = 在同一个 agent 作用域上「撤销 → 重新声明」，且整个过程是同步的：

- 插件在 `agent/created` 里通过 `agent.ctx.inject(['tools'], ...)` 拿到一个 **带 tools 注入、且仍带 agent 作用域标签** 的子上下文（裸 `agent.ctx` 不允许访问服务）；
- 用该子上下文调用 `presentAs(mode)`，声明随 agent 销毁自动撤销；
- `agent/inbox/inserted` 是同步事件，在驱动器唤醒并组装第一步之前触发，所以在监听器里切换能赶在 `systemPrompt.assemble()` 之前生效；
- agent 作用域的声明会遮住 preset 作用域的声明，所以即使会话用的是 `ptc` preset，本插件仍能把它切回标准模式。

## 验证

```sh
npm test            # 29 个用例：分类器 + 路由状态机
npm run spike       # 真实 dsh-tools / dsh-system-prompt 上验证 presentAs 往返切换
npm run integration # 真实服务上挂载插件，检查模型实际看到的 tools 与 prompt sections
```

已验证的行为（0.2.1-rc.2）：

- native → ptc → native 反复重建，模型可见工具从 `demo_tool` 变为 `run_code` 再变回；
- PTC 时出现 `tools:sdk` 与 `tools:ptc-only` 段落，切回标准后消失；
- 批量任务历史 → 创建即 PTC；短任务消息 → 下一步切回标准；
- 在 `ptc` preset 下，agent 作用域仍可覆盖为 native，再切回 PTC；
- `/mode` 固定后不再自动重判，`/mode auto` 恢复；
- 无 PTC 运行时时自动回退标准并报 `fallback`。

## 已知限制

- **切换会让前缀缓存失效一次**：工具目录与系统提示变了，下一次请求会重建前缀。这是模式切换的固有代价。
- **手动固定不持久化**：重启/恢复后按最近任务重新判定；v1 不写会话日志（避免引入自定义事件类型）。若需要跨重启记住 `/mode native`，后续可加 storage。
- **只接管根 agent**：默认不碰子 agent，避免子 agent 的 preset 被悄悄改写。
- **依赖 `presentAs` 的撤销语义**：这是当前 Harness 的公开 API，但“撤销后重新声明”是隐式约定；升级到新版本后请跑一次 `npm run spike`。
- **PTC 需要 profile 挂载 `ptcRuntime`**：Web/Headless 默认挂载；缺失时自动回退并在 `/mode` 里提示。
- **自动判定是启发式的**：它只决定第一步；判断错了可以让模型调用 `switch_tool_mode`，或 `/mode` 手动纠正。

## 目录

```text
.
├── index.js                 # 插件入口：事件接线、/mode、switch_tool_mode
├── classifier.js            # 纯函数：任务评分与判定（可单独复用）
├── cordis.patch.yml         # bundle patch（安装时使用）
├── package.json             # dsh.bundle.patch + 元数据
├── locale/{en,zh}.json      # 插件页标题与说明
├── icon.svg
├── bin/classify.mjs         # 离线调参 CLI
├── test/                    # node:test 用例
└── dev/                     # 开发期验证脚本与 overlay patch
```
