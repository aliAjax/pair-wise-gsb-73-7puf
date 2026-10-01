<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import { useToast } from 'primevue/usetoast'
import { isFailNextWriteArmed, setFailNextWrite } from '@/services/repository'
import { useThreatModelStore } from '@/stores/threatModel'
import { requestResumeDraft } from '@/composables/useDraftResume'
import type { PendingDraft } from '@/models/domain'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ 'update:visible': [value: boolean] }>()

const store = useThreatModelStore()
const router = useRouter()
const toast = useToast()
const failArmed = ref(isFailNextWriteArmed())

watch(
  () => props.visible,
  (visible) => {
    if (visible) failArmed.value = isFailNextWriteArmed()
  },
)

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
})

const routeForDraft = (action: PendingDraft['action']): string => {
  switch (action) {
    case 'save_mitigation':
    case 'update_mitigation_status':
      return '/mitigations'
    case 'save_evidence':
      return '/evidence'
    case 'save_risk':
    case 'accept_risk':
    case 'close_risk':
      return '/risks'
    case 'save_threat':
      return '/threats'
    case 'submit_decision':
      return '/reviews'
    case 'create_version':
      return '/versions'
    default:
      return '/'
  }
}

const resume = (draft: PendingDraft): void => {
  dialogVisible.value = false
  void router.push(routeForDraft(draft.action)).then(() => {
    requestResumeDraft(draft)
    toast.add({
      severity: 'info',
      summary: '草稿已恢复到编辑表单',
      detail: '内容已回填，确认后可重新保存。',
      life: 3000,
    })
  })
}

const discard = (draft: PendingDraft): void => {
  store.discardDraft(draft.id)
  toast.add({ severity: 'success', summary: '草稿已丢弃', detail: draft.title, life: 2500 })
}

const toggleFailNextWrite = (): void => {
  failArmed.value = !failArmed.value
  setFailNextWrite(failArmed.value)
}

const simulateRemote = (): void => {
  store.simulateRemoteChange()
  toast.add({
    severity: 'warn',
    summary: '已模拟另一窗口提交',
    detail: '对端刚更新了一条缓解任务，现在本窗口保存将看到冲突版本。',
    life: 4000,
  })
}
</script>

<template>
  <Dialog v-model:visible="dialogVisible" header="失败草稿与并发演练" modal :style="{ width: '680px' }">
    <section class="draft-section">
      <div class="section-head">
        <h3>写入失败保留的草稿（{{ store.drafts.length }}）</h3>
        <span class="muted">独立持久化，重启浏览器后仍可恢复</span>
      </div>
      <div v-if="store.drafts.length" class="draft-list">
        <article v-for="draft in store.drafts" :key="draft.id" class="draft-item">
          <div class="draft-main">
            <strong>{{ draft.title }}</strong>
            <div class="draft-tags">
              <span class="draft-tag" :class="draft.reason">
                {{ draft.reason === 'conflict' ? '冲突版本' : '写入失败' }}
              </span>
              <span class="muted">基于 v1.{{ draft.baseRevision }}</span>
              <span class="muted">{{ new Date(draft.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
            <p v-if="draft.remoteSummary" class="muted">{{ draft.remoteSummary }}</p>
          </div>
          <div class="draft-actions">
            <Button label="恢复" size="small" icon="pi pi-folder-open" @click="resume(draft)" />
            <Button label="丢弃" size="small" severity="secondary" text @click="discard(draft)" />
          </div>
        </article>
      </div>
      <div v-else class="empty">暂无失败写入草稿。</div>
    </section>

    <section class="drill-section">
      <div class="section-head">
        <h3>并发 / 故障演练</h3>
      </div>
      <div class="drill-row">
        <div>
          <strong>模拟下一次写入失败</strong>
          <p class="muted">开启后下一次保存会失败，表单内容自动进入草稿箱，可用于验证重启恢复。</p>
        </div>
        <Button
          :label="failArmed ? '演练开关：已开启' : '演练开关：关闭'"
          :severity="failArmed ? 'danger' : 'secondary'"
          outlined
          @click="toggleFailNextWrite"
        />
      </div>
      <div class="drill-row">
        <div>
          <strong>模拟另一窗口刚提交</strong>
          <p class="muted">
            由“另一个窗口”推进一条缓解任务并替换版本令牌；随后本窗口保存将弹出冲突版本，
            不会覆盖对方的处置或会签意见。
          </p>
        </div>
        <Button label="模拟对端提交" icon="pi pi-desktop" severity="warn" outlined @click="simulateRemote" />
      </div>
    </section>
  </Dialog>
</template>

<style scoped>
.draft-section,
.drill-section {
  display: grid;
  gap: 10px;
}

.drill-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #e6eaf0;
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.section-head h3 {
  margin: 0;
  font-size: 14px;
}

.muted {
  color: #828c9c;
  font-size: 11px;
}

.draft-list {
  display: grid;
  gap: 8px;
}

.draft-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px;
  border: 1px solid #e2e6ec;
  border-radius: 6px;
  background: #fafbfc;
}

.draft-main {
  display: grid;
  gap: 5px;
}

.draft-main strong {
  font-size: 13px;
}

.draft-tags {
  display: flex;
  align-items: center;
  gap: 9px;
}

.draft-tag {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
}

.draft-tag.conflict {
  color: #b45309;
  background: #fdf3e2;
}

.draft-tag.write_failure {
  color: #b04436;
  background: #fdece9;
}

.draft-actions {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}

.empty {
  padding: 18px;
  border: 1px dashed #d6dce5;
  border-radius: 6px;
  color: #8a93a3;
  font-size: 12px;
  text-align: center;
}

.drill-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 12px;
  border: 1px solid #e6eaf0;
  border-radius: 6px;
}

.drill-row p {
  margin: 4px 0 0;
  line-height: 1.5;
}
</style>
