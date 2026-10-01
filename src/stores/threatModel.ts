import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ActorRole,
  AuditEvent,
  ChainChangeSource,
  ChainEvent,
  DecisionType,
  MitigationTask,
  PendingDraft,
  Risk,
  SaveOutcome,
  Threat,
  ThreatModelState,
  VersionSnapshot,
} from '@/models/domain'
import {
  commitState,
  createId,
  loadDrafts,
  loadState,
  removeDraft,
  resetState,
  simulateRemoteCommit,
  upsertDraft,
} from '@/services/repository'
import {
  dashboardMetrics,
  decisionsForThreat,
  getValidationIssues,
  latestEventForThreat,
  reviewProgress,
} from '@/services/selectors'

type CollectionKey =
  | 'zones'
  | 'components'
  | 'dependencies'
  | 'flows'
  | 'controls'
  | 'evidence'
  | 'threats'
  | 'attackPaths'
  | 'risks'
  | 'mitigations'
  | 'decisions'

type TrackedCollection = 'threats' | 'mitigations' | 'evidence' | 'risks'

interface IdentifiedEntity {
  id: string
}

interface ApplyChainParams {
  state: ThreatModelState
  source: ChainChangeSource
  sourceId: string
  summary: string
  changedFields: string[]
  affectedThreatIds: string[]
  actor?: string
  snapshotId?: string
  remote?: boolean
}

interface RetryHandle {
  draft: PendingDraft
  applyTo: (state: ThreatModelState, payload: unknown) => void
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  name: '名称',
  status: '状态',
  action: '处置动作',
  owner: '负责人',
  dueAt: '截止日期',
  detail: '执行说明',
  evidenceIds: '关联证据',
  conflictGroup: '冲突检查组',
  threatId: '关联威胁',
  controlId: '关联控制',
  valid: '证据有效性',
  reference: '引用编号',
  expiresAt: '到期日',
  collectedAt: '采集日',
  likelihood: '可能性',
  impact: '影响',
  acceptanceExpiresAt: '接受到期日',
  acceptanceCondition: '接受条件',
  code: '编号',
  severity: '严重级别',
  description: '描述',
}

export const fieldLabel = (field: string): string => FIELD_LABELS[field] ?? field

const stableValue = (value: unknown): string => {
  if (Array.isArray(value)) return [...value].map((item) => String(item)).sort().join('|')
  return String(value)
}

const cloneState = (value: ThreatModelState): ThreatModelState => {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as ThreatModelState
  }
}

const changedFieldsOf = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): string[] => {
  const keys = new Set([...(before ? Object.keys(before) : []), ...Object.keys(after)])
  return [...keys]
    .filter((key) => key !== 'revision')
    .filter((key) => stableValue(before?.[key]) !== stableValue(after[key]))
    .map(fieldLabel)
}

const ACTION_TITLES: Record<PendingDraft['action'], string> = {
  save_threat: '威胁编辑',
  save_mitigation: '缓解任务编辑',
  save_evidence: '控制证据编辑',
  save_risk: '风险值编辑',
  submit_decision: '会签意见',
  create_version: '创建版本',
  update_mitigation_status: '缓解任务状态推进',
  accept_risk: '风险接受',
  close_risk: '关闭风险',
  update_boundary: '系统边界更新',
}

