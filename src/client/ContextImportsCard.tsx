/**
 * dsh-context-imports — plugins.item 页面组件（0.1.7 适配）。
 *
 * 全部用官方共享件：SettingsForm（框架：unavailable/readOnly/save）+
 * SettingsValueField（文本/数字字段）+ Checkbox（布尔/多选字段）。
 * 页面壳（标题/一句话描述/tab chrome）由内置 PluginsSettingsSection 绘制；
 * view === 'summary' 时我们只交一句话描述。
 */
import { Checkbox, SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'

export type Translate = (key: string) => string

/** controller.inject() 经 slot 运行时注入的 props（hooks.xxx → useXxx）。 */
export interface ContextImportsCardProps {
  t: Translate
  view?: 'summary' | 'form'
  useContextImportsCard: <S>(selector: (snapshot: ContextImportsCardState) => S) => S
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface ContextImportsCardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  files: FieldState
  scanImports: FieldState
  instructionFiles: FieldState
  maxDepth: FieldState
  maxFileBytes: FieldState
  maxTotalBytes: FieldState
  injectOn: FieldState
  template: FieldState
}

/** 合法的注入时机 token（与 host 端 SOURCES 一致）。 */
export const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const

/** SettingsForm 框架的文案（从本页字典读）。 */
function formLabels(t: Translate) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/** 布尔字段行：Checkbox staging 'true'/'false' 草稿。 */
function BoolField(props: {
  id: string
  label: string
  hint: string
  state: FieldState
  disabled: boolean
  onEdit: (text: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
      <Checkbox
        checked={props.state.text === 'true'}
        disabled={props.disabled}
        label={props.label}
        onChange={(next) => props.onEdit(next ? 'true' : 'false')}
      />
      <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{props.hint}</p>
    </div>
  )
}

/** injectOn：固定 token 的 Checkbox 组，草稿为逗号分隔文本。 */
function TokensField(props: {
  id: string
  label: string
  hint: string
  state: FieldState
  disabled: boolean
  tokens: readonly string[]
  tokenLabel: (token: string) => string
  onEdit: (text: string) => void
}) {
  const selected = new Set(props.state.text.split(/[,\s]+/).filter((token) => token !== ''))
  const toggle = (token: string, next: boolean) => {
    const set = new Set(selected)
    if (next) set.add(token)
    else set.delete(token)
    props.onEdit(props.tokens.filter((item) => set.has(item)).join(','))
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>{props.label}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
        {props.tokens.map((token) => (
          <Checkbox
            key={token}
            checked={selected.has(token)}
            disabled={props.disabled}
            label={props.tokenLabel(token)}
            onChange={(next) => toggle(token, next)}
          />
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{props.hint}</p>
    </div>
  )
}

export function ContextImportsCard(props: ContextImportsCardProps) {
  const { t } = props
  if (props.view === 'summary') return t('description')
  const state = props.useContextImportsCard((snapshot) => snapshot)

  const fieldProps = (field: keyof ContextImportsCardState & string, id: string, label: string, hint: string, invalidLabel: string) => ({
    id,
    label,
    hint,
    invalidLabel,
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled: !state.writable,
    ...(state[field] as FieldState),
    onEdit: (text: string) => props.edit(field, text),
    onReset: () => props.resetField(field),
  })

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField {...fieldProps('files', 'plugin-config-context-imports-files', t('files'), t('filesHint'), t('invalidNumber'))} />
      <BoolField
        id="plugin-config-context-imports-scan"
        label={t('scanImports')}
        hint={t('scanImportsHint')}
        state={state.scanImports}
        disabled={!state.writable}
        onEdit={(text) => props.edit('scanImports', text)}
      />
      <SettingsValueField
        {...fieldProps(
          'instructionFiles',
          'plugin-config-context-imports-instruction-files',
          t('instructionFiles'),
          t('instructionFilesHint'),
          t('invalidNumber'),
        )}
      />
      <SettingsValueField
        numeric
        {...fieldProps('maxDepth', 'plugin-config-context-imports-max-depth', t('maxDepth'), t('maxDepthHint'), t('invalidNumber'))}
      />
      <SettingsValueField
        numeric
        {...fieldProps(
          'maxFileBytes',
          'plugin-config-context-imports-max-file-bytes',
          t('maxFileBytes'),
          t('maxFileBytesHint'),
          t('invalidNumber'),
        )}
      />
      <SettingsValueField
        numeric
        {...fieldProps(
          'maxTotalBytes',
          'plugin-config-context-imports-max-total-bytes',
          t('maxTotalBytes'),
          t('maxTotalBytesHint'),
          t('invalidNumber'),
        )}
      />
      <TokensField
        id="plugin-config-context-imports-inject-on"
        label={t('injectOn')}
        hint={t('injectOnHint')}
        state={state.injectOn}
        disabled={!state.writable}
        tokens={SOURCES}
        tokenLabel={(token) => t(`injectOn${token[0].toUpperCase()}${token.slice(1)}`)}
        onEdit={(text) => props.edit('injectOn', text)}
      />
      <SettingsValueField
        placeholder={'{{content}}'}
        {...fieldProps('template', 'plugin-config-context-imports-template', t('template'), t('templateHint'), t('invalidNumber'))}
      />
    </SettingsForm>
  )
}
