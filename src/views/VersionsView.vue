<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import MultiSelect from 'primevue/multiselect'
import Textarea from 'primevue/textarea'
import { useToast } from 'primevue/usetoast'
import PageHeader from '@/components/PageHeader.vue'
import InvalidationScopePanel from '@/components/InvalidationScopePanel.vue'
import type { DraftPayload, VersionChange, VersionSnapshot } from '@/models/domain'
import { compareSnapshots } from '@/services/selectors'
import { draftStore } from '@/services/drafts'
import { useThreatModelStore } from '@/stores/threatModel'

const store = useThreatModelStore()
const toast = useToast()
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
    : { added: [], removed: [], changed: [], basisChangedThreatIds: [] },
)

const basisChangedThreats = computed(
  () =>
    difference.value.basisChangedThreatIds
      .map((id) => store.data.threats.find((threat) => threat.id === id))
      .filter(Boolean),
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

const openCreate = (): void => {
  createForm.label = `v1.${store.data.currentRevision + 1} 变更评审`
  createForm.notes = ''
  createForm.affectedThreatIds = []
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
  const snapshot = store.createVersion(createForm.label, createForm.notes, createForm.affectedThreatIds, {
    kind: 'version',
    title: createForm.label,
    route: '/versions',
    payload: { ...createForm },
  })
  if (!snapshot) {
    createVisible.value = false
    toast.add({
      severity: store.activeConflict ? 'warn' : 'error',
      summary: store.activeConflict ? '并发冲突，版本未创建' : '写入失败，版本草稿已保留',
      detail: store.activeConflict
        ? '另一窗口已提交，创建版本的内容已存为草稿，可在冲突窗口处理后恢复。'
        : '可从顶部草稿条恢复后重试。',
      life: 4000,
    })
    return
  }
  fromVersionId.value = toVersionId.value
  toVersionId.value = snapshot.id
  createVisible.value = false
  toast.add({ severity: 'success', summary: '版本已创建', detail: '受影响威胁的旧会签意见已失效', life: 3000 })
}

const restoreDraft = (draft: DraftPayload): void => {
  Object.assign(createForm, draft.payload)
  createVisible.value = true
  toast.add({
    severity: 'info',
    summary: '已恢复版本草稿',
    detail: '请确认最新版本号与受影响威胁后重新创建。',
    life: 3500,
  })
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = draftStore.on('version', restoreDraft)
  const pending = draftStore.takePending('version')
  if (pending) {
    restoreDraft(pending)
    draftStore.remove(pending.id)
  }
})
onUnmounted(() => unsubscribe?.())

const approvalLabel = (snapshot: VersionSnapshot): string =>
  `${snapshot.affectedThreatIds.filter((id) => {
    const threat = store.data.threats.find((item) => item.id === id)
    return threat?.reviewStatus === 'approved'
  }).length}/${snapshot.affectedThreatIds.length}`
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="审计与基线"
      title="版本差异"
      description="比较模型基线与统一版本链：识别组件、数据流、控制、风险以及会签基准（缓解/证据/风险值）的变化，失效范围与会签页一致。"
    />

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

      <div class="basis-diff diff-padding">
        <h4>会签基准变化（与会签页同一失效范围）</h4>
        <ul v-if="basisChangedThreats.length" class="basis-list">
          <li v-for="threat in basisChangedThreats" :key="threat!.id">
            <span class="mono">{{ threat!.code }}</span>
            {{ threat!.title }}
            <i class="pi pi-arrow-right"></i>
            <em>旧会签意见失效，需重新会签</em>
          </li>
        </ul>
        <span v-else class="muted">两个版本之间没有威胁的会签基准（缓解任务/证据/风险值）发生变化。</span>
      </div>

      <div class="changed-list">
        <h4>重新审核差异</h4>
        <div v-for="item in difference.changed" :key="item" class="changed-item">
          <i class="pi pi-arrow-right"></i>
          <span>{{ item }}</span>
        </div>
      </div>
    </section>

    <InvalidationScopePanel class="shared-scope" :limit="5" />

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
          <label>受影响威胁</label>
          <MultiSelect
            v-model="createForm.affectedThreatIds"
            :options="store.data.threats"
            option-label="title"
            option-value="id"
            display="chip"
            filter
            placeholder="只选择需要重新会签的威胁"
          />
          <small class="muted">创建后受影响威胁的旧会签意见立即失效（保留只读），并进入会签页的待重签队列。</small>
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

.basis-diff {
  padding-top: 4px;
}

.basis-diff h4 {
  margin: 0 0 10px;
  font-size: 14px;
  color: #8a4a12;
}

.basis-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.basis-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid #f0d9b8;
  border-left: 3px solid #d97706;
  border-radius: 5px;
  background: #fff8ee;
  color: #5f5138;
  font-size: 12px;
}

.basis-list .mono {
  color: #3268a6;
  font-family: monospace;
}

.basis-list i {
  color: #d97706;
  font-size: 10px;
}

.basis-list em {
  color: #a23a34;
  font-style: normal;
  font-weight: 700;
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

.shared-scope {
  margin-top: 16px;
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
