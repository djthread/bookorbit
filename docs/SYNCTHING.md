# Syncthing — Device Sync Setup Guide

BookOrbit can automatically deliver your collection files to a device over a local network using **Syncthing** as the transport — any device that runs Syncthing and reads books from a folder works. No cloud account or manual cable transfers are needed.

This guide walks through the most common setup: a **KOReader** device (Kobo, Kindle, PocketBook, Android, …). The same steps apply to any other Syncthing target — just point its synced folder wherever your reading app expects books.

**How it works:**

```
BookOrbit                            Your KOReader device
─────────────────────────────────    ─────────────────────────────────
Sync target (collection mapping)     KOReader Syncthing plugin
    │                                    │
    ▼  hardlinks/copies to export dir   ▼
Bundled Syncthing ──── P2P sync ────► Syncthing on KOReader
    │                                    │
    └── sends each book in              └── lands in /mnt/onboard/books
        Author/Title.epub                    (or your chosen path)
```

---

## Requirements

- BookOrbit running via Docker Compose.
- A KOReader-compatible device (any device KOReader runs on).
- The [KOSyncthing+ plugin](https://github.com/d0nizam/kosyncthing_plus.koplugin) installed on your device.
- Both BookOrbit and the device on the **same local network** (or reachable via the internet if `SYNCTHING_SYNC_PORT` is forwarded).

---

## Step 1 — Enable the Syncthing sidecar in BookOrbit

### 1a. Generate an API key

```bash
openssl rand -hex 32
```

Copy the output — you'll use it as `SYNCTHING_API_KEY`.

### 1b. Edit `.env`

Add or uncomment these lines in your `.env` file:

```dotenv
# Enable the Syncthing sync module
SYNC_ENABLED=true

# Must match STGUIAPIKEY in the Syncthing container
SYNCTHING_API_KEY=<paste-your-generated-key>
```

See `.env.example` for the full list of optional overrides (`SYNCTHING_URL`, `SYNC_EXPORT_PATH`, `SYNCTHING_SYNC_PORT`, `SYNCTHING_GUI_PORT`).

### 1c. Start with the `sync` profile

The Syncthing sidecar is only launched when the `sync` profile is active:

```bash
docker compose --profile sync up -d
```

To make this permanent in a `docker compose` alias or systemd unit, set `COMPOSE_PROFILES=sync` in your shell or `.env` file.

### 1d. Verify Syncthing is healthy

```bash
docker compose ps
```

You should see `bookorbit-syncthing` with status `healthy`. If it is stuck in `starting`, check the logs:

```bash
docker compose logs syncthing
```

---

## Step 2 — Create a sync target in BookOrbit

1. Open BookOrbit in your browser and go to **Settings → Integrations → Syncthing**.
2. Click **New target**.
3. Enter a name (e.g. `Kobo Libra`) and select one or more collections to sync.
4. Click **Create target**.

A pairing panel opens, showing BookOrbit's **Syncthing Device ID** and a QR code.

---

## Step 3 — Install the KOSyncthing+ plugin

> Skip this step if you already have the plugin installed.

We recommend the [**KOSyncthing+** plugin](https://github.com/d0nizam/kosyncthing_plus.koplugin). It bundles its own Syncthing binary with automatic architecture detection and works out of the box on Kobo, Kindle, and other KOReader devices.

### On a Kobo / Kindle / other KOReader device

1. Download the latest `kosyncthing_plus.koplugin.zip` from the [releases page](https://github.com/d0nizam/kosyncthing_plus.koplugin/releases).
2. Extract and copy the `kosyncthing_plus.koplugin/` folder into your KOReader `plugins/` directory:
   - **Kobo:** `/mnt/onboard/.adds/koreader/plugins/`
   - **Kindle:** `/mnt/us/koreader/plugins/`
   - **Android:** `/koreader/plugins/`
3. Restart KOReader. The plugin appears as **KOSyncthing+** under **☰ → Tools**.

> On Android you can instead point `SYNCTHING_URL` at an existing Syncthing app and skip the on-device plugin entirely.

---

## Step 4 — Pair the device

### On your KOReader device

1. Open KOReader, tap the top menu, and go to **☰ → Tools → KOSyncthing+**.
2. Start Syncthing from the plugin menu.
3. (Optional) Under **Network access**, choose **LAN only** if BookOrbit and the device are on the same network, or **Global** to also use relays/global discovery for sync over the internet.
4. Open **Setup → Pair with another device** and add BookOrbit's Device ID from the pairing panel — scan the QR code or enter the ID manually.

### In BookOrbit

After a few seconds, the device will appear in the **Pending Devices** list on the pairing panel.

Click **Accept** to approve the connection.

### On your KOReader device (accept the folder)

KOSyncthing+ will detect the shared folder (see the **Status & conflicts** menu). Accept it and set the local path to where you want your books — the plugin suggests a default but you can edit it (e.g. `/mnt/onboard/books`).

---

## Step 5 — Verify sync

Once paired, BookOrbit reconciles your collection immediately and Syncthing transfers the files. In BookOrbit the pairing panel collapses and shows a **progress bar** (0–100%).

On your device, the books appear in the folder you chose in Step 4. KOReader can scan for new books via **File manager → Refresh**.

---

## LAN-only sync (no relays or internet)

By default Syncthing can fall back to public **relay** and **global-discovery** servers so devices find each other over the internet. If BookOrbit and your device are always on the same local network, you can turn those off — sync stays entirely on your LAN, which is more private and removes any dependency on Syncthing's public infrastructure.

**On the device (KOSyncthing+):** set **Network access → LAN only**. This disables global announcement, relays, and auto-upgrade.

**On BookOrbit's Syncthing node:** disable global discovery and relays in the Syncthing GUI (**Actions → Settings → Connections**, uncheck *Global Discovery* and *Enable Relaying*), or via the REST API:

```bash
curl -X PATCH -H "X-API-Key: $SYNCTHING_API_KEY" \
  http://127.0.0.1:8384/rest/config/options \
  -d '{"globalAnnounceEnabled":false,"relaysEnabled":false,"natEnabled":false}'
```

**Make sure the two nodes can still find each other on the LAN.** With the default bridge networking, local discovery (UDP broadcast) does not reach the container, so use **one** of:

- **Host networking (simplest, Linux):** run the sidecar on the host network so local discovery works with zero extra config. Create `docker-compose.override.yml`:

  ```yaml
  services:
    syncthing:
      network_mode: host
  ```

  (The `ports:` mappings are ignored in host mode — Syncthing binds directly to the host.) Then pair as usual; the device discovers BookOrbit automatically.

- **Direct address (keep bridge networking):** the sync port is already published, so add BookOrbit's node on the device with an explicit address `tcp://<bookorbit-host-ip>:22000` — no discovery needed.

To stop publishing the sync port to the LAN entirely (e.g. host-network or relay-only setups), set `SYNCTHING_SYNC_BIND=127.0.0.1` in `.env`.

---

## Using an external Syncthing instance

If you already run your own Syncthing, you don't need the bundled sidecar. Point BookOrbit at it instead:

1. Leave `docker compose --profile sync` off (omit the profile).
2. Add to `.env`:

```dotenv
SYNC_ENABLED=true
SYNCTHING_URL=http://<your-syncthing-host>:<port>
SYNCTHING_API_KEY=<your-existing-api-key>
```

BookOrbit will create and manage a send-only folder in your Syncthing instance. The export directory on disk defaults to `./data/app/sync`; override it with `SYNC_EXPORT_PATH` if needed.

---

## Triggering a manual sync

BookOrbit syncs automatically: collection changes reconcile within seconds, and a periodic safety sweep catches anything else. To push immediately instead of waiting, go to **Settings → Integrations → Syncthing** and click the **Sync now** button on any sync target (re-scans your collections, updates the export folder, and tells Syncthing to push).

This is useful right after editing a collection or book metadata, or if you believe the on-device state drifted.

---

## Troubleshooting

### Syncthing container does not start

- Check `SYNCTHING_API_KEY` is set in `.env` and matches `STGUIAPIKEY` passed to the container.
- Inspect logs: `docker compose logs syncthing`.

### "Syncthing is not enabled on this server" error

`SYNC_ENABLED` is `false` (the default). Set `SYNC_ENABLED=true` in `.env` and restart the `app` container.

### Pending device list is empty even though the device shows BookOrbit's device ID

- Ensure both BookOrbit and your device are on the same network and can reach each other on port 22000 (or the port you set via `SYNCTHING_SYNC_PORT`).
- Check that the Syncthing daemon on the device is actually running (the plugin must be started from within KOReader).
- Syncthing device discovery can take 30–60 seconds. Refresh the status panel after waiting.

### Books do not appear in KOReader after accepting the folder

- Confirm the local path on the device is correct and writable.
- In the KOReader Syncthing plugin, check for error messages on the folder entry.
- KOReader does not watch the filesystem continuously. Use **File manager → Refresh** (or the sweep icon) to force a rescan.

### Sync target shows "Error" status

The `lastError` field in the status panel contains the specific error message. Common causes:

| Error | Resolution |
|---|---|
| Syncthing is unreachable | Check that the sidecar is healthy and `SYNCTHING_URL` is correct. |
| Source file missing | The book's `absolutePath` no longer exists on disk. Remove the book from the collection or re-scan the library. |
| Export directory not writable | Ensure `./data/app` is writable by the container's UID/GID (`PUID`/`PGID`). |

### The device keeps going "out of sync" / progress drops back to 0%

A sync that completes and then immediately reads as out of sync (BookOrbit shows a
low or `0%` progress even though the device's Syncthing says "Up to Date") almost
always means the **receive-only folder on the device is being modified locally**.
There are two common sources:

1. **Filesystem permissions.** E-readers use FAT/exFAT storage, which can't store
   Unix permission bits. If Syncthing sends permission metadata the device can't
   apply, the device flags the received files — *including the book files
   themselves* — as locally changed on its next scan. Those local changes diverge
   from BookOrbit's copies, so the server reports the device as needing every file
   again.

   BookOrbit sets **`ignorePerms: true`** on the folders it creates, which marks
   files "no permission bits" so receivers stop churning on them. If you created a
   sync target on an older version, apply it to the existing folder once:

   ```bash
   curl -X PATCH -H "X-API-Key: $SYNCTHING_API_KEY" \
     http://127.0.0.1:8384/rest/config/folders/<folder-id> \
     -d '{"ignorePerms":true}'
   ```

   Then, on the device, choose **Revert Local Changes** on the folder once to pull
   BookOrbit's versions cleanly. It should stay in sync afterward.

2. **KOReader sidecar files.** KOReader writes a `<book>.sdr/` folder (reading
   position, bookmarks, per-book settings) next to each book. On a receive-only
   folder these appear as **Local Additions** and keep the folder looking out of
   sync. Either:
   - Add a `.stignore` entry on the device folder (via the KOSyncthing+ ignore
     patterns) so the sidecars are ignored:

     ```
     *.sdr
     ```

   - Or configure KOReader to store its metadata in a central `koreader/docsettings`
     directory instead of alongside each book, keeping the synced folder limited to
     the book files.

> The device folder must be **Receive Only** — BookOrbit's side is Send Only, so the
> device has to be the receiver. If both sides are Send Only, nothing transfers and
> both report `0%`.

---

## Storage notes

When BookOrbit exports a book it tries to **hardlink** it into the sync folder (the file shares disk blocks with the library copy — near-zero extra storage) and falls back to **copying** when a hardlink isn't possible (each synced book then occupies extra space equal to its file size).

- **Hardlinks:** used when the library and the export directory are on the **same mount point** inside the container.
- **Copies:** used otherwise — the kernel returns `EXDEV` ("cross-device link") and BookOrbit copies instead.

> **Same filesystem is not enough — it must be the same mount.** `link(2)` fails across different mount points *even when both point at the same physical filesystem*. In the default `docker-compose.yml`, your library (`/books`) and the export directory (under `/data`) are **two separate bind mounts**, so hardlinks never succeed even if `./books` and `./data/app` live on the same XFS/ext4 volume on the host. This is a hard kernel limitation, not a BookOrbit choice.

> **A nested host path does not help.** Relocating the library's *host* directory to sit physically inside `./data/app` (e.g. `BOOKS_HOST_PATH=./data/app/books`) still leaves it mounted at container target `/books`, which Docker creates as its own bind mount — separate from `/data`. What matters is the **mount as seen inside the container**, not where the host directories nest. The library has to be *reached through* the same mount as the export directory.

**To get hardlinks, put the library and the export directory under a single mount inside the container.** There are two ways to do this — pick whichever fits your setup:

### Option A — keep the export *inside* the books mount

Best if your library already lives at `/books` and you don't want to reorganize it.

1. In `.env`, point the export path at a hidden subdirectory of the books mount:

   ```dotenv
   SYNC_EXPORT_PATH=/books/.bookorbit-sync
   ```

2. Give the Syncthing sidecar the same books mount so it can serve that directory. In `docker-compose.yml` (or a `docker-compose.override.yml`), add the books volume to the `syncthing` service so its path matches the app's:

   ```yaml
   services:
     syncthing:
       volumes:
         - ${BOOKS_HOST_PATH:-./books}:/books
   ```

### Option B — keep the library *inside* the `/data` mount

Best for fresh setups, because the `syncthing` sidecar **already** mounts `./data/app:/data`, so it needs **no compose edit** to serve the export. Both the library and the default export directory (`/data/sync`) then live on the single shared `/data` mount.

1. Store your library under the app data directory on the host (e.g. `./data/app/books`) so it is reachable inside the container through the existing `/data` mount at `/data/books`. When you create the library in BookOrbit (**Libraries → New library → Scan folders**), add **`/data/books`** as the scan folder — not `/books`. Leave `SYNC_EXPORT_PATH` unset so it keeps the `/data/sync` default.

2. The separate `/books` bind mount in the `app` service becomes unused; you can leave it or remove it. No change to the `syncthing` service is needed — it already has `/data`.

### Then, for either option

Recreate the containers (`docker compose up -d`) and **recreate your sync targets** (the export path is fixed per target when it's created, so existing targets keep their old copy-based path). New targets will hardlink.

Each sync target shows which mode it's actually using: a **Hardlinked** or **Copied** badge appears next to the target's status in **Settings → Integrations → Syncthing**, and the expanded panel explains the trade-off. The mode is verified on each reconcile (collection change, **Sync now**, or the periodic sweep) by attempting a real hardlink in the export directory, so it reflects what genuinely happens — not just whether the volumes happen to share a filesystem. A **Mixed** badge means your library spans multiple mounts relative to the export directory (some books hardlink, others copy).
