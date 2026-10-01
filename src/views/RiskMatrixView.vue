<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { Risk } from '@/models/domain'
import { resumeRequest } from '@/composables/useDraftResume'
import { riskLevel, riskScore } from '@/services/selectors'
import { useThreatModelStore } from '@/stores/threatModel'

const store = useThreatModelStore()
const toast = useToast()
const route = useRoute()
const acceptanceVisible = ref(false)
const riskEditorVisible = ref(false)
const selectedRiskId = ref('')
const acceptanceForm = reactive({
  expiresAt: '',
  condition: '',
})
const riskForm = reactive<Risk>({
  id: '',
  code: '',
  title: '',
  likelihood: 3,
  impact: 3,
  status: 'open',
  owner: '',
})

const likelihoodOptions = [1, 2, 3, 4, 5].map((value) => ({ label: `${value}`, value: value as 1 | 2 | 3 | 4 | 5 }))
const impactOptions = likelihoodOptions

const likelihoods = [5, 4, 3, 2, 1] as const
const impacts = [1, 2, 3, 4, 5] as const

const risksAt = (likelihood: number, impact: number): Risk[] =>
  store.data.risks.filter(
    (risk) => risk.likelihood === likelihood && risk.impact === impact && risk.status !== 'closed',
  )

const selectedRisk = computed(
  () => store.data.risks.find((risk) => risk.id === selectedRiskId.value) ?? null,
)

const openAcceptance = (risk: Risk): void => {
  selectedRiskId.value = risk.id
  acceptanceForm.expiresAt = risk.acceptanceExpiresAt ?? ''
  acceptanceForm.condition = risk.acceptanceCondition ?? ''
  acceptanceVisible.value = true
}

const openRiskEditor = (risk: Risk): void => {
  Object.assign(riskForm, structuredClone(risk))
  riskEditorVisible.value = true
}

const submitAcceptance = (): void => {
  if (!acceptanceForm.expiresAt || !acceptanceForm.condition.trim()) {
    toast.add({ severity: 'error', summary: '校验失败', detail: '到期日与接受条件不能为空', life: 3000 })
    return
  }
  const outcome = store.acceptRisk(selectedRiskId.value, acceptanceForm.expiresAt, acceptanceForm.condition)
  if (!outcome.ok) {
    toast.add({
      severity: 'error',
      summary: outcome.reason === 'conflict' ? '版本冲突，风险接受未覆盖对方版本' : '写入失败，草稿已保留',
      detail: '可在顶部“草稿”中恢复。',
      life: 4000,
    })
    return
  }
  acceptanceVisible.value = false
  toast.add({ severity: 'success', summary: '风险接受已记录', detail: '已写入审计轨迹与版本链', life: 2500 })
}

const closeRisk = (risk: Risk): void => {
  const outcome = store.closeRisk(risk.id)
  if (!outcome.ok) {
    toast.add({
      severity: 'error',
      summary: outcome.reason === 'conflict' ? '版本冲突，关闭操作已中止' : '写入失败，草稿已保留',
      detail: '可在顶部“草稿”中恢复。',
      life: 4000,
    })
  }
}

const saveRiskForm = (): void => {
  if (!riskForm.title.trim() || !riskForm.owner.trim()) {
    toast.add({ severity: 'error', summary: '校验失败', detail: '风险标题与负责人不能为空', life: 3000 })
    return
  }
  const outcome = store.saveRisk({ ...riskForm })
  if (!outcome.ok) {
    toast.add({
      severity: 'error',
      summary: outcome.reason === 'conflict' ? '版本冲突，风险值修改未覆盖对方版本' : '写入失败，草稿已保留',
      detail: '引用该风险的威胁会按版本链重新会签，可在草稿中恢复编辑。',
      life: 4000,
    })
    return
  }
  riskEditorVisible.value = false
  toast.add({
    severity: 'success',
    summary: '风险值已保存',
    detail: '被引用威胁的旧会签意见已作废，回到待重新会签。',
    life: 3000,
  })
}

