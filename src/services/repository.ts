import type {
  ChainEvent,
  EntityConflict,
  PendingDraft,
  ReviewDecision,
  ThreatModelState,
} from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'scapex-threat-model-v1'
const DRAFTS_KEY = 'scapex-threat-drafts-v1'
const FAIL_FLAG_KEY = 'scapex-sim-fail-next-write'

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value)
  } catch {
    // 某些宿主对 Proxy / 特殊对象的 structuredClone 支持不完整，回退到 JSON 深拷贝
    return JSON.parse(JSON.stringify(value)) as T
  }
}

const newToken = (): string =>
  `tok-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

export const createStateToken = (): string => newToken()

const seedWithToken = (): ThreatModelState => ({ ...createSeedState(), stateToken: newToken() })

export const loadState = (): ThreatModelState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = seedWithToken()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }

  try {
    return migrateState(JSON.parse(raw) as ThreatModelState)
  } catch {
    const seed = seedWithToken()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

/** 兼容旧版本本地数据：补齐统一版本链所需字段。 */
const migrateState = (state: ThreatModelState): ThreatModelState => {
  if (!state.stateToken) state.stateToken = newToken()
  if (!Array.isArray(state.chainEvents)) state.chainEvents = []

  state.decisions.forEach((decision: ReviewDecision) => {
    if (!decision.status) decision.status = 'active'
  })
  state.mitigations.forEach((task) => {
    if (task.revision === undefined) task.revision = state.currentRevision
  })
  state.evidence.forEach((item) => {
    if (item.revision === undefined) item.revision = state.currentRevision
  })
  state.risks.forEach((risk) => {
    if (risk.revision === undefined) risk.revision = state.currentRevision
  })
  return state
}

export interface CommitResult {
  outcome: 'ok' | 'conflict' | 'write_failure'
  newToken?: string
  remoteState?: ThreatModelState
  error?: string
}

/**
 * 乐观并发提交：先读 localStorage 中的最新状态，token 不一致说明另一个窗口已提交，
 * 本次写入整体失败，绝不覆盖对方刚保存的缓解处置或会签意见。
 */
export const commitState = (baseToken: string, next: ThreatModelState): CommitResult => {
  let raw: string | null = null
  let remote: ThreatModelState | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
    remote = raw ? (JSON.parse(raw) as ThreatModelState) : null
  } catch {
    remote = null
  }

  if (remote && remote.stateToken && remote.stateToken !== baseToken) {
    return { outcome: 'conflict', remoteState: migrateState(clone(remote)) }
  }

  if (localStorage.getItem(FAIL_FLAG_KEY) === '1') {
    localStorage.removeItem(FAIL_FLAG_KEY)
    return { outcome: 'write_failure', error: '模拟存储层写入失败（演练开关已触发）' }
  }

  try {
    const token = newToken()
    const stamped: ThreatModelState = { ...next, stateToken: token }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped))
    return { outcome: 'ok', newToken: token }
  } catch (error) {
    return {
      outcome: 'write_failure',
      error: error instanceof Error ? error.message : 'localStorage 写入失败',
    }
  }
}

/** 供“模拟另一窗口已提交”演练使用：直接在最新状态上叠加一次远程提交。 */
export const simulateRemoteCommit = (
  mutate: (state: ThreatModelState, event: ChainEvent) => void,
  event: Omit<ChainEvent, 'id' | 'createdAt' | 'actor' | 'remote'>,
): ThreatModelState => {
  const current = migrateState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ThreatModelState)
  const fullEvent: ChainEvent = {
    ...event,
    id: `chn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    actor: '另一窗口用户',
    remote: true,
  }
  current.currentRevision = fullEvent.revision
  current.chainEvents.unshift(fullEvent)
  mutate(current, fullEvent)
  current.audit.unshift({
    id: `aud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    entityType: fullEvent.source,
    entityId: fullEvent.sourceId,
    action: '远程提交',
    actor: '另一窗口用户',
    createdAt: new Date().toISOString(),
    detail: fullEvent.summary,
  })
  const stamped = { ...current, stateToken: newToken() }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped))
  return stamped
}

export const setFailNextWrite = (enabled: boolean): void => {
  if (enabled) {
    localStorage.setItem(FAIL_FLAG_KEY, '1')
  } else {
    localStorage.removeItem(FAIL_FLAG_KEY)
  }
}

export const isFailNextWriteArmed = (): boolean => localStorage.getItem(FAIL_FLAG_KEY) === '1'

export const saveState = (state: ThreatModelState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(state)))
}

export const resetState = (): ThreatModelState => {
  const seed = seedWithToken()
  saveState(seed)
  localStorage.removeItem(DRAFTS_KEY)
  return seed
}

/* ---------------- 失败写入草稿 ---------------- */

export const loadDrafts = (): PendingDraft[] => {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    return raw ? (JSON.parse(raw) as PendingDraft[]) : []
  } catch {
    return []
  }
}

export const saveDrafts = (drafts: PendingDraft[]): void => {
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(clone(drafts)))
}

export const upsertDraft = (draft: PendingDraft): PendingDraft[] => {
  const drafts = loadDrafts().filter((item) => item.id !== draft.id)
  drafts.unshift(draft)
  saveDrafts(drafts)
  return drafts
}

export const removeDraft = (id: string): PendingDraft[] => {
  const drafts = loadDrafts().filter((item) => item.id !== id)
  saveDrafts(drafts)
  return drafts
}

export const clearDrafts = (): PendingDraft[] => {
  saveDrafts([])
  return []
}

/* ---------------- 冲突对比 ---------------- */

const IGNORE_KEYS = new Set(['revision', 'stateToken'])

const toComparable = (value: unknown): unknown => {
  if (Array.isArray(value)) return [...value].sort().join('|')
  return value
}

/** 对比同 id 实体的两个版本，返回草稿相对远程版本发生变化的字段。 */
export const diffEntity = (remote: unknown, draft: unknown): EntityConflict => {
  const changedFields: string[] = []
  const remoteRecord = (remote && typeof remote === 'object' ? remote : {}) as Record<string, unknown>
  const draftRecord = (draft && typeof draft === 'object' ? draft : {}) as Record<string, unknown>
  const keys = new Set([...Object.keys(remoteRecord), ...Object.keys(draftRecord)])
  keys.forEach((key) => {
    if (IGNORE_KEYS.has(key)) return
    const remoteValue = toComparable(remoteRecord[key])
    const draftValue = toComparable(draftRecord[key])
    if (JSON.stringify(remoteValue) !== JSON.stringify(draftValue)) {
      changedFields.push(key)
    }
  })
  return { remote, draft, changedFields }
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
