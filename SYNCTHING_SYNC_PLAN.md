# Device Sync (Syncthing) — Implementation Plan

Auto-deliver the files of a chosen collection to a Kobo running KOReader, using
Syncthing as the transport. BookOrbit stays authoritative; the device receives.

## 1. Background & rationale

### What already exists

- **`Collection.syncToKobo`** (`server/src/db/schema/collections.ts:16`,
  `packages/types/src/collection.ts:7`) drives the `kobo` module, which pushes
  files to the **stock Kobo Nickel reader** over Kobo's store-sync API
  (`server/src/modules/kobo/kobo-sync.controller.ts`). This does not reach KOReader.
- **`koreader` module** (`server/src/modules/koreader/`) is **progress sync only**
  (kosync position/percentage, `packages/types/src/koreader.ts`) plus an OPDS
  catalog (`opds` module) the user browses and downloads from **manually**.

**The gap:** there is no automatic *file* delivery into KOReader's on-device
library. A KOReader user must pull each book by hand over OPDS.

### Why Syncthing

- P2P, no cloud account, resumes well over the Kobo's flaky wifi / e-ink sleep cycles.
- A maintained [KOSyncthing+ plugin](https://github.com/d0nizam/kosyncthing_plus.koplugin)
  runs the receiving side **inside KOReader** (bundles its own Syncthing binary and
  a CA cert bundle, so it works on Kobo devices without a system certificate store).
- Full [REST API](https://docs.syncthing.net/dev/rest.html) (auth `X-API-Key`), so
  BookOrbit can drive pairing + folder sharing programmatically instead of making
  the user hand-edit Syncthing config.

### Key constraint that shapes the design

Syncthing syncs a **folder**, not a database query. BookOrbit's book files live at
arbitrary `absolutePath`s scattered across library folders
(`server/src/modules/book/book.repository.ts`). So the core of this feature is a
**materialization layer** that reconciles a dynamic collection into a dedicated,
KOReader-friendly folder. Syncthing then replicates that folder.

### Chosen approach (approved)

- **Bundled Syncthing** sidecar container; BookOrbit owns its API key and drives it
  via REST. One-click pairing for the user.
- **Managed hardlink/copy export dir** per sync target (respects collection
  boundaries, gives a clean `Author/Title.epub` tree, never leaks the whole library).
- **Send-only** folder (BookOrbit authoritative). Two-way (highlights/sidecars) is a
  later option.

## 2. Architecture overview

```
Collection ──┐
             │  reconciler (hardlink/copy + prune)
             ▼
   data/sync/<target>/Author/Title.epub   ◄── managed export dir
             │
             │  shared as send-only Syncthing folder
             ▼
   Syncthing (bundled sidecar)  ──REST──  BookOrbit sync module
             │  P2P
             ▼
   Kobo: KOReader + syncthing plugin  →  /mnt/onboard/...  →  KOReader library
```

## 3. Data model

New schema file `server/src/db/schema/sync-targets.ts`:

- **`sync_targets`**
  - `id`, `userId` (FK users, cascade)
  - `name` (text), unique per user (mirror `collections_user_name_uidx`)
  - `syncthingFolderId` (text) — Syncthing folder ID we generate
  - `exportPath` (text) — managed dir, e.g. `<appDataPath>/sync/<id>`
  - `deviceId` (text, nullable) — paired Kobo device ID
  - `mode` (text, default `'sendonly'`)
  - `status` (text: `idle | reconciling | syncing | error`)
  - `lastCompletion` (integer, nullable) — % from `/rest/db/completion`
  - `lastSyncedAt` (timestamp, nullable), `lastError` (text, nullable)
  - `createdAt` / `updatedAt` (match collections' timestamp pattern)
- **`sync_target_collections`** join table
  - `syncTargetId` (FK cascade), `collectionId` (FK cascade), PK both columns.
  - A target syncs the union of one or more collections (keeps `syncToKobo` untouched).

Register in `server/src/db/schema/` barrel, then generate a migration:
`pnpm --filter server db:generate add_sync_targets` → produces
`server/src/db/migrations/0024_*.sql` (current head is `0023`). Snapshot/meta files
are written by drizzle-kit; do not hand-edit.

Types: add `packages/types/src/sync-target.ts` (`SyncTarget`, `SyncTargetStatus`,
`CreateSyncTargetPayload`, `SyncTargetProgress`, `PendingDevice`) and export from
`packages/types/src/index.ts`.

## 4. Server: `sync` module

New `server/src/modules/sync/` following the existing module layout
(see `collection/` and `koreader/` for the controller/service/repository/module +
`.test.ts` per file pattern, and `dto/` for request DTOs).

- **`sync.module.ts`** — wires controller/service/repository; imports `BookModule`,
  `CollectionModule`, `ConfigModule`. Registered in `server/src/app.module.ts`.
- **`sync.repository.ts`** — CRUD over `sync_targets` / `sync_target_collections`;
  resolve a target's book files (reuse `BookRepository` file-path queries around
  `book.repository.ts:1159`).
- **`syncthing-client.service.ts`** — thin typed wrapper over the Syncthing REST API
  (`undici`/fetch + `X-API-Key`). Methods:
  - `getDeviceId()` → `GET /rest/svc/deviceid` (our node's ID, shown to user).
  - `ensureFolder(target)` → `GET /rest/config/defaults/folder`, mutate
    `id/label/path/type=sendonly/devices`, `POST /rest/config/folders`.
  - `ensureDevice(deviceId)` → `GET /rest/config/defaults/device`, `POST /rest/config/devices`.
  - `listPendingDevices()` → `GET /rest/cluster/pending/devices`.
  - `acceptDevice(deviceId)` → add device, then add it to the folder's `devices`.
  - `getCompletion(folderId, deviceId)` → `GET /rest/db/completion`.
  - `rescan(folderId)` → `POST /rest/db/scan` after a reconcile.
  - Connection config (base URL + API key) from `storageConfig`/env (see §6).
- **`sync-reconciler.service.ts`** — the core logic:
  1. Resolve the union of files for the target's collections (`bookId`, `absolutePath`,
     `format`).
  2. Compute desired relative paths with the existing filename resolver
     (`book.service.ts` `resolveDownloadFilename*`, ~`:1146`) → `Author/Title.ext`.
  3. Diff against current export dir contents; **hardlink** new files when
     `exportPath` and source share a device (fall back to **copy** across filesystems;
     use the `path` module's safety patterns — no symlink traversal,
     `server/src/modules/path/path.service.ts`).
  4. **Prune** files no longer in the collection union.
  5. `rescan()` the Syncthing folder; update `status`/`lastSyncedAt`.
  - Trigger on: collection membership change (hook `CollectionService.addBooks/removeBooks`
    at `collection.service.ts:173/197`), target create/update, and a periodic
    safety sweep (NestJS `@Cron`/scheduler, debounced like
    `fileWriteConfig.debounceMs`).
- **`sync.service.ts`** — orchestration + ownership checks
  (`findCollectionForUserOrThrow` pattern, `collection.service.ts:56`).
- **`sync.controller.ts`** — REST under `/sync`:
  - `GET /sync/targets`, `POST /sync/targets`, `PATCH/DELETE /sync/targets/:id`
  - `GET /sync/targets/:id/status` (device ID, completion %, pending devices, errors)
  - `POST /sync/targets/:id/accept-device` `{ deviceId }`
  - `POST /sync/targets/:id/reconcile` (manual trigger)

## 5. Client: "Device Sync" UI (Vue)

- New `client/src/features/sync/` (mirror `features/collection/` and
  `features/settings/`): components + composables + a pinia store + a service in
  `client/src/services/`.
- Settings entry (new `SyncSettings.vue` alongside the `features/settings/*Settings.vue`
  files) and/or a panel on the collection detail view.
- Flow:
  1. Create target → pick collection(s).
  2. **Pairing screen:** show BookOrbit's Syncthing device ID as text + **QR code**,
     with step-by-step Kobo instructions (install KOReader + NickelMenu +
     KOSyncthing+ plugin; add this device; accept the shared folder under `/mnt/onboard`).
  3. **Accept device:** poll `GET /sync/targets/:id/status`; when the Kobo appears in
     pending devices, surface an **Accept** button.
  4. **Progress:** live bar from completion %, file count, last-synced, errors.

## 6. Config & deployment

- **Bundled Syncthing** service in `docker-compose.yml` (sidecar next to `app`/`postgres`):
  - `image: syncthing/syncthing` (pin by digest, matching repo convention at
    `docker-compose.yml:65`).
  - Shared volume so the `app` container's `exportPath`
    (`<APP_DATA_PATH>/sync`) is the same path Syncthing exports; also mount the
    library/books volume **read-only** so hardlinks resolve.
  - Expose `8384` (GUI, optional) and `22000` (sync) per Syncthing docs.
  - Pre-seed an API key + GUI config so `app` can talk to it on first boot
    (`STGUIAPIKEY` env or generated config).
- **Env / `env.validation.ts`** (`server/src/config/env.validation.ts`) + `config.ts`
  `storageConfig`:
  - `SYNCTHING_URL` (default `http://syncthing:8384`)
  - `SYNCTHING_API_KEY`
  - `SYNC_EXPORT_PATH` (default `join(appDataPath, 'sync')`)
  - Feature flag `SYNC_ENABLED` (default off) so the module is inert when no
    Syncthing is configured.
- Document all of the above in `.env.example` and `docker-compose.yml` comments;
  add an **external Syncthing** note (point `SYNCTHING_URL`/`_API_KEY` at an existing
  instance instead of the sidecar).

## 7. Testing

- **Server unit** (`*.test.ts` next to each file, per repo convention):
  - `sync-reconciler.service.test.ts`: hardlink-vs-copy selection, path safety,
    diff/prune correctness, filename collisions.
  - `syncthing-client.service.test.ts`: REST payload shaping, error mapping (mock fetch).
  - `sync.service.test.ts` / `sync.repository.test.ts`: ownership, CRUD, collection union.
  - Architecture-boundary test (`modules/architecture/architecture-boundaries.test.ts`)
    stays green with the new module's imports.
- **Client unit:** store + components (`vitest`, matching `features/settings/__tests__`).
- **Migration:** verify `db:generate` output + `pnpm --filter server db:migrate` on a
  fresh DB; baseline/e2e migration suite passes.
- Run `pnpm run verify` (lint + typecheck + test) before PR, per
  `docs/CONTRIBUTING.md`.

## 8. Suggested PR sequencing

1. **Schema + types + migration** (`sync_targets`, join, `0024_*`).
2. **`syncthing-client.service`** (+ tests) against the REST API.
3. **`sync-reconciler.service`** (+ tests) — the materialization core.
4. **`sync.module` controller/service/repository** wiring (+ tests).
5. **docker-compose + env/config** for the bundled sidecar.
6. **Client `features/sync`** UI (pairing, QR, accept, progress).
7. **Docs** (`.env.example`, README Kobo/KOReader section, on-device setup guide).

## 9. Open questions / future

- **Two-way sync** for KOReader `.sdr` sidecars (highlights/progress) — flip folder
  to `sendreceive` and ingest sidecars back into the `annotation`/`koreader` modules.
  Out of scope for v1 (send-only).
- **Per-user vs. shared device:** v1 scopes targets per user; multi-user device
  sharing can come later.
- **Format conversion:** deliver as-is in v1; KOReader reads epub/pdf/cbz/mobi natively.
- **Storage:** hardlinks mean ~zero duplication on the same filesystem; copy fallback
  duplicates — surface that in the UI when crossing filesystems.
