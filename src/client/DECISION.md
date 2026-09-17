# DECISION — client bundle 能否复用官方包的运行时代码

**结论：B（有限复用）。** `@deepseek-ai/dsh-client-ui-settings-plugins` 虽会作为
boot graph 工厂注册进浏览器模块表（可被 require 解析），但其 `lib/client.js`
尾部只导出 `apply`/`inject`（L1813-1814）——CardForm / PluginCard / ValueField
都在工厂闭包内，外部拿不到。因此表单逻辑自实现（`form.ts`，按官方 L768-1015
移植），卡片自绘（`ContextImportsCard.tsx`，复刻官方结构与 CSS 变量）。

**可复用的运行时 = shell 模块表种子**：`react`、`react/jsx-runtime`、`react-dom`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`（createSnapshotStore）、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`
（Tag / Switch / IconChevronDownOutline14 …）、`@deepseek-ai/dsh-client-ui-dockkit`。

**证据**：`dsh-web-frontend/dist/assets/index-*.js` 的 staticModules 种子表
（`function by(){return{react:…, "@deepseek-ai/dsh-client-store":Hc,
"@deepseek-ai/dsh-client-ui-primitives":Zg, …}}`）；解析规则见
`dsh-client-modules/lib/index.js` L25-31 与 `lib/client.js` L295-318
（seed → memoized → registered factory → throw）。本卡片用到 store 与
primitives 两个种子，已加入 tsdown CLIENT_EXTERNALS。

**API 先例**：slot 注册契约（keyed、`name` 必填、`inject()` face、
hooks.xxx→useXxx）见 settings-plugins client.js L1785-1810 与
`types/client/slot-contract.d.ts`；settingsScope.bind/set/unset 签名见
`dsh-client-ui-settings/lib/types/client/settings-scope.d.ts` /
`settings-contract.d.ts`；locale register/addLanguage 签名见
`dsh-client-locale/lib/types/client/index.d.ts` L159-216。

**构建**：`npx tsdown` 通过（lib/client.js 38.91 kB），产物为 ModuleLoader.load
包装，运行时 require 仅四个种子模块（react、react/jsx-runtime、
dsh-client-store、dsh-client-ui-primitives），exports 为 apply/inject。
