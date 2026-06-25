# Device Sync — KOReader + Syncthing Setup Guide

BookOrbit can automatically deliver your collection files to a KOReader device (Kobo, Kindle, PocketBook, Android, …) over a local network using **Syncthing** as the transport. No cloud account or manual cable transfers are needed.

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
- The [KOReader Syncthing plugin](https://github.com/jasonchoimtt/koreader-syncthing) installed on your device.
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
# Enable the device sync module
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

1. Open BookOrbit in your browser and go to **Settings → Integrations → Device Sync**.
2. Click **New target**.
3. Enter a name (e.g. `Kobo Libra`) and select one or more collections to sync.
4. Click **Create target**.

A pairing panel opens, showing BookOrbit's **Syncthing Device ID** and a QR code.

---

## Step 3 — Install the KOReader Syncthing plugin

> Skip this step if you already have the plugin installed.

### On a Kobo running KOReader

1. Download the latest plugin archive from [github.com/jasonchoimtt/koreader-syncthing/releases](https://github.com/jasonchoimtt/koreader-syncthing/releases).
2. Extract and copy the `syncthing.koplugin` folder to `/mnt/onboard/.adds/koreader/plugins/`.
3. The plugin bundles its own Syncthing binary — no separate install needed.
4. Restart KOReader.

### On Android

Install Syncthing from [syncthing.net](https://syncthing.net) (or the F-Droid build), then install the KOReader Syncthing plugin as above. You can also point `SYNCTHING_URL` at your existing Syncthing instance and skip the plugin entirely.

---

## Step 4 — Pair the device

### On your KOReader device

1. Open KOReader, tap the top menu, and go to **Tools → More tools → Syncthing**.
2. Start the Syncthing daemon from within the plugin.
3. Open the plugin settings and tap **Add remote device**.
4. Enter BookOrbit's Device ID from the pairing panel (or scan the QR code).
5. Save.

### In BookOrbit

After a few seconds, the device will appear in the **Pending Devices** list on the pairing panel.

Click **Accept** to approve the connection.

### On your KOReader device (accept the folder)

Back in the Syncthing plugin, you will see a notification about a new shared folder. Accept it and set the local path to where you want your books (e.g. `/mnt/onboard/books`).

---

## Step 5 — Verify sync

Once paired, BookOrbit reconciles your collection immediately and Syncthing transfers the files. In BookOrbit the pairing panel collapses and shows a **progress bar** (0–100%).

On your device, the books appear in the folder you chose in Step 4. KOReader can scan for new books via **File manager → Refresh**.

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

From **Settings → Integrations → Device Sync**, click the **refresh icon** on any sync target to trigger an immediate file reconciliation (re-scan your collections, update the export folder, and tell Syncthing to push).

This is useful after adding books to a collection or if you believe the on-device state drifted.

---

## Troubleshooting

### Syncthing container does not start

- Check `SYNCTHING_API_KEY` is set in `.env` and matches `STGUIAPIKEY` passed to the container.
- Inspect logs: `docker compose logs syncthing`.

### "Device sync is not enabled on this server" error

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

---

## Storage notes

- **Hardlinks (same filesystem):** When the export directory and your book library are on the same Docker volume (`/books` and `/data/app/sync` both on the same host filesystem), BookOrbit uses hardlinks. The files share disk blocks — near-zero extra storage.
- **Copies (cross-filesystem):** If the volumes are on different physical drives or filesystems, BookOrbit falls back to copying. Each synced book occupies additional space equal to its file size.

The BookOrbit UI will surface which mode is in use in a future release. For now, keep your books volume and app-data volume on the same underlying filesystem to benefit from hardlinks.
