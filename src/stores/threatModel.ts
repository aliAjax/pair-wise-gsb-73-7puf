import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  ActorRole,
  AuditEvent,
  DecisionType,
  DraftPayload,
  Threat,
  ThreatModelState,
  VersionSnapshot,
  WriteConflict,
} from '@/models/domain'
import {
  adoptRemote,
  commitState,
  createId,
  isFaultInjectionEnabled,
  loadState,
  readRemote,
  resetState,
  setFaultInjection,
} from '@/services/repository'
import {
  activeDecisionsForThreat,
  basisFingerprintOf,
  collectBasisFingerprints,
  invalidationScope,
  newChainToken,
  runInvalidation,
  type InvalidationOptions,
} from '@/services/versionChain'
import {
  dashboardMetrics,
  decisionsForThreat,
  getValidationIssues,
  reviewProgress,
} from '@/services/selectors'
import { draftStore } from '@/services/drafts'

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

interface IdentifiedEntity {
  id: string
}

/** 深拷贝：状态全部为可 JSON 序列化结构，该方式对 Vue 响应式代理同样安全 */
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface DraftInput {
  kind: DraftPayload['kind']
  title: string
  route: string
  payload: unknown
  contextId?: string
}

export interface CommitOutcome {
  ok: boolean
  conflict?: WriteConflict
  error?: string
  draftId?: string
}

interface MutateOptions {
  invalidation?: InvalidationOptions
  draft?: DraftInput
}

const DRAFT_ROUTE: Partial<Record<CollectionKey, { kind: DraftPayload['kind']; route: string }>> = {
  mitigations: { kind: 'mitigation', route: '/mitigations' },
  evidence: { kind: 'evidence', route: '/evidence' },
  risks: { kind: 'risk_acceptance', route: '/risks' },
  controls: { kind: 'evidence', route: '/evidence' },
}

