<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import InvalidationScopePanel from '@/components/InvalidationScopePanel.vue'
import PageHeader from '@/components/PageHeader.vue'
import type { ChainEvent, VersionChange, VersionSnapshot } from '@/models/domain'
import { resumeRequest } from '@/composables/useDraftResume'
import {
  chainEventsBetween,
  compareSnapshots,
  invalidatedDecisionsBetween,
  pendingInvalidationScope,
} from '@/services/selectors'
import { useThreatModelStore } from '@/stores/threatModel'

const store = useThreatModelStore()
const toast = useToast()
const route = useRoute()
const fromVersionId = ref(store.data.versions[1]?.id ?? store.data.versions[0]?.id ?? '')
const toVersionId = ref(store.data.versions[0]?.id ?? '')
const createVisible = ref(false)
const createForm = reactive({
  label: '',
  notes: '',
  affectedThreatIds: [] as string[],
})

const fromVersion = computed(
  () => store.data.versions.find((version) => version.id === fromVersionId.value) ?? null,
)
const toVersion = computed(
  () => store.data.versions.find((version) => version.id === toVersionId.value) ?? null,
)
const difference = computed(() =>
  fromVersion.value && toVersion.value
    ? compareSnapshots(fromVersion.value, toVersion.value)
    : { added: [], removed: [], changed: [] },
)
// 与会签中心完全相同的失效范围
const invalidationScope = computed(() => pendingInvalidationScope(store.data))
const chainDiffs = computed<ChainEvent[]>(() =>
  chainEventsBetween(store.data.chainEvents, fromVersion.value, toVersion.value),
)
const invalidatedInRange = computed(() =>
  invalidatedDecisionsBetween(store.data, fromVersion.value, toVersion.value),
)

const entityName = (change: VersionChange): string => {
  if (change.category === '组件') {
    const item = store.data.components.find((entry) => entry.id === change.id)
    return item ? `${item.name} (${item.id})` : change.id
  }
  if (change.category === '数据流') {
    const item = store.data.flows.find((entry) => entry.id === change.id)
    return item ? `${item.name} (${item.id})` : change.id
  }
  if (change.category === '威胁') {
    const item = store.data.threats.find((entry) => entry.id === change.id)
    return item ? `${item.code} ${item.title} (${item.id})` : change.id
  }
  if (change.category === '控制') {
    const item = store.data.controls.find((entry) => entry.id === change.id)
    return item ? `${item.name} (${item.id})` : change.id
  }
  if (change.category === '风险') {
    const item = store.data.risks.find((entry) => entry.id === change.id)
    return item ? `${item.code} ${item.title} (${item.id})` : change.id
  }
  return change.id
}

const threatLabel = (id: string): string => {
  const threat = store.data.threats.find((item) => item.id === id)
  return threat ? `${threat.code} ${threat.title}` : id
}

const eventSourceLabel = (source: ChainEvent['source']): string =>
  ({
    threat: '威胁变更',
    mitigation: '缓解任务',
    evidence: '控制证据',
    risk: '风险值',
    version: '版本快照',
    remote: '另一窗口',
  })[source]

const openCreate = (): void => {
  createForm.label = `v1.${store.data.currentRevision + 1} 变更评审`
  createForm.notes = ''
  // 预填当前统一失效范围，与左侧会签中心看到的待办一致
  createForm.affectedThreatIds = invalidationScope.value.map((entry) => entry.threatId)
  createVisible.value = true
}

const createVersion = (): void => {
  if (!createForm.label.trim() || !createForm.notes.trim()) {
    toast.add({ severity: 'error', summary: '校验失败', detail: '版本名称和变更说明不能为空', life: 3000 })
    return
  }
  if (createForm.affectedThreatIds.length === 0) {
    toast.add({ severity: 'error', summary: '校验失败', detail: '至少选择一条受影响威胁', life: 3000 })
    return
  }
  const result = store.createVersion(
    createForm.label,
    createForm.notes,
    createForm.affectedThreatIds,
  )
  if (!result.ok) {
    createVisible.value = true
    toast.add({
      severity: 'error',
      summary: result.reason === 'conflict' ? '版本冲突：对方刚提交，版本号需顺延' : '写入失败，版本草稿已保留',
      detail: '草稿保留在顶部“草稿”中，可恢复后重新创建。',
      life: 4000,
    })
    return
  }
  const snapshot = result.snapshot
  fromVersionId.value = toVersionId.value
  if (snapshot) toVersionId.value = snapshot.id
  createVisible.value = false
  toast.add({ severity: 'success', summary: '版本已创建', detail: '受影响威胁进入重新会签，旧意见已作废', life: 3000 })
}

const approvalLabel = (snapshot: VersionSnapshot): string =>
  `${snapshot.affectedThreatIds.filter((id) => {
    const threat = store.data.threats.find((item) => item.id === id)
    return threat?.reviewStatus === 'approved'
  }).length}/${snapshot.affectedThreatIds.length}`

