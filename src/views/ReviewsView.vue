<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import ProgressBar from 'primevue/progressbar'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import InvalidationScopePanel from '@/components/InvalidationScopePanel.vue'
import type { ActorRole, DecisionType, DraftPayload, Threat } from '@/models/domain'
import {
  decisionHistoryForThreat,
  decisionsForThreat,
  reviewProgress,
} from '@/services/selectors'
import { draftStore } from '@/services/drafts'
import { reasonText } from '@/services/versionChain'
import { useThreatModelStore } from '@/stores/threatModel'

const store = useThreatModelStore()
const toast = useToast()
const route = useRoute()
const selectedThreatId = ref('')
const decisionVisible = ref(false)

const roleOptions: { label: string; value: ActorRole; actor: string }[] = [
  { label: '开发负责人', value: 'development', actor: '赵恺' },
  { label: '安全负责人', value: 'security', actor: '王岚' },
  { label: '业务负责人', value: 'business', actor: '宋雨' },
]
const decisionOptions = [
  { label: '通过', value: 'approved' },
  { label: '接受条件', value: 'accept' },
  { label: '同意降级', value: 'degrade' },
  { label: '要求补证', value: 'evidence_required' },
  { label: '驳回', value: 'rejected' },
]

const form = reactive<{
  role: ActorRole
  decision: DecisionType
  actor: string
  comment: string
  threatId: string
}>({
  role: 'security',
  decision: 'approved',
  actor: '王岚',
  comment: '',
  threatId: '',
})

const latestVersion = computed(() => store.data.versions[0])
/** 待重新会签队列：优先统一版本链失效范围；其外仍处于审核中的威胁一并保留以便继续会签 */
const affectedThreats = computed<Threat[]>(() => {
  const queued = store.scope
    .map((item) => store.data.threats.find((threat) => threat.id === item.threatId))
    .filter((threat): threat is Threat => Boolean(threat))
  const queuedIds = new Set(queued.map((threat) => threat.id))
  const reviewing = store.data.threats.filter(
    (threat) => threat.reviewStatus === 'in_review' && !queuedIds.has(threat.id),
  )
  return [...queued, ...reviewing]
})
const selectedThreat = computed(
  () => store.data.threats.find((threat) => threat.id === selectedThreatId.value) ?? null,
)
const selectedScope = computed(
  () => store.scope.find((item) => item.threatId === selectedThreatId.value) ?? null,
)
const currentDecisions = computed(() =>
  selectedThreat.value
    ? decisionsForThreat(store.data.decisions, selectedThreat.value.id, selectedThreat.value)
    : [],
)
const historyDecisions = computed(() =>
  selectedThreat.value
    ? decisionHistoryForThreat(store.data.decisions, selectedThreat.value.id)
    : [],
)

const statusForRole = (threat: Threat, role: ActorRole): DecisionType | 'pending' =>
  decisionsForThreat(store.data.decisions, threat.id, threat).find(
    (decision) => decision.role === role,
  )?.decision ?? 'pending'

const openDecision = (): void => {
  if (!selectedThreat.value) return
  form.threatId = selectedThreat.value.id
  form.comment = ''
  form.role = 'security'
  form.actor = '王岚'
  form.decision = 'approved'
  decisionVisible.value = true
}

const changeRole = (): void => {
  form.actor = roleOptions.find((item) => item.value === form.role)?.actor ?? form.actor
}

