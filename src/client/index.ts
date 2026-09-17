/**
 * @dsh-external/dsh-context-imports — client 设置卡片（settings.plugin.item slot）。
 * 构建：npm run build:client（tsdown，产物 lib/client.js，ModuleLoader.load 注册）。
 *
 * 范式全部对齐官方 @deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js：
 *  - apply 注册 zh/en 字典（register(ns, {zh,en})，L1703）
 *  - addLanguage + 单语言 register 注册 ja/fr/ru/ko（fallback 'en'）
 *  - controller 持 CardForm，inject() 返回 { hooks: { contextImportsCard: store }, ...actions }
 *  - keyed slot 注册：register({ name, key, locale, inject }, Component)（L1804-1809）
 *  ⚠️ register 必须带 name 字段；inject 数组声明服务依赖（cordis fiber inject）。
 */
import { ContextImportsCard, SOURCES } from './ContextImportsCard.tsx'
import type { ContextImportsCardState, Translate } from './ContextImportsCard.tsx'
import { boolField, CardForm, linesField, numberField, textField, tokensField } from './form.ts'
import type { SettingsScopeLike, SnapshotStoreLike } from './form.ts'
import { en, fr, ja, ko, ru, zh } from './locales.ts'

/** 设置命名空间（host 端 installSection 同名）。 */
const NS = 'dsh-context-imports'

/* ------------------------------------------------------------------ *
 * ctx 服务的最小结构类型（官方服务；签名见 DECISION.md 引用文件）
 * ------------------------------------------------------------------ */

interface SlotsLike {
  inject(slot: string, factory: () => unknown): () => void
  register(options: Record<string, unknown>, component?: unknown): unknown
}

interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
  bind(ns: string): Translate
}

interface SettingsScopeBinderLike {
  bind(spec: { namespace: string }): SettingsScopeLike
}

interface ClientContext {
  slots: SlotsLike
  locale: LocaleLike
  settingsScope: SettingsScopeBinderLike
  effect(factory: () => (() => void) | void, label?: string): void
}

/** 必需服务（cordis fiber inject 声明）。 */
export const inject = ['slots', 'locale', 'settingsScope']

/* ------------------------------------------------------------------ *
 * 卡片 controller：把 dsh-context-imports scope 桥接到暂存表单
 * ------------------------------------------------------------------ */

class ContextImportsCardController {
  private form: CardForm
  private store: SnapshotStoreLike<ContextImportsCardState>

  constructor(scope: SettingsScopeLike) {
    this.form = new CardForm(scope, [
      linesField('files'),
      boolField('scanImports'),
      linesField('instructionFiles'),
      numberField('maxDepth'),
      numberField('maxFileBytes'),
      numberField('maxTotalBytes'),
      tokensField('injectOn', SOURCES),
      textField('template'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ContextImportsCardState {
    return {
      ...this.form.shell(),
      files: this.form.field('files'),
      scanImports: this.form.field('scanImports'),
      instructionFiles: this.form.field('instructionFiles'),
      maxDepth: this.form.field('maxDepth'),
      maxFileBytes: this.form.field('maxFileBytes'),
      maxTotalBytes: this.form.field('maxTotalBytes'),
      injectOn: this.form.field('injectOn'),
      template: this.form.field('template'),
    }
  }

  /** slot 注册注入的 face：hooks.xxx → 组件 props.useXxx。 */
  inject(): Record<string, unknown> {
    return {
      hooks: { contextImportsCard: this.store },
      ...this.form.actions(),
    }
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/** 内置 zh/en 之外的扩展语言：addLanguage + 单语言字典，fallback 到 en。 */
const EXTRA_LANGUAGES: { id: string; label: string; dict: Record<string, string> }[] = [
  { id: 'ja', label: '日本語', dict: ja },
  { id: 'fr', label: 'Français', dict: fr },
  { id: 'ru', label: 'Русский', dict: ru },
  { id: 'ko', label: '한국어', dict: ko },
]

export function apply(ctx: ClientContext): void {
  // 内置双语字典（官方范式：register(ns, { zh, en })）。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-context-imports: base dictionaries')

  // 扩展语言包：addLanguage 可能因别的包已注册同 id 而抛错（single occupant），
  // 此时只挂字典——活跃语言沿其 fallback 链仍能解析到我们的 key。
  for (const pack of EXTRA_LANGUAGES) {
    ctx.effect(() => {
      let offLanguage: (() => void) | undefined
      try {
        offLanguage = ctx.locale.addLanguage({ id: pack.id, label: pack.label, fallback: 'en' })
      } catch {
        // language id already owned by another package; dictionary still resolves
      }
      const offDict = ctx.locale.register(NS, pack.id, pack.dict)
      return () => {
        offDict()
        offLanguage?.()
      }
    }, `dsh-context-imports: ${pack.id} dictionary`)
  }

  const card = new ContextImportsCardController(ctx.settingsScope.bind({ namespace: NS }))

  // keyed slot：ConfigurablePluginsTab 按 Host 服务的命名空间派发（key = ns）。
  ctx.effect(
    () =>
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NS,
            locale: NS,
            inject: () => card.inject(),
          },
          ContextImportsCard,
        ),
      ),
    'dsh-context-imports: settings card',
  )
}
