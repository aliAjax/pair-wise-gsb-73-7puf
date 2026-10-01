import { ref } from 'vue'
import type { PendingDraft } from '@/models/domain'

/**
 * 草稿恢复总线：顶栏草稿箱发起恢复，对应页面监听并把草稿内容填回编辑表单。
 * nonce 每次递增，同一路由的重复恢复也能被页面感知。
 */
export const resumeRequest = ref<{ draft: PendingDraft; nonce: number } | null>(null)

export const requestResumeDraft = (draft: PendingDraft): void => {
  resumeRequest.value = { draft, nonce: Date.now() }
}

export const clearResumeRequest = (): void => {
  resumeRequest.value = null
}
