<script setup lang="ts">
import { computed } from 'vue'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useThreatModelStore } from '@/stores/threatModel'
import { reasonText } from '@/services/versionChain'

const store = useThreatModelStore()

interface DiffRow {
  label: string
  added: number
  removed: number
  changed: number
}

const DIFF_LABELS: { key: keyof DiffSections; label: string }[] = [
  { key: 'mitigations', label: '缓解任务' },
  { key: 'evidence', label: '控制证据' },
  { key: 'risks', label: '风险值' },
  { key: 'controls', label: '控制措施' },
  { key: 'threats', label: '威胁' },
  { key: 'decisions', label: '会签意见' },
  { key: 'versions', label: '版本快照' },
]

interface DiffSections {
  mitigations: { id: string }[]
  evidence: { id: string }[]
  risks: { id: string }[]
  controls: { id: string }[]
  threats: { id: string }[]
  decisions: { id: string }[]
  versions: { id: string }[]
}

const remote = computed(() => store.activeConflict)

const localSections = computed<DiffSections | null>(() =>
  remote.value
    ? {
        mitigations: store.data.mitigations,
        evidence: store.data.evidence,
        risks: store.data.risks,
        controls: store.data.controls,
        threats: store.data.threats,
        decisions: store.data.decisions,
        versions: store.data.versions,
      }
    : null,
)

const rows = computed<DiffRow[]>(() => {
  if (!remote.value || !localSections.value) return []
  const remoteState = remote.value.remoteState
  return DIFF_LABELS.map(({ key, label }) => {
    const localList = localSections.value![key]
    const remoteList = remoteState[key] as { id: string }[]
    const localMap = new Map(localList.map((item) => [item.id, item]))
    const remoteMap = new Map(remoteList.map((item) => [item.id, item]))
    let changed = 0
    remoteList.forEach((item) => {
      const localItem = localMap.get(item.id)
      if (localItem && JSON.stringify(localItem) !== JSON.stringify(item)) changed += 1
    })
    return {
      label,
      added: remoteList.filter((item) => !localMap.has(item.id)).length,
      removed: localList.filter((item) => !remoteMap.has(item.id)).length,
      changed,
    }
  }).filter((row) => row.added || row.removed || row.changed)
})

const remoteInvalidations = computed(() =>
  remote.value ? remote.value.remoteState.invalidations.slice(0, 3) : [],
)

const adopt = (): void => {
  store.resolveConflictAdoptRemote()
}
</script>

<template>
  <Dialog
    :visible="Boolean(store.activeConflict)"
    @update:visible="(value: boolean) => !value && store.dismissConflict()"
    header="检测到并发版本冲突"
    modal
    :style="{ width: '680px' }"
    :closable="false"
  >
    <template v-if="remote">
      <div class="conflict-intro">
        <i class="pi pi-exclamation-triangle"></i>
        <div>
          <p>
            另一个窗口已先提交了新版本（{{ new Date(remote.remoteUpdatedAt).toLocaleString('zh-CN') }}），
            你本次的缓解处置 / 会签意见<strong>未写入</strong>，表单内容已保留为草稿，不会覆盖对方的提交。
          </p>
          <p class="muted">请先查看对方版本，再选择处理方式；恢复草稿后可在最新版本上重新提交。</p>
        </div>
      </div>

      <section class="diff-section">
        <h4>对方窗口相对你本地版本的变更</h4>
        <table v-if="rows.length" class="diff-table">
          <thead>
            <tr>
              <th>对象</th>
              <th>新增</th>
              <th>修改</th>
              <th>移除</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.label">
              <td>{{ row.label }}</td>
              <td class="num added">{{ row.added || '-' }}</td>
              <td class="num changed">{{ row.changed || '-' }}</td>
              <td class="num removed">{{ row.removed || '-' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">对方版本仅更新了写入令牌（例如只提交了会签意见）。</p>
      </section>

      <section v-if="remoteInvalidations.length" class="invalidated-section">
        <h4>对方提交引起的会签失效</h4>
        <ul>
          <li v-for="record in remoteInvalidations" :key="record.id">
            <span class="reason">{{ reasonText(record.reason) }}变更</span>
            {{ record.sourceLabel }}：{{ record.threatIds.length }} 条威胁回到待重新会签，
            {{ record.decisionIds.length }} 条旧意见失效
          </li>
        </ul>
      </section>
    </template>
    <template #footer>
      <Button
        label="保留我的草稿并采用对方版本"
        icon="pi pi-check"
        @click="adopt"
      />
      <Button
        label="仅关闭，稍后处理"
        severity="secondary"
        outlined
        @click="store.dismissConflict()"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.conflict-intro {
  display: flex;
  gap: 13px;
  padding: 14px;
  border: 1px solid #f2c78f;
  border-left: 4px solid #d97706;
  border-radius: 6px;
  background: #fffaf0;
}

.conflict-intro > i {
  margin-top: 3px;
  color: #b45309;
  font-size: 18px;
}

.conflict-intro p {
  margin: 0;
  color: #5f5138;
  font-size: 13px;
  line-height: 1.7;
}

.conflict-intro p + p {
  margin-top: 6px;
}

.muted {
  color: #8a8272;
  font-size: 12px;
}

.diff-section,
.invalidated-section {
  margin-top: 18px;
}

.diff-section h4,
.invalidated-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
}

.diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.diff-table th,
.diff-table td {
  padding: 8px 10px;
  border: 1px solid #e6e3dc;
  text-align: left;
}

.diff-table th {
  background: #faf7f1;
  color: #6b6353;
  font-weight: 600;
}

.num {
  text-align: center;
  font-weight: 700;
}

.added {
  color: #2f8f69;
}

.changed {
  color: #b45309;
}

.removed {
  color: #c64b39;
}

.invalidated-section ul {
  margin: 0;
  padding-left: 18px;
  color: #5f6a7e;
  font-size: 12px;
  line-height: 1.9;
}

.reason {
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 4px;
  color: #8a4a12;
  background: #fdf0dc;
  font-weight: 700;
}
</style>