const submitDecision = (): void => {
  if (!selectedThreat.value) return
  if (!form.comment.trim()) {
    toast.add({ severity: 'error', summary: '校验失败', detail: '会签意见不能为空', life: 3000 })
    return
  }
  const outcome = store.submitDecision(
    selectedThreat.value.id,
    form.role,
    form.decision,
    form.actor,
    form.comment,
    {
      kind: 'decision',
      title: `${selectedThreat.value.code} 会签意见`,
      route: '/reviews',
      payload: { ...form },
      contextId: selectedThreat.value.id,
    },
  )
  if (outcome.ok) {
    decisionVisible.value = false
    toast.add({ severity: 'success', summary: '会签意见已提交', detail: '审核状态已重新计算', life: 2500 })
    return
  }
  decisionVisible.value = false
  toast.add({
    severity: outcome.conflict ? 'warn' : 'error',
    summary: outcome.conflict ? '并发冲突，意见未覆盖对方版本' : '写入失败，意见已存为草稿',
    detail: outcome.conflict
      ? '请在冲突窗口查看对方版本，草稿恢复后基于最新版本重提。'
      : outcome.error ?? '存储不可用，可从顶部草稿条恢复。',
    life: 4000,
  })
}

const decisionLabel = (decision: DecisionType | 'pending'): string =>
  decision === 'pending'
    ? '待提交'
    : decisionOptions.find((item) => item.value === decision)?.label ?? decision

const validityLabel = (validity: string): string => {
  if (validity === 'invalidated') return '旧版本意见 · 已失效 · 只读'
  if (validity === 'superseded') return '已被新意见覆盖 · 只读'
  return '当前生效'
}

