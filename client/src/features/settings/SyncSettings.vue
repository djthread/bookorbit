<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { AlertCircle, Check, ChevronDown, ChevronUp, Copy, Plus, RefreshCw, Server, Smartphone, Trash2, Wifi } from '@lucide/vue'
import { toast } from 'vue-sonner'
import QRCode from 'qrcode'
import SettingsPageHeader from './SettingsPageHeader.vue'
import { copyToClipboard } from '@/lib/clipboard'
import { useSyncTargets } from '@/features/sync/composables/useSyncTargets'
import { useCollections } from '@/features/collection/composables/useCollections'
import { api } from '@/lib/api'
import type { SyncTarget, SyncTargetProgress, PendingDevice, SyncLayout } from '@bookorbit/types'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { targets, loading, error, fetchTargets, createTarget, updateTarget, deleteTarget, acceptDevice, reconcile } = useSyncTargets()

const LAYOUT_OPTIONS: { value: SyncLayout; label: string; hint: string }[] = [
  { value: 'flat', label: 'Flat — all books together', hint: 'One tap to open in KOReader. Best for the My Bookshelf plugin.' },
  { value: 'series', label: 'By series', hint: 'Series get their own shelf; standalone books stay at the top level.' },
  { value: 'author', label: 'By author', hint: 'Author/Series/Title folders — mirrors KOReader’s native file tree.' },
]
const { collections, fetchCollections } = useCollections()

const pageLoading = ref(true)
const pageError = ref<string | null>(null)

// Per-target status (keyed by target ID)
const statusMap = ref<Record<number, SyncTargetProgress>>({})
// QR codes keyed by device ID string
const qrCodeCache = ref<Record<string, string>>({})
// Which targets are expanded (show pairing panel)
const expandedIds = ref<number[]>([])

// Create form
const showCreateForm = ref(false)
const newName = ref('')
const newCollectionIds = ref<number[]>([])
const newLayout = ref<SyncLayout>('flat')
const creating = ref(false)

// Per-action loading state
const acceptingTarget = ref<number | null>(null)
const reconcilingTarget = ref<number | null>(null)
const updatingLayout = ref<number | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null

async function fetchStatusFor(targetId: number): Promise<void> {
  try {
    const res = await api(`/api/v1/sync/targets/${targetId}/status`)
    if (!res.ok) return
    const progress: SyncTargetProgress = await res.json()
    statusMap.value = { ...statusMap.value, [targetId]: progress }
    if (progress.ourDeviceId && !qrCodeCache.value[progress.ourDeviceId]) {
      QRCode.toDataURL(progress.ourDeviceId, { errorCorrectionLevel: 'M', margin: 2 })
        .then((url) => {
          qrCodeCache.value = { ...qrCodeCache.value, [progress.ourDeviceId]: url }
        })
        .catch(() => {})
    }
  } catch {
    // ignore polling errors silently
  }
}

async function fetchAllStatuses(): Promise<void> {
  await Promise.all(targets.value.map((t) => fetchStatusFor(t.id)))
}

