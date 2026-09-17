/**
 * 运行时外部模块的最小类型声明（这些包是 DSH Web shell 的模块表种子，
 * 本地 node_modules 没有它们的类型；仅声明我们用到的导出）。
 * 证据：dsh-web-frontend/dist/assets/index-*.js 的 staticModules 种子表。
 */
declare module '@deepseek-ai/dsh-client-store' {
  export interface SnapshotStore<T> {
    getSnapshot(): T
    set(next: T): void
    subscribe(listener: () => void): () => void
  }
  export function createSnapshotStore<T>(seed: T): SnapshotStore<T>
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType, ReactNode } from 'react'
  export const Tag: ComponentType<{ tone?: string; className?: string; children?: ReactNode }>
  export const IconChevronDownOutline14: ComponentType<{ className?: string }>
}
