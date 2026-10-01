<script setup lang="ts">
import { computed } from 'vue'
import ConfirmDialog from 'primevue/confirmdialog'
import Toast from 'primevue/toast'
import SaveConflictDialog from '@/components/SaveConflictDialog.vue'
import { useThreatModelStore } from '@/stores/threatModel'

const store = useThreatModelStore()
const conflictDraft = computed(() => store.lastConflict?.draft ?? null)
</script>

<template>
  <RouterView />
  <Toast position="top-right" />
  <ConfirmDialog />
  <SaveConflictDialog :draft="conflictDraft" @close="store.clearConflict()" />
</template>
