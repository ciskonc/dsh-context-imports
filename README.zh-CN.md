<div align="center">

# dsh-context-imports

**一个把 AGENTS.md 里的 `@路径` 引用展开为真实文件内容、注入模型上下文的 DeepSeek Harness 插件。**

DSH 自带的 agent-instructions 插件会注入 AGENTS.md 本体，但里面的 `@路径` 引用只是普通文本，模型看不到。这个插件把每个被引用的文件读出来，加进会话上下文。

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

[English](README.md) | 中文

</div>

---

## 简介

dsh-context-imports 是一个 DeepSeek Harness 插件：扫描指令文件里的 `@路径` 引用，把被引用的文件注入会话上下文。AGENTS.md 本体仍由官方 agent-instructions 插件注入，不会重复。

DSH 自带的插件只注入 AGENTS.md 本体，里面的 `@路径` 引用模型看不到；再往深一层嵌套的引用更是没人处理。

这个插件接手之后，每个被引用的文件全文进入上下文。

## 工作原理

```text
agent/created（新会话 / 恢复 / 清空 / 压缩后）记录场景
agent/pre-step（每一步）决定是否注入
  ├─ 扫描指令文件（默认 AGENTS.md、CLAUDE.md）里的 @路径 引用
  │    ├─ 跳过围栏代码块；路径必须带文件扩展名
  │    ├─ 相对路径按引用者所在目录解析
  │    ├─ 按解析后的路径去重，循环引用不会死循环
  │    └─ 相对引用若落在会话工作目录之外，不读内容，只留一条六语提示
  │         （绝对路径引用不受此限制）
  ├─ 合并显式配置的 files 列表（这些文件注入全文；指令文件只扫描，不会重复注入）
  ├─ 预算限制：单文件 64 KB（超出就截断并标注），总量 128 KB（放不下的跳过并标注）；
  │    文件不存在只记一行提示，不报错
  ├─ 去重是块级增量的：已出现在表面的文件块不再重发，内容变化会重新注入，
  │    压缩把块压出表面后自动补注
  ├─ live 模式（默认关闭）在步骤之间监视已注入的文件，重新注入变更的内容
  │    （防抖 + 最小间隔节流）
  └─ 注入内容追加在整条消息序列的末尾，排在 AGENTS.md 和其他上下文之后
```

注入的消息是一个 `<system-reminder>`，里面只有 `<file path="...">` 块，没有别的说明文字。想自定义包装格式就配置 `template`。

## 特性

- 递归展开 `@路径` 引用，默认深度 3 层，循环引用和重复路径会自动合并。同时跟随 DSH 已加载的所有指令文件里的引用——包括 AI 碰到项目文件后、会话中途自动带进来的项目 AGENTS.md。
- 注入时机：新会话、恢复、清空、压缩后都会触发，每种场景都可以单独关掉。可选的 live 模式（默认关闭）在会话运行期间盯住文件变更。
- 增量注入：已在上下文里的未变更文件不再重发，内容变了才重新注入；中途新加载的说明书只补上它自己引用的那些文件。
- 两道机制挡住频繁改写：变更事件有防抖窗口（`watchDebounceMs`），短时间连续保存合并为一次监视处理；同一文件的重新注入有最小间隔（`minReinjectIntervalMs`），不会刷屏上下文。
- 工作区围栏：扫描发现的相对引用必须落在会话工作区内；围栏外的路径不读内容，对应位置只注入一条六语提示。绝对路径引用不受围栏限制。
- 单文件与总量都有字节上限，文件缺失只是提示，不会导致失败。截断只作用于注入文本——嵌套扫描始终读全文，大文件尾部的引用不会静默丢失。
- 扫描对 Unicode 感知：中文等非 ASCII 路径正常匹配注入。
- 设置卡片支持六种语言（中、英、日、法、俄、韩），在 Settings 的 Plugins 页。所有配置都能在卡片上改，改完立即生效，不用重启。
- 只用官方公开 API：cordis 事件、dsh-llm 的 `createUserMessage`、schemastery 配置校验，client 侧用 `slots`、`locale`、`configForms` 三个服务。不依赖其他功能插件。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `files` | `[]` | 额外注入的文件，相对会话工作目录或绝对路径 |
| `scanImports` | `true` | 扫描 AGENTS.md 等指令文件里的 @import |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | 参与扫描的文件。它们本身不会被重复注入 |
| `expandLoadedInstructions` | `true` | 同时跟随 DSH 实际加载的其它指令文件里的引用，包括会话中途自动带进来的项目 AGENTS.md |
| `maxDepth` | `3` | 嵌套引用最多跟几层 |
| `maxFileBytes` | `65536` | 单文件字节上限，超出截断 |
| `maxTotalBytes` | `131072` | 总字节预算，放不下的文件跳过并标注 |
| `injectOn` | 全部四项 | 哪些会话启动场景触发注入 |
| `liveMode` | `off` | 可选的实时模式（默认关闭）。在设置页选择：`off` = 同 0.3.1，`inject` = 变更后下次交互补发，`inject+wake` = 空闲会话立即唤醒重注入。节流窗口内的连续改动会被合并投递，最后一次改动仍会送达每个会话 |
| `watchDebounceMs` | `30000` | 文件变更事件的防抖窗口 |
| `minReinjectIntervalMs` | `300000` | 同一文件两次重注入的最小间隔（防频繁改写刷屏） |
| `detectedLocale` | `""` | 浏览器解析出的界面语言，由 client 半写入，供 host 半按界面语言包装注入文本 |
| `template` | `""` | 自定义包装文本。`{{content}}` 标记文件内容的位置；留空用默认格式 |