export const useThreatModelStore = defineStore('threat-model', () => {
  const initial = loadState()
  const data = ref<ThreatModelState>(initial.state)
  const writeToken = ref(initial.writeToken)
  const lastSavedAt = ref(new Date().toISOString())
  const activeConflict = ref<WriteConflict | null>(null)
  const lastCommitError = ref<string | null>(null)

  const metrics = computed(() => dashboardMetrics(data.value))
  const issues = computed(() => getValidationIssues(data.value))
  const scope = computed(() => invalidationScope(data.value))
  const pendingReviews = computed(() =>
    data.value.threats.filter(
      (threat) => threat.invalidationPending || threat.reviewStatus === 'in_review',
    ),
  )

  const appendAudit = (
    target: ThreatModelState,
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    const event: AuditEvent = {
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      createdAt: new Date().toISOString(),
      detail,
    }
    target.audit.unshift(event)
  }

  /**
   * 统一提交入口：在克隆上应用修改 → 重算会签基准指纹 → 跑失效引擎 →
   * 乐观锁写入。写入失败时回滚内存状态并保留草稿；冲突时弹出对方版本。
   */
  const commit = (
    mutate: (draft: ThreatModelState) => void,
    options: MutateOptions = {},
  ): CommitOutcome => {
    const baseline = deepClone(data.value)
    const working = deepClone(data.value)
    mutate(working)

    // 重算所有威胁的会签基准指纹，供失效引擎比较
    working.threats = working.threats.map((threat) => ({
      ...threat,
      basisFingerprint: basisFingerprintOf(working, threat),
    }))

    const nowIso = new Date().toISOString()
    const invalidationOptions: InvalidationOptions = options.invalidation ?? {
      mode: 'none',
      reason: 'threat',
      sourceLabel: '',
    }
    runInvalidation(baseline, working, invalidationOptions, nowIso)

    const result = commitState(working, writeToken.value)
    if (!result.ok) {
      const baseDetail =
        result.error ?? `对方窗口已于其他时间提交新版本（${result.conflict?.remoteUpdatedAt ?? ''}）`
      if (options.draft) {
        const saved = draftStore.add({
          kind: options.draft.kind,
          title: options.draft.title,
          route: options.draft.route,
          payload: options.draft.payload,
          contextId: options.draft.contextId,
          reason: result.conflict ? 'conflict' : 'write_failed',
          detail: result.conflict
            ? `并发冲突：${baseDetail}`
            : `写入失败：${result.error ?? '存储不可用'}，表单内容已保留为草稿`,
        })
        if (result.conflict) activeConflict.value = result.conflict
        lastCommitError.value = baseDetail
        return { ok: false, conflict: result.conflict, error: result.error, draftId: saved.id }
      }
      if (result.conflict) activeConflict.value = result.conflict
      lastCommitError.value = baseDetail
      return { ok: false, conflict: result.conflict, error: result.error }
    }

    data.value = working
    writeToken.value = result.writeToken!
    lastSavedAt.value = new Date().toISOString()
    lastCommitError.value = null
    return { ok: true }
  }

  const entityLabel = (item: IdentifiedEntity): string =>
    'name' in item && typeof item.name === 'string'
      ? item.name
      : 'code' in item && typeof (item as { code: unknown }).code === 'string'
        ? String((item as { code: unknown }).code)
        : 'title' in item && typeof (item as { title: unknown }).title === 'string'
          ? String((item as { title: unknown }).title)
          : item.id

  const saveEntity = (
    collection: CollectionKey,
    item: IdentifiedEntity,
    draft?: DraftInput,
  ): CommitOutcome => {
    const label = entityLabel(item)
    const routeMeta = DRAFT_ROUTE[collection]
    const invalidation: InvalidationOptions | undefined =
      collection === 'mitigations'
        ? { mode: 'auto', reason: 'mitigation', sourceLabel: label }
        : collection === 'evidence'
          ? { mode: 'auto', reason: 'evidence', sourceLabel: label }
          : collection === 'risks'
            ? { mode: 'auto', reason: 'risk', sourceLabel: label }
            : collection === 'controls'
              ? { mode: 'auto', reason: 'control', sourceLabel: label }
              : collection === 'threats'
                ? { mode: 'auto', reason: 'threat', sourceLabel: label }
                : undefined

    return commit(
      (draftState) => {
        const target = draftState[collection]
        const at = target.findIndex((entry) => entry.id === item.id)
        if (at >= 0) {
          if (collection === 'threats') {
            // 威胁自身修订：重置版本链令牌，使该威胁的旧会签意见确定性失效
            target[at] = { ...(item as Threat), chainToken: newChainToken() } as never
          } else {
            target[at] = item as never
          }
        } else {
          target.unshift(item as never)
        }
        appendAudit(draftState, collection, item.id, at >= 0 ? '更新' : '新增', `${label} 已保存`)
      },
      {
        invalidation,
        draft:
          draft ??
          (routeMeta
            ? {
                kind: routeMeta.kind,
                title: label,
                route: routeMeta.route,
                payload: item,
                contextId: item.id,
              }
            : undefined),
      },
    )
  }

  const removeEntity = (collection: CollectionKey, id: string): CommitOutcome =>
    commit((draftState) => {
      const target = draftState[collection]
      const index = target.findIndex((entry) => entry.id === id)
      if (index >= 0) target.splice(index, 1)
      appendAudit(draftState, collection, id, '删除', '记录已从当前版本移除')
    })

  const updateBoundary = (boundary: ThreatModelState['boundary']): CommitOutcome =>
    commit((draftState) => {
      draftState.boundary = boundary
      appendAudit(draftState, 'boundary', boundary.id, '更新', `${boundary.name} 的系统边界已更新`)
    })

  const saveThreat = (threat: Threat, draft?: DraftInput): CommitOutcome =>
    saveEntity('threats', threat, draft)

  const createVersion = (
    label: string,
    notes: string,
    affectedThreatIds: string[],
    draft?: DraftInput,
  ): VersionSnapshot | null => {
    const revision = data.value.currentRevision + 1
    const snapshotId = createId('ver')
    const snapshot: VersionSnapshot = {
      id: snapshotId,
      revision,
      label,
      createdAt: new Date().toISOString(),
      author: '当前用户',
      notes,
      threatIds: data.value.threats.map((threat) => threat.id),
      componentIds: data.value.components.map((component) => component.id),
      flowIds: data.value.flows.map((flow) => flow.id),
      controlIds: data.value.controls.map((control) => control.id),
      riskIds: data.value.risks.map((risk) => risk.id),
      mitigationIds: data.value.mitigations.map((task) => task.id),
      evidenceIds: data.value.evidence.map((item) => item.id),
      affectedThreatIds: [...affectedThreatIds],
      basisFingerprints: collectBasisFingerprints(data.value),
    }

    const outcome = commit(
      (draftState) => {
        draftState.currentRevision = revision
        draftState.versions.unshift({ ...snapshot, basisFingerprints: collectBasisFingerprints(draftState) })
        // 受影响威胁重置版本链令牌，把快照变更接入统一版本链
        draftState.threats.forEach((threat) => {
          if (affectedThreatIds.includes(threat.id)) {
            threat.chainToken = newChainToken()
            threat.revision = revision
          }
        })
        appendAudit(
          draftState,
          'version',
          snapshotId,
          '创建版本',
          `${label} 已创建，${affectedThreatIds.length} 条威胁进入重新审核`,
        )
      },
      {
        invalidation: {
          mode: 'explicit',
          reason: 'version',
          sourceLabel: label,
          explicitThreatIds: affectedThreatIds,
          versionId: snapshotId,
        },
        draft,
      },
    )

    return outcome.ok ? snapshot : null
  }

  const submitDecision = (
    threatId: string,
    role: ActorRole,
    decision: DecisionType,
    actor: string,
    comment: string,
    draft?: DraftInput,
  ): CommitOutcome => {
    const threat = data.value.threats.find((item) => item.id === threatId)
    if (!threat) return { ok: false, error: '威胁不存在' }

    return commit(
      (draftState) => {
        const targetThreat = draftState.threats.find((item) => item.id === threatId)!
        // 同一角色同一基准下的旧 active 意见转为 superseded（保留可查看）
        draftState.decisions.forEach((item) => {
          if (
            item.threatId === threatId &&
            item.role === role &&
            item.validity === 'active' &&
            item.basisFingerprint === targetThreat.basisFingerprint
          ) {
            item.validity = 'superseded'
            item.invalidatedAt = new Date().toISOString()
          }
        })

        draftState.decisions.unshift({
          id: createId('dec'),
          threatId,
          role,
          actor,
          decision,
          comment,
          createdAt: new Date().toISOString(),
          revision: targetThreat.revision,
          basisFingerprint: targetThreat.basisFingerprint,
          validity: 'active',
          invalidatedAt: null,
          invalidationReason: null,
        })

        const currentDecisions = activeDecisionsForThreat(draftState.decisions, targetThreat)
        const requiredRoles: ActorRole[] = ['development', 'security', 'business']
        const allSubmitted = requiredRoles.every((requiredRole) =>
          currentDecisions.some((item) => item.role === requiredRole),
        )
        if (currentDecisions.some((item) => item.decision === 'rejected')) {
          targetThreat.reviewStatus = 'rejected'
        } else if (
          allSubmitted &&
          currentDecisions.every((item) => item.decision === 'approved')
        ) {
          targetThreat.reviewStatus = 'approved'
          targetThreat.invalidationPending = false
        } else {
          targetThreat.reviewStatus = 'in_review'
        }

        const decisionLabel: Record<DecisionType, string> = {
          accept: '接受',
          degrade: '降级',
          evidence_required: '要求补证',
          approved: '会签通过',
          rejected: '驳回',
        }
        appendAudit(
          draftState,
          'threat',
          threatId,
          decisionLabel[decision],
          `${actor}（${role}）提交会签意见`,
        )
      },
      { invalidation: { mode: 'none', reason: 'threat', sourceLabel: '' }, draft },
    )
  }

  const updateMitigationStatus = (
    taskId: string,
    status: ThreatModelState['mitigations'][number]['status'],
    draft?: DraftInput,
  ): CommitOutcome => {
    const task = data.value.mitigations.find((item) => item.id === taskId)
    if (!task) return { ok: false, error: '缓解任务不存在' }
    return commit(
      (draftState) => {
        const target = draftState.mitigations.find((item) => item.id === taskId)!
        target.status = status
        appendAudit(draftState, 'mitigation', taskId, '更新状态', `${task.title} 更新为 ${status}`)
      },
      {
        invalidation: { mode: 'auto', reason: 'mitigation', sourceLabel: task.title },
        draft:
          draft ?? {
            kind: 'mitigation_status',
            title: task.title,
            route: '/mitigations',
            payload: { taskId, status },
            contextId: taskId,
          },
      },
    )
  }

  const acceptRisk = (
    riskId: string,
    expiresAt: string,
    condition: string,
    draft?: DraftInput,
  ): CommitOutcome => {
    const risk = data.value.risks.find((item) => item.id === riskId)
    if (!risk) return { ok: false, error: '风险不存在' }
    return commit(
      (draftState) => {
        const target = draftState.risks.find((item) => item.id === riskId)!
        target.status = 'accepted'
        target.acceptanceExpiresAt = expiresAt
        target.acceptanceCondition = condition
        appendAudit(draftState, 'risk', riskId, '接受风险', `接受有效至 ${expiresAt}：${condition}`)
      },
      {
        invalidation: { mode: 'auto', reason: 'risk', sourceLabel: `${risk.code} ${risk.title}` },
        draft,
      },
    )
  }

  const closeRisk = (riskId: string, draft?: DraftInput): CommitOutcome => {
    const risk = data.value.risks.find((item) => item.id === riskId)
    if (!risk) return { ok: false, error: '风险不存在' }
    return commit(
      (draftState) => {
        const target = draftState.risks.find((item) => item.id === riskId)!
        target.status = 'closed'
        appendAudit(draftState, 'risk', riskId, '关闭风险', '风险已关闭并从开放风险中移除')
      },
      {
        invalidation: { mode: 'auto', reason: 'risk', sourceLabel: `${risk.code} ${risk.title}` },
        draft,
      },
    )
  }

  /** 冲突弹窗中选择“采用对方版本” */
  const resolveConflictAdoptRemote = (): void => {
    if (!activeConflict.value) return
    const adopted = adoptRemote(activeConflict.value)
    data.value = adopted.state
    writeToken.value = adopted.writeToken
    lastSavedAt.value = new Date().toISOString()
    activeConflict.value = null
  }

  const dismissConflict = (): void => {
    activeConflict.value = null
  }

  /** 另一个窗口写入（storage 事件）：同步对方版本；有本地草稿时仅提示，不覆盖草稿 */
  const syncFromRemote = (): { changed: boolean; hasDrafts: boolean } => {
    const remote = readRemote()
    if (!remote || remote.writeToken === writeToken.value) {
      return { changed: false, hasDrafts: draftStore.drafts.length > 0 }
    }
    data.value = remote.state
    writeToken.value = remote.writeToken
    lastSavedAt.value = new Date().toISOString()
    activeConflict.value = null
    return { changed: true, hasDrafts: draftStore.drafts.length > 0 }
  }

  const resetDemo = (): void => {
    const reset = resetState()
    data.value = reset.state
    writeToken.value = reset.writeToken
    lastSavedAt.value = new Date().toISOString()
    activeConflict.value = null
  }

  const faultInjectionEnabled = ref(isFaultInjectionEnabled())
  const toggleFaultInjection = (enabled: boolean): void => {
    setFaultInjection(enabled)
    faultInjectionEnabled.value = enabled
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
      `- 会签失效待重签：${scope.value.length}`,
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
      '## 会签失效范围',
      ...(scope.value.length
        ? scope.value.map(
            (item) =>
              `- ${item.threatCode} ${item.threatTitle}：失效意见 ${item.invalidatedDecisionCount} 条，最近失效 ${item.lastInvalidatedAt ?? '-'}`,
          )
        : ['- 无']),
      '',
      '## 校验问题',
      ...issues.value.map((issue) => `- [${issue.severity}] ${issue.title}：${issue.detail}`),
      '',
      '## 会签记录',
      ...data.value.decisions.map(
        (decision) =>
          `- ${decision.createdAt} ${decision.actor}（${decision.role}）${decision.decision}${decision.validity === 'active' ? '' : `[${decision.validity === 'invalidated' ? '已失效·只读' : '已覆盖·只读'}]`}：${decision.comment}`,
      ),
    ]
    return lines.join('\n')
  }

  return {
    data,
    writeToken,
    lastSavedAt,
    activeConflict,
    lastCommitError,
    faultInjectionEnabled,
    metrics,
    issues,
    scope,
    pendingReviews,
    saveEntity,
    removeEntity,
    updateBoundary,
    saveThreat,
    createVersion,
    submitDecision,
    updateMitigationStatus,
    acceptRisk,
    closeRisk,
    resolveConflictAdoptRemote,
    dismissConflict,
    syncFromRemote,
    resetDemo,
    toggleFaultInjection,
    exportReport,
    reviewProgress,
    decisionsForThreat,
  }
})