export const useThreatModelStore = defineStore('threat-model', () => {
  const data = ref<ThreatModelState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())
  const drafts = ref<PendingDraft[]>(loadDrafts())
  const lastConflict = ref<{ draft: PendingDraft; remoteRevision: number } | null>(null)
  const retryRegistry = new Map<string, RetryHandle>()

  /** 把草稿载荷重放到任意状态上（重启后仍可重放冲突草稿）。 */
  const replayDraftPayload = (draft: PendingDraft): ((state: ThreatModelState) => void) => {
    const upsertTracked = (collection: TrackedCollection) => (state: ThreatModelState) => {
      const payload = draft.payload as IdentifiedEntity
      upsertCollection(state, collection, payload)
    }
    switch (draft.action) {
      case 'save_threat':
        return upsertTracked('threats')
      case 'save_mitigation':
        return upsertTracked('mitigations')
      case 'save_evidence':
        return upsertTracked('evidence')
      case 'save_risk':
        return upsertTracked('risks')
      case 'submit_decision':
        return (state) => {
          const p = draft.payload as {
            threatId: string
            role: ActorRole
            decision: DecisionType
            actor: string
            comment: string
          }
          const threat = state.threats.find((item) => item.id === p.threatId)
          if (!threat) return
          state.decisions = state.decisions.filter(
            (item) =>
              !(
                item.threatId === p.threatId &&
                item.role === p.role &&
                item.revision === threat.revision &&
                item.status === 'active'
              ),
          )
          state.decisions.unshift({
            id: createId('dec'),
            threatId: p.threatId,
            role: p.role,
            actor: p.actor,
            decision: p.decision,
            comment: p.comment,
            createdAt: new Date().toISOString(),
            revision: threat.revision,
            status: 'active',
          })
        }
      case 'update_mitigation_status':
        return (state) => {
          const p = draft.payload as { id: string; status: MitigationTask['status'] }
          const task = state.mitigations.find((item) => item.id === p.id)
          if (!task) return
          task.status = p.status
        }
      case 'accept_risk':
        return (state) => {
          const p = draft.payload as { riskId: string; expiresAt: string; condition: string }
          const risk = state.risks.find((item) => item.id === p.riskId)
          if (risk) {
            risk.status = 'accepted'
            risk.acceptanceExpiresAt = p.expiresAt
            risk.acceptanceCondition = p.condition
          }
        }
      case 'close_risk':
        return (state) => {
          const p = draft.payload as { riskId: string }
          const risk = state.risks.find((item) => item.id === p.riskId)
          if (risk) risk.status = 'closed'
        }
      default:
        return () => {}
    }
  }

  const metrics = computed(() => dashboardMetrics(data.value))
  const issues = computed(() => getValidationIssues(data.value))
  const pendingReviews = computed(() =>
    data.value.threats.filter((threat) => threat.reviewStatus === 'in_review'),
  )

  /* ---------------- 提交与草稿 ---------------- */

  const persistDraft = (
    draft: Omit<PendingDraft, 'id' | 'createdAt' | 'baseRevision' | 'baseToken'>,
  ): string => {
    const id = createId('drf')
    const full: PendingDraft = {
      ...draft,
      id,
      createdAt: new Date().toISOString(),
      baseRevision: data.value.currentRevision,
      baseToken: data.value.stateToken,
    }
    drafts.value = upsertDraft(full)
    return id
  }

  /**
   * 在状态克隆上执行一次变更并做乐观锁提交。
   * 冲突或写入失败时本地内存状态保持不变，草稿由调用方登记。
   */
  const commit = (
    mutate: (state: ThreatModelState) => void,
    draftSpec?: {
      action: PendingDraft['action']
      entityId: string
      title: string
      payload: unknown
      applyTo: (state: ThreatModelState, payload: unknown) => void
    },
  ): SaveOutcome => {
    const base = data.value
    const next = cloneState(base)
    mutate(next)

    const result = commitState(base.stateToken, next)
    if (result.outcome === 'ok') {
      if (result.newToken) next.stateToken = result.newToken
      data.value = next
      lastSavedAt.value = new Date().toISOString()
      return { ok: true }
    }

    const reason = result.outcome === 'conflict' ? 'conflict' : 'write_failure'
    const draftId = draftSpec
      ? persistDraft({
          action: draftSpec.action,
          entityId: draftSpec.entityId,
          title: draftSpec.title,
          payload: draftSpec.payload,
          reason,
          remoteSummary:
            reason === 'conflict'
              ? `另一窗口已提交至 v1.${result.remoteState?.currentRevision}`
              : result.error,
        })
      : ''

    if (reason === 'conflict' && result.remoteState) {
      if (draftSpec && draftId) {
        retryRegistry.set(draftId, {
          draft: drafts.value.find((item) => item.id === draftId) as PendingDraft,
          applyTo: draftSpec.applyTo,
        })
      }
      lastConflict.value = {
        draft: drafts.value.find((item) => item.id === draftId) as PendingDraft,
        remoteRevision: result.remoteState.currentRevision,
      }
      // 刷新为对方刚提交的版本，但不把草稿的改动合并进去
      data.value = result.remoteState
      lastSavedAt.value = new Date().toISOString()
      return { ok: false, reason: 'conflict', draftId, remoteState: result.remoteState }
    }

    return {
      ok: false,
      reason: 'write_failure',
      draftId,
      error: result.error ?? '写入失败',
    }
  }

  /** 处理冲突后，以最新版本为基线重新提交草稿（重启后也可重放）。 */
  const retryDraft = (id: string): SaveOutcome => {
    const handle = retryRegistry.get(id)
    const draft = drafts.value.find((item) => item.id === id)
    if (!draft) return { ok: false, reason: 'write_failure', draftId: id, error: '草稿已不存在' }

    const replay = handle
      ? (state: ThreatModelState) => handle.applyTo(state, draft.payload)
      : replayDraftPayload(draft)

    const outcome = commit(replay, undefined)
    if (outcome.ok) {
      discardDraft(id)
    }
    return outcome
  }

  const discardDraft = (id: string): void => {
    drafts.value = removeDraft(id)
    retryRegistry.delete(id)
    if (lastConflict.value?.draft.id === id) lastConflict.value = null
  }

  const clearConflict = (): void => {
    lastConflict.value = null
  }

  /** 接受远程版本后放弃本地草稿（草稿仍保留在草稿箱，可稍后恢复）。 */
  const keepDraftAfterConflict = (): void => {
    lastConflict.value = null
  }

  const syncFromStorage = (): boolean => {
    const fresh = loadState()
    if (fresh.stateToken === data.value.stateToken) return false
    data.value = fresh
    lastSavedAt.value = new Date().toISOString()
    return true
  }

  /* ---------------- 审计与版本链 ---------------- */

  const appendAuditOn = (
    state: ThreatModelState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
    actor = '当前用户',
  ): void => {
    const event: AuditEvent = {
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor,
      createdAt: new Date().toISOString(),
      detail,
    }
    state.audit.unshift(event)
  }

  const threatsReferencingEvidence = (
    state: ThreatModelState,
    evidenceId: string,
    controlIds: string[],
  ): Threat[] => {
    const directTasks = state.mitigations
      .filter((task) => task.evidenceIds.includes(evidenceId))
      .map((task) => task.threatId)
    const controlSet = new Set(controlIds)
    return state.threats.filter(
      (threat) =>
        directTasks.includes(threat.id) ||
        threat.controlIds.some((id) => controlSet.has(id)),
    )
  }

  const affectedThreatsFor = (
    state: ThreatModelState,
    collection: TrackedCollection,
    item: Record<string, unknown>,
    before?: Record<string, unknown>,
  ): Threat[] => {
    if (collection === 'threats') {
      const threat = state.threats.find((entry) => entry.id === item.id)
      return threat ? [threat] : []
    }
    if (collection === 'mitigations') {
      // 换绑威胁时，新旧两个威胁都受影响
      const threatIds = new Set(
        [String(item.threatId ?? ''), String(before?.threatId ?? '')].filter(Boolean),
      )
      return state.threats.filter((threat) => threatIds.has(threat.id))
    }
    if (collection === 'risks') {
      const riskId = String(item.id)
      return state.threats.filter((threat) => threat.riskIds.includes(riskId))
    }
    // evidence：证据所属控制 + 旧控制，以及直接引用证据的缓解任务
    const controlIds = [String(item.controlId ?? ''), String(before?.controlId ?? '')].filter(Boolean)
    return threatsReferencingEvidence(state, String(item.id), controlIds)
  }

  const sourceLabel = (source: ChainChangeSource): string =>
    ({
      threat: '威胁',
      mitigation: '缓解任务',
      evidence: '控制证据',
      risk: '风险值',
      version: '版本快照',
      remote: '远程提交',
    })[source]

  /**
   * 推进统一版本链：链版本 +1，登记链事件，
   * 把受影响威胁打回待重新会签，并将其当前生效会签意见作废（保留只读记录）。
   */
  const applyChainEvent = (params: ApplyChainParams): ChainEvent => {
    const { state } = params
    const revision = state.currentRevision + 1
    const affectedSet = new Set(params.affectedThreatIds)
    const invalidatedDecisionIds: string[] = []
    const now = new Date().toISOString()

    state.threats = state.threats.map((threat) => {
      if (!affectedSet.has(threat.id)) return threat
      let invalidatedHere = 0
      state.decisions.forEach((decision) => {
        if (
          decision.threatId === threat.id &&
          decision.status === 'active' &&
          decision.revision <= threat.revision
        ) {
          decision.status = 'invalidated'
          decision.invalidatedAt = now
          decision.invalidationReason = params.summary
          // 事件尚未创建，先临时记录，下面回填
          invalidatedDecisionIds.push(decision.id)
          invalidatedHere += 1
        }
      })
      // 有旧意见被作废，或版本快照明确圈定，才回到待重新会签；全新草稿保持草稿态
      const shouldReReview = invalidatedHere > 0 || params.source === 'version'
      return shouldReReview
        ? { ...threat, revision, reviewStatus: 'in_review' as const }
        : { ...threat, revision }
    })

    const event: ChainEvent = {
      id: createId('chn'),
      revision,
      createdAt: now,
      actor: params.actor ?? '当前用户',
      source: params.source,
      sourceId: params.sourceId,
      summary: params.summary,
      changedFields: params.changedFields,
      affectedThreatIds: [...affectedSet],
      invalidatedDecisionIds,
      snapshotId: params.snapshotId,
      remote: params.remote,
    }
    state.decisions.forEach((decision) => {
      if (invalidatedDecisionIds.includes(decision.id)) {
        decision.invalidationEventId = event.id
      }
    })
    state.currentRevision = revision
    state.chainEvents.unshift(event)
    return event
  }

  const makeEventSummary = (
    source: ChainChangeSource,
    label: string,
    changedFields: string[],
    isNew: boolean,
  ): string =>
    `${sourceLabel(source)}「${label}」${isNew ? '新增' : '变更'}（${changedFields.join('、') || '内容调整'}）`

  /* ---------------- 通用保存 ---------------- */

  const isTrackedCollection = (collection: CollectionKey): collection is TrackedCollection =>
    collection === 'threats' ||
    collection === 'mitigations' ||
    collection === 'evidence' ||
    collection === 'risks'

  const collectionSource = (collection: TrackedCollection): ChainChangeSource =>
    ({
      threats: 'threat',
      mitigations: 'mitigation',
      evidence: 'evidence',
      risks: 'risk',
    })[collection] as ChainChangeSource

  const saveTrackedEntity = (
    collection: TrackedCollection,
    item: IdentifiedEntity,
  ): SaveOutcome => {
    const target = data.value[collection] as unknown as IdentifiedEntity[]
    const existing = target.find((entry) => entry.id === item.id)
    const record = item as unknown as Record<string, unknown>
    const before = existing
      ? (JSON.parse(JSON.stringify(existing)) as unknown as Record<string, unknown>)
      : undefined
    const changedFields = before ? changedFieldsOf(before, record) : ['新增']
    const label =
      typeof record.title === 'string'
        ? record.title
        : typeof record.name === 'string'
          ? record.name
          : item.id
    const isNew = !before

    if (before && changedFields.length === 0) return { ok: true }

    const draftAction = {
      threats: 'save_threat',
      mitigations: 'save_mitigation',
      evidence: 'save_evidence',
      risks: 'save_risk',
    }[collection] as 'save_threat' | 'save_mitigation' | 'save_evidence' | 'save_risk'

    const applyTo = (state: ThreatModelState, payload: unknown): void => {
      upsertCollection(state, collection, payload as IdentifiedEntity)
      const list = state[collection] as unknown as IdentifiedEntity[]
      const fresh = list.find((entry) => entry.id === (payload as IdentifiedEntity).id)
      const preThreats = affectedThreatsFor(state, collection, payload as Record<string, unknown>, before)
      const event = applyChainEvent({
        state,
        source: collectionSource(collection),
        sourceId: (payload as IdentifiedEntity).id,
        summary: makeEventSummary(collectionSource(collection), String(label), changedFields, isNew),
        changedFields,
        affectedThreatIds: preThreats.map((threat) => threat.id),
      })
      if (collection !== 'threats') stampRevision(fresh, event.revision)
      appendAuditOn(
        state,
        collection,
        (payload as IdentifiedEntity).id,
        isNew ? '新增' : '更新',
        `${label} 已保存，${preThreats.length} 条威胁的旧会签意见按版本链作废`,
      )
    }

    return commit(
      (state) => applyTo(state, item),
      {
        action: draftAction,
        entityId: item.id,
        title: `${ACTION_TITLES[draftAction]}：${label}`,
        payload: item,
        applyTo,
      },
    )
  }

  const stampRevision = (entity: IdentifiedEntity | undefined, revision: number): void => {
    if (entity && 'revision' in entity) {
      ;(entity as { revision?: number }).revision = revision
    }
  }

  const upsertCollection = (
    state: ThreatModelState,
    collection: CollectionKey,
    item: IdentifiedEntity,
  ): boolean => {
    const target = state[collection] as unknown as IdentifiedEntity[]
    const index = target.findIndex((entry) => entry.id === item.id)
    if (index >= 0) {
      target[index] = item
      return false
    }
    target.unshift(item)
    return true
  }

  const saveEntity = (collection: CollectionKey, item: IdentifiedEntity): SaveOutcome => {
    if (isTrackedCollection(collection)) {
      return saveTrackedEntity(collection, item)
    }
    const label = 'name' in item && typeof item.name === 'string' ? item.name : item.id
    return commit(
      (state) => {
        const isNew = upsertCollection(state, collection, item)
        appendAuditOn(
          state,
          collection,
          item.id,
          isNew ? '新增' : '更新',
          `${label} 已保存`,
        )
      },
      {
        action: 'update_boundary',
        entityId: item.id,
        title: `${collection} 编辑：${label}`,
        payload: { collection, item },
        applyTo: (state, payload) => {
          const p = payload as { collection: CollectionKey; item: IdentifiedEntity }
          upsertCollection(state, p.collection, p.item)
        },
      },
    )
  }

  const removeEntity = (collection: CollectionKey, id: string): SaveOutcome => {
    const target = data.value[collection] as unknown as IdentifiedEntity[]
    const existing = target.find((entry) => entry.id === id)
    if (!existing) return { ok: true }
    const isTracked = isTrackedCollection(collection) && collection !== 'threats'
    const beforeRecord = isTracked
      ? (JSON.parse(JSON.stringify(existing)) as unknown as Record<string, unknown>)
      : undefined

    return commit((state) => {
      const list = state[collection] as unknown as IdentifiedEntity[]
      const pos = list.findIndex((entry) => entry.id === id)
      if (pos < 0) return
      if (isTracked && beforeRecord) {
        // 删除被威胁引用的缓解任务/证据/风险同样作废旧会签
        const affected = affectedThreatsFor(
          state,
          collection as TrackedCollection,
          beforeRecord,
        )
        if (affected.length > 0) {
          applyChainEvent({
            state,
            source: collectionSource(collection as TrackedCollection),
            sourceId: id,
            summary: `${sourceLabel(collectionSource(collection as TrackedCollection))}（${
              typeof beforeRecord.title === 'string' ? beforeRecord.title : id
            }）已删除`,
            changedFields: ['删除'],
            affectedThreatIds: affected.map((threat) => threat.id),
          })
        }
      }
      list.splice(pos, 1)
      appendAuditOn(state, collection, id, '删除', '记录已从当前版本移除')
    })
  }

  const updateBoundary = (boundary: ThreatModelState['boundary']): SaveOutcome =>
    commit(
      (state) => {
        state.boundary = boundary
        appendAuditOn(state, 'boundary', boundary.id, '更新', `${boundary.name} 的系统边界已更新`)
      },
      {
        action: 'update_boundary',
        entityId: boundary.id,
        title: `系统边界：${boundary.name}`,
        payload: boundary,
        applyTo: (state, payload) => {
          state.boundary = payload as ThreatModelState['boundary']
        },
      },
    )

  const saveThreat = (threat: Threat): SaveOutcome => saveTrackedEntity('threats', threat)

  /* ---------------- 版本快照 ---------------- */

  const createVersion = (
    label: string,
    notes: string,
    affectedThreatIds: string[],
  ): SaveOutcome & { snapshot?: VersionSnapshot } => {
    let snapshot: VersionSnapshot | undefined

    const applyTo = (state: ThreatModelState, payload: unknown): void => {
      const p = payload as { label: string; notes: string; affectedThreatIds: string[] }
      const revision = state.currentRevision + 1
      const snap: VersionSnapshot = {
        id: createId('ver'),
        revision,
        label: p.label,
        createdAt: new Date().toISOString(),
        author: '当前用户',
        notes: p.notes,
        threatIds: state.threats.map((threat) => threat.id),
        componentIds: state.components.map((component) => component.id),
        flowIds: state.flows.map((flow) => flow.id),
        controlIds: state.controls.map((control) => control.id),
        riskIds: state.risks.map((risk) => risk.id),
        affectedThreatIds: p.affectedThreatIds,
      }
      const event = applyChainEvent({
        state,
        source: 'version',
        sourceId: snap.id,
        summary: `创建版本 ${p.label}：${p.notes}`,
        changedFields: [`受影响威胁 ${p.affectedThreatIds.length} 条`],
        affectedThreatIds: p.affectedThreatIds,
        snapshotId: snap.id,
      })
      snap.chainEventId = event.id
      snap.revision = event.revision
      state.versions.unshift(snap)
      appendAuditOn(
        state,
        'version',
        snap.id,
        '创建版本',
        `${p.label} 已创建，${p.affectedThreatIds.length} 条威胁进入重新审核`,
      )
      snapshot = snap
    }

    const outcome = commit(
      (state) => applyTo(state, { label, notes, affectedThreatIds }),
      {
        action: 'create_version',
        entityId: `version-${Date.now()}`,
        title: `创建版本：${label}`,
        payload: { label, notes, affectedThreatIds },
        applyTo,
      },
    )
    return outcome.ok ? { ...outcome, snapshot } : outcome
  }

  /* ---------------- 会签 ---------------- */

  const submitDecision = (
    threatId: string,
    role: ActorRole,
    decision: DecisionType,
    actor: string,
    comment: string,
  ): SaveOutcome => {
    const payload = { threatId, role, decision, actor, comment }

    const applyTo = (state: ThreatModelState, p: unknown): void => {
      const data = p as typeof payload
      const threat = state.threats.find((item) => item.id === data.threatId)
      if (!threat) return
      state.decisions = state.decisions.filter(
        (item) =>
          !(
            item.threatId === data.threatId &&
            item.role === data.role &&
            item.revision === threat.revision &&
            item.status === 'active'
          ),
      )
      state.decisions.unshift({
        id: createId('dec'),
        threatId: data.threatId,
        role: data.role,
        actor: data.actor,
        decision: data.decision,
        comment: data.comment,
        createdAt: new Date().toISOString(),
        revision: threat.revision,
        status: 'active',
      })

      const currentDecisions = decisionsForThreat(
        state.decisions,
        data.threatId,
        threat.revision,
      )
      const requiredRoles: ActorRole[] = ['development', 'security', 'business']
      const allSubmitted = requiredRoles.every((requiredRole) =>
        currentDecisions.some((item) => item.role === requiredRole),
      )
      if (currentDecisions.some((item) => item.decision === 'rejected')) {
        threat.reviewStatus = 'rejected'
      } else if (
        allSubmitted &&
        currentDecisions.every((item) => item.decision === 'approved')
      ) {
        threat.reviewStatus = 'approved'
      } else {
        threat.reviewStatus = 'in_review'
      }

      const decisionLabel: Record<DecisionType, string> = {
        accept: '接受',
        degrade: '降级',
        evidence_required: '要求补证',
        approved: '会签通过',
        rejected: '驳回',
      }
      appendAuditOn(
        state,
        'threat',
        data.threatId,
        decisionLabel[data.decision],
        `${data.actor}（${data.role}）提交会签意见`,
      )
    }

    return commit(
      (state) => applyTo(state, payload),
      {
        action: 'submit_decision',
        entityId: `${threatId}:${role}`,
        title: `${ACTION_TITLES.submit_decision}：${threatId} / ${role}`,
        payload,
        applyTo,
      },
    )
  }

  /* ---------------- 缓解任务状态 / 风险 ---------------- */

  const updateMitigationStatus = (taskId: string, status: MitigationTask['status']): SaveOutcome => {
    const task = data.value.mitigations.find((item) => item.id === taskId)
    if (!task) return { ok: true }
    if (task.status === status) return { ok: true }
    const payload = { id: taskId, status }

    const applyTo = (state: ThreatModelState, p: unknown): void => {
      const { id, status } = p as typeof payload
      const current = state.mitigations.find((item) => item.id === id)
      if (!current) return
      current.status = status
      const threat = state.threats.find((item) => item.id === current.threatId)
      const event = applyChainEvent({
        state,
        source: 'mitigation',
        sourceId: id,
        summary: makeEventSummary('mitigation', current.title, ['状态'], false),
        changedFields: ['状态'],
        affectedThreatIds: threat ? [threat.id] : [],
      })
      current.revision = event.revision
      appendAuditOn(state, 'mitigation', id, '更新状态', `${current.title} 更新为 ${status}`)
    }

    return commit(
      (state) => applyTo(state, payload),
      {
        action: 'update_mitigation_status',
        entityId: taskId,
        title: `${task.title} → ${status}`,
        payload,
        applyTo,
      },
    )
  }

  const saveRisk = (risk: Risk): SaveOutcome => saveTrackedEntity('risks', risk)

  const acceptRisk = (riskId: string, expiresAt: string, condition: string): SaveOutcome => {
    const risk = data.value.risks.find((item) => item.id === riskId)
    if (!risk) return { ok: true }
    const payload = { riskId, expiresAt, condition }

    const applyTo = (state: ThreatModelState, p: unknown): void => {
      const data = p as typeof payload
      const current = state.risks.find((item) => item.id === data.riskId)
      if (!current) return
      current.status = 'accepted'
      current.acceptanceExpiresAt = data.expiresAt
      current.acceptanceCondition = data.condition
      const affected = state.threats.filter((threat) => threat.riskIds.includes(current.id))
      const event = applyChainEvent({
        state,
        source: 'risk',
        sourceId: current.id,
        summary: `风险值「${current.code} ${current.title}」记录风险接受`,
        changedFields: ['状态', '接受到期日', '接受条件'],
        affectedThreatIds: affected.map((threat) => threat.id),
      })
      current.revision = event.revision
      appendAuditOn(
        state,
        'risk',
        current.id,
        '接受风险',
        `接受有效至 ${data.expiresAt}：${data.condition}`,
      )
    }

    return commit(
      (state) => applyTo(state, payload),
      {
        action: 'accept_risk',
        entityId: riskId,
        title: `风险接受：${risk.code}`,
        payload,
        applyTo,
      },
    )
  }

  const closeRisk = (riskId: string): SaveOutcome => {
    const risk = data.value.risks.find((item) => item.id === riskId)
    if (!risk) return { ok: true }

    const applyTo = (state: ThreatModelState): void => {
      const current = state.risks.find((item) => item.id === riskId)
      if (!current) return
      current.status = 'closed'
      const affected = state.threats.filter((threat) => threat.riskIds.includes(current.id))
      const event = applyChainEvent({
        state,
        source: 'risk',
        sourceId: current.id,
        summary: `风险值「${current.code} ${current.title}」关闭`,
        changedFields: ['状态'],
        affectedThreatIds: affected.map((threat) => threat.id),
      })
      current.revision = event.revision
      appendAuditOn(state, 'risk', current.id, '关闭风险', '风险已关闭并从开放风险中移除')
    }

    return commit(
      (state) => applyTo(state),
      {
        action: 'close_risk',
        entityId: riskId,
        title: `关闭风险：${risk.code}`,
        payload: { riskId },
        applyTo: (state) => {
          const current = state.risks.find((item) => item.id === riskId)
          if (current) current.status = 'closed'
        },
      },
    )
  }

  /* ---------------- 其他 ---------------- */

  const resetDemo = (): void => {
    data.value = resetState()
    drafts.value = []
    retryRegistry.clear()
    lastConflict.value = null
    lastSavedAt.value = new Date().toISOString()
  }

  const exportReport = (): string => {
    const lines = [
      `# ${data.value.boundary.name} 威胁建模报告`,
      '',
      `生成时间：${new Date().toISOString()}`,
      `当前版本：v1.${data.value.currentRevision}`,
      `建模范围：${data.value.boundary.inScope}`,
      `排除范围：${data.value.boundary.outOfScope}`,
      '',
      '## 风险摘要',
      `- 资产与组件：${data.value.components.length}`,
      `- 威胁：${data.value.threats.length}`,
      `- 开放关键威胁：${metrics.value.critical}`,
      `- 威胁覆盖率：${metrics.value.coverage}%`,
      `- 待处理校验问题：${issues.value.length}`,
      '',
      '## 威胁清单',
      ...data.value.threats.map(
        (threat) =>
          `- ${threat.code} [${threat.severity}/${threat.reviewStatus}] ${threat.title}：${threat.description}`,
      ),
      '',
      '## 风险接受',
      ...data.value.risks
        .filter((risk) => risk.status === 'accepted')
        .map(
          (risk) =>
            `- ${risk.code} ${risk.title}，有效至 ${risk.acceptanceExpiresAt ?? '未设置'}，条件：${risk.acceptanceCondition ?? '未填写'}`,
        ),
      '',
      '## 校验问题',
      ...issues.value.map((issue) => `- [${issue.severity}] ${issue.title}：${issue.detail}`),
      '',
      '## 会签记录',
      ...data.value.decisions.map(
        (decision) =>
          `- ${decision.createdAt} ${decision.actor}（${decision.role}）${decision.decision}${decision.status === 'invalidated' ? '[已作废-只读]' : ''}：${decision.comment}`,
      ),
    ]
    return lines.join('\n')
  }

  const latestInvalidationEvent = (threatId: string) =>
    latestEventForThreat(data.value.chainEvents, threatId)

  /**
   * 演练：模拟另一个窗口已完成一次缓解任务提交（推进链版本并替换 token），
   * 之后本窗口再保存即触发乐观锁冲突。
   */
  const simulateRemoteChange = (): void => {
    const target = data.value.mitigations.find((task) => task.status !== 'done')
    if (!target) return
    const nextStatus: MitigationTask['status'] =
      target.status === 'todo'
        ? 'in_progress'
        : target.status === 'in_progress'
          ? 'verifying'
          : 'done'
    const affectedThreatIds = [target.threatId]
    const stamped = simulateRemoteCommit(
      (state, event) => {
        const task = state.mitigations.find((item) => item.id === target.id)
        if (!task) return
        task.status = nextStatus
        task.revision = event.revision
        state.threats.forEach((threat) => {
          if (!affectedThreatIds.includes(threat.id)) return
          threat.revision = event.revision
          threat.reviewStatus = 'in_review'
          state.decisions.forEach((decision) => {
            if (
              decision.threatId === threat.id &&
              decision.status === 'active' &&
              decision.revision < event.revision
            ) {
              decision.status = 'invalidated'
              decision.invalidatedAt = event.createdAt
              decision.invalidationEventId = event.id
              decision.invalidationReason = event.summary
            }
          })
        })
      },
      {
        revision: data.value.currentRevision + 1,
        source: 'remote',
        sourceId: target.id,
        summary: `另一窗口将缓解任务「${target.title}」状态推进为 ${nextStatus}`,
        changedFields: ['状态'],
        affectedThreatIds,
        invalidatedDecisionIds: data.value.decisions
          .filter(
            (decision) =>
              decision.threatId === target.threatId && decision.status === 'active',
          )
          .map((decision) => decision.id),
      },
    )
    data.value = stamped
    lastSavedAt.value = new Date().toISOString()
  }

  return {
    data,
    lastSavedAt,
    drafts,
    lastConflict,
    metrics,
    issues,
    pendingReviews,
    saveEntity,
    removeEntity,
    updateBoundary,
    saveThreat,
    saveRisk,
    createVersion,
    submitDecision,
    updateMitigationStatus,
    acceptRisk,
    closeRisk,
    resetDemo,
    exportReport,
    reviewProgress,
    retryDraft,
    discardDraft,
    clearConflict,
    keepDraftAfterConflict,
    syncFromStorage,
    simulateRemoteChange,
    latestInvalidationEvent,
  }
})