## 安装

<details>
<summary>通过 dsh plugin 安装</summary>

```sh
dsh plugin --profile web add dsh-context-imports
```

装完不用配置就能用：默认扫描 AGENTS.md 和 CLAUDE.md，并把引用到的文件注入会话。

</details>

<details>
<summary>从源码构建</summary>

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<你的 dsh 安装目录> npm run build
npm run build:client
```

</details>

## 版本适配

| 插件版本 | DeepSeek Harness | 说明 |
|---|---|---|
| **0.6.1** | **≥ 0.2.0**（实测 0.2.2-rc.5 与 0.2.1-rc.5） | 当前线。peer 依赖显式声明 `@deepseek-ai/cosmokit`，标准安装不再解析到缺少 `createVolatile` 的版本（该不匹配会让插件静默不激活）；设置项拒绝非正数、多行字段一行一条显示、全角标点后的 `@引用` 可识别、连续改动的最后一次不再丢失 |
| 0.6.0 | ≥ 0.2.0（实测 0.2.2-rc.5 与 0.2.1-rc.5） | 当前线。对抗审查加固：设置页 liveMode 保存修复（字符串枚举）、扫描引用的工作区围栏、CJK 路径、唤醒风暴去重。增量注入语义不变 |
| 0.3.1 – 0.5.1 | ≥ 0.2.0-rc.1（0.3.1 实测 0.2.1-rc.2 与 0.2.1-rc.3） | 新增 `expandLoadedInstructions`：展开 DSH 已加载的所有指令文件里的引用，包括会话中途自动带进来的项目 AGENTS.md；注入改为增量式——已在上下文里的文件不再重复发送。依赖宿主发布的指令作用域信息（`agent-instructions` 消息 source + `agent.inbox.nextStep`），故面向 DSH ≥ 0.2.0 |
| 0.3.0 | ≥ 0.2.0-rc.1（实测 0.2.1-rc.2） | 同一功能，但 inbox 取值读成了 `session.inbox`（应为 `agent.inbox`），那条路径从未生效——实际靠「本轮消息批次」路径撑起。0.3.1 已修 |
| 0.2.3 | ≥ 0.1.7-rc.1（实测 0.2.0-rc.1、0.2.0-rc.2 与 0.2.1-rc.2） | 配置读取加固：DSH ≥ 0.2.0-rc.2 起 volatile 配置投影不再填充 schema 默认值，入口处对全部字段归一化（0.2.2 在该版本上可能崩溃会话创建或静默不注入）。注意：DSH ≥ 0.2.0-rc.2 起只能用 `dsh plugin add` 安装——loader 会校验 lockfile 一致性，手拷 node_modules 会被静默丢弃 |
| 0.2.0 – 0.2.2 | ≥ 0.1.7-rc.1（0.2.1 实测 0.1.7-rc.2 与 0.2.0-rc.1；0.2.2 实测 0.2.0-rc.1） | 0.2.2 修复压缩后不重注入与设置页挂载，但在 DSH ≥ 0.2.0-rc.2 上可能崩溃会话创建（`injectOn.includes is not a function`）或静默不注入（`cfg.files is not iterable`）——请升级 0.2.3 |
| 0.1.x | 0.1.5-rc.1 – 0.1.5-rc.3（实测 0.1.5-rc.2/rc.3） | 旧线。**不支持 0.1.7**——它依赖已被移除的 `settingsScope` 服务和 `agent/session-start` 事件 |

## 说明

- **实时模式请在设置页配置，不要手写 patch。** `dsh plugin add` 与 `pnpm add` 会重写本插件在 profile patch 里的配置段，手写的 `liveMode` / `watchDebounceMs` / `minReinjectIntervalMs` 在安装或升级后不会保留。到 设置 → 插件 → 上下文导入 里设置一次即可。
- **未保存的修改在刷新页面后会丢失。** 宿主设置表单只提供「保存」，没有「放弃修改」按钮。
- **没有文件扩展名的 `@引用` 会被明确标注为已忽略**，而不是无声丢弃——扫描器需要扩展名才能识别路径。

## 许可

[MIT](LICENSE)
