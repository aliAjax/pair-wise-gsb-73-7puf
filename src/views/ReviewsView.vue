<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import ProgressBar from 'primevue/progressbar'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import InvalidationScopePanel from '@/components/InvalidationScopePanel.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { ActorRole, DecisionType, Threat } from '@/models/domain'
import { resumeRequest } from '@/composables/useDraftResume'
import {
  decisionHistoryForThreat,
  decisionsForThreat,
  pendingInvalidationScope,
  reviewProgress,
} from '@/services/selectors'
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
}>({
  role: 'security',
  decision: 'approved',
  actor: '王岚',
  comment: '',
})

const latestVersion = computed(() => store.data.versions[0])
// 与版本比较页共用同一份失效范围计算
const invalidationScope = computed(() => pendingInvalidationScope(store.data))
const affectedThreats = computed(() =>
  invalidationScope.value
    .map((entry) => store.data.threats.find((threat) => threat.id === entry.threatId))
    .filter((threat): threat is Threat => Boolean(threat)),
)
const selectedThreat = computed(
  () => store.data.threats.find((threat) => threat.id === selectedThreatId.value) ?? null,
)
const currentDecisions = computed(() =>
  selectedThreat.value
    ? decisionsForThreat(
        store.data.decisions,
        selectedThreat.value.id,
        selectedThreat.value.revision,
      )
    : [],
)
const invalidatedDecisions = computed(() =>
  selectedThreat.value
    ? decisionHistoryForThreat(store.data.decisions, selectedThreat.value.id).filter(
        (decision) => decision.status === 'invalidated',
      )
    : [],
)
const selectedScopeEntry = computed(() =>
  invalidationScope.value.find((entry) => entry.threatId === selectedThreatId.value),
)

const statusForRole = (threat: Threat, role: ActorRole): DecisionType | 'pending' =>
  decisionsForThreat(store.data.decisions, threat.id, threat.revision).find(
    (decision) => decision.role === role,
  )?.decision ?? 'pending'

const openDecision = (): void => {
  if (!selectedThreat.value) return
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
  const threatId = selectedThreat.value.id
  const payload = {
    role: form.role,
    decision: form.decision,
    actor: form.actor,
    comment: form.comment,
  }
  const outcome = store.submitDecision(
    threatId,
    payload.role,
    payload.decision,
    payload.actor,
    payload.comment,
  )
  if (!outcome.ok) {
    decisionVisible.value = true
    toast.add({
      severity: 'error',
      summary: outcome.reason === 'conflict' ? '版本冲突，会签意见未覆盖对方提交' : '写入失败，意见草稿已保留',
      detail: '对方刚更新了处置或已提交会签，可从草稿恢复。',
      life: 4000,
    })
    return
  }
  decisionVisible.value = false
  toast.add({ severity: 'success', summary: '会签意见已提交', detail: '审核状态已重新计算', life: 2500 })
}

const decisionLabel = (decision: DecisionType | 'pending'): string =>
  decision === 'pending'
    ? '待提交'
    : decisionOptions.find((item) => item.value === decision)?.label ?? decision

const roleLabel = (role: ActorRole): string =>
  roleOptions.find((item) => item.value === role)?.label ?? role

