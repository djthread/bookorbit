<div align="center">

# BookOrbit

A self-hosted library management and reading platform for ebooks, PDFs, audiobooks, and comics.

[![Latest release](https://img.shields.io/github/v/release/bookorbit/bookorbit?label=latest&style=flat-square)](https://github.com/bookorbit/bookorbit/releases)
[![Stars](https://img.shields.io/github/stars/bookorbit/bookorbit?style=flat-square&color=FFC72C)](https://github.com/bookorbit/bookorbit/stargazers)
[![CI](https://github.com/bookorbit/bookorbit/actions/workflows/ci.yml/badge.svg)](https://github.com/bookorbit/bookorbit/actions/workflows/ci.yml)
[![Release](https://github.com/bookorbit/bookorbit/actions/workflows/release.yml/badge.svg)](https://github.com/bookorbit/bookorbit/actions/workflows/release.yml)
[![Server Coverage](https://codecov.io/gh/bookorbit/bookorbit/graph/badge.svg?token=F6TADEFCUV&flag=server)](https://codecov.io/gh/bookorbit/bookorbit)

[![Website](https://img.shields.io/badge/Website-bookorbit.app-blue?style=flat-square&logo=googlechrome&logoColor=white&color=4169E1)](https://bookorbit.app)
[![Demo](https://img.shields.io/badge/Demo-live-brightgreen?style=flat-square&logo=rocket&logoColor=white&color=40a829)](https://demo.bookorbit.app/magic?token=2d92cb900e184cf0eb8b11f72cffc6011673d1016e1b300d750eb3d76abc1572)
[![GHCR Pulls](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2Fbookorbit%2Fbookorbit%2Fbookorbit&query=downloadCount&label=Docker%20Pulls&logo=docker&style=flat-square&color=2496ed)](https://github.com/bookorbit/bookorbit/pkgs/container/bookorbit)
[![Discussions](https://img.shields.io/badge/Discussions-GitHub-333?style=flat-square&logo=github&logoColor=white)](https://github.com/bookorbit/bookorbit/discussions)
[![Contributing](https://img.shields.io/badge/Contributing-guide-orange?style=flat-square&logo=handshake&logoColor=white)](https://github.com/bookorbit/bookorbit/blob/main/docs/CONTRIBUTING.md)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=flat-square&color=B461B3)](LICENSE)

<!--
[![GHCR](https://img.shields.io/badge/GHCR-bookorbit%2Fbookorbit-blue?style=flat-square&logo=docker&logoColor=white)](https://github.com/bookorbit/bookorbit/pkgs/container/bookorbit)
[Website](https://bookorbit.app) · [Demo](https://demo.bookorbit.app) · [Discussions](https://github.com/bookorbit/bookorbit/discussions) · [Contributing](https://github.com/bookorbit/bookorbit/blob/main/docs/CONTRIBUTING.md) · [Changelog](https://github.com/bookorbit/bookorbit/releases)
-->

</div>

---

![BookOrbit dashboard showing reading stats, widgets, and book shelves](https://bookorbit.app/images/home/dashboard-overview.webp)

## What is BookOrbit?

**[BookOrbit](https://bookorbit.app)** is a self-hosted digital library and reading platform. Organize and read your books, sync seamlessly with Kobo and KOReader devices, enrich your collection with metadata from multiple providers, and support multiple users with OIDC/SSO authentication and detailed reading statistics. Built-in features include OPDS support, customizable dashboard widgets, Send-to-Kindle delivery, and Smart Scopes for dynamic rule-based shelves and filters - all running on infrastructure you control.

[![Visit Website](https://img.shields.io/badge/Visit%20Website-bookorbit.app-4169E1?style=for-the-badge&logo=googlechrome&logoColor=white)](https://bookorbit.app)

---

## Live Demo

Want to try BookOrbit before installing? Explore the live instance instantly: no account required!

[![Launch Live Demo](https://img.shields.io/badge/Launch%20Live%20Demo-2ea44f?style=for-the-badge&logo=rocket&logoColor=white)](https://demo.bookorbit.app/magic?token=2d92cb900e184cf0eb8b11f72cffc6011673d1016e1b300d750eb3d76abc1572)

_Experience the interface, built-in readers, and dashboard first-hand._

> **Note:** The demo includes a sample library of public domain books. Some administrative features are limited in the public demo. Self-hosting BookOrbit provides the full experience.

---

## Features

### Reading Experience & Sync

- **Built-in Web Readers**: Native support for eBooks (EPUB, MOBI, AZW3), PDFs, Comics (CBZ, CBR), and Audiobooks (M4B, MP3) with no extra plugins required.
- **Kobo & KOReader Integration**: Automatically push books to your Kobo devices and maintain two-way reading progress sync via KOReader over OPDS.
- **Syncthing Device Sync**: Automatically deliver collection files to your devices (KOReader and any other Syncthing target) over a local network using the bundled Syncthing sidecar — no cloud account required. See the [Syncthing setup guide](docs/SYNCTHING.md).
- **Reading Statistics**: Track your daily reading time, view heatmaps, maintain streaks, and monitor library health.

### Library Management

- **Multiple Libraries**: Isolate content with per-library folders, custom scan rules, and format priorities.
- **Rich Metadata Providers**: Fetch robust metadata from Google Books, Amazon, Goodreads, Hardcover, Open Library, Audible, ComicVine, and more.
- **Smart Scopes & Collections**: Organize your collection using curated lists and dynamic, rule-based saved filters.

### Platform & Delivery

- **Multi-User & SSO**: Granular per-user permissions and isolated reading data, with native support for Authentik, Keycloak, and Authelia via OIDC.
- **Content Delivery**: OPDS support for compatible apps, Send-to-Kindle via email, and browser drag-and-drop uploads.
- **Automated Ingestion**: Configure a Book Dock drop folder for hands-free importing.

---

## Quick Start (Docker)

```bash
mkdir bookorbit && cd bookorbit
mkdir -p books data/app data/postgres
curl -fsSLo .env https://raw.githubusercontent.com/bookorbit/bookorbit/main/.env.example
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/bookorbit/bookorbit/main/docker-compose.yml
```

Edit `.env` and set these required values:

```dotenv
APP_URL=http://your-server-ip:3000   # the URL you'll open in your browser
BOOKS_HOST_PATH=./books              # folder on your server where your book files live

POSTGRES_PASSWORD=         # database password           - openssl rand -hex 24
JWT_SECRET=                # signs login tokens          - openssl rand -hex 32
SETUP_BOOTSTRAP_TOKEN=     # one-time setup wizard token - openssl rand -hex 16
```

Then start:

```bash
docker compose up -d
```

Open `http://your-server-ip:3000` and complete setup using your `SETUP_BOOTSTRAP_TOKEN`.

For the full installation guide including reverse proxy setup, file permissions on NAS, external databases, and environment variable reference, see **[bookorbit.app/installation](https://bookorbit.app/installation.html)**.

To enable automatic file delivery to your devices via Syncthing, see **[docs/SYNCTHING.md](docs/SYNCTHING.md)**.

---

## Documentation and Contributing

Full documentation is at **[bookorbit.app](https://bookorbit.app/what-is-bookorbit.html)** - covering libraries, metadata, readers, Kobo sync, OPDS, users and permissions, OIDC setup, and more.

For local development, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). To contribute, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for the full workflow: branch naming, test expectations, PR checklist, and commit format.

---

## Support

- **Questions and discussion:** [GitHub Discussions](https://github.com/bookorbit/bookorbit/discussions)
- **Bug reports:** [GitHub Issues](https://github.com/bookorbit/bookorbit/issues/new?template=bug_report.yml)
- **Feature requests:** [GitHub Issues](https://github.com/bookorbit/bookorbit/issues/new?template=feature_request.yml)

---

## License

BookOrbit is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**.
