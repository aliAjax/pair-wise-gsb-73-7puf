<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import { diffEntity } from '@/services/repository'
import { fieldLabel } from '@/stores/threatModel'
import { useThreatModelStore } from '@/stores/threatModel'
import { requestResumeDraft } from '@/composables/useDraftResume'
import type { PendingDraft } from '@/models/domain'

const props = defineProps<{
  draft: PendingDraft | null
}>()
const emit = defineEmits<{ close: [] }>()

const store = useThreatModelStore()
const router = useRouter()

const visible = computed({
  get: () => props.draft !== null,
  set: (value) => {
    if (!value) emit('close')
  },
})

const isConflict = computed(() => props.draft?.reason === 'conflict')

const findRemoteEntity = (draft: PendingDraft): unknown => {
  const state = store.data
  const payload = draft.payload as Record<string, unknown>
  const id = String(payload.id ?? draft.entityId)
  const collections = [
    state.mitigations,
    state.evidence,
    state.risks,
    state.threats,
  ]
  for (const collection of collections) {
    const found = collection.find((entry) => entry.id === id)
    if (found) return found
  }
  return null
}

const conflictFields = computed(() => {
  if (!props.draft || !isConflict.value) return []
  if (props.draft.action === 'submit_decision') {
    const payload = props.draft.payload as { threatId: string }
    const threat = store.data.threats.find((item) => item.id === payload.threatId)
    return threat
      ? [`该威胁已回到 v1.${threat.revision} 待重新会签，对方的处置/会签已更新`]
      : ['对方已更新该会签上下文']
  }
  if (props.draft.action === 'create_version') return ['对方已创建新的版本快照，版本号需要顺延']
  const remote = findRemoteEntity(props.draft)
  if (!remote) return ['对方刚提交的变更已影响该记录']
  return diffEntity(remote, props.draft.payload).changedFields.map(fieldLabel)
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

const acceptRemote = (): void => {
  if (!props.draft) return
  store.keepDraftAfterConflict()
  emit('close')
}

const retry = (): void => {
  if (!props.draft) return
  const outcome = store.retryDraft(props.draft.id)
  if (outcome.ok) {
    emit('close')
  }
}

const openDraft = (): void => {
  if (!props.draft) return
  const draft = props.draft
  emit('close')
  void router.push(routeForDraft(draft.action)).then(() => {
    requestResumeDraft(draft)
  })
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    :header="isConflict ? '检测到冲突版本：保存已中止' : '写入失败：草稿已保留'"
    modal
    :closable="true"
    :style="{ width: '640px' }"
  >
    <div v-if="draft" class="conflict-body">
      <div class="conflict-banner" :class="{ failure: !isConflict }">
        <i :class="isConflict ? 'pi pi-exclamation-triangle' : 'pi pi-save'"></i>
        <div>
          <strong>{{ draft.title }}</strong>
          <p v-if="isConflict">
            基于 v1.{{ draft.baseRevision }} 的编辑未写入；另一个窗口已提交到
            v1.{{ store.data.currentRevision }}。对方刚保存的缓解处置或会签意见未被覆盖。
          </p>
          <p v-else>{{ draft.remoteSummary ?? '本地存储写入失败，内容未丢失。' }}</p>
        </div>
      </div>

      <div v-if="isConflict" class="diff-box">
        <h4>冲突字段 / 冲突范围</h4>
        <ul>
          <li v-for="field in conflictFields" :key="field">
            <i class="pi pi-arrow-right"></i>{{ field }}
          </li>
        </ul>
        <p class="hint">
          你的修改已作为草稿保留。建议先查看对方提交的最新版本，再决定：
          用草稿内容在最新版本上重新提交，或打开草稿继续编辑。
        </p>
      </div>
    </div>

    <template #footer>
      <Button
        v-if="isConflict"
        label="接受对方版本"
        severity="secondary"
        outlined
        @click="acceptRemote"
      />
      <Button label="打开草稿继续编辑" icon="pi pi-folder-open" severity="secondary" @click="openDraft" />
      <Button
        v-if="isConflict"
        label="基于最新版本重试保存"
        icon="pi pi-check"
        @click="retry"
      />
      <Button v-else label="稍后在草稿箱恢复" @click="emit('close')" />
    </template>
  </Dialog>
</template>

<style scoped>
.conflict-body {
  display: grid;
  gap: 14px;
}

.conflict-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border: 1px solid #f2c78f;
  border-left: 4px solid #d97706;
  border-radius: 6px;
  background: #fffaf0;
}

.conflict-banner.failure {
  border-color: #e3b7b0;
  border-left-color: #c64b39;
  background: #fdf4f2;
}

.conflict-banner > i {
  margin-top: 3px;
  color: #b45309;
  font-size: 18px;
}

.conflict-banner.failure > i {
  color: #c64b39;
}

.conflict-banner strong {
  font-size: 13px;
}

.conflict-banner p {
  margin: 5px 0 0;
  color: #6f6250;
  font-size: 12px;
  line-height: 1.6;
}

.diff-box {
  padding: 13px 15px;
  border: 1px solid #e3e7ee;
  border-radius: 6px;
  background: #f8fafc;
}

.diff-box h4 {
  margin: 0 0 9px;
  font-size: 13px;
}

.diff-box ul {
  margin: 0;
  padding-left: 4px;
  list-style: none;
}

.diff-box li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  color: #4c586d;
  font-size: 12px;
}

.diff-box li i {
  color: #c64b39;
  font-size: 9px;
}

.hint {
  margin: 10px 0 0;
  color: #7a8496;
  font-size: 11px;
  line-height: 1.6;
}
</style>
