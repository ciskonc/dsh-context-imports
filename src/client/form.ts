/**
 * dsh-context-imports — 字段 spec 工厂（0.1.7 适配）。
 *
 * 表单模型用官方 SettingsFormModel（dsh-client-ui-primitives），这里只剩
 * 官方没有工厂的三种字段类型：多行数组、布尔、固定 token 子集。
 * spec 形状与官方 SettingsFieldSpec 一致：{field, format, parse}，
 * 空草稿 = clear（回退组合层），非法草稿 = undefined（阻止保存）。
 */

/** 保存时一个字段要执行的写入（与官方 SettingsFieldWrite 同形）。 */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

export interface FieldSpec {
  field: string
  format: (value: unknown) => string
  /** undefined = 草稿非法，阻止保存。 */
  parse: (text: string) => FieldWrite | undefined
}

/** 每行一个字符串的数组字段（files / instructionFiles）。 */
export function linesField(field: string): FieldSpec {
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
export function boolField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) =>
      text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/** 固定 token 子集的数组字段（injectOn）：逗号分隔草稿，非法 token 阻止保存。 */
export function tokensField(field: string, allowed: readonly string[]): FieldSpec {
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
