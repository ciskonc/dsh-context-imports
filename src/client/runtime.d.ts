/**
 * 运行时外部模块的最小类型声明（这些包是 DSH Web shell 的模块表种子，
 * 本地 node_modules 没有它们的类型；仅声明我们用到的导出）。
 * 证据：dsh-web-frontend/dist/assets/index-*.js 的 staticModules 种子表。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'

  export const Checkbox: ComponentType<{
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }>

  export interface SettingsFieldWrite {
    kind: 'set'
    value: unknown
  }
  export interface SettingsFieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined
  }
  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }
  export interface SettingsFormActions {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  }
  export class SettingsFormModel<T> {
    constructor(scope: unknown, specs: SettingsFieldSpec[], secrets?: unknown[])
    bind<S>(project: () => S): { getSnapshot(): S; subscribe(listener: () => void): () => void }
    shell(): SettingsFormShell
    field(field: string): SettingsFieldState
    actions(): SettingsFormActions
    save(): Promise<void>
    dispose(): void
  }
  export function settingsNumberField(field: string): SettingsFieldSpec
  export function settingsTextField(field: string): SettingsFieldSpec

  export const SettingsForm: ComponentType<{
    labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string }
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }>
  export const SettingsValueField: ComponentType<{
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    onEdit: (text: string) => void
    onReset: () => void
    numeric?: boolean
    placeholder?: string
  }>
}
