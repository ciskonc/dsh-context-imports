/**
 * dsh-context-imports — settings.plugin.item 卡片组件。
 *
 * 视觉/交互复刻官方 PluginCard + ValueField（lib/client.js L201-285 / L49-92），
 * 但自绘：官方 bundle 不导出这些组件（见 DECISION.md）。Tag 与 chevron 图标
 * 来自 shell 种子模块 @deepseek-ai/dsh-client-ui-primitives，CSS 变量
 * (--dsw-alias-*) 由 Web shell 提供，风格自动对齐。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardFieldState, CardShell } from './form.ts'

export type Translate = (key: string) => string

/** controller.inject() 经 slot 运行时注入的 props（hooks.xxx → useXxx）。 */
export interface ContextImportsCardProps {
  t: Translate
  useContextImportsCard: <S>(selector: (snapshot: ContextImportsCardState) => S) => S
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

export interface ContextImportsCardState extends CardShell {
  files: CardFieldState
  scanImports: CardFieldState
  instructionFiles: CardFieldState
  maxDepth: CardFieldState
  maxFileBytes: CardFieldState
  maxTotalBytes: CardFieldState
  injectOn: CardFieldState
  template: CardFieldState
}

/** 合法的注入时机 token（与 host 端 SOURCES 一致）。 */
export const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const

/* ------------------------------------------------------------------ *
 * CSS（照搬官方 fields.module.css / PluginCard.module.css，类名加 dci 前缀）
 * ------------------------------------------------------------------ */

const CSS = `
.dci_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dci_field+.dci_field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dci_head{align-items:center;gap:8px;display:flex}
.dci_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dci_badges{align-items:center;gap:8px;display:inline-flex}
.dci_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.dci_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dci_reset:disabled{cursor:default}
.dci_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5}
input.dci_input{height:34px;padding:0 12px}
textarea.dci_input{min-height:72px;resize:vertical;font-family:monospace}
.dci_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dci_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dci_inputInvalid{border-color:var(--dsw-alias-label-error)}
.dci_invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.dci_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dci_checkRow{align-items:center;gap:8px;display:flex;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dci_choices{flex-wrap:wrap;gap:8px 16px;display:flex}
.dci_choice{align-items:center;gap:6px;display:inline-flex;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;cursor:pointer}
.dci_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dci_card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dci_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dci_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dci_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dci_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dci_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dci_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dci_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dci_chevronOpen{transform:rotate(180deg)}
.dci_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dci_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.dci_pending{flex:none}
.dci_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dci_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dci_discard,.dci_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dci_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dci_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dci_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}
.dci_save:hover:not(:disabled){opacity:.88}
.dci_discard:disabled,.dci_save:disabled{opacity:.45;cursor:default}
`

const CSS_TAG_ID = 'dsh-context-imports/card.css'

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-context-imports'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

function clsx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ *
 * 字段控件（对应官方 ValueField，另加 checkbox / textarea / token 组）
 * ------------------------------------------------------------------ */

interface RowProps {
  id: string
  label: string
  hint: string
  state: CardFieldState
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  children: ReactNode
}

function FieldRow(props: RowProps) {
  const { state } = props
  return (
    <div className="dci_field">
      <div className="dci_head">
        <label className="dci_label" htmlFor={props.id}>
          {props.label}
        </label>
        {state.overridden ? (
          <span className="dci_badges">
            <Tag tone="neutral">{props.overriddenLabel}</Tag>
            <button type="button" className="dci_reset" disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      {props.children}
      <p className={state.invalid ? 'dci_invalid' : 'dci_hint'}>{state.invalid ? props.invalidLabel : props.hint}</p>
    </div>
  )
}

/** 单行/数字输入行。 */
function TextRow(props: Omit<RowProps, 'children'> & { numeric?: boolean; placeholder?: string }) {
  return (
    <FieldRow {...props}>
      <input
        id={props.id}
        className={props.state.invalid ? 'dci_input dci_inputInvalid' : 'dci_input'}
        type="text"
        {...(props.numeric ? { inputMode: 'numeric' } : {})}
        {...(props.state.invalid ? { 'aria-invalid': true } : {})}
        value={props.state.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
      />
    </FieldRow>
  )
}

/** 多行输入行（files / instructionFiles / template）。 */
function AreaRow(props: Omit<RowProps, 'children'> & { placeholder?: string }) {
  return (
    <FieldRow {...props}>
      <textarea
        id={props.id}
        className={props.state.invalid ? 'dci_input dci_inputInvalid' : 'dci_input'}
        {...(props.state.invalid ? { 'aria-invalid': true } : {})}
        value={props.state.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
      />
    </FieldRow>
  )
}

/** 布尔行（scanImports）：checkbox staging 'true'/'false'。 */
function BoolRow(props: Omit<RowProps, 'children'>) {
  return (
    <FieldRow {...props}>
      <label className="dci_checkRow">
        <input
          id={props.id}
          type="checkbox"
          checked={props.state.text === 'true'}
          disabled={props.disabled}
          onChange={(event) => props.onEdit(event.target.checked ? 'true' : 'false')}
        />
      </label>
    </FieldRow>
  )
}

/** injectOn：固定 token 的 checkbox 组，草稿为逗号分隔文本。 */
function TokensRow(props: Omit<RowProps, 'children'> & { tokens: readonly string[]; tokenLabel: (token: string) => string }) {
  const selected = new Set(props.state.text.split(/[,\s]+/).filter((token) => token !== ''))
  const toggle = (token: string) => {
    const next = new Set(selected)
    if (next.has(token)) next.delete(token)
    else next.add(token)
    props.onEdit(props.tokens.filter((item) => next.has(item)).join(','))
  }
  return (
    <FieldRow {...props}>
      <div className="dci_choices" role="group" aria-labelledby={props.id}>
        {props.tokens.map((token) => (
          <label key={token} className="dci_choice">
            <input
              type="checkbox"
              checked={selected.has(token)}
              disabled={props.disabled}
              onChange={() => toggle(token)}
            />
            <span>{props.tokenLabel(token)}</span>
          </label>
        ))}
      </div>
    </FieldRow>
  )
}

/* ------------------------------------------------------------------ *
 * 卡片（复刻官方 PluginCard 的展开/保存/丢弃结构与行为）
 * ------------------------------------------------------------------ */

export function ContextImportsCard(props: ContextImportsCardProps) {
  ensureStyles()
  const { t } = props
  const state = props.useContextImportsCard((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)

  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  if (!state.available) return null
  const title = t('title')
  const blocked = !state.dirty || state.invalid || state.saving
  const disabled = !state.writable

  const rowProps = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled,
  }
  const fieldRow = (
    field: keyof ContextImportsCardState,
    id: string,
    label: string,
    hint: string,
    invalidLabel: string,
  ) => ({
    id,
    label,
    hint,
    invalidLabel,
    state: state[field] as CardFieldState,
    onEdit: (text: string) => props.edit(field as string, text),
    onReset: () => props.resetField(field as string),
    ...rowProps,
  })

  return (
    <li className={clsx('dci_card', open && 'dci_cardOpen')}>
      <button
        type="button"
        className="dci_header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => setOpen(!open)}
      >
        <span className="dci_headText">
          <span className="dci_name">{title}</span>
          <span className="dci_description">{t('description')}</span>
        </span>
        {state.dirty ? (
          <Tag tone="neutral" className="dci_pending">
            {t('unsaved')}
          </Tag>
        ) : null}
        <IconChevronDownOutline14 className={clsx('dci_chevron', open && 'dci_chevronOpen')} />
      </button>
      {open ? (
        <div className="dci_body">
          {!state.writable ? (
            <p className="dci_readOnly" role="status">
              {t('readOnly')}
            </p>
          ) : null}
          <AreaRow {...fieldRow('files', 'plugin-config-context-imports-files', t('files'), t('filesHint'), t('invalidNumber'))} />
          <BoolRow
            {...fieldRow('scanImports', 'plugin-config-context-imports-scan', t('scanImports'), t('scanImportsHint'), t('invalidNumber'))}
          />
          <AreaRow
            {...fieldRow(
              'instructionFiles',
              'plugin-config-context-imports-instruction-files',
              t('instructionFiles'),
              t('instructionFilesHint'),
              t('invalidNumber'),
            )}
          />
          <TextRow
            {...fieldRow('maxDepth', 'plugin-config-context-imports-max-depth', t('maxDepth'), t('maxDepthHint'), t('invalidNumber'))}
            numeric
          />
          <TextRow
            {...fieldRow(
              'maxFileBytes',
              'plugin-config-context-imports-max-file-bytes',
              t('maxFileBytes'),
              t('maxFileBytesHint'),
              t('invalidNumber'),
            )}
            numeric
          />
          <TextRow
            {...fieldRow(
              'maxTotalBytes',
              'plugin-config-context-imports-max-total-bytes',
              t('maxTotalBytes'),
              t('maxTotalBytesHint'),
              t('invalidNumber'),
            )}
            numeric
          />
          <TokensRow
            {...fieldRow('injectOn', 'plugin-config-context-imports-inject-on', t('injectOn'), t('injectOnHint'), t('invalidTokens'))}
            tokens={SOURCES}
            tokenLabel={(token) => t(`injectOn${token[0].toUpperCase()}${token.slice(1)}`)}
          />
          <AreaRow
            {...fieldRow('template', 'plugin-config-context-imports-template', t('template'), t('templateHint'), t('invalidNumber'))}
            placeholder={'{{content}}'}
          />
          <div className="dci_footer">
            {state.failed ? (
              <p className="dci_failed" role="status">
                {t('saveFailed')}
              </p>
            ) : null}
            <button type="button" className="dci_discard" disabled={!state.dirty || state.saving} onClick={props.discard}>
              {t('discard')}
            </button>
            <button type="button" className="dci_save" disabled={blocked} onClick={props.save}>
              {t(state.saving ? 'saving' : 'save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