// 草稿恢复：会签意见写失败/冲突后回填表单
watch(resumeRequest, (request) => {
  if (!request || route.path !== '/reviews') return
  const { draft } = request
  if (draft.action !== 'submit_decision') return
  const payload = draft.payload as {
    threatId: string
    role: ActorRole
    decision: DecisionType
    actor: string
    comment: string
  }
  selectedThreatId.value = payload.threatId
  form.role = payload.role
  form.decision = payload.decision
  form.actor = payload.actor
  form.comment = payload.comment
  decisionVisible.value = true
  toast.add({ severity: 'info', summary: '已恢复会签意见草稿', detail: draft.title, life: 3000 })
})
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="受影响范围"
      title="逐项会签中心"
      :description="`链版本 v1.${store.data.currentRevision}：仅展示被缓解任务、控制证据或风险值变更打回、需要重新会签的威胁。`"
    />

    <section class="version-context">
      <div>
        <span>审核基线</span>
        <strong>{{ latestVersion?.label ?? '尚未建立版本' }}</strong>
      </div>
      <div>
        <span>待重新会签威胁</span>
        <strong>{{ invalidationScope.length }} 条</strong>
      </div>
      <div>
        <span>链版本</span>
        <strong>v1.{{ store.data.currentRevision }}</strong>
      </div>
    </section>

    <InvalidationScopePanel :scope="invalidationScope" class="scope-panel" />

    <div class="review-board">
      <section class="review-list">
        <article
          v-for="threat in affectedThreats"
          :key="threat.id"
          class="review-card"
          :class="{ selected: selectedThreatId === threat.id }"
          @click="selectedThreatId = threat.id"
        >
          <div class="review-card-head">
            <div>
              <span class="mono">{{ threat.code }}</span>
              <h2>{{ threat.title }}</h2>
            </div>
            <StatusTag :value="threat.reviewStatus" kind="review" />
          </div>
          <p v-if="invalidationScope.find((entry) => entry.threatId === threat.id)?.latestEvent" class="invalidate-reason">
            <i class="pi pi-sync"></i>
            {{ invalidationScope.find((entry) => entry.threatId === threat.id)?.latestEvent?.summary }}
          </p>
          <div class="role-grid">
            <div v-for="role in roleOptions" :key="role.value" class="role-state">
              <span>{{ role.label }}</span>
              <strong :class="{ pending: statusForRole(threat, role.value) === 'pending' }">
                {{ decisionLabel(statusForRole(threat, role.value)) }}
              </strong>
            </div>
          </div>
          <ProgressBar
            :value="reviewProgress(decisionsForThreat(store.data.decisions, threat.id, threat.revision))"
            :show-value="false"
            class="review-progress"
          />
        </article>
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
          <div v-if="selectedScopeEntry?.latestEvent" class="chain-reason">
            <i class="pi pi-sync"></i>
            <div>
              <strong>本版本失效原因</strong>
              <p>{{ selectedScopeEntry.latestEvent.summary }}</p>
              <span>{{ new Date(selectedScopeEntry.latestEvent.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
          </div>
          <p class="decision-description">{{ selectedThreat.description }}</p>
          <Button label="提交会签意见" icon="pi pi-pencil" @click="openDecision" />

          <section class="decision-history">
            <h3>当前版本（v1.{{ selectedThreat.revision }}）会签记录</h3>
            <article v-for="decision in currentDecisions" :key="decision.id" class="decision-entry">
              <div>
                <strong>{{ decision.actor }}</strong>
                <span>{{ roleLabel(decision.role) }}</span>
              </div>
              <StatusTag :value="decision.decision" kind="review" />
              <p>{{ decision.comment }}</p>
              <time>{{ new Date(decision.createdAt).toLocaleString('zh-CN') }}</time>
            </article>
            <div v-if="currentDecisions.length === 0" class="empty-state">尚未提交本版本会签意见。</div>
          </section>

          <section v-if="invalidatedDecisions.length" class="decision-history invalidated">
            <h3>
              <i class="pi pi-lock"></i>
              已作废旧会签（{{ invalidatedDecisions.length }} 条 · 只读保留）
            </h3>
            <article
              v-for="decision in invalidatedDecisions"
              :key="decision.id"
              class="decision-entry invalidated-entry"
            >
              <div>
                <strong>{{ decision.actor }}</strong>
                <span>{{ roleLabel(decision.role) }} · v1.{{ decision.revision }}</span>
              </div>
              <span class="invalidated-tag">已作废</span>
              <p>{{ decision.comment }}</p>
              <time>
                {{ new Date(decision.createdAt).toLocaleString('zh-CN') }} ·
                作废原因：{{ decision.invalidationReason ?? '引用的缓解/证据/风险已变更' }}
              </time>
            </article>
          </section>
        </template>
        <div v-else class="empty-state">从左侧选择一条待重新会签的威胁。</div>
      </aside>
    </div>

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
  margin-bottom: 16px;
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

.scope-panel {
  margin-bottom: 16px;
}

.review-board {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(390px, 0.75fr);
  gap: 16px;
  align-items: start;
}

.review-list {
  display: grid;
  gap: 12px;
}

.review-card {
  padding: 16px;
  border: 1px solid #dde2ea;
  border-radius: 7px;
  background: #fff;
  cursor: pointer;
}

.review-card:hover,
.review-card.selected {
  border-color: #7898bb;
  box-shadow: 0 0 0 1px rgba(70, 108, 150, 0.1);
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

.invalidate-reason {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: 5px;
  color: #8a5a17;
  background: #fdf6e9;
  font-size: 11px;
  line-height: 1.5;
}

.invalidate-reason i {
  margin-top: 3px;
}

.role-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 16px;
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

.chain-reason {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
  padding: 11px 12px;
  border-left: 3px solid #d97706;
  border-radius: 4px;
  background: #fdf8ef;
}

.chain-reason > i {
  margin-top: 3px;
  color: #b45309;
}

.chain-reason strong {
  font-size: 12px;
}

.chain-reason p {
  margin: 4px 0;
  color: #6f6250;
  font-size: 11px;
  line-height: 1.55;
}

.chain-reason span {
  color: #9a8a70;
  font-size: 10px;
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

.decision-history.invalidated {
  border-top-color: #ecd9b8;
}

.decision-history h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 12px;
  font-size: 13px;
}

.decision-history.invalidated h3 {
  color: #9a6a1c;
}

.decision-entry {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 11px 0;
  border-bottom: 1px solid #eef0f3;
}

.invalidated-entry {
  opacity: 0.72;
  background: repeating-linear-gradient(
    -45deg,
    transparent,
    transparent 9px,
    rgba(180, 130, 40, 0.04) 9px,
    rgba(180, 130, 40, 0.04) 18px
  );
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

.decision-entry time {
  line-height: 1.5;
}

.decision-entry p {
  grid-column: 1 / -1;
  margin: 0;
  color: #566176;
  font-size: 12px;
  line-height: 1.5;
}

.invalidated-tag {
  padding: 1px 8px;
  border-radius: 999px;
  color: #9a6a1c !important;
  background: #f6e8cf;
  font-weight: 700;
}
</style>
