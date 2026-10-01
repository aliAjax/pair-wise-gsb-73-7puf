<script setup lang="ts">
import type { InvalidationScopeEntry } from '@/models/domain'
import StatusTag from '@/components/StatusTag.vue'

defineProps<{
  scope: InvalidationScopeEntry[]
  title?: string
  compact?: boolean
}>()

const sourceLabels: Record<string, string> = {
  threat: '威胁变更',
  mitigation: '缓解任务变更',
  evidence: '控制证据变更',
  risk: '风险值变更',
  version: '版本快照',
  remote: '另一窗口提交',
}
</script>

<template>
  <section class="invalidation-panel" :class="{ compact }">
    <header class="invalidation-head">
      <h3>
        <i class="pi pi-sync"></i>
        {{ title ?? '旧会签失效范围（统一版本链）' }}
      </h3>
      <span class="count-badge">{{ scope.length }} 条威胁待重新会签</span>
    </header>

    <div v-if="scope.length" class="scope-list">
      <article v-for="entry in scope" :key="entry.threatId" class="scope-entry">
        <div class="scope-main">
          <div class="scope-title">
            <span class="mono">{{ entry.threatCode }}</span>
            <strong>{{ entry.threatTitle }}</strong>
            <StatusTag :value="entry.reviewStatus" kind="review" />
          </div>
          <p v-if="entry.latestEvent" class="scope-reason">
            <span class="source-tag">{{ sourceLabels[entry.latestEvent.source] ?? entry.latestEvent.source }}</span>
            {{ entry.latestEvent.summary }}
            <em v-if="entry.latestEvent.remote">（来自另一窗口）</em>
          </p>
          <p v-else class="scope-reason muted">该威胁处于会签队列中，尚无链变更记录。</p>
        </div>
        <div class="scope-meta">
          <span v-if="entry.invalidatedDecisionCount > 0" class="invalid-count">
            {{ entry.invalidatedDecisionCount }} 条旧意见已作废 · 只读保留
          </span>
          <span class="active-count">当前版本生效意见 {{ entry.activeDecisionCount }}/3</span>
        </div>
      </article>
    </div>
    <div v-else class="scope-empty">
      <i class="pi pi-check-circle"></i>
      当前没有因版本链变更而等待重新会签的威胁。
    </div>
  </section>
</template>

<style scoped>
.invalidation-panel {
  border: 1px solid #dde2ea;
  border-left: 4px solid #b45309;
  border-radius: 7px;
  background: #fff;
}

.invalidation-panel.compact {
  border-left-width: 3px;
}

.invalidation-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px;
  border-bottom: 1px solid #eef0f3;
}

.invalidation-head h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
}

.invalidation-head h3 i {
  color: #b45309;
}

.count-badge {
  padding: 2px 10px;
  border-radius: 999px;
  color: #92650a;
  background: #fdf3e2;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.scope-list {
  display: grid;
}

.scope-entry {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #f1f3f6;
}

.scope-entry:last-child {
  border-bottom: 0;
}

.scope-title {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.scope-title .mono {
  color: #3268a6;
  font-family: monospace;
  font-size: 12px;
}

.scope-reason {
  margin: 6px 0 0;
  color: #5f6a7e;
  font-size: 12px;
  line-height: 1.55;
}

.scope-reason em {
  color: #b45309;
  font-style: normal;
}

.source-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 3px;
  color: #7a5a17;
  background: #f6ead2;
  font-size: 10px;
}

.scope-meta {
  display: grid;
  gap: 5px;
  justify-items: end;
  white-space: nowrap;
}

.invalid-count {
  color: #b45309;
  font-size: 11px;
  font-weight: 600;
}

.active-count {
  color: #7a8496;
  font-size: 10px;
}

.scope-empty {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 18px 16px;
  color: #4f8a6a;
  font-size: 12px;
}

.muted {
  color: #8a93a3;
}
</style>
