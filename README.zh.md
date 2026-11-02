# dsh-ptc-router

[English](README.md) | 中文

**为 DeepSeek Harness 按任务选择工具呈现方式。** 每个任务自动在 PTC 与标准模式之间选择，并允许在任务进行中随时切换，无需修改会话的 agent preset。

## 为什么需要它

DeepSeek Harness 用两种形态之一向模型呈现工具：

| 形态 | 模型看到 | 适合 |
|---|---|---|
| `native` | 每个工具一份 JSON Schema | 短问答、单个动作、少量工具调用 |
| `ptc` | 一个 `run_code` + 生成的 SDK | 批量 / 遍历、并行、脚本化、数据加工 |

形态在 agent 组装时确定（通常由 agent preset 决定），所以一个会话通常从头到尾只有一种形态。但真实会话常常混着用：先做一次批量迁移，紧接着问“刚才那个为什么失败”。

本插件补上按任务选择的能力：

- **自动判定**：任务开始时选择形态；新任务替换旧任务时重新判定。
- **随时切换**：模型或用户都能切换，从下一步生效。
- **agent 作用域覆盖**：覆盖 preset 的形态，并随 agent 销毁自动撤销；子 agent 保持自己的组合。
- **自动回退**：部署没有挂载 PTC 运行时时保持标准模式。

## 安装

这是一个 Host bundle：不需要构建，没有运行时依赖。

### 插件页（推荐）

打开 **插件**，从 GitHub（使用本仓库地址）或本地目录安装，然后启用 `dsh-ptc-router`。

### CLI

```sh
dsh plugin --profile web add github:<owner>/dsh-ptc-router   # <owner> = this repository's owner
```

然后在插件页启用 `dsh-ptc-router`。（插件页会同时维护 profile 的 bundle 列表；单独执行 CLI 只安装包本身。）

### 开发期 overlay

```sh
dsh --profile web --patch ./dev/dev.patch.yml
```

`dev/dev.patch.yml` 直接从本检出加载 `../index.js`，改完代码下次启动或重载即生效，不需要装进 profile。

## 使用

### 自动判定

无需操作。agent 创建或恢复时读取最近一条实质性用户消息；之后每条新用户消息都会在第一步模型请求之前判定。`继续`、`接着`、`ok` 这类短回复沿用当前形态，不会触发重判。

### `/mode`

```text
/mode                 查看当前形态、来源与最近一次判定
/mode native          固定为标准模式（自动判定暂停）
/mode ptc             固定为 PTC
/mode auto            恢复自动判定，并按当前任务重新判定
```

### `switch_tool_mode`

任务形态变化时由模型调用：

```text
switch_tool_mode({ mode: "ptc" | "native" | "auto", reason?: string })
```

PTC 模式下同一工具在程序内以 `tools.switch_tool_mode` 出现。

## 怎么判定

对任务文本做中英双语加权评分。

- **偏向 PTC**：批量 / 逐个 / 遍历、并行、脚本与流水线、全仓范围、数据加工、审查与迁移、多步骤说明、长结构化提示、多处文件引用。
- **偏向标准**：短指令、提问与解释、单个动作、寒暄、视觉 / 界面类请求。

`ptcScore - nativeScore >= threshold`（默认 `2`）时选 PTC。示例：

| 任务 | 形态 |
|---|---|
| `遍历所有文件，统计每个文件的行数并汇总` | ptc |
| `并行下载这些 URL 然后合并结果` | ptc |
| `解释一下这个函数的作用` | native |
| `帮我看下 README 第一段` | native |
| `继续` | 不变 |

分类器刻意保持小而可测试；模型可用 `switch_tool_mode` 覆盖，用户可用 `/mode` 覆盖。

## 配置

所有字段都可选；逐项说明见 `cordis.patch.yml` 注释。

| 字段 | 默认 | 含义 |
|---|---|---|
| `auto` | `true` | 是否按任务自动判定 |
| `defaultMode` | `native` | 无任务文本时使用的形态；`/mode auto` 无历史时也用它 |
| `forceMode` | `auto` | `native` / `ptc` 强制所有会话使用同一形态 |
| `threshold` | `2` | 选 PTC 所需的分差 |
| `guidance` | `true` | 是否注入一小段提示，告诉模型可以切换 |
| `applyToSubagents` | `false` | 是否也接管子 agent（默认只接管根 agent） |
| `extraPtc` | `[]` | 追加 PTC 关键词（每个 +2 分） |
| `extraNative` | `[]` | 追加标准关键词（每个 −2 分） |

在 profile patch 中覆盖：

```yaml
- id: dsh-ptc-router
  config:
    threshold: 3
    extraPtc: ['截图比对', '批量截图']
```

## 工作原理

`ctx.tools.presentAs(mode)` 是挂在调用作用域上的 Cordis effect：一个作用域只能声明一次，撤销声明会移除该作用域的呈现层。因此切换 = 在 agent 自己的作用域上「撤销 → 重新声明」——同步完成，并由 `agent/inbox/inserted` 触发；该事件早于驱动器唤醒并组装步骤。

裸 `agent.ctx` 不能访问服务，所以插件注入一个带 `tools` 的 agent 子上下文（`agent.ctx.inject(['tools'], …)`）并在其中声明。声明保留 agent 的作用域标签，随 agent 销毁自动撤销；由于 agent 作用域比 preset 作用域更近，它在存活期间覆盖 preset 的形态。这些 effect 的撤销是同步的，这正是收件箱路径不会与步骤组装竞态的原因；切换后会发出 `tools/change`，让其他注册表重新读取工具目录。

## 开发

```sh
npm test                          # 分类器 + 路由状态机
npm run classify -- "遍历所有文件并统计行数"
```

两个集成 harness 会挂载真实的 Host 服务，因此需要让 `@deepseek-ai/*` 能从 `dev/` 解析：

```sh
ln -s /path/to/dsh/node_modules dev/node_modules
npm run spike          # presentAs 撤销 / 重新声明往返
npm run integration    # 在真实 ToolRuntime / SystemPrompt 上挂载路由器
```

## 限制

- 切换会改变工具目录与系统提示，下一次请求会重建前缀（一次 KV cache 失效）。这是切换形态的固有代价。
- 手动 `/mode` 固定不会持久化。重启后按最近任务重新判定；需要部署级策略时用 `forceMode` / `defaultMode`。
- 默认只接管根 agent；子 agent 保持自己的 preset 形态。
- `ptc` 需要挂载 `ptcRuntime`。没有时插件保持标准模式，并在 `/mode` 中说明。
- 运行中切换依赖 `presentAs` 的「撤销后重新声明」语义（已在 `0.2.1-rc.2` 验证）。升级 Harness 后请重跑 `npm run spike`。

## 目录结构

```text
.
├── index.js                 # Host 插件：事件、/mode、switch_tool_mode
├── classifier.js            # 纯函数加权分类器
├── cordis.patch.yml         # bundle patch
├── package.json             # dsh.bundle 清单
├── locale/                  # 插件页标题与说明
├── icon.svg
├── bin/classify.mjs         # 离线分类 CLI
├── test/                    # node:test 用例
└── dev/                     # 真实服务 harness 与 overlay patch
```

## 许可证

MIT
