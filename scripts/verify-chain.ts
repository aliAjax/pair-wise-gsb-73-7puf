// 端到端逻辑验证：版本链失效、乐观锁冲突、失败草稿
import { createSeedState } from '../src/models/seed'
import {
  commitState,
  diffEntity,
  loadDrafts,
  removeDraft,
  setFailNextWrite,
  simulateRemoteCommit,
  upsertDraft,
  createStateToken,
} from '../src/services/repository'
import { pendingInvalidationScope, decisionsForThreat } from '../src/services/selectors'

let store: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => {
    store[k] = v
  },
  removeItem: (k: string) => {
    delete store[k]
  },
}

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${detail}`)
  }
}

const clone = <T,>(v: T): T => structuredClone(v)

// 初始化
const initial = { ...createSeedState(), stateToken: createStateToken() }
store['scapex-threat-model-v1'] = JSON.stringify(initial)

// 模拟 store commit 的最小封装
const commit = (
  base: any,
  mutate: (s: any) => void,
  draftMeta?: { action: string; entityId: string; title: string; payload: unknown },
) => {
  const next = clone(base)
  mutate(next)
  const result = commitState(base.stateToken, next)
  if (result.outcome === 'ok') {
    const saved = JSON.parse(store['scapex-threat-model-v1'])
    return { ok: true as const, state: saved }
  }
  const reason = result.outcome
  if (draftMeta && result.outcome !== 'ok') {
    upsertDraft({
      id: `drf-test-${Date.now()}-${Math.random()}`,
      createdAt: new Date().toISOString(),
      baseRevision: base.currentRevision,
      baseToken: base.stateToken,
      reason: reason === 'conflict' ? 'conflict' : 'write_failure',
      ...draftMeta,
    })
  }
  return { ok: false as const, reason, remoteState: (result as any).remoteState, error: (result as any).error }
}

// 复制 store 内部的链事件应用逻辑做验证
const applyChainEvent = (state: any, params: any) => {
  const revision = state.currentRevision + 1
  const affected = new Set(params.affectedThreatIds)
  const invalidated: string[] = []
  const now = new Date().toISOString()
  state.threats = state.threats.map((t: any) => {
    if (!affected.has(t.id)) return t
    let n = 0
    state.decisions.forEach((d: any) => {
      if (d.threatId === t.id && d.status === 'active' && d.revision <= t.revision) {
        d.status = 'invalidated'
        d.invalidatedAt = now
        d.invalidationReason = params.summary
        invalidated.push(d.id)
        n++
      }
    })
    return n > 0 || params.source === 'version'
      ? { ...t, revision, reviewStatus: 'in_review' }
      : { ...t, revision }
  })
  const event = {
    id: `chn-test-${revision}`,
    revision,
    createdAt: now,
    actor: '当前用户',
    source: params.source,
    sourceId: params.sourceId,
    summary: params.summary,
    changedFields: params.changedFields,
    affectedThreatIds: [...affected],
    invalidatedDecisionIds: invalidated,
  }
  state.decisions.forEach((d: any) => {
    if (invalidated.includes(d.id)) d.invalidationEventId = event.id
  })
  state.currentRevision = revision
  state.chainEvents.unshift(event)
  return event
}

console.log('场景 1：缓解任务改动 → 旧会签失效')
{
  let s = JSON.parse(store['scapex-threat-model-v1'])
  const thr2 = s.threats.find((t: any) => t.id === 'thr-02')
  check('前置：thr-02 已通过', thr2.reviewStatus === 'approved')
  const activeBefore = decisionsForThreat(s.decisions, 'thr-02', 2)
  check('前置：thr-02 有 1 条生效意见', activeBefore.length === 1, `got ${activeBefore.length}`)

  const mit = s.mitigations.find((m: any) => m.id === 'mit-03')
  const result = commit(
    s,
    (next) => {
      const task = next.mitigations.find((m: any) => m.id === 'mit-03')
      task.status = 'done'
      task.revision = next.currentRevision + 1
      applyChainEvent(next, {
        source: 'mitigation',
        sourceId: 'mit-03',
        summary: '缓解任务「轮换对象存储访问密钥」变更（状态）',
        changedFields: ['状态'],
        affectedThreatIds: [task.threatId],
      })
    },
    { action: 'save_mitigation', entityId: 'mit-03', title: 'test', payload: clone(mit) },
  )
  check('提交成功', result.ok)
  if (result.ok) {
    s = result.state
    const t2 = s.threats.find((t: any) => t.id === 'thr-02')
    check('thr-02 回到 in_review', t2.reviewStatus === 'in_review', t2.reviewStatus)
    check('thr-02 revision 升到 3', t2.revision === 3, String(t2.revision))
    const old = s.decisions.find((d: any) => d.id === 'dec-02')
    check('旧意见 dec-02 标记 invalidated', old.status === 'invalidated')
    check('旧意见内容保留', old.comment.includes('密钥轮换'))
    check('旧意见记录失效原因', typeof old.invalidationReason === 'string')
    check('链事件已登记', s.chainEvents[0].source === 'mitigation' && s.chainEvents[0].revision === 3)
    check('链事件记录作废意见 id', s.chainEvents[0].invalidatedDecisionIds.includes('dec-02'))
    const scope = pendingInvalidationScope(s)
    check('失效范围包含 thr-02', scope.some((e) => e.threatId === 'thr-02'))
    const thr01Entry = scope.find((e) => e.threatId === 'thr-01')
    check('失效范围同时包含仍在会签的 thr-01', Boolean(thr01Entry))
    const t2entry = scope.find((e) => e.threatId === 'thr-02')
    check('失效范围条目记录作废意见数=1', t2entry?.invalidatedDecisionCount === 1)
    // 未受影响的 thr-03 决议 dec-03 仍 active
    check('thr-03 的 dec-03 仍生效', s.decisions.find((d: any) => d.id === 'dec-03').status === 'active')
    store['scapex-threat-model-v1'] = JSON.stringify(s)
  }
}

console.log('场景 2：证据改动 → 经控制传播到引用控制的威胁')
{
  let s = JSON.parse(store['scapex-threat-model-v1'])
  // ev-02 属于 ctl-02；ctl-02 被 thr-02 引用
  const result = commit(s, (next) => {
    const ev = next.evidence.find((e: any) => e.id === 'ev-02')
    ev.valid = true
    ev.revision = next.currentRevision + 1
    const affected = next.threats
      .filter((t: any) => t.controlIds.includes('ctl-02'))
      .map((t: any) => t.id)
    applyChainEvent(next, {
      source: 'evidence',
      sourceId: 'ev-02',
      summary: '控制证据「数据库透明加密配置快照」变更（证据有效性）',
      changedFields: ['证据有效性'],
      affectedThreatIds: affected,
    })
  })
  check('提交成功', result.ok)
  if (result.ok) {
    s = result.state
    check('链版本到 4', s.currentRevision === 4, String(s.currentRevision))
    const t2 = s.threats.find((t: any) => t.id === 'thr-02')
    check('thr-02 仍在 in_review', t2.reviewStatus === 'in_review')
    check('事件 affectedThreatIds 含 thr-02', s.chainEvents[0].affectedThreatIds.includes('thr-02'))
    store['scapex-threat-model-v1'] = JSON.stringify(s)
  }
}

console.log('场景 3：风险值改动 → 引用该风险的威胁失效')
{
  let s = JSON.parse(store['scapex-threat-model-v1'])
  const result = commit(s, (next) => {
    const risk = next.risks.find((r: any) => r.id === 'risk-03')
    risk.impact = 5
    risk.revision = next.currentRevision + 1
    const affected = next.threats.filter((t: any) => t.riskIds.includes('risk-03')).map((t: any) => t.id)
    applyChainEvent(next, {
      source: 'risk',
      sourceId: 'risk-03',
      summary: '风险值「R-003 敏感数据超范围导出」变更（影响）',
      changedFields: ['影响'],
      affectedThreatIds: affected,
    })
  })
  check('提交成功', result.ok)
  if (result.ok) {
    s = result.state
    const t3 = s.threats.find((t: any) => t.id === 'thr-03')
    check('thr-03 回到 in_review', t3.reviewStatus === 'in_review')
    const old = s.decisions.find((d: any) => d.id === 'dec-03')
    check('dec-03 被作废', old.status === 'invalidated')
    store['scapex-threat-model-v1'] = JSON.stringify(s)
  }
}

console.log('场景 4：两窗口并发 → 后保存方看到冲突，未覆盖对方')
{
  let s = JSON.parse(store['scapex-threat-model-v1'])
  const tokenA = s.stateToken
  // 窗口 B 先提交：推进 mit-04 状态
  const stamped = simulateRemoteCommit(
    (state: any, event: any) => {
      const task = state.mitigations.find((m: any) => m.id === 'mit-04')
      task.status = 'in_progress'
      task.revision = event.revision
      state.threats.forEach((t: any) => {
        if (t.id !== 'thr-03') return
        t.revision = event.revision
        t.reviewStatus = 'in_review'
        state.decisions.forEach((d: any) => {
          if (d.threatId === 'thr-03' && d.status === 'active') {
            d.status = 'invalidated'
            d.invalidationEventId = event.id
            d.invalidationAt = event.createdAt
            d.invalidationReason = event.summary
          }
        })
      })
    },
    {
      revision: s.currentRevision + 1,
      source: 'remote',
      sourceId: 'mit-04',
      summary: '另一窗口将缓解任务「接入敏感导出行为监测」推进为 in_progress',
      changedFields: ['状态'],
      affectedThreatIds: ['thr-03'],
      invalidatedDecisionIds: [],
    },
  )
  check('远程窗口提交后 token 改变', stamped.stateToken !== tokenA)

  // 窗口 A 用旧 token 提交
  const result = commit(s, (next) => {
    const task = next.mitigations.find((m: any) => m.id === 'mit-01')
    task.status = 'done'
  })
  check('旧 token 提交被拒', !result.ok && result.reason === 'conflict')
  if (!result.ok && result.reason === 'conflict') {
    check('冲突返回对方版本', result.remoteState.currentRevision === stamped.currentRevision)
    const remoteTask = result.remoteState.mitigations.find((m: any) => m.id === 'mit-04')
    check('对方的处置（in_progress）保留', remoteTask.status === 'in_progress')
    // A 刷新到远程版本后，其改动确实没有写入
    const stored = JSON.parse(store['scapex-threat-model-v1'])
    const mit01 = stored.mitigations.find((m: any) => m.id === 'mit-01')
    check('A 的改动（mit-01 done）没有覆盖写入', mit01.status === 'in_progress')
    // 冲突字段对比
    const remote01 = stored.mitigations.find((m: any) => m.id === 'mit-01')
    const draft01 = { ...s.mitigations.find((m: any) => m.id === 'mit-01'), status: 'done' }
    const d = diffEntity(remote01, draft01)
    check('diffEntity 识别出 status 冲突', d.changedFields.includes('status'))
  }

  // 刷新后以新 token 重试 → 成功
  const refreshed = JSON.parse(store['scapex-threat-model-v1'])
  const retry = commit(refreshed, (next) => {
    const task = next.mitigations.find((m: any) => m.id === 'mit-01')
    task.status = 'done'
  })
  check('刷新后重试成功', retry.ok)
}

console.log('场景 5：写入失败 → 草稿留存，重启后可读回')
{
  let s = JSON.parse(store['scapex-threat-model-v1'])
  setFailNextWrite(true)
  const result = commit(
    s,
    (next) => {
      next.boundary.name = '改名测试'
    },
    { action: 'save_mitigation', entityId: 'mit-01', title: '失败草稿测试', payload: { id: 'mit-01', status: 'done' } },
  )
  check('写入失败被返回', !result.ok && result.reason === 'write_failure')
  const drafts = loadDrafts()
  check('草稿已持久化', drafts.length >= 1)
  const d = drafts[0]
  check('草稿记录基线版本', d.baseRevision === s.currentRevision)
  check('草稿记录失败原因', d.reason === 'write_failure')
  check('失败开关为一次性', (globalThis as any).localStorage.getItem('scapex-sim-fail-next-write') === null)
  // 模拟重启：重新读 drafts
  const afterRestart = loadDrafts()
  check('重启后草稿仍在', afterRestart.some((x) => x.id === d.id))
  const remaining = removeDraft(d.id)
  check('草稿可丢弃', !remaining.some((x) => x.id === d.id))
  // 正式状态未被污染
  const live = JSON.parse(store['scapex-threat-model-v1'])
  check('失败写入没有污染正式状态', live.boundary.name !== '改名测试')
}

console.log('场景 6：会签意见提交是链上保存，旧意见作废后不能再被计入')
{
  const s = JSON.parse(store['scapex-threat-model-v1'])
  const t2 = s.threats.find((t: any) => t.id === 'thr-02')
  // dec-02 已在场景1作废
  const dec02 = s.decisions.find((d: any) => d.id === 'dec-02')
  check('dec-02 已作废', dec02.status === 'invalidated')
  const current = decisionsForThreat(s.decisions, 'thr-02', t2.revision)
  check('decisionsForThreat 不返回作废意见', !current.some((d: any) => d.id === 'dec-02'))
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
