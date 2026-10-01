import type {
  ControlEvidence,
  InvalidationReason,
  InvalidationRecord,
  InvalidationScopeItem,
  ReviewDecision,
  SecurityControl,
  Threat,
  ThreatModelState,
  VersionSnapshot,
} from '@/models/domain'
import { createId } from '@/services/repository'

const HEX_RADIX = 16
const HEX_WIDTH = 8

/** FNV-1a 32 位哈希，输出 8 位十六进制，作为会签基准指纹 */
export const fingerprint = (canonical: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, '0')
}

export const newChainToken = (): string => createId('tok')

type SortableRecord = Record<string, unknown>

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as SortableRecord)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 威胁的会签基准：把该威胁引用的缓解任务、控制、控制证据、风险值，
 * 以及版本链令牌组装为规范结构。任何一项内容改动都会改变基准指纹。
 */
export const threatBasis = (state: ThreatModelState, threat: Threat): unknown => {
  const controls = threat.controlIds
    .map((id) => state.controls.find((control) => control.id === id))
    .filter((control): control is SecurityControl => Boolean(control))
    .map((control) => ({
      id: control.id,
      name: control.name,
      type: control.type,
      status: control.status,
      owner: control.owner,
      description: control.description,
      evidenceIds: [...control.evidenceIds].sort(),
    }))

  const controlEvidenceIds = new Set(controls.flatMap((control) => control.evidenceIds))

  const evidence = state.evidence
    .filter((item) => controlEvidenceIds.has(item.id))
    .map((item: ControlEvidence) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      reference: item.reference,
      collectedAt: item.collectedAt,
      expiresAt: item.expiresAt,
      owner: item.owner,
      valid: item.valid,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const mitigations = state.mitigations
    .filter((task) => task.threatId === threat.id)
    .map((task) => ({
      id: task.id,
      title: task.title,
      owner: task.owner,
      dueAt: task.dueAt,
      status: task.status,
      action: task.action,
      detail: task.detail,
      evidenceIds: [...task.evidenceIds].sort(),
      conflictGroup: task.conflictGroup ?? '',
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const risks = threat.riskIds
    .map((id) => state.risks.find((risk) => risk.id === id))
    .filter(Boolean)
    .map((risk) => ({
      id: risk!.id,
      likelihood: risk!.likelihood,
      impact: risk!.impact,
      score: risk!.likelihood * risk!.impact,
      status: risk!.status,
      acceptanceExpiresAt: risk!.acceptanceExpiresAt ?? '',
      acceptanceCondition: risk!.acceptanceCondition ?? '',
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    chainToken: threat.chainToken,
    controls: controls.sort((left, right) => left.id.localeCompare(right.id)),
    evidence,
    mitigations,
    risks,
  }
}

export const basisFingerprintOf = (state: ThreatModelState, threat: Threat): string =>
  fingerprint(stableStringify(threatBasis(state, threat)))

/** 当前对威胁仍然生效的会签意见：未失效、未被覆盖，且基准指纹一致 */
export const activeDecisionsForThreat = (
  decisions: ReviewDecision[],
  threat: Threat,
): ReviewDecision[] =>
  decisions.filter(
    (decision) =>
      decision.threatId === threat.id &&
      decision.validity === 'active' &&
      decision.basisFingerprint === threat.basisFingerprint,
  )

export interface InvalidationOutcome {
  invalidations: InvalidationRecord[]
  /** 本次失效（基准变化）的威胁 id */
  affectedThreatIds: string[]
}

export interface InvalidationOptions {
  /** none：决策提交等操作不做基准重算；explicit：创建版本时按指定范围失效；auto：按基准指纹变化自动失效 */
  mode: 'none' | 'explicit' | 'auto'
  reason: InvalidationReason
  sourceLabel: string
  explicitThreatIds?: string[]
  versionId?: string
  remoteWriteToken?: string
}

const AUTO_REASON_LABEL: Record<InvalidationReason, string> = {
  mitigation: '缓解任务',
  control: '控制措施',
  evidence: '控制证据',
  risk: '风险值',
  threat: '威胁分析',
  version: '版本快照',
}

const reasonLabel = (reason: InvalidationReason): string => AUTO_REASON_LABEL[reason]

/**
 * 统一版本链失效引擎。
 * 比较每个威胁变更前后的会签基准指纹；引用的缓解任务、控制证据或风险值一旦改动，
 * 旧会签意见置为 invalidated（保留记录、只能查看），威胁回到待重新会签。
 */
export const runInvalidation = (
  prev: ThreatModelState,
  next: ThreatModelState,
  options: InvalidationOptions,
  now: string,
): InvalidationOutcome => {
  if (options.mode === 'none') {
    return { invalidations: [], affectedThreatIds: [] }
  }

  const prevThreats = new Map(prev.threats.map((threat) => [threat.id, threat]))
  const changedThreats: Threat[] = []

  next.threats.forEach((threat) => {
    const prevThreat = prevThreats.get(threat.id)
    if (options.mode === 'explicit') {
      if (options.explicitThreatIds?.includes(threat.id)) changedThreats.push(threat)
      return
    }
    if (!prevThreat) return
    if (prevThreat.basisFingerprint !== threat.basisFingerprint) changedThreats.push(threat)
  })

  if (changedThreats.length === 0) {
    return { invalidations: [], affectedThreatIds: [] }
  }

  const changedThreatIds = new Set(changedThreats.map((threat) => threat.id))
  const invalidatedDecisionIds: string[] = []

  next.decisions.forEach((decision) => {
    if (!changedThreatIds.has(decision.threatId)) return
    const threat = next.threats.find((item) => item.id === decision.threatId)
    if (!threat) return
    if (decision.validity === 'active' && decision.basisFingerprint !== threat.basisFingerprint) {
      decision.validity = 'invalidated'
      decision.invalidatedAt = now
      decision.invalidationReason = options.reason
      invalidatedDecisionIds.push(decision.id)
    }
  })

  changedThreats.forEach((threat) => {
    if (threat.reviewStatus !== 'draft') {
      threat.reviewStatus = 'in_review'
    }
    threat.invalidationPending = true
    threat.lastInvalidationReason = options.reason
    threat.lastInvalidatedAt = now
  })

  const record: InvalidationRecord = {
    id: createId('inv'),
    createdAt: now,
    actor: '当前用户',
    reason: options.reason,
    sourceLabel: options.sourceLabel,
    threatIds: changedThreats.map((threat) => threat.id),
    decisionIds: invalidatedDecisionIds,
    versionId: options.versionId,
    remoteWriteToken: options.remoteWriteToken,
  }
  next.invalidations.unshift(record)

  return {
    invalidations: [record],
    affectedThreatIds: changedThreats.map((threat) => threat.id),
  }
}

/**
 * 会签失效范围的单一数据源：版本比较页和会签页都通过该选择器渲染同一份范围。
 */
export const invalidationScope = (state: ThreatModelState): InvalidationScopeItem[] => {
  const queuedThreatIds = new Set<string>()
  state.invalidations.forEach((record) => {
    record.threatIds.forEach((id) => queuedThreatIds.add(id))
  })

  return state.threats
    .filter((threat) => queuedThreatIds.has(threat.id) && threat.invalidationPending)
    .map((threat) => {
      const records = state.invalidations.filter((record) =>
        record.threatIds.includes(threat.id),
      )
      const reasons = Array.from(new Set(records.map((record) => record.reason)))
      const decisionCount = new Set(
        records.flatMap((record) => record.decisionIds),
      ).size
      const times = records.map((record) => record.createdAt).sort()
      const latest = times.length ? times[times.length - 1] : undefined
      return {
        threatId: threat.id,
        threatCode: threat.code,
        threatTitle: threat.title,
        reasons,
        invalidatedDecisionCount: decisionCount,
        lastInvalidatedAt: latest ?? threat.lastInvalidatedAt ?? null,
      }
    })
    .sort((left, right) => (right.lastInvalidatedAt ?? '').localeCompare(left.lastInvalidatedAt ?? ''))
}

export const reasonText = (reason: InvalidationReason): string => reasonLabel(reason)

/**
 * 把 v1（无版本链字段）状态归一化为当前结构。
 * 基线种子与浏览器中遗留的 localStorage 都会经过这里。
 */
export const normalizeState = (raw: Partial<ThreatModelState>): ThreatModelState => {
  const state = raw as ThreatModelState
  state.invalidations = Array.isArray(state.invalidations) ? state.invalidations : []
  state.audit = Array.isArray(state.audit) ? state.audit : []

  state.threats = state.threats.map((threat) => {
    const normalized: Threat = {
      ...threat,
      basisFingerprint:
        typeof threat.basisFingerprint === 'string' && threat.basisFingerprint
          ? threat.basisFingerprint
          : '__pending__',
      chainToken:
        typeof threat.chainToken === 'string' && threat.chainToken
          ? threat.chainToken
          : newChainToken(),
      invalidationPending: Boolean(threat.invalidationPending),
      lastInvalidationReason: threat.lastInvalidationReason ?? null,
      lastInvalidatedAt: threat.lastInvalidatedAt ?? null,
    }
    return normalized
  })

  // 第一遍先得到真实基准指纹
  state.threats = state.threats.map((threat) =>
    threat.basisFingerprint === '__pending__'
      ? { ...threat, basisFingerprint: basisFingerprintOf(state, threat) }
      : threat,
  )

  state.versions = state.versions.map((version: VersionSnapshot) => ({
    ...version,
    mitigationIds: Array.isArray(version.mitigationIds)
      ? version.mitigationIds
      : state.mitigations.map((task) => task.id),
    evidenceIds: Array.isArray(version.evidenceIds)
      ? version.evidenceIds
      : state.evidence.map((item) => item.id),
    basisFingerprints:
      version.basisFingerprints && typeof version.basisFingerprints === 'object'
        ? version.basisFingerprints
        : Object.fromEntries(
            state.threats.map((threat) => [
              threat.id,
              state.threats.find((item) => item.id === threat.id)?.basisFingerprint ?? '',
            ]),
          ),
  }))

  // 遗留意见没有指纹时，按当前威胁基准补齐并视为仍然生效
  state.decisions = state.decisions.map((decision) => {
    const threat = state.threats.find((item) => item.id === decision.threatId)
    return {
      ...decision,
      basisFingerprint:
        typeof decision.basisFingerprint === 'string' && decision.basisFingerprint
          ? decision.basisFingerprint
          : threat?.basisFingerprint ?? '',
      validity: decision.validity ?? 'active',
      invalidatedAt: decision.invalidatedAt ?? null,
      invalidationReason: decision.invalidationReason ?? null,
    }
  })

  return state
}

/** 创建版本快照时收集各威胁的基准指纹 */
export const collectBasisFingerprints = (
  state: ThreatModelState,
): Record<string, string> =>
  Object.fromEntries(state.threats.map((threat) => [threat.id, threat.basisFingerprint]))
