# TryHackX Media Server

A self-hosted media server for a home network: one catalogue, one account system and one web
interface for a music and a movie library. Python streams the bytes, PHP holds the session and
the short API, TypeScript renders the interface. The interface language is Polish; the code and
the documentation are English.

> Status: released and in use. It runs on a VPS, on a home server or on a single machine, and
> serves the library at the root of its host. Four shapes are supported — directly on a public
> address, behind a reverse proxy, on a private network without TLS, or on localhost only. Each
> one, together with a complete virtual host to copy
> ([deploy/apache/media-vhost.conf.example](deploy/apache/media-vhost.conf.example)), is described
> in [docs/PUBLIC-EXPOSURE.md](docs/PUBLIC-EXPOSURE.md).

## What it does

- **Transfers** — full and partial HTTP downloads (`Range`, `HEAD`, `ETag`, `If-Range`, `206`,
  `416`) and ZIP64 archives built on the fly with STORE, without a temporary file and without
  buffering the archive in memory.
- **Playback** — audio player with a persistent queue, folder and library-wide shuffle, ratings,
  favourites, collections and audio visualisations; video with a compatibility mode (FFmpeg,
  keyframe seeking, read-ahead, abandoned-stream cleanup) and a persistent WebVTT subtitle cache.
- **Accounts** — its own sign-in, sign-up with e-mail activation, anti-bot protection
  (reCAPTCHA / hCaptcha / Turnstile), a queue of pending accounts with manual activation, and
  self-service password and e-mail changes.
- **Permission groups** — the single source of an account's rights (a guest account is simply a
  member of the system *guest* group): access per library, downloads, ratings, favourites,
  collections, sharing, video compatibility mode and tag editing; plus limits on downloads inside
  a configurable time window, on simultaneous downloads and on simultaneous compatibility streams.
- **Catalogue** — an incremental scanner and a metadata queue (parsed in a separate process with a
  hard timeout).
- **Operations** — an installer, Windows start-up scripts, a systemd unit and a release script for
  Debian 13 (one directory per version behind a `current` symlink, with an automatic rollback when
  the new release fails its health check), CI, a local quality gate and hash-verified dependency
  locks.

All application data (thumbnail cache, subtitles, bundled FFmpeg) lives under `runtime/` inside
the project tree; the only external inputs are the configured media directories. On Debian that
directory is a symlink to `/var/lib/tryhackx-media-server`, so it outlives the release that
created it.

## Why Python for transfers

PHP only checks the session and issues a ticket. It does not read the file, build the ZIP, or hold
a long-running process. An asynchronous Python service moves the bytes, so a PHP worker is never
blocked. Apache can act as a plain reverse proxy without raising global PHP limits or the global
`Timeout`: a connection that is actively transferring is not idle, and an interrupted client can
resume with a Range request.

## Quick start (Windows)

```powershell
$env:MEDIA_SERVER_DB_PASSWORD = 'a-separate-strong-password'
python scripts\install.py --dev --build-frontend --music-root 'E:\Muzyka' --movies-root 'E:\Filmy Video'
scripts\start-windows.bat
```

The installer never overwrites an existing configuration, does not touch Apache, does not create
the database user and does not run migrations without `--migrate`. Python dependencies are
installed from hash-verified locks; caches default to `runtime/` in the project tree.

## Releases (Debian)

```bash
sudo scripts/release-debian.sh --build-frontend --migrate   # deploy beside the running version
sudo scripts/release-debian.sh --rollback                   # back to the previous release
scripts/release-debian.sh --list                            # what is installed, what is active
```

Each release is built in its own directory and `current` is switched only after the install, the
migrations, the service restart and `health/ready` all succeed; a release that does not answer is
rolled back automatically. The full first-install sequence is in
[docs/INSTALL-DEBIAN.md](docs/INSTALL-DEBIAN.md).

## Commands

```text
media-server check
media-server check --database
media-server migrate
media-server scan --root music --kind music
media-server scan --root music --kind music --metadata --apply
media-server metadata-worker --limit 500 --timeout-seconds 15
media-server scan --root movies --kind movies --apply
media-server maintenance                    # one scheduled run: scan, metadata queue, film lookups
media-server maintenance --only metadata
media-server serve
media-server token file music "Artist/Album/song.flac" --inline
```

Before a change and before a release (the same checks CI runs):

```text
python scripts/check.py            # ruff, pytest, php -l, tsc, production build, node tests, secret scan
python scripts/check.py --audit    # additionally pip-audit and npm audit
python scripts/lock-deps.py        # refresh requirements*.lock (needs uv)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Windows + WAMP install](docs/INSTALL-WINDOWS.md)
- [Debian 13 install](docs/INSTALL-DEBIAN.md)
- [Exposing it publicly](docs/PUBLIC-EXPOSURE.md)
- [Roadmap](docs/ROADMAP.md) · [Changelog](docs/CHANGELOG.md)
- [Catalogue worker](docs/CATALOG-WORKER.md)
- [Shared frontend](docs/FRONTEND.md)
- [Security policy](SECURITY.md)

## Requirements

Python 3.11+, PHP 8.1+ with OpenSSL, MySQL 8.x or MariaDB 10.4+, Apache 2.4 with `proxy`,
`proxy_http` and `headers` — plus `ssl` for anything reachable over a network, because signing in
over plain HTTP is refused. Node.js is needed only to build the frontend from source. FFmpeg is
required for the video compatibility mode, thumbnails and subtitle extraction.

## Licence

MIT — see [LICENSE](LICENSE). Attribution and the origin of the transfer design are described in
[NOTICE.md](NOTICE.md).
