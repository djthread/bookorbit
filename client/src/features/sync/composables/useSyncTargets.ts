import { ref } from 'vue'
import { api } from '@/lib/api'
import type { SyncTarget, CreateSyncTargetPayload, UpdateSyncTargetPayload } from '@bookorbit/types'

const targets = ref<SyncTarget[]>([])
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
let fetchPromise: Promise<void> | null = null

export function useSyncTargets() {
  async function fetchTargets(): Promise<void> {
    if (loaded.value) return
    if (fetchPromise) return fetchPromise
    loading.value = true
    error.value = null
    fetchPromise = api('/api/v1/sync/targets')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        targets.value = await res.json()
        loaded.value = true
      })
      .catch((e: unknown) => {
        error.value = e instanceof Error ? e.message : 'Failed to load sync targets'
      })
      .finally(() => {
        loading.value = false
        fetchPromise = null
      })
    return fetchPromise
  }

  async function refreshTargets(): Promise<void> {
    loaded.value = false
    return fetchTargets()
  }

  async function createTarget(payload: CreateSyncTargetPayload): Promise<SyncTarget> {
    const res = await api('/api/v1/sync/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { message?: string }).message ?? 'Failed to create sync target')
    }
    const created: SyncTarget = await res.json()
    targets.value = [...targets.value, created]
    return created
  }

  async function updateTarget(id: number, payload: UpdateSyncTargetPayload): Promise<SyncTarget> {
    const res = await api(`/api/v1/sync/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error((body as { message?: string }).message ?? 'Failed to update sync target')
    }
    const updated: SyncTarget = await res.json()
    targets.value = targets.value.map((t) => (t.id === id ? updated : t))
    return updated
  }

  async function deleteTarget(id: number): Promise<void> {
    const res = await api(`/api/v1/sync/targets/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('Failed to delete sync target')
    targets.value = targets.value.filter((t) => t.id !== id)
  }

  async function reconcile(id: number): Promise<void> {
    const res = await api(`/api/v1/sync/targets/${id}/reconcile`, { method: 'POST' })
    if (!res.ok) throw new Error('Failed to trigger reconciliation')
  }

  async function acceptDevice(id: number, deviceId: string): Promise<SyncTarget> {
    const res = await api(`/api/v1/sync/targets/${id}/accept-device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    })
    if (!res.ok) throw new Error('Failed to accept device')
    const updated: SyncTarget = await res.json()
    targets.value = targets.value.map((t) => (t.id === id ? updated : t))
    return updated
  }

  return {
    targets,
    loaded,
    loading,
    error,
    fetchTargets,
    refreshTargets,
    createTarget,
    updateTarget,
    deleteTarget,
    reconcile,
    acceptDevice,
  }
}
