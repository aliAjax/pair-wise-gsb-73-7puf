<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import { useThreatModelStore } from '@/stores/threatModel'
import ConflictDialog from '@/components/ConflictDialog.vue'
import DraftRecoveryBar from '@/components/DraftRecoveryBar.vue'

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()
const store = useThreatModelStore()

const navigation = [
  { label: '工作台', icon: 'pi pi-chart-line', to: '/' },
  { label: '架构与边界', icon: 'pi pi-sitemap', to: '/architecture' },
  { label: '威胁清单', icon: 'pi pi-shield', to: '/threats' },
  { label: '风险矩阵', icon: 'pi pi-th-large', to: '/risks' },
  { label: '缓解任务', icon: 'pi pi-list-check', to: '/mitigations' },
  { label: '会签中心', icon: 'pi pi-verified', to: '/reviews' },
  { label: '版本差异', icon: 'pi pi-code', to: '/versions' },
  { label: '控制证据', icon: 'pi pi-folder-open', to: '/evidence' },
  { label: '导出报告', icon: 'pi pi-file-export', to: '/report' },
]

const reset = (): void => {
  confirm.require({
    header: '恢复演示基线',
    message: '当前本地修改将被清除，是否继续？',
    icon: 'pi pi-exclamation-triangle',
    acceptLabel: '恢复',
    rejectLabel: '取消',
    accept: () => {
      store.resetDemo()
      void router.push('/')
    },
  })
}

// 另一个窗口完成提交时（storage 事件）同步对方版本，保证不会用过期版本覆盖
const handleStorage = (event: StorageEvent): void => {
  if (!event.key || !event.key.startsWith('scapex-threat-model')) return
  const result = store.syncFromRemote()
  if (result.changed) {
    toast.add({
      severity: 'warn',
      summary: '已同步另一窗口的新版本',
      detail: result.hasDrafts
        ? '检测到并发提交，本窗口已刷新为最新版本；你的失败草稿仍可恢复。'
        : '另一窗口已提交，本窗口已自动刷新为最新版本。',
      life: 4000,
    })
  }
}

onMounted(() => window.addEventListener('storage', handleStorage))
onUnmounted(() => window.removeEventListener('storage', handleStorage))
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">SX</span>
        <div>
          <strong>SCAPEX</strong>
          <small>威胁建模与会签</small>
        </div>
      </div>
      <nav class="nav-list">
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: $route.path === item.to }"
        >
          <i :class="item.icon"></i>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="sidebar-foot">
        <span>本地持久化 · 乐观并发</span>
        <strong>令牌 {{ store.writeToken.slice(-6) }}</strong>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div>
          <strong>{{ store.data.boundary.name }}</strong>
          <span>当前基线 v1.{{ store.data.currentRevision }}</span>
        </div>
        <div class="topbar-actions">
          <label class="fault-toggle" title="开启后所有保存都会模拟写入失败，用于验收失败草稿与重启恢复">
            <input
              type="checkbox"
              :checked="store.faultInjectionEnabled"
              @change="store.toggleFaultInjection(($event.target as HTMLInputElement).checked)"
            />
            <span>模拟写入失败</span>
          </label>
          <span class="sync-state">
            <i class="pi pi-cloud-upload"></i>
            最后保存 {{ new Date(store.lastSavedAt).toLocaleTimeString('zh-CN') }}
          </span>
          <Button label="恢复基线" icon="pi pi-history" severity="secondary" outlined @click="reset" />
        </div>
      </header>
      <DraftRecoveryBar />
      <section class="content-shell">
        <RouterView />
      </section>
    </main>

    <ConflictDialog />
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100vh;
}

.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 18px 14px;
  color: #d9e1ec;
  background: #172235;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 4px 8px 22px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  color: #172235;
  background: #7dd3b0;
  font-size: 13px;
  font-weight: 800;
}

.brand div {
  display: grid;
  gap: 3px;
}

.brand strong {
  color: #fff;
  font-size: 15px;
  letter-spacing: 0.06em;
}

.brand small {
  color: #8492a8;
  font-size: 11px;
}

.nav-list {
  display: grid;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0 11px;
  border-radius: 5px;
  color: #aeb9ca;
  font-size: 13px;
  text-decoration: none;
}

.nav-item i {
  width: 16px;
  font-size: 14px;
}

.nav-item:hover {
  color: #fff;
  background: #22324b;
}

.nav-item.active {
  color: #fff;
  background: #2b4365;
  box-shadow: inset 3px 0 #7dd3b0;
}

.sidebar-foot {
  display: grid;
  gap: 5px;
  margin-top: auto;
  padding: 13px 10px;
  border-top: 1px solid #2b374a;
  color: #7f8da2;
  font-size: 11px;
}

.sidebar-foot strong {
  color: #aeb9ca;
  font-family: monospace;
  font-size: 11px;
}

.main-shell {
  min-width: 0;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  padding: 0 24px;
  border-bottom: 1px solid #dde2e9;
  background: rgba(255, 255, 255, 0.96);
}

.topbar > div:first-child {
  display: grid;
  gap: 4px;
}

.topbar strong {
  font-size: 14px;
}

.topbar span {
  color: #717c90;
  font-size: 12px;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.fault-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #a23a34;
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.sync-state {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.content-shell {
  max-width: 1560px;
  padding: 24px;
}
</style>
