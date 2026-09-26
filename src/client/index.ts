/**
 * dsh-context-imports — client 设置页（plugins.item slot，0.1.7 适配）。
 * 构建：npm run build:client（tsdown，产物 lib/client.js，ModuleLoader.load 注册）。
 *
 * 0.1.7 范式（对齐官方 dsh-client-ui-settings-agent-loop）：
 *  - inject = ['slots','locale','configForms']（settingsScope 服务已移除）
 *  - scope = ctx.configForms.get(NS)（SettingsFormScope：getSnapshot/subscribe/mutate）
 *  - 表单模型 = 官方 SettingsFormModel（primitives），字段 spec 同形
 *  - 页面注册 = configForms.whileServed([NS], () => slots.inject('plugins.item', ...))
 *    （Host 不为该 loader entry 服务时页面自动消失）
 */
import { ContextImportsCard, SOURCES } from './ContextImportsCard.tsx'
import type { ContextImportsCardState, Translate } from './ContextImportsCard.tsx'
import { boolField, linesField, tokensField } from './form.ts'
import type { FieldSpec } from './form.ts'
import { en, fr, ja, ko, ru, zh } from './locales.ts'
import { SettingsFormModel, settingsNumberField, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'

/** 设置命名空间 = loader entry id（0.1.7：settings 服务从 loader entries 投影）。 */
const NS = 'dsh-context-imports'

/* ------------------------------------------------------------------ *
 * ctx 服务的最小结构类型（签名对齐官方 0.1.7 类型声明）
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
  /** 当前语言快照（含浏览器 provisional 解析）。 */
  getSnapshot(): { active: string }
  /** 订阅语言变化。 */
  subscribe(listener: () => void): () => void
}

interface ConfigFormScopeLike {
  getSnapshot(): { status: 'loading' | 'ready' | 'unavailable'; value?: Record<string, unknown> }
  subscribe(listener: () => void): () => void
  mutate(ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]): Promise<boolean>
}

interface ConfigFormsLike {
  get(entryId: string): ConfigFormScopeLike
  /** 只在 Host 服务所列命名空间期间保持 factory 的注册。 */
  whileServed(entryIds: string[], factory: () => unknown): () => void
}

interface ClientContext {
  slots: SlotsLike
  locale: LocaleLike
  configForms: ConfigFormsLike
  effect(factory: () => (() => void) | void, label?: string): void
}

/** 必需服务（cordis fiber inject 声明）。 */
export const inject = ['slots', 'locale', 'configForms']

/* ------------------------------------------------------------------ *
 * 页面 controller：SettingsFormModel 桥接到暂存表单
 * ------------------------------------------------------------------ */

class ContextImportsCardController {
  private form: SettingsFormModel<Record<string, unknown>>
  private store: ReturnType<SettingsFormModel<Record<string, unknown>>['bind']>

  constructor(scope: ConfigFormScopeLike) {
    const specs: FieldSpec[] = [
      linesField('files'),
      boolField('scanImports'),
      linesField('instructionFiles'),
      settingsNumberField('maxDepth') as unknown as FieldSpec,
      settingsNumberField('maxFileBytes') as unknown as FieldSpec,
      settingsNumberField('maxTotalBytes') as unknown as FieldSpec,
      tokensField('injectOn', SOURCES),
      settingsTextField('template') as unknown as FieldSpec,
    ]
    this.form = new SettingsFormModel(scope as never, specs as never)
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

  dispose(): void {
    this.form.dispose()
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

  const scope = ctx.configForms.get(NS)
  const card = new ContextImportsCardController(scope)
  ctx.effect(() => () => card.dispose(), 'dsh-context-imports: form subscription')

  // 把浏览器解析后的活跃语言写进我们自己的配置字段（detectedLocale），
  // 供 host 半跟随 UI 语言包装注入文本。
  let lastSynced = ''
  const syncDetectedLocale = () => {
    const active = ctx.locale.getSnapshot().active
    if (!active || active === lastSynced) return
    lastSynced = active
    void scope
      .mutate([{ op: 'set', path: ['detectedLocale'], value: active }])
      .catch(() => {
        lastSynced = ''
      })
  }
  ctx.effect(() => ctx.locale.subscribe(syncDetectedLocale), 'dsh-context-imports: locale sync')
  syncDetectedLocale()

  // 页面只在 Host 服务本命名空间（loader entry 活着）期间出现。
  ctx.effect(
    () =>
      ctx.configForms.whileServed([NS], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: 'dsh-context-imports',
              order: 30,
              label: () => ctx.locale.bind(NS)('title'),
              locale: NS,
              inject: () => card.inject(),
            },
            ContextImportsCard,
          ),
        ),
      ),
    'dsh-context-imports: settings page',
  )
}
