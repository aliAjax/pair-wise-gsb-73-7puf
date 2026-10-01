<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import Button from 'primevue/button'
import { draftStore } from '@/services/drafts'

const router = useRouter()
const route = useRoute()

const reasonLabel: Record<string, string> = {
  write_failed: '写入失败',
  conflict: '并发冲突',
}

const kindLabel: Record<string, string> = {
  mitigation: '缓解任务',
  evidence: '控制证据',
  decision: '会签意见',
  version: '版本快照',
  risk_acceptance: '风险接受',
  mitigation_status: '缓解状态',
}

const resumeDraft = async (draftId: string): Promise<void> => {
  const draft = draftStore.drafts.find((item) => item.id === draftId)
  if (!draft) return
  if (route.path !== draft.route) {
    await router.push(draft.route)
  }
  // 目标页挂载并注册处理器后回填；只有被消费才从草稿区移除，否则保留待页面领取
  const consumed = draftStore.requestResume(draft)
  if (consumed) draftStore.remove(draft.id)
}

// 挂载时无需主动领取：目标页面挂载后会自行 takePending
const discardDraft = (draftId: string): void => {
  draftStore.remove(draftId)
}
</script>

<template>
  <div v-if="draftStore.drafts.length" class="draft-bar">
    <i class="pi pi-save"></i>
    <div class="draft-body">
      <strong>{{ draftStore.drafts.length }} 份草稿待恢复</strong>
      <span>写入失败或并发冲突时的编辑内容已保留，重启后仍可恢复。</span>
    </div>
    <div class="draft-items">
      <div v-for="draft in draftStore.drafts" :key="draft.id" class="draft-chip">
        <em :class="draft.reason === 'conflict' ? 'conflict' : 'failed'">
          {{ reasonLabel[draft.reason] }}
        </em>
        <span class="draft-kind">{{ kindLabel[draft.kind] }}</span>
        <span class="draft-title">{{ draft.title }}</span>
        <Button label="恢复" size="small" text @click="resumeDraft(draft.id)" />
        <Button
          label="丢弃"
          size="small"
          severity="secondary"
          text
          @click="discardDraft(draft.id)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 24px;
  border-bottom: 1px solid #f0d9b8;
  background: #fff7ec;
}

.draft-bar > i {
  color: #b45309;
  font-size: 18px;
}

.draft-body {
  display: grid;
  gap: 2px;
  flex: none;
}

.draft-body strong {
  font-size: 12px;
  color: #7a4a12;
}

.draft-body span {
  color: #9c7d52;
  font-size: 11px;
}

.draft-items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.draft-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px 3px 10px;
  border: 1px solid #ecd7b8;
  border-radius: 16px;
  background: #fff;
}

.draft-chip em {
  padding: 1px 8px;
  border-radius: 10px;
  font-style: normal;
  font-size: 10px;
  font-weight: 700;
}

.draft-chip em.conflict {
  color: #8a4a12;
  background: #fdf0dc;
}

.draft-chip em.failed {
  color: #a23a34;
  background: #fbe6e4;
}

.draft-kind {
  color: #8a7a60;
  font-size: 10px;
}

.draft-title {
  max-width: 220px;
  overflow: hidden;
  color: #3d4657;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
