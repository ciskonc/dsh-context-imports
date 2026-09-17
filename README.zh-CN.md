<div align="center">

# dsh-context-imports

在会话启动时，把 AGENTS.md 里引用的文件注入模型上下文。

DSH 自带的 agent-instructions 插件会注入 AGENTS.md 本体，但里面的 `@路径` 引用只是普通文本，模型看不到。这个插件按 Claude Code 的方式处理这些引用：把每个被引用的文件读出来，加进会话上下文。

<p align="center">
  <a href="LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/ciskonc/dsh-context-imports"></a>
  <a href="https://github.com/ciskonc/dsh-context-imports/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/ciskonc/dsh-context-imports"></a>
</p>

[English](README.md) | 中文

</div>

---

## 解决什么问题

| | 没有这个插件 | 装上之后 |
|---|---|---|
| AGENTS.md 本体 | 由官方 agent-instructions 注入 | 仍由它注入，不重复 |
| `@docs/architecture.md` 这类引用 | 普通文本，被忽略 | 文件全文进入上下文 |
| 引用里还有引用 | 没人处理 | 递归展开，深度可控 |
| 上下文压缩之后 | 被引用的文件随历史一起消失 | 自动重新注入 |
| 恢复旧会话 | 可能叠出第二份 | 检测到已有注入就跳过 |

## 工作原理

```text
agent/session-start（新会话 / 恢复 / 清空 / 压缩后）记录场景
agent/pre-step（每一步）决定是否注入
  ├─ 扫描指令文件（默认 AGENTS.md、CLAUDE.md）里的 @路径 引用
  │    ├─ 跳过围栏代码块；路径必须带文件扩展名
  │    ├─ 相对路径按引用者所在目录解析
  │    └─ 按解析后的路径去重，循环引用不会死循环
  ├─ 合并显式配置的 files 列表（这些文件注入全文；指令文件只扫描，不会重复注入）
  ├─ 预算限制：单文件 64 KB（超出就截断并标注），总量 128 KB（放不下的跳过并标注）；
  │    文件不存在只记一行提示，不报错
  ├─ 活跃历史里最多保留一份注入：全量事件日志按指纹扫描，
  │    压缩真的把旧块压掉之后，下一次会话启动会重新注入
  └─ 注入内容追加在整条消息序列的末尾，排在 AGENTS.md 和其他上下文之后
```

注入的消息是一个 `<system-reminder>`，里面只有 `<file path="...">` 块，没有别的说明文字。想自定义包装格式就配置 `template`。

## 特性

- 递归展开 `@路径` 引用。默认深度 3 层，循环引用和重复路径会自动合并。
- 四种场景都会触发：新会话、恢复、清空、压缩后。每种场景都可以单独关掉。
- 活跃历史里最多一份注入。压缩把它压掉之后，下次会话启动会重新注入。
- 设置卡片支持六种语言（中、英、日、法、俄、韩），在 Settings 的 Plugins 页。所有配置都能在卡片上改，改完立即生效，不用重启。
- 单文件和总量都有字节上限。文件缺失只是提示，不会导致失败。
- 只用官方公开 API：cordis 事件、dsh-llm 的 `createUserMessage`、schemastery 配置校验、可选的 dsh-settings 命名空间。不依赖其他功能插件。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `files` | `[]` | 额外注入的文件，相对会话工作目录或绝对路径 |
| `scanImports` | `true` | 扫描 AGENTS.md 等指令文件里的 @import |
| `instructionFiles` | `["AGENTS.md", "CLAUDE.md"]` | 参与扫描的文件。它们本身不会被重复注入 |
| `maxDepth` | `3` | 嵌套引用最多跟几层 |
| `maxFileBytes` | `65536` | 单文件字节上限，超出截断 |
| `maxTotalBytes` | `131072` | 总字节预算，放不下的文件跳过并标注 |
| `injectOn` | 全部四项 | 哪些会话启动场景触发注入 |
| `template` | `""` | 自定义包装文本。`{{content}}` 标记文件内容的位置；留空用默认格式 |

## 安装

```sh
dsh plugin --profile web add dsh-context-imports
```

装完不用配置就能用：默认扫描 AGENTS.md 和 CLAUDE.md，并把引用到的文件注入会话。想从源码构建：

```sh
git clone https://github.com/ciskonc/dsh-context-imports.git
cd dsh-context-imports
npm install
DSH_CHECKOUT=<你的 dsh 安装目录> npm run build
npm run build:client
```

## 开发

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 端：会话场景记账、引用展开、预算、pre-step 注入、设置命名空间 |
| `src/client/index.ts` | 浏览器端：六语言字典和设置卡片 |
| `src/client/form.ts` | 卡片背后的暂存表单模型 |
| `src/client/ContextImportsCard.tsx` | 卡片组件 |

## 许可

[MIT](LICENSE)