onMounted(async () => {
  try {
    await Promise.all([fetchTargets(), fetchCollections()])
    pageError.value = error.value
    if (!error.value) {
      for (const t of targets.value) {
        if (!t.deviceId) expandedIds.value.push(t.id)
      }
      await fetchAllStatuses()
      pollTimer = setInterval(fetchAllStatuses, 5000)
    }
  } catch (e) {
    pageError.value = e instanceof Error ? e.message : 'Failed to load'
  } finally {
    pageLoading.value = false
  }
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function toggleExpand(id: number): void {
  if (expandedIds.value.includes(id)) {
    expandedIds.value = expandedIds.value.filter((i) => i !== id)
  } else {
    expandedIds.value = [...expandedIds.value, id]
  }
}

function toggleCollection(id: number): void {
  if (newCollectionIds.value.includes(id)) {
    newCollectionIds.value = newCollectionIds.value.filter((c) => c !== id)
  } else {
    newCollectionIds.value = [...newCollectionIds.value, id]
  }
}

async function submitCreate(): Promise<void> {
  if (!newName.value.trim() || newCollectionIds.value.length === 0) return
  creating.value = true
  try {
    const target = await createTarget({ name: newName.value.trim(), collectionIds: newCollectionIds.value, layout: newLayout.value })
    toast.success(`Sync target "${target.name}" created`)
    showCreateForm.value = false
    newName.value = ''
    newCollectionIds.value = []
    newLayout.value = 'flat'
    if (!expandedIds.value.includes(target.id)) {
      expandedIds.value = [...expandedIds.value, target.id]
    }
    await fetchStatusFor(target.id)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to create sync target')
  } finally {
    creating.value = false
  }
}

function cancelCreate(): void {
  showCreateForm.value = false
  newName.value = ''
  newCollectionIds.value = []
  newLayout.value = 'flat'
}

async function handleLayoutChange(target: SyncTarget, layout: SyncLayout): Promise<void> {
  if (layout === target.layout) return
  updatingLayout.value = target.id
  try {
    await updateTarget(target.id, { layout })
    toast.success('Layout updated — re-syncing files to the device')
    setTimeout(() => fetchStatusFor(target.id), 1500)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to update layout')
  } finally {
    updatingLayout.value = null
  }
}

async function handleAcceptDevice(target: SyncTarget, deviceId: string): Promise<void> {
  acceptingTarget.value = target.id
  try {
    await acceptDevice(target.id, deviceId)
    toast.success('Device accepted — sync will begin shortly')
    // Collapse the pairing panel after successful pairing
    expandedIds.value = expandedIds.value.filter((i) => i !== target.id)
    await fetchStatusFor(target.id)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to accept device')
  } finally {
    acceptingTarget.value = null
  }
}

async function handleReconcile(id: number): Promise<void> {
  reconcilingTarget.value = id
  try {
    await reconcile(id)
    toast.success('Reconciliation triggered')
    setTimeout(() => fetchStatusFor(id), 1500)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to trigger reconciliation')
  } finally {
    reconcilingTarget.value = null
  }
}

async function handleDelete(target: SyncTarget): Promise<void> {
  if (!confirm(`Delete sync target "${target.name}"?\n\nFiles already exported to the sync folder will not be deleted.`)) return
  try {
    await deleteTarget(target.id)
    const updated = { ...statusMap.value }
    delete updated[target.id]
    statusMap.value = updated
    expandedIds.value = expandedIds.value.filter((i) => i !== target.id)
    toast.success(`Sync target "${target.name}" deleted`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to delete sync target')
  }
}

async function copyText(text: string, label: string): Promise<void> {
  const copied = await copyToClipboard(text)
  if (copied) toast.success(`${label} copied`)
  else toast.error(`Failed to copy ${label.toLowerCase()}`)
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

function statusLabel(status: string): string {
  return ({ idle: 'Idle', reconciling: 'Reconciling', syncing: 'Syncing', error: 'Error' } as Record<string, string>)[status] ?? status
}

function collectionNames(ids: number[]): string {
  const names = ids.map((id) => collections.value.find((c) => c.id === id)?.name).filter(Boolean)
  return names.length > 0 ? names.join(', ') : 'No collections'
}

function ourDeviceId(targetId: number): string | null {
  return statusMap.value[targetId]?.ourDeviceId ?? null
}

function pendingDevices(targetId: number): PendingDevice[] {
  return statusMap.value[targetId]?.pendingDevices ?? []
}

function syncCompletion(targetId: number): number | null {
  return statusMap.value[targetId]?.lastCompletion ?? targets.value.find((t) => t.id === targetId)?.lastCompletion ?? null
}
</script>

<template>
  <SettingsPageHeader v-if="!props.embedded" title="Device Sync" subtitle="Push collections to KOReader devices automatically via Syncthing." />

  <div v-if="pageLoading || loading" class="text-sm text-muted-foreground">Loading...</div>
  <div v-else-if="pageError" class="text-sm text-destructive">{{ pageError }}</div>
  <template v-else>
    <!-- Targets section -->
    <div class="mb-8">
      <div class="flex items-center justify-between mb-3">
        <p class="settings-group-label mb-0">Sync Targets</p>
        <button v-if="!showCreateForm" class="settings-btn-primary" @click="showCreateForm = true">
          <Plus :size="12" />
          New target
        </button>
      </div>

      <!-- Create form -->
      <div v-if="showCreateForm" class="border border-border rounded-lg p-5 bg-card mb-4 space-y-4 shadow-xs">
        <div>
          <label class="settings-label block mb-1.5">Target name</label>
          <input v-model="newName" type="text" placeholder="e.g. Kobo Libra H2O" autofocus class="input-field w-full" />
        </div>

        <div>
          <p class="settings-label mb-1.5">Collections to sync</p>
          <div v-if="collections.length === 0" class="text-xs text-muted-foreground italic">No collections yet — create one first.</div>
          <div v-else class="border border-border rounded-lg divide-y divide-border overflow-hidden">
            <label
              v-for="col in collections"
              :key="col.id"
              class="flex items-center gap-2.5 px-4 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors bg-card"
            >
              <input
                type="checkbox"
                :checked="newCollectionIds.includes(col.id)"
                class="accent-primary"
                @change="toggleCollection(col.id)"
              />
              <span class="text-sm text-foreground">{{ col.name }}</span>
            </label>
          </div>
        </div>

        <div>
          <label class="settings-label block mb-1.5">On-device folder layout</label>
          <select v-model="newLayout" class="input-field w-full">
            <option v-for="opt in LAYOUT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <p class="text-xs text-muted-foreground mt-1.5">{{ LAYOUT_OPTIONS.find((o) => o.value === newLayout)?.hint }}</p>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <button
            class="settings-btn-primary"
            :disabled="creating || !newName.trim() || newCollectionIds.length === 0"
            @click="submitCreate()"
          >
            {{ creating ? 'Creating...' : 'Create target' }}
          </button>
          <button class="settings-btn-outline" @click="cancelCreate()">Cancel</button>
        </div>
      </div>

      <!-- Empty state -->
      <div v-if="targets.length === 0 && !showCreateForm" class="border border-border rounded-lg px-5 py-10 bg-card text-center shadow-xs">
        <div class="w-10 h-10 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
          <Smartphone :size="18" class="text-muted-foreground/70" />
        </div>
        <p class="text-sm font-medium text-foreground">No sync targets yet</p>
        <p class="text-xs text-muted-foreground mt-1 max-w-[280px] mx-auto">
          Create a sync target to automatically deliver your collection to a KOReader device via Syncthing.
        </p>
      </div>

      <!-- Target cards -->
      <div v-if="targets.length > 0" class="space-y-3">
        <div
          v-for="target in targets"
          :key="target.id"
          class="border border-border rounded-lg bg-card shadow-xs overflow-hidden"
        >
          <!-- Card header -->
          <div class="flex items-center gap-3 px-5 py-4">
            <div class="w-9 h-9 rounded-lg bg-muted flex items-center justify-center text-muted-foreground shrink-0 border border-border">
              <Smartphone :size="16" />
            </div>
            <div class="flex-1 min-w-0">
              <p class="settings-label leading-none mb-1.5 truncate">{{ target.name }}</p>
              <div class="flex items-center gap-2 flex-wrap">
                <span
                  class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                  :class="{
                    'bg-muted text-muted-foreground': target.status === 'idle',
                    'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400': target.status === 'syncing',
                    'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400': target.status === 'reconciling',
                    'bg-destructive/10 text-destructive': target.status === 'error',
                  }"
                >
                  {{ statusLabel(target.status) }}
                </span>
                <span class="text-xs text-muted-foreground truncate">{{ collectionNames(target.collectionIds) }}</span>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button
                class="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                :class="{ 'animate-spin': reconcilingTarget === target.id }"
                :disabled="reconcilingTarget === target.id"
                title="Sync now — push collection changes to the device immediately"
                @click="handleReconcile(target.id)"
              >
                <RefreshCw :size="14" />
              </button>
              <button
                class="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="Delete sync target"
                @click="handleDelete(target)"
              >
                <Trash2 :size="14" />
              </button>
              <button
                class="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                @click="toggleExpand(target.id)"
              >
                <ChevronUp v-if="expandedIds.includes(target.id)" :size="14" />
                <ChevronDown v-else :size="14" />
              </button>
            </div>
          </div>

          <!-- Progress bar (when paired) -->
          <div v-if="target.deviceId && syncCompletion(target.id) !== null" class="px-5 pb-3">
            <div class="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
              <span>Sync progress</span>
              <span class="font-mono font-medium">{{ syncCompletion(target.id) }}%</span>
            </div>
            <div class="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                class="h-full bg-primary rounded-full transition-all duration-500"
                :style="{ width: `${syncCompletion(target.id)}%` }"
              />
            </div>
            <p class="text-xs text-muted-foreground mt-1.5">Last synced: {{ formatTime(target.lastSyncedAt) }}</p>
          </div>

          <!-- Error message -->
          <div
            v-if="target.status === 'error' && target.lastError"
            class="mx-5 mb-3 flex items-start gap-2 text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md px-3 py-2"
          >
            <AlertCircle :size="12" class="shrink-0 mt-0.5" />
            {{ target.lastError }}
          </div>

          <!-- Expanded panel -->
          <div v-if="expandedIds.includes(target.id)" class="border-t border-border">
            <div class="p-5 space-y-5">

              <!-- Folder layout -->
              <div>
                <p class="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2.5">On-Device Folder Layout</p>
                <select
                  :value="target.layout"
                  :disabled="updatingLayout === target.id"
                  class="input-field w-full"
                  @change="handleLayoutChange(target, ($event.target as HTMLSelectElement).value as SyncLayout)"
                >
                  <option v-for="opt in LAYOUT_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <p class="text-xs text-muted-foreground mt-1.5">
                  {{ LAYOUT_OPTIONS.find((o) => o.value === target.layout)?.hint }}
                  Changing this re-links and re-syncs all files to the device.
                </p>
              </div>

              <!-- Our Syncthing device ID + QR -->
              <div v-if="ourDeviceId(target.id)">
                <p class="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2.5">BookOrbit Syncthing Device ID</p>
                <div class="flex items-start gap-4">
                  <div class="flex-1 min-w-0 space-y-2">
                    <div class="flex items-center gap-2 px-3 py-2.5 rounded-md border border-border bg-muted/30">
                      <Server :size="14" class="text-muted-foreground shrink-0" />
                      <span class="flex-1 text-xs font-mono text-foreground select-all truncate min-w-0">
                        {{ ourDeviceId(target.id) }}
                      </span>
                      <button
                        class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border bg-background hover:bg-muted transition-colors shrink-0"
                        @click="copyText(ourDeviceId(target.id)!, 'Device ID')"
                      >
                        <Copy :size="11" />
                        Copy
                      </button>
                    </div>
                    <p class="text-xs text-muted-foreground">Add this device ID in the Syncthing plugin on your KOReader device.</p>
                  </div>
                  <div v-if="qrCodeCache[ourDeviceId(target.id)!]" class="shrink-0">
                    <img
                      :src="qrCodeCache[ourDeviceId(target.id)!]"
                      alt="QR code for Syncthing device ID"
                      class="w-24 h-24 rounded border border-border bg-white"
                    />
                  </div>
                </div>
              </div>

              <!-- Paired device status -->
              <div
                v-if="target.deviceId && !pendingDevices(target.id).length"
                class="flex items-center gap-2 text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900/40 rounded-md px-3 py-2"
              >
                <Check :size="13" class="shrink-0" />
                <span>Device paired — files are being delivered automatically</span>
              </div>

              <!-- Pending devices -->
              <div v-if="pendingDevices(target.id).length > 0">
                <p class="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">Pending Devices</p>
                <div class="space-y-2">
                  <div
                    v-for="device in pendingDevices(target.id)"
                    :key="device.deviceId"
                    class="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20"
                  >
                    <Wifi :size="16" class="text-amber-600 dark:text-amber-400 shrink-0" />
                    <div class="flex-1 min-w-0">
                      <p class="text-xs font-medium text-foreground truncate">{{ device.name ?? 'Unknown device' }}</p>
                      <p class="text-[11px] text-muted-foreground font-mono truncate">{{ device.deviceId }}</p>
                      <p class="text-[11px] text-muted-foreground">Seen {{ formatTime(device.seen) }}</p>
                    </div>
                    <button
                      class="settings-btn-primary shrink-0 flex items-center gap-1.5"
                      :disabled="acceptingTarget === target.id"
                      @click="handleAcceptDevice(target, device.deviceId)"
                    >
                      <Check :size="12" />
                      {{ acceptingTarget === target.id ? 'Accepting...' : 'Accept' }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Setup instructions (shown until device is paired) -->
              <div v-if="!target.deviceId" class="bg-muted/30 rounded-lg border border-border p-4">
                <p class="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2.5">Setup Instructions</p>
                <ol class="text-xs text-muted-foreground space-y-2 list-decimal list-inside leading-relaxed">
                  <li>Install <strong class="text-foreground">KOReader</strong> on your device (e.g. Kobo, Kindle, PocketBook).</li>
                  <li>
                    Install the
                    <strong class="text-foreground">KOSyncthing+ plugin</strong>
                    — see
                    <strong class="text-foreground">github.com/d0nizam/kosyncthing_plus.koplugin</strong>
                    for the plugin and setup guide.
                  </li>
                  <li>In the plugin, open <strong class="text-foreground">Setup → Pair with another device</strong> and add the <strong class="text-foreground">BookOrbit device ID</strong> shown above.</li>
                  <li>A confirmation will appear here — click <strong class="text-foreground">Accept</strong> to approve the connection.</li>
                  <li>
                    On your device, accept the shared folder and set the path to
                    <code class="bg-muted px-1 py-0.5 rounded font-mono">/mnt/onboard/books</code>
                    (or your preferred location).
                  </li>
                  <li>Your collection will sync automatically whenever BookOrbit and the device are on the same network.</li>
                </ol>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>
