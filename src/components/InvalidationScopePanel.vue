<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { InvalidationReason } from '@/models/domain'
import { reasonText } from '@/services/versionChain'
import { useThreatModelStore } from '@/stores/threatModel'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    limit?: number
    selectable?: boolean
  }>(),
  {
    title: '会签失效范围（版本链统一视图）',
    description: '下列威胁引用的缓解任务、控制证据或风险值已改动，旧会签意见失效且仅可查看，需重新会签。',
    limit: 0,
    selectable: true,
  },
)

const store = useThreatModelStore()
const router = useRouter()

const items = computed(() =>
  props.limit > 0 ? store.scope.slice(0, props.limit) : store.scope,
)

const reasonClass = (reason: InvalidationReason): string => `reason-${reason}`

const openReview = (threatId: string): void => {
  if (!props.selectable) return
  void router.push({ path: '/reviews', query: { threat: threatId } })
}
</script>

<template>
  <section class="panel invalidation-panel">
    <div class="panel-header">
      <h2 class="panel-title">{{ title }}</h2>
      <span class="count-badge">{{ store.scope.length }} 条待重签</span>
    </div>
    <p class="scope-description">{{ description }}</p>
    <div v-if="items.length" class="scope-list">
      <article
        v-for="item in items"
        :key="item.threatId"
        class="scope-item"
        :class="{ clickable: selectable }"
        @click="openReview(item.threatId)"
      >
        <div class="scope-item-head">
          <strong>
            <span class="mono">{{ item.threatCode }}</span>
            {{ item.threatTitle }}
          </strong>
          <span v-if="item.invalidatedDecisionCount" class="decision-count">
            {{ item.invalidatedDecisionCount }} 条旧意见已失效
          </span>
        </div>
        <div class="scope-item-foot">
          <div class="reason-tags">
            <span
              v-for="reason in item.reasons"
              :key="reason"
              class="reason-tag"
              :class="reasonClass(reason)"
            >
              {{ reasonText(reason) }}变更
            </span>
          </div>
          <time v-if="item.lastInvalidatedAt">
            失效于 {{ new Date(item.lastInvalidatedAt).toLocaleString('zh-CN') }}
          </time>
        </div>
      </article>
    </div>
    <div v-else class="empty-state">当前没有会签失效的威胁，所有旧意见均处于生效状态。</div>
  </section>
</template>

<style scoped>
.invalidation-panel {
  padding: 16px;
}

.scope-description {
  margin: 4px 0 14px;
  color: #717c8f;
  font-size: 12px;
  line-height: 1.6;
}

.count-badge {
  padding: 3px 10px;
  border-radius: 11px;
  color: #8a4a12;
  background: #fdf0dc;
  font-size: 11px;
  font-weight: 700;
}

.scope-list {
  display: grid;
  gap: 10px;
}

.scope-item {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid #ead9c4;
  border-left: 3px solid #d97706;
  border-radius: 6px;
  background: #fffaf3;
}

.scope-item.clickable {
  cursor: pointer;
}

.scope-item.clickable:hover {
  border-color: #d97706;
  box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.15);
}

.scope-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.scope-item-head strong {
  font-size: 13px;
}

.mono {
  margin-right: 8px;
  color: #3268a6;
  font-family: monospace;
  font-size: 12px;
}

.decision-count {
  flex: none;
  color: #b45309;
  font-size: 11px;
  font-weight: 700;
}

.scope-item-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.reason-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.reason-tag {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}

.reason-mitigation {
  color: #1d4f8f;
  background: #e4eefb;
}

.reason-evidence {
  color: #7a3ea8;
  background: #f1e7fb;
}

.reason-risk {
  color: #a23a34;
  background: #fbe6e4;
}

.reason-control {
  color: #8a5a12;
  background: #fbf0dd;
}

.reason-threat {
  color: #2f6b50;
  background: #e3f4ec;
}

.reason-version {
  color: #4a5568;
  background: #e8edf3;
}

.scope-item-foot time {
  color: #97a0af;
  font-size: 10px;
}
</style>