const restoreDraft = (draft: DraftPayload): void => {
  const payload = draft.payload as typeof form
  selectedThreatId.value = payload.threatId
  Object.assign(form, payload)
  decisionVisible.value = true
  toast.add({
    severity: 'info',
    summary: '已恢复会签草稿',
    detail: '内容已回填，请基于当前最新版本确认后重新提交。',
    life: 3500,
  })
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = draftStore.on('decision', restoreDraft)
  const pending = draftStore.takePending('decision')
  if (pending) {
    restoreDraft(pending)
    draftStore.remove(pending.id)
  }
  const threatParam = route.query.threat
  if (typeof threatParam === 'string') selectedThreatId.value = threatParam
  else if (!selectedThreatId.value) selectedThreatId.value = affectedThreats.value[0]?.id ?? ''
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="受影响范围"
      title="逐项会签中心"
      description="统一版本链：威胁引用的缓解任务、控制证据或风险值一改动，旧会签意见立即失效并保留只读，威胁回到待重新会签。"
    />

    <section class="version-context">
      <div>
        <span>审核基线</span>
        <strong>{{ latestVersion?.label ?? '尚未建立版本' }}</strong>
      </div>
      <div>
        <span>待重新会签</span>
        <strong>{{ affectedThreats.length }} 条</strong>
      </div>
      <div>
        <span>失效旧意见</span>
        <strong>
          {{ store.data.decisions.filter((decision) => decision.validity === 'invalidated').length }} 条
        </strong>
      </div>
    </section>

    <div class="review-board">
      <section class="review-list">
        <article
          v-for="threat in affectedThreats"
          :key="threat.id"
          class="review-card"
          :class="{ selected: selectedThreatId === threat.id, invalidated: threat.invalidationPending }"
          @click="selectedThreatId = threat.id"
        >
          <div class="review-card-head">
            <div>
              <span class="mono">{{ threat.code }}</span>
              <h2>{{ threat.title }}</h2>
            </div>
            <StatusTag value="in_review" kind="review" />
          </div>
          <div v-if="threat.invalidationPending" class="invalidation-reason">
            <i class="pi pi-arrow-circle-up"></i>
            因
            <strong>{{ threat.lastInvalidationReason ? reasonText(threat.lastInvalidationReason) : '' }}
              变更</strong>
            回到待重新会签
            <time v-if="threat.lastInvalidatedAt">
              · {{ new Date(threat.lastInvalidatedAt).toLocaleString('zh-CN') }}
            </time>
          </div>
          <div v-else class="invalidation-reason pending-only">
            <i class="pi pi-clock"></i>
            <span>等待三方会签提交</span>
          </div>
          <div class="role-grid">
            <div v-for="role in roleOptions" :key="role.value" class="role-state">
              <span>{{ role.label }}</span>
              <strong :class="{ pending: statusForRole(threat, role.value) === 'pending' }">
                {{ decisionLabel(statusForRole(threat, role.value)) }}
              </strong>
            </div>
          </div>
          <ProgressBar
            :value="reviewProgress(decisionsForThreat(store.data.decisions, threat.id, threat))"
            :show-value="false"
            class="review-progress"
          />
        </article>
        <div v-if="affectedThreats.length === 0" class="empty-state list-empty">
          当前没有待重新会签的威胁，所有会签意见均与其引用的缓解/证据/风险一致。
        </div>
      </section>

      <aside class="decision-panel">
        <template v-if="selectedThreat">
          <div class="decision-head">
            <div>
              <span class="mono">{{ selectedThreat.code }}</span>
              <h2>{{ selectedThreat.title }}</h2>
            </div>
            <StatusTag :value="selectedThreat.reviewStatus" kind="review" />
          </div>
          <div v-if="selectedScope" class="scope-banner">
            <i class="pi pi-info-circle"></i>
            <span>
              {{ selectedScope.invalidatedDecisionCount }} 条旧会签意见因
              <strong>{{ selectedScope.reasons.map(reasonText).join('、') }}</strong>
              变更失效，下方留档仅供查看。
            </span>
          </div>
          <p class="decision-description">{{ selectedThreat.description }}</p>
          <Button label="提交会签意见" icon="pi pi-pencil" @click="openDecision" />

          <section class="decision-history">
            <h3>当前版本会签意见（生效中）</h3>
            <article v-for="decision in currentDecisions" :key="decision.id" class="decision-entry active-entry">
              <div>
                <strong>{{ decision.actor }}</strong>
                <span>{{ roleOptions.find((role) => role.value === decision.role)?.label }}</span>
              </div>
              <StatusTag :value="decision.decision" kind="review" />
              <p>{{ decision.comment }}</p>
              <time>{{ new Date(decision.createdAt).toLocaleString('zh-CN') }}</time>
            </article>
            <div v-if="currentDecisions.length === 0" class="empty-state">
              基准变更后尚无新生效意见，旧意见已全部失效。
            </div>

            <h3 class="archive-title">历史会签意见（留档 · 只读）</h3>
            <article
              v-for="decision in historyDecisions.filter((item) => item.validity !== 'active')"
              :key="decision.id"
              class="decision-entry archived-entry"
            >
              <div>
                <strong>{{ decision.actor }}</strong>
                <span>{{ roleOptions.find((role) => role.value === decision.role)?.label }}</span>
              </div>
              <span class="archived-badge">{{ validityLabel(decision.validity) }}</span>
              <p>{{ decision.comment }}</p>
              <time>
                {{ new Date(decision.createdAt).toLocaleString('zh-CN') }}
                <template v-if="decision.invalidatedAt">
                  · {{ validityLabel(decision.validity) }}于 {{ new Date(decision.invalidatedAt).toLocaleString('zh-CN') }}
                </template>
              </time>
            </article>
            <div
              v-if="historyDecisions.filter((item) => item.validity !== 'active').length === 0"
              class="empty-state"
            >
              暂无已失效或被覆盖的历史意见。
            </div>
          </section>
        </template>
        <div v-else class="empty-state">从左侧选择一条待重新会签的威胁。</div>
      </aside>
    </div>

    <InvalidationScopePanel class="shared-scope" :selectable="false" />

    <Dialog v-model:visible="decisionVisible" header="提交会签意见" modal :style="{ width: '620px' }">
      <div class="editor-form">
        <div class="field">
          <label>会签角色</label>
          <Select
            v-model="form.role"
            :options="roleOptions"
            option-label="label"
            option-value="value"
            @change="changeRole"
          />
        </div>
        <div class="field">
          <label>会签人</label>
          <InputText v-model="form.actor" />
        </div>
        <div class="field field-wide">
          <label>意见类型</label>
          <Select
            v-model="form.decision"
            :options="decisionOptions"
            option-label="label"
            option-value="value"
          />
        </div>
        <div class="field field-wide">
          <label>意见与条件</label>
          <Textarea
            v-model="form.comment"
            rows="5"
            placeholder="通过、降级、接受或补证都需要写明具体条件"
          />
        </div>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" outlined @click="decisionVisible = false" />
        <Button label="提交意见" icon="pi pi-check" @click="submitDecision" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.version-context {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe4eb;
  border-radius: 6px;
  background: #dfe4eb;
}

.version-context > div {
  display: grid;
  gap: 7px;
  padding: 14px 16px;
  background: #fff;
}

.version-context span {
  color: #717c8f;
  font-size: 11px;
}

.review-board {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(390px, 0.75fr);
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}

.review-list {
  display: grid;
  gap: 12px;
}

.list-empty {
  padding: 28px 16px;
  border: 1px dashed #d5dbe4;
  border-radius: 7px;
  background: #fff;
}

.review-card {
  padding: 16px;
  border: 1px solid #dde2ea;
  border-radius: 7px;
  background: #fff;
  cursor: pointer;
}

.review-card.invalidated {
  border-color: #e7d6c2;
  border-left: 3px solid #d97706;
}

.review-card:hover,
.review-card.selected {
  border-color: #7898bb;
  box-shadow: 0 0 0 1px rgba(70, 108, 150, 0.1);
}

.review-card.invalidated.selected,
.review-card.invalidated:hover {
  border-color: #d97706;
  box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.15);
}

