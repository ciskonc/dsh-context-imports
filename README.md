<div align="center">

# dsh-context-imports · 上下文导入

<p align="center">DeepSeek Harness 会注入 <b>AGENTS.md 本体</b>，但里面的 <b>@路径 引用只是死文本</b>——模型根本读不到。本插件把 Claude Code 的 <b>@import 机制</b>真正带进 DSH：会话启动时<b>递归展开</b>引用（深度可控、预算封顶、代码块忽略、缺失兜底），把被引用文件全文注入为持久上下文；<b>压缩后自动续命</b>，<b>活跃上下文永远只有一份</b>（事件形态无关的注入检测）；装上即有<b>六语言设置卡片</b>（中/英/日/法/俄/韩），注入包装文本跟随 UI 语言。只基于官方公开 API（<code>agent/session-start</code> + <code>agent.inject()</code> + schemastery + dsh-settings），<b>零功能插件依赖</b>。</p>

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

中文 | [English](README.en.md)

</div>

---

## 它解决什么问题

| | 没有 dsh-context-imports | 装上之后 |
|---|---|---|
| AGENTS.md 本体 | ✅ 官方 agent-instructions 注入 | ✅ 仍由官方注入（不重复） |
| `@00_BOOT/SYSTEM_STATE.md` 等引用 | ❌ 死文本，模型看不到 | ✅ 全文注入为会话上下文 |
| 引用的引用（嵌套 @import） | ❌ 无人处理 | ✅ 递归展开，深度可控 |
| 长会话压缩后 | ❌ 状态文件随历史被压掉 | ✅ compact 后自动重新注入（续命） |
| 恢复会话（resume） | — | ✅ 检测到已有注入即跳过，永不叠加重复块 |

## 工作机制

```text
agent/session-start（startup / resume / clear / compact）
  │
  ├─ 读取配置（设置卡片实时生效，无需重载）
  │
  ├─ 扫描指令文件（默认 AGENTS.md / CLAUDE.md）中的 @路径 引用
  │    ├─ 跳过围栏代码块；必须带文件扩展名
  │    ├─ 相对路径按「引用者所在目录」解析，逐层递归（默认 ≤3 层）
  │    └─ 按解析后路径去重，环引用天然免疫
  │
  ├─ 合并显式 files 列表（这些文件注入全文，指令文件本体只扫描不重注）
  │
  ├─ 预算封顶：单文件 64KB（超限截断并标注）/ 总量 128KB（超限省略并标注）
  │    缺失文件只记一行提示，不报错
  │
  ├─ 单份不变量：扫描持久历史，任何事件形态下检测到已有注入 → 跳过
  │    （注入消息以 agent/inbox/spliced 事件落库，按 source 标签 +
  │     中/英包装指纹三重匹配；compact 真正压掉旧块后会自动重注）
  │
  └─ agent.inject() 注入一条 <system-reminder> 上下文消息（官方推荐通道）
```

包装文本语言解析链：用户显式语言偏好 → 浏览器实际解析语言（client 半自动同步）→ 英文兜底；也可用 `template` 完全自定义（`{{content}}` 占位）。

## 特性

- **Claude Code 式 @import**：`AGENTS.md` 里写 `@04_MEMORY/INDEX.md`，会话开始模型就"已经读过"它——不再依赖 Agent 自觉执行启动读取（那个假设已被证明不可靠）。
- **四场景触发，全部可配**：新会话 / 恢复 / 清空 / 压缩后。压缩续命是刻意设计——长会话压缩后状态文件自动回场。
- **单份注入不变量**：对持久会话日志做了事件形态核验（注入以 `agent/inbox/spliced` 事件落库而非 `user/message`），检测跨形态三重匹配；任何场景下活跃上下文最多一份。
- **六语言设置卡片**：设置 → Plugins → Plugin configuration 图形化编辑全部配置；界面文案中/英/日/法/俄/韩，跟随宿主语言实时切换。
- **预算与兜底**：单文件/总量双预算、缺失文件降级为提示行、围栏代码块内的 `@` 不误判、环引用去重。
- **纯官方 API**：cordis 事件 + `agent.inject()`/`createUserMessage`（dsh-llm）+ schemastery Config + dsh-settings `installSection`（可选服务，缺失时按组合配置照常工作）。不依赖任何其他功能插件。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `files` | `[]` | 额外注入的文件（相对会话工作目录或绝对路径） |
| `scanImports` | `true` | 扫描 AGENTS.md 等指令文件中的 @import 并递归展开 |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | 参与扫描的指令文件候选名（只扫描，不重注本体） |
| `maxDepth` | `3` | @import 递归深度上限 |
| `maxFileBytes` | `65536` | 单文件字节上限（超限截断） |
| `maxTotalBytes` | `131072` | 总字节预算（超限省略） |
| `injectOn` | 全部四项 | 触发注入的会话启动场景（startup / resume / clear / compact） |
| `template` | `""` | 自定义包装模板，`{{content}}` 标记注入内容位置；留空用语言默认 |

## 安装

npm 包即将发布，发布后此处提供一键安装命令。当前可从源码构建：

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<你的 dsh 安装目录> npm run build        # host 半 → lib/index.js
npm run build:client                                  # 浏览器半 → lib/client.js
```

构建产物为标准 DSH 插件包（`lib/`），装入你的 profile 即可；设置卡片出现在 **Settings → Plugins → Plugin configuration**。

## 开发

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | Host 半：session-start 监听、@import 递归展开、预算、注入、settings 命名空间 |
| [src/client/index.ts](src/client/index.ts) | 浏览器半入口：六语言字典注册 + `settings.plugin.item` keyed slot 卡片 |
| [src/client/form.ts](src/client/form.ts) | 精简 CardForm（官方实现移植，修正数组回读比较） |
| [src/client/ContextImportsCard.tsx](src/client/ContextImportsCard.tsx) | 卡片组件（复刻官方 PluginCard 结构与 CSS 变量） |

**client 插件两条铁律**（真实踩坑沉淀，违者炸宿主）：

1. `__ModuleLoader__.load({ id })` 的 `id` 必须逐字等于 package.json 的 `name`——差一个 scope 前缀 loader 就按"未注册"处理；
2. `inject` 只声明 shell 模块表（staticModules 种子）里真实存在的模块——已从模块表删除的包（如 `@deepseek-ai/dsh-client-runtime`）声明了就崩。

## License

[MIT](LICENSE)