watch(resumeRequest, (request) => {
  if (!request || route.path !== '/risks') return
  const { draft } = request
  if (draft.action === 'save_risk' && draft.payload) {
    Object.assign(riskForm, draft.payload as Risk)
    riskEditorVisible.value = true
  } else if (draft.action === 'accept_risk' && draft.payload) {
    const payload = draft.payload as { riskId: string; expiresAt: string; condition: string }
    selectedRiskId.value = payload.riskId
    acceptanceForm.expiresAt = payload.expiresAt
    acceptanceForm.condition = payload.condition
    acceptanceVisible.value = true
  } else if (draft.action === 'close_risk' && draft.payload) {
    const payload = draft.payload as { riskId: string }
    const risk = store.data.risks.find((item) => item.id === payload.riskId)
    if (risk) closeRisk(risk)
  }
})
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="风险管理"
      title="风险矩阵与接受"
      description="按可能性和影响评估开放风险，检查控制失效与接受过期，并记录接受条件。"
    />

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">5 × 5 风险矩阵</h2>
        <span class="muted">评分 = 可能性 × 影响</span>
      </div>
      <div class="matrix-wrap">
        <div class="matrix-grid">
          <div class="matrix-axis">可能性 \ 影响</div>
          <div v-for="impact in impacts" :key="`head-${impact}`" class="matrix-axis">
            影响 {{ impact }}
          </div>
          <template v-for="likelihood in likelihoods" :key="likelihood">
            <div class="matrix-axis">可能 {{ likelihood }}</div>
            <div
              v-for="impact in impacts"
              :key="`${likelihood}-${impact}`"
              class="matrix-cell"
              :class="`level-${riskLevel(likelihood * impact) === 'critical' ? 5 : riskLevel(likelihood * impact) === 'high' ? 4 : riskLevel(likelihood * impact) === 'medium' ? 3 : 2}`"
            >
              <button
                v-for="risk in risksAt(likelihood, impact)"
                :key="risk.id"
                type="button"
                class="matrix-risk"
                @click="selectedRiskId = risk.id"
              >
                <strong>{{ risk.code }}</strong>
                {{ risk.title }}
              </button>
              <span v-if="risksAt(likelihood, impact).length === 0" class="cell-score">
                {{ likelihood * impact }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </section>

    <div class="risk-layout">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">开放风险</h2>
        </div>
        <DataTable :value="store.data.risks.filter((risk) => risk.status !== 'closed')" size="small" stripedRows>
          <Column field="code" header="编号" style="width: 90px" />
          <Column field="title" header="风险" />
          <Column header="评分" style="width: 100px">
            <template #body="{ data }">
              <strong>{{ riskScore(data) }}</strong>
              <StatusTag :value="riskLevel(riskScore(data))" kind="severity" class="risk-tag" />
            </template>
          </Column>
          <Column field="owner" header="负责人" style="width: 135px" />
          <Column header="状态" style="width: 100px">
            <template #body="{ data }">
              <StatusTag :value="data.status" kind="status" />
            </template>
          </Column>
          <Column header="操作" style="width: 230px">
            <template #body="{ data }">
              <Button label="编辑风险值" size="small" text @click="openRiskEditor(data)" />
              <Button label="接受" size="small" text @click="openAcceptance(data)" />
              <Button label="关闭" size="small" text @click="closeRisk(data)" />
            </template>
          </Column>
        </DataTable>
      </section>

      <aside class="validation-panel">
        <h2>风险校验</h2>
        <article
          v-for="issue in store.issues.filter((item) => ['risk_acceptance_expired', 'control_failed', 'missing_evidence'].includes(item.kind))"
          :key="issue.id"
          class="validation-item"
          :class="{ error: issue.severity === 'critical' || issue.severity === 'high' }"
        >
          <i class="validation-dot"></i>
          <div class="validation-copy">
            <strong>{{ issue.title }}</strong>
            <p>{{ issue.detail }}</p>
          </div>
          <StatusTag :value="issue.severity" kind="severity" />
        </article>
      </aside>
    </div>

    <Dialog v-model:visible="acceptanceVisible" header="记录风险接受" modal :style="{ width: '620px' }">
      <div v-if="selectedRisk" class="selected-risk">
        <strong>{{ selectedRisk.code }} · {{ selectedRisk.title }}</strong>
        <span>评分 {{ riskScore(selectedRisk) }} / 25</span>
      </div>
      <div class="acceptance-form">
        <div class="field">
          <label>接受到期日</label>
          <InputText v-model="acceptanceForm.expiresAt" type="date" />
        </div>
        <div class="field">
          <label>接受条件</label>
          <Textarea
            v-model="acceptanceForm.condition"
            rows="4"
            placeholder="说明补偿控制、复核频率和终止条件"
          />
        </div>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" outlined @click="acceptanceVisible = false" />
        <Button label="确认接受" icon="pi pi-check" @click="submitAcceptance" />
      </template>
    </Dialog>

    <Dialog v-model:visible="riskEditorVisible" header="编辑风险值（触发版本链重新会签）" modal :style="{ width: '620px' }">
      <div class="editor-form">
        <div class="field field-wide">
          <label>风险编号</label>
          <InputText v-model="riskForm.code" />
        </div>
        <div class="field field-wide">
          <label>风险标题</label>
          <InputText v-model="riskForm.title" />
        </div>
        <div class="field">
          <label>可能性（1-5）</label>
          <Select v-model="riskForm.likelihood" :options="likelihoodOptions" option-label="label" option-value="value" />
        </div>
        <div class="field">
          <label>影响（1-5）</label>
          <Select v-model="riskForm.impact" :options="impactOptions" option-label="label" option-value="value" />
        </div>
        <div class="field field-wide">
          <label>负责人</label>
          <InputText v-model="riskForm.owner" />
        </div>
        <div class="field field-wide">
          <div class="score-preview">
            风险值 = {{ riskForm.likelihood }} × {{ riskForm.impact }} =
            <strong>{{ riskScore(riskForm) }}</strong>
            <StatusTag :value="riskLevel(riskScore(riskForm))" kind="severity" />
          </div>
        </div>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" outlined @click="riskEditorVisible = false" />
        <Button label="保存风险值" icon="pi pi-check" @click="saveRiskForm" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.matrix-wrap {
  overflow-x: auto;
  padding: 16px;
}

.matrix-grid {
  min-width: 860px;
}

.matrix-risk {
  width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 4px;
  color: #273247;
  background: #fff;
  font-size: 10px;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
}

.matrix-risk strong {
  display: block;
  margin-bottom: 2px;
}

.cell-score {
  margin: auto;
  color: #a1a9b6;
  font-size: 10px;
}

.risk-layout {
  display: grid;
  grid-template-columns: minmax(700px, 1.4fr) minmax(320px, 0.6fr);
  gap: 16px;
  align-items: start;
}

.validation-panel {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid #dde2ea;
  border-radius: 7px;
  background: #fff;
}

.validation-panel h2 {
  margin: 0 0 2px;
  font-size: 16px;
}

.risk-tag {
  margin-left: 7px;
}

.selected-risk {
  display: flex;
  justify-content: space-between;
  margin-bottom: 18px;
  padding: 12px;
  border: 1px solid #dde2ea;
  border-radius: 5px;
  background: #f8f9fb;
}

.selected-risk span {
  color: #6c7689;
  font-size: 12px;
}

.acceptance-form {
  display: grid;
  gap: 16px;
}

.score-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 5px;
  background: #f5f7fa;
  font-size: 13px;
}
</style>