watch(resumeRequest, (request) => {
  if (!request || route.path !== '/versions') return
  const { draft } = request
  if (draft.action !== 'create_version') return
  const payload = draft.payload as { label: string; notes: string; affectedThreatIds: string[] }
  createForm.label = payload.label
  createForm.notes = payload.notes
  createForm.affectedThreatIds = payload.affectedThreatIds
  createVisible.value = true
  toast.add({ severity: 'info', summary: '已恢复版本创建草稿', detail: draft.title, life: 3000 })
})
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="审计与基线"
      title="版本差异"
      description="统一版本链：比较基线差异，查看缓解任务、控制证据与风险值变更导致的会签失效范围。"
    />

    <InvalidationScopePanel :scope="invalidationScope" class="scope-panel" compact />

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">版本比较</h2>
        <Button label="创建新版本" icon="pi pi-plus" @click="openCreate" />
      </div>
      <div class="compare-toolbar">
        <div class="version-select">
          <span>基准版本</span>
          <select v-model="fromVersionId">
            <option v-for="version in store.data.versions" :key="version.id" :value="version.id">
              {{ version.label }}
            </option>
          </select>
        </div>
        <i class="pi pi-arrow-right"></i>
        <div class="version-select">
          <span>目标版本</span>
          <select v-model="toVersionId">
            <option v-for="version in store.data.versions" :key="version.id" :value="version.id">
              {{ version.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="diff-columns diff-padding">
        <div class="diff-block added-block">
          <h4>新增项</h4>
          <ul v-if="difference.added.length">
            <li v-for="change in difference.added" :key="`${change.category}-${change.id}`">
              <span>{{ change.category }}</span> {{ entityName(change) }}
            </li>
          </ul>
          <span v-else class="muted">无新增项</span>
        </div>
        <div class="diff-block removed-block">
          <h4>移除项</h4>
          <ul v-if="difference.removed.length">
            <li v-for="change in difference.removed" :key="`${change.category}-${change.id}`">
              <span>{{ change.category }}</span> {{ entityName(change) }}
            </li>
          </ul>
          <span v-else class="muted">无移除项</span>
        </div>
      </div>

      <div class="chain-diff">
        <h4>版本链事件（{{ chainDiffs.length }}）</h4>
        <p v-if="!chainDiffs.length" class="muted">该区间内没有缓解任务、控制证据或风险值变更。</p>
        <article v-for="event in chainDiffs" :key="event.id" class="chain-event">
          <div class="chain-event-head">
            <span class="source-tag">{{ eventSourceLabel(event.source) }}</span>
            <strong>{{ event.summary }}</strong>
            <span v-if="event.remote" class="remote-tag">另一窗口</span>
            <span class="muted">v1.{{ event.revision }}</span>
          </div>
          <div class="chain-event-meta">
            <span v-for="field in event.changedFields" :key="field" class="field-chip">{{ field }}</span>
          </div>
          <p class="muted">
            受影响威胁：{{ event.affectedThreatIds.map(threatLabel).join('、') || '无' }} ·
            作废旧会签 {{ event.invalidatedDecisionIds.length }} 条
          </p>
        </article>
      </div>

      <div v-if="invalidatedInRange.length" class="invalidated-box">
        <h4><i class="pi pi-lock"></i> 该区间作废的会签意见（{{ invalidatedInRange.length }} 条，只读保留）</h4>
        <article v-for="item in invalidatedInRange" :key="item.decision.id" class="invalidated-row">
          <span class="mono">{{ threatLabel(item.decision.threatId) }}</span>
          <span>{{ item.decision.actor }}（{{ item.decision.role }}）</span>
          <span>v1.{{ item.decision.revision }} → v1.{{ item.event.revision }}</span>
          <span class="muted">{{ item.event.summary }}</span>
        </article>
      </div>

      <div class="changed-list">
        <h4>重新审核差异</h4>
        <div v-for="item in difference.changed" :key="item" class="changed-item">
          <i class="pi pi-arrow-right"></i>
          <span>{{ item }}</span>
        </div>
      </div>
    </section>

    <div class="versions-grid">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">版本历史</h2>
        </div>
        <DataTable :value="store.data.versions" dataKey="id" size="small" stripedRows>
          <Column header="版本" style="width: 180px">
            <template #body="{ data }">
              <strong>{{ data.label }}</strong>
              <div class="mono">r{{ data.revision }}</div>
            </template>
          </Column>
          <Column header="创建时间" style="width: 155px">
            <template #body="{ data }">
              {{ new Date(data.createdAt).toLocaleDateString('zh-CN') }}
            </template>
          </Column>
          <Column field="author" header="创建人" style="width: 90px" />
          <Column header="受影响" style="width: 80px">
            <template #body="{ data }">{{ data.affectedThreatIds.length }} 条</template>
          </Column>
          <Column header="通过" style="width: 80px">
            <template #body="{ data }">{{ approvalLabel(data) }}</template>
          </Column>
          <Column field="notes" header="说明" />
        </DataTable>
      </section>

      <section class="panel audit-panel">
        <div class="panel-header">
          <h2 class="panel-title">审计轨迹</h2>
          <span class="muted">{{ store.data.audit.length }} 条</span>
        </div>
        <div class="audit-list">
          <article v-for="event in store.data.audit.slice(0, 12)" :key="event.id" class="audit-item">
            <i class="pi pi-circle-fill"></i>
            <div>
              <strong>{{ event.action }}</strong>
              <p>{{ event.detail }}</p>
              <span>{{ event.actor }} · {{ new Date(event.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
          </article>
        </div>
      </section>
    </div>

    <Dialog v-model:visible="createVisible" header="创建变更版本" modal :style="{ width: '720px' }">
      <div class="editor-form">
        <div class="field field-wide">
          <label>版本名称</label>
          <InputText v-model="createForm.label" />
        </div>
        <div class="field field-wide">
          <label>变更说明</label>
          <Textarea
            v-model="createForm.notes"
            rows="4"
            placeholder="说明架构、控制或风险发生的变更"
          />
        </div>
        <div class="field field-wide">
          <label>受影响威胁（默认带入统一失效范围）</label>
          <MultiSelect
            v-model="createForm.affectedThreatIds"
            :options="store.data.threats"
            option-label="title"
            option-value="id"
            display="chip"
            filter
            placeholder="只选择需要重新会签的威胁"
          />
          <small class="muted">被选中的威胁其当前会签意见立即作废并回到待重新会签；未选择的威胁保持已通过状态。</small>
        </div>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" outlined @click="createVisible = false" />
        <Button label="创建版本" icon="pi pi-check" @click="createVersion" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.scope-panel {
  margin-bottom: 16px;
}

.compare-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 40px minmax(0, 1fr);
  align-items: end;
  gap: 10px;
  padding: 16px;
}

.compare-toolbar > i {
  display: grid;
  place-items: center;
  height: 38px;
  color: #6c7689;
}

.version-select {
  display: grid;
  gap: 6px;
}

.version-select span {
  color: #697489;
  font-size: 12px;
  font-weight: 600;
}

.version-select select {
  width: 100%;
  min-height: 39px;
  padding: 0 10px;
  border: 1px solid #ccd3dc;
  border-radius: 5px;
  color: #273247;
  background: #fff;
}

.diff-padding {
  padding: 0 16px 16px;
}

.added-block {
  border-left: 3px solid #2f8f69;
}

.removed-block {
  border-left: 3px solid #c64b39;
}

.diff-block li span {
  display: inline-block;
  min-width: 55px;
  margin-right: 7px;
  color: #748094;
  font-size: 11px;
}

.chain-diff {
  padding: 0 16px 14px;
}

.chain-diff h4,
.invalidated-box h4 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 10px;
  font-size: 14px;
}

.chain-event {
  padding: 10px 12px;
  margin-bottom: 8px;
  border: 1px solid #e6e2d4;
  border-left: 3px solid #d97706;
  border-radius: 5px;
  background: #fdfaf3;
}

.chain-event-head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  font-size: 12px;
}

.chain-event-head strong {
  font-size: 12px;
}

.source-tag {
  padding: 1px 8px;
  border-radius: 3px;
  color: #7a5a17;
  background: #f6ead2;
  font-size: 10px;
}

.remote-tag {
  padding: 1px 8px;
  border-radius: 3px;
  color: #b04436;
  background: #fdece9;
  font-size: 10px;
  font-weight: 700;
}

.chain-event-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 7px 0;
}

.field-chip {
  padding: 1px 8px;
  border: 1px solid #e0d7c3;
  border-radius: 999px;
  color: #6f6250;
  font-size: 10px;
}

.invalidated-box {
  margin: 0 16px 14px;
  padding: 12px 14px;
  border: 1px solid #ecd9b8;
  border-radius: 6px;
  background: #fdf8ef;
}

.invalidated-box h4 {
  color: #9a6a1c;
}

.invalidated-row {
  display: grid;
  grid-template-columns: 1.1fr 1fr 1fr 2fr;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #f0e5cf;
  font-size: 11px;
  color: #5f5440;
}

.invalidated-row:last-child {
  border-bottom: 0;
}

.changed-list {
  padding: 0 16px 18px;
}

.changed-list h4 {
  margin: 0 0 10px;
  font-size: 14px;
}

.changed-item {
  display: flex;
  gap: 9px;
  padding: 6px 0;
  color: #515e73;
  font-size: 12px;
}

.changed-item i {
  color: #4c78a8;
  font-size: 10px;
}

.versions-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.55fr);
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}

.audit-list {
  padding: 8px 16px 14px;
}

.audit-item {
  position: relative;
  display: grid;
  grid-template-columns: 12px 1fr;
  gap: 10px;
  padding: 11px 0;
}

.audit-item::after {
  position: absolute;
  top: 28px;
  bottom: -10px;
  left: 4px;
  width: 1px;
  background: #dce2e9;
  content: "";
}

.audit-item:last-child::after {
  display: none;
}

.audit-item > i {
  margin-top: 5px;
  color: #5b83ad;
  font-size: 7px;
}

.audit-item strong {
  font-size: 12px;
}

.audit-item p {
  margin: 4px 0;
  color: #5f6a7e;
  font-size: 11px;
  line-height: 1.45;
}

.audit-item span {
  color: #8992a1;
  font-size: 10px;
}
</style>
