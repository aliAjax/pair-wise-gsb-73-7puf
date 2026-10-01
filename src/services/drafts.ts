import { reactive } from 'vue'
import type { DraftPayload } from '@/models/domain'
import { createId, loadDrafts, saveDrafts } from '@/services/repository'

export type ResumeHandler = (draft: DraftPayload) => void

const drafts = reactive<DraftPayload[]>(loadDrafts())
const handlers = new Map<DraftPayload['kind'], Set<ResumeHandler>>()
let pendingResume: DraftPayload | null = null

const persist = (): void => {
  saveDrafts([...drafts])
}

export const draftStore = {
  drafts,

  add(draft: Omit<DraftPayload, 'id' | 'createdAt'>): DraftPayload {
    const saved: DraftPayload = {
      ...draft,
      id: createId('drf'),
      createdAt: new Date().toISOString(),
    }
    drafts.unshift(saved)
    persist()
    return saved
  },

  remove(id: string): void {
    const index = drafts.findIndex((draft) => draft.id === id)
    if (index >= 0) {
      drafts.splice(index, 1)
      persist()
    }
  },

  /** 业务页面挂载时注册草稿回填处理器 */
  on(kind: DraftPayload['kind'], handler: ResumeHandler): () => void {
    const set = handlers.get(kind) ?? new Set<ResumeHandler>()
    set.add(handler)
    handlers.set(kind, set)
    return () => set.delete(handler)
  },

  /**
   * 全局恢复条点击恢复：先路由到目标页面（await 之后页面已挂载并注册处理器），
   * 再请求回填；若页面尚未注册则暂存，页面挂载时取走。
   * @returns 是否已有处理器立即消费了该草稿
   */
  requestResume(draft: DraftPayload): boolean {
    const set = handlers.get(draft.kind)
    if (set && set.size > 0) {
      set.forEach((handler) => handler(draft))
      return true
    }
    pendingResume = draft
    return false
  },

  /** 业务页面挂载时取走暂存的同类型草稿（重启后经恢复条触发时使用） */
  takePending(kind: DraftPayload['kind']): DraftPayload | null {
    if (pendingResume && pendingResume.kind === kind) {
      const draft = pendingResume
      pendingResume = null
      return draft
    }
    return null
  },
}
