// 真实 Pinia store 端到端验证（localStorage 内存 shim）
import { setActivePinia, createPinia } from 'pinia'
import { createSeedState } from '../src/models/seed'
import { simulateRemoteCommit } from '../src/services/repository'
import { useThreatModelStore } from '../src/stores/threatModel'

const mem = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
}
;(globalThis as any).window = globalThis
;(globalThis as any).addEventListener = () => {}
;(globalThis as any).removeEventListener = () => {}

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name} ${detail}`)
  }
}

// 用干净 seed 初始化
const seed = createSeedState()
;(seed as any).stateToken = 'tok-base-1'
mem.set('scapex-threat-model-v1', JSON.stringify(seed))
mem.delete('scapex-threat-drafts-v1')

setActivePinia(createPinia())
const store = useThreatModelStore()

console.log('A. store 基本链路：推进缓解任务状态 → 旧会签作废')
{
  const t1 = store.data.threats.find((t) => t.id === 'thr-01')!
  check('初始 thr-01 in_review rev2', t1.reviewStatus === 'in_review' && t1.revision === 2)
  const r1 = store.updateMitigationStatus('mit-01', 'verifying')
  check('推进成功', r1.ok)
  const t1b = store.data.threats.find((t) => t.id === 'thr-01')!
  check('thr-01 revision=3', t1b.revision === 3, String(t1b.revision))
  check('thr-01 in_review', t1b.reviewStatus === 'in_review')
  const d1 = store.data.decisions.find((d) => d.id === 'dec-01')!
  check('dec-01 作废', d1.status === 'invalidated')
  check('作废原因已写入', d1.invalidationReason!.includes('缓解任务'))
  check('作废事件 id 已回填', Boolean(d1.invalidationEventId))
  const task = store.data.mitigations.find((m) => m.id === 'mit-01')!
  check('任务 revision=3', task.revision === 3)
}

console.log('B. 提交新会签意见 → 在 rev3 生效，全部通过后 approved')
{
  const roles = [
    ['security', '王岚'],
    ['development', '赵恺'],
    ['business', '宋雨'],
  ] as const
  for (const [role, actor] of roles) {
    const r = store.submitDecision('thr-01', role, 'approved', actor, `rev3 ${role} 同意`)
    check(`${role} 会签提交成功`, r.ok)
  }
  const t1 = store.data.threats.find((t) => t.id === 'thr-01')!
  check('三方通过后 thr-01 approved', t1.reviewStatus === 'approved', t1.reviewStatus)
}

console.log('C. 再次改动缓解任务 → rev3 会签全部作废，回 in_review')
{
  const r = store.updateMitigationStatus('mit-01', 'done')
  check('推进成功', r.ok)
  const t1 = store.data.threats.find((t) => t.id === 'thr-01')!
  check('thr-01 回到 in_review', t1.reviewStatus === 'in_review')
  check('thr-01 revision=4', t1.revision === 4)
  const active = store.data.decisions.filter(
    (d) => d.threatId === 'thr-01' && d.status === 'active',
  )
  check('rev3 三条意见全部作废', active.length === 0, `active=${active.length}`)
  const invalidated = store.data.decisions.filter((d) => d.threatId === 'thr-01' && d.status === 'invalidated')
  check('历史意见全部保留（4 条）', invalidated.length === 4, `got ${invalidated.length}`)
  check('每条作废意见都可查原因', invalidated.every((d) => d.invalidationReason && d.invalidationEventId))
}

console.log('D. 模拟另一窗口提交 → 本窗口保存冲突、草稿留存、未覆盖对方')
{
  const beforeToken = store.data.stateToken
  store.simulateRemoteChange()
  check('token 已变化（远程提交）', store.data.stateToken !== beforeToken)

  const remoteMit = store.data.mitigations.find((m) => m.id === 'mit-02')
  const remoteStatus = remoteMit?.status
  check('远程窗口推进了 mit-02', remoteStatus === 'in_progress', remoteStatus ?? '')

  // 本窗口尝试编辑 mit-01（基于过期状态），commit 必须冲突
  const draftBefore = store.drafts.length
  const local = JSON.parse(JSON.stringify(store.data.mitigations.find((m) => m.id === 'mit-01')))
  local.title = '本地窗口改的标题'
  // 注意：store.data 此时已被 simulateRemoteChange 刷新，所以这里人为把 baseToken 改老来模拟"窗口里持有的旧表单"
  // 直接调用 saveTrackedEntity 走的是当前 token；要模拟过期 token，先把存储回退一版再改回来不现实，
  // 因此用另一种方式：远程再提交一次，而 store 持有的 token 是 simulateRemoteChange 后的，
  // 直接再次 simulateRemoteCommit 到存储，store.token 立刻过期。
  const r2token = store.data.stateToken
  const remote2 = simulateRemoteCommit(
    (s: any) => {
      const t = s.mitigations.find((m: any) => m.id === 'mit-03')
      if (t) t.status = 'done'
    },
    {
      revision: store.data.currentRevision + 1,
      source: 'remote',
      sourceId: 'mit-03',
      summary: '另一窗口完成密钥轮换验证',
      changedFields: ['状态'],
      affectedThreatIds: [],
      invalidatedDecisionIds: [],
    },
  )
  check('第二次远程提交成功', remote2.stateToken !== r2token)

  const result = store.saveEntity('mitigations', local)
  check('本地保存被判定冲突', !result.ok && result.reason === 'conflict')
  check('冲突后草稿数 +1', store.drafts.length === draftBefore + 1)
  const draft = store.drafts.find((d) => d.entityId === 'mit-01')
  check('草稿内容保留', draft?.payload && (draft.payload as any).title === '本地窗口改的标题')
  check('草稿基线版本已记录', typeof draft?.baseRevision === 'number')

  // store 已刷新到远程版本，对方的两次提交都在
  const mit02 = store.data.mitigations.find((m) => m.id === 'mit-02')
  const mit03 = store.data.mitigations.find((m) => m.id === 'mit-03')
  check('对方的 mit-02 处置保留', mit02?.status === 'in_progress')
  check('对方的 mit-03 处置保留', mit03?.status === 'done')
  // 本地改动没有写进去
  const mit01 = store.data.mitigations.find((m) => m.id === 'mit-01')
  check('本地标题修改未覆盖正式数据', mit01?.title !== '本地窗口改的标题')
}

console.log('E. 冲突后基于最新版本重试草稿 → 成功并删除草稿')
{
  const draft = store.drafts.find((d) => d.entityId === 'mit-01')!
  // 模拟用户在冲突对话框点“基于最新版本重试保存”
  const outcome = store.retryDraft(draft.id)
  check('重试成功', outcome.ok)
  check('成功后草稿被删除', !store.drafts.some((d) => d.id === draft.id))
  const mit01 = store.data.mitigations.find((m) => m.id === 'mit-01')
  check('重试后标题写入', mit01?.title === '本地窗口改的标题')
}

console.log('F. 创建版本：仅圈定威胁回到会签，其余保持')
{
  // 先把 thr-02 保持 approved（seed 中是 approved，未被前面操作影响）
  const t2 = store.data.threats.find((t) => t.id === 'thr-02')!
  check('前置 thr-02 approved', t2.reviewStatus === 'approved')
  const result = store.createVersion('v1.x 测试版本', '只圈 thr-01', ['thr-01'])
  check('版本创建成功', result.ok)
  check('快照 id 存在', Boolean(result.snapshot?.id))
  const t1 = store.data.threats.find((t) => t.id === 'thr-01')!
  check('thr-01 in_review', t1.reviewStatus === 'in_review')
  const t2after = store.data.threats.find((t) => t.id === 'thr-02')!
  check('thr-02 仍 approved', t2after.reviewStatus === 'approved')
  const snap = store.data.versions[0]
  check('快照记录链事件 id', Boolean(snap.chainEventId))
  check('快照 affectedThreatIds 仅 thr-01', JSON.stringify(snap.affectedThreatIds) === JSON.stringify(['thr-01']))
}

console.log('G. 风险值编辑 → 引用威胁的会签失效')
{
  const before = store.data.threats.find((t) => t.id === 'thr-02')?.revision
  const risk = JSON.parse(JSON.stringify(store.data.risks.find((r) => r.id === 'risk-02')))
  risk.impact = 5
  const result = store.saveEntity('risks', risk)
  check('风险保存成功', result.ok)
  const t2 = store.data.threats.find((t) => t.id === 'thr-02')!
  check('thr-02 回到 in_review', t2.reviewStatus === 'in_review')
  check('thr-02 revision 随链版本前进', t2.revision === store.data.currentRevision && t2.revision > (before ?? 0),
    `t2.rev=${t2.revision} before=${before} chain=${store.data.currentRevision}`)
  const riskAfter = store.data.risks.find((r) => r.id === 'risk-02')!
  check('风险实体 revision 同步到链版本', riskAfter.revision === store.data.currentRevision)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
