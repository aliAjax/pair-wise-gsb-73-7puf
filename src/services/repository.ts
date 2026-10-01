import type {
  DraftPayload,
  StoredEnvelope,
  ThreatModelState,
  WriteConflict,
} from '@/models/domain'
import { createSeedState } from '@/models/seed'
import { normalizeState } from '@/services/versionChain'

const STORAGE_KEY = 'scapex-threat-model-v2'
const LEGACY_STORAGE_KEY = 'scapex-threat-model-v1'
const DRAFTS_KEY = 'scapex-drafts-v1'
const FAULT_KEY = 'scapex-fault-injection'

const clone = <T>(value: T): T => structuredClone(value)

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const newWriteToken = (): string => createId('tok')

const parseEnvelope = (raw: string): StoredEnvelope | null => {
  try {
    const parsed = JSON.parse(raw) as StoredEnvelope
    if (parsed && parsed.schema === 2 && parsed.state) return parsed
  } catch {
    // 落到迁移分支
  }
  return null
}

export interface LoadResult {
  state: ThreatModelState
  writeToken: string
  /** 本次加载是否来自另一个窗口刚写入的新版本（用于跨窗口提示） */
  migrated: boolean
}

export const loadState = (): LoadResult => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    const envelope = parseEnvelope(raw)
    if (envelope) {
      return { state: normalizeState(envelope.state), writeToken: envelope.writeToken, migrated: false }
    }
  }

  // 迁移 v1 裸状态或损坏数据
  let state: ThreatModelState | null = null
  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacyRaw) {
    try {
      state = normalizeState(JSON.parse(legacyRaw) as ThreatModelState)
    } catch {
      state = null
    }
  }
  if (!state) state = normalizeState(createSeedState())

  const envelope: StoredEnvelope = {
    schema: 2,
    writeToken: newWriteToken(),
    updatedAt: new Date().toISOString(),
    state,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  return { state, writeToken: envelope.writeToken, migrated: Boolean(legacyRaw) }
}

export interface CommitResult {
  ok: boolean
  writeToken?: string
  conflict?: WriteConflict
  error?: string
}

/**
 * 乐观并发提交：仅当磁盘上的 writeToken 与本窗口持有的基线令牌一致时才允许写入。
 * 另一个窗口先提交会更换令牌，后保存的一方收到 conflict 而不能覆盖对方的处置/会签。
 */
export const commitState = (state: ThreatModelState, expectedToken: string): CommitResult => {
  if (isFaultInjectionEnabled()) {
    return { ok: false, error: '存储写入失败（模拟）：浏览器存储不可用' }
  }

  let remote: StoredEnvelope | null = null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) remote = parseEnvelope(raw)

  if (remote && remote.writeToken !== expectedToken) {
    return {
      ok: false,
      conflict: {
        expectedToken,
        remoteWriteToken: remote.writeToken,
        remoteUpdatedAt: remote.updatedAt,
        remoteState: clone(normalizeState(remote.state)),
      },
    }
  }

  const envelope: StoredEnvelope = {
    schema: 2,
    writeToken: newWriteToken(),
    updatedAt: new Date().toISOString(),
    state: clone(state),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '未知写入错误' }
  }
  return { ok: true, writeToken: envelope.writeToken }
}

/** 冲突解决为“采用对方版本”后，以远端令牌为基线继续工作 */
export const adoptRemote = (conflict: WriteConflict): { state: ThreatModelState; writeToken: string } => ({
  state: normalizeState(conflict.remoteState),
  writeToken: conflict.remoteWriteToken,
})

export const resetState = (): { state: ThreatModelState; writeToken: string } => {
  const state = normalizeState(createSeedState())
  const envelope: StoredEnvelope = {
    schema: 2,
    writeToken: newWriteToken(),
    updatedAt: new Date().toISOString(),
    state,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  return { state, writeToken: envelope.writeToken }
}

/** 只读地拉取磁盘上的最新信封，用于跨窗口 storage 事件同步 */
export const readRemote = (): StoredEnvelope | null => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  const envelope = parseEnvelope(raw)
  return envelope ? { ...envelope, state: normalizeState(envelope.state) } : null
}

/* ---------------- 写入失败后的草稿（独立 key，重启后恢复） ---------------- */

const memoryDrafts: DraftPayload[] = []

export const loadDrafts = (): DraftPayload[] => {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as DraftPayload[]) : []
  } catch {
    return [...memoryDrafts]
  }
}

export const saveDrafts = (drafts: DraftPayload[]): void => {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    memoryDrafts.splice(0, memoryDrafts.length, ...drafts)
  }
}

/* ---------------- 写入故障注入（演示/验收用） ---------------- */

export const isFaultInjectionEnabled = (): boolean => localStorage.getItem(FAULT_KEY) === '1'

export const setFaultInjection = (enabled: boolean): void => {
  if (enabled) localStorage.setItem(FAULT_KEY, '1')
  else localStorage.removeItem(FAULT_KEY)
}
