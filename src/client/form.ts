/**
 * dsh-context-imports — 精简版 CardForm（表单模型）。
 *
 * 官方 @deepseek-ai/dsh-client-ui-settings-plugins 的 client bundle 只导出
 * apply/inject（CardForm 等在工厂闭包内，不可复用），因此按其 lib/client.js
 * 的已实现逻辑（L768-1015）移植：暂存草稿 → save 时统一 scope.set/unset，
 * 写后从 Host 回读结果。snapshot store 用 shell 种子模块 dsh-client-store。
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** '@deepseek-ai/dsh-client-ui-settings/client' SettingsScope 的最小结构类型。 */
export interface SettingsScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: Record<string, unknown>
    base?: unknown
    user?: unknown
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface SnapshotStoreLike<T> {
  getSnapshot(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
}

/** 保存时一个字段要执行的写入。 */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

export interface CardFieldSpec {
  field: string
  format: (value: unknown) => string
  /** undefined = 草稿非法，阻止保存。 */
  parse: (text: string) => FieldWrite | undefined
}

export interface CardFieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export interface CardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/* ---------------------------------------------------------------- *
 * 字段 spec（parse 时校验，语义与官方一致：空草稿 = clear）
 * ---------------------------------------------------------------- */

/** 数字字段：空 = 清除；非有限数 = 非法。 */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** 多行文本字段（template）：空白 = 清除；其余原样保存。 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
  }
}

/** 每行一个字符串的数组字段（files / instructionFiles）。 */
export function linesField(field: string): CardFieldSpec {
  return {
    field,
    format: (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string').join('\n') : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      return { kind: 'set', value: lines }
    },
  }
}

/** 布尔字段：草稿文本 'true'/'false'，由 checkbox 控件 staging。 */
export function boolField(field: string): CardFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) =>
      text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/** 固定 token 子集的数组字段（injectOn）：逗号分隔草稿，非法 token 阻止保存。 */
export function tokensField(field: string, allowed: readonly string[]): CardFieldSpec {
  return {
    field,
    format: (value) =>
      Array.isArray(value)
        ? allowed.filter((token) => (value as unknown[]).includes(token)).join(',')
        : '',
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      const tokens = [...new Set(text.split(/[,\s]+/).filter((token) => token !== ''))]
      if (tokens.some((token) => !allowed.includes(token))) return undefined
      return { kind: 'set', value: tokens }
    },
  }
}

/* ---------------------------------------------------------------- *
 * CardForm（移植自官方实现，去掉 secret 通道）
 * ---------------------------------------------------------------- */

interface Staged {
  text: string
  clear: boolean
}

export class CardForm {
  private specs: Map<string, CardFieldSpec>
  private staged = new Map<string, Staged>()
  private listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(private scope: SettingsScopeLike, specs: CardFieldSpec[]) {
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    scope.subscribe(() => {
      this.publish()
    })
  }

  /** 绑定投影到 snapshot store，供 slot 组件经 useXxx(selector) 读取。 */
  bind<S>(project: () => S): SnapshotStoreLike<S> {
    const store = createSnapshotStore(project()) as unknown as SnapshotStoreLike<S>
    this.listeners.add(() => {
      store.set(project())
    })
    return store
  }

  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? ({ kind: 'clear' } as FieldWrite) : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  actions(): CardActions {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false })
      },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** 写入全部暂存编辑，再从 Host 接受的值重建（Host 是唯一权威）。 */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap((item) => (item.run === undefined ? [] : [item.run]))
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) landed = (await write()) && landed
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private plan(): { field: string; run: (() => Promise<boolean>) | undefined }[] {
    const plan: { field: string; run: (() => Promise<boolean>) | undefined }[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.same((this.userLayer() as Record<string, unknown> | undefined)?.[field], value)
  }

  /** 标量用 ===，数组/对象按 JSON 比较（Host 回读的值与本地草稿不是同一引用）。 */
  private same(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b)
      } catch {
        return false
      }
    }
    return false
  }

  private stage(field: string, edit: Staged): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  private sectionValue(field: string): unknown {
    return this.scope.getSnapshot().value?.[field]
  }

  private baseValue(field: string): unknown {
    const base = this.scope.getSnapshot().base
    return base !== null && typeof base === 'object' ? (base as Record<string, unknown>)[field] : undefined
  }

  private userLayer(): unknown {
    return this.scope.getSnapshot().user
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== null && typeof user === 'object' && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