.review-card-head,
.decision-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
}

.review-card h2,
.decision-head h2 {
  margin: 6px 0 0;
  font-size: 16px;
}

.invalidation-reason {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  color: #8a5a12;
  font-size: 11px;
}

.invalidation-reason i {
  color: #d97706;
}

.invalidation-reason time {
  color: #a9916f;
}

.invalidation-reason.pending-only {
  color: #717c8f;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.role-state {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid #e2e6ec;
  border-radius: 5px;
  background: #f9fafb;
}

.role-state span {
  color: #737e91;
  font-size: 10px;
}

.role-state strong {
  color: #2e684f;
  font-size: 11px;
}

.role-state strong.pending {
  color: #a05a00;
}

.review-progress {
  height: 4px;
  margin-top: 14px;
}

.decision-panel {
  position: sticky;
  top: 82px;
  padding: 18px;
  border: 1px solid #dde2ea;
  border-radius: 7px;
  background: #fff;
}

.scope-banner {
  display: flex;
  gap: 9px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid #f0d9b8;
  border-radius: 5px;
  color: #7a5520;
  background: #fff8ee;
  font-size: 12px;
  line-height: 1.6;
}

.scope-banner i {
  margin-top: 3px;
  color: #d97706;
}

.decision-description {
  margin: 14px 0 18px;
  color: #59657a;
  font-size: 13px;
  line-height: 1.65;
}

.decision-history {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid #e5e9ef;
}

.decision-history h3 {
  margin: 0 0 12px;
  font-size: 13px;
}

.archive-title {
  margin-top: 20px !important;
  color: #8a93a4;
}

.decision-entry {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 11px 0;
  border-bottom: 1px solid #eef0f3;
}

.archived-entry {
  opacity: 0.72;
  background: #fafbfc;
  padding: 11px;
  border-bottom: 0;
  border-radius: 5px;
  margin-bottom: 8px;
}

.decision-entry > div {
  display: grid;
  gap: 3px;
}

.decision-entry span,
.decision-entry time {
  color: #7a8496;
  font-size: 10px;
}

.decision-entry p {
  grid-column: 1 / -1;
  margin: 0;
  color: #566176;
  font-size: 12px;
  line-height: 1.5;
}

.archived-badge {
  padding: 2px 8px;
  border-radius: 4px;
  color: #a23a34 !important;
  background: #fbe6e4;
  font-weight: 700;
}

.shared-scope {
  margin-top: 16px;
}
</style>
