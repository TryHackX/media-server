# TryHackX Media Server

A self-hosted server for your music and films: one catalogue, one account system and one web
interface that opens in any browser — at home, or from anywhere through a VPS. It streams and
downloads, keeps a play queue, ratings, favourites, collections and history for every account, and
plays music with Winamp-style visualisations. Python moves the bytes, PHP holds the session and the
short API, TypeScript renders the interface. The interface and the guides in `docs/` are Polish; the
code, its comments and this README are English.

## Support the project

TryHackX Media Server is free and open source under the MIT license, written and maintained in spare
time. If this project is useful to you, please consider a donation — it pays for the servers and
keeps new releases coming. Any amount helps. Thank you!

<table>
  <thead>
    <tr><th>Currency</th><th>Network</th></tr>
  </thead>
  <tbody>
    <tr><td><b>Monero</b> (XMR)</td><td>Monero</td></tr>
    <tr><td colspan="2"><code>45hvee4Jv7qeAm6SrBzXb9YVjb8DkHtFtFh7qkDMxS9zYX3NRi1dV27MtSdVC5X8T1YVoiG8XFiJkh4p9UncqWGxHi4tiwk</code></td></tr>
    <tr><td><b>Bitcoin</b> (BTC)</td><td>Bitcoin (on-chain)</td></tr>
    <tr><td colspan="2"><code>bc1qncavcek4kknpvykedxas8kxash9kdng990qed2</code></td></tr>
    <tr><td><b>Ethereum</b> (ETH)</td><td>Ethereum (mainnet)</td></tr>
    <tr><td colspan="2"><code>0xa3d38d5Cf202598dd782C611e9F43f342C967cF5</code></td></tr>
  </tbody>
</table>

Send each coin only over the network named beside it; a transfer made over a different network may
never arrive. The same addresses are on the home page of
[tracker.tryhackx.org](https://tracker.tryhackx.org/), so each one can be checked against a second
source before you send.

## What it does

- **Transfers** — full and partial HTTP downloads (`Range`, `HEAD`, `ETag`, `If-Range`, `206`,
  `416`) and ZIP64 archives built on the fly with STORE, without a temporary file and without
  buffering the archive in memory.
- **Playback** — an audio player with a persistent queue, folder and library-wide shuffle, ratings,
  favourites and collections; video with a compatibility mode (FFmpeg, keyframe seeking,
  read-ahead, abandoned-stream cleanup) and a persistent WebVTT subtitle cache; a mini player and a
  player sheet on the phone, and an installable app (PWA) over HTTPS.
- **Visualisations** — Winamp AVS on an engine of its own (preset code compiled to WebAssembly, no
  `eval`), MilkDrop with textures, Ryan Geiss's Geiss, Cthugha and other retro programs, VoltViz,
  shader visualisers and the project's own WebGL 2 set, with one search across every preset pack and
  per-account favourite presets. What a given build offers is described under
  [What the interface includes](#what-the-interface-includes).
- **Accounts** — its own sign-in, sign-up with e-mail activation, anti-bot protection
  (reCAPTCHA / hCaptcha / Turnstile or a built-in proof of work), step-up checks and two-factor
  sign-in, a queue of pending accounts with manual activation, self-service password and e-mail
  changes, and account deletion.
- **Permission groups** — the single source of an account's rights (a guest account is simply a
  member of the system *guest* group): access per library, downloads, ratings, favourites,
  collections, sharing, video compatibility mode and tag editing; plus limits on downloads inside
  a configurable time window, on simultaneous downloads and on simultaneous compatibility streams.
- **Catalogue** — an incremental scanner and a metadata queue (parsed in a separate process with a
  hard timeout).
- **Operations** — graphical installer for Windows, an installer for Debian 13, Windows start-up
  scripts, systemd units, a release script for Debian (one directory per version behind a `current`
  symlink, with an automatic rollback when the new release fails its health check), CI, a local
  quality gate, hash-verified dependency locks and an encrypted backup of the secrets.

All application data (thumbnail cache, subtitles, bundled FFmpeg) lives under `runtime/` inside
the installation; the only external inputs are the configured media folders, which are only ever
read. On Debian that directory is a symlink to `/var/lib/tryhackx-media-server`, so it outlives the
release that created it.

## Installing

Pick the installer for your system. Both check the machine, ask a few questions, list every change
they are about to make and change nothing until you confirm. Both can rehearse the whole run
without changing anything, and both are run again later to change settings, update, repair or
uninstall. Neither configures your router or DNS — they tell you the exact values to set.

| | Windows | Debian 13 |
|---|---|---|
| Install first | WampServer 64-bit, started once (from a clone also Node.js LTS — the wizard offers it) | nothing — the installer adds the packages |
| Release archive | `TryHackX-Media-Server-<version>-windows.zip` | `TryHackX-Media-Server-<version>-debian.tar.gz` |
| Start | `Install.cmd` (English) or `Zainstaluj.cmd` (Polish) | `sudo bash zainstaluj-debian.sh` (`--lang en` for English) |
| Rehearsal, no changes | `Install.cmd -DryRun` | `bash zainstaluj-debian.sh --dry-run` |
| Afterwards | run it again | `--zmien`, `--odnow`, `--odinstaluj`, `--status` |
| Full guide (Polish) | [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) | [docs/INSTALL-DEBIAN.md](docs/INSTALL-DEBIAN.md) |

The release archives already contain the built interface, so Node.js is not needed. Everything
personal — folders, the administrator account, passwords, the domain — is entered during the
installation; nothing of the kind ships in the archive.

### From a clone of this repository

A clone carries the sources, not a built interface. Both installers build it — at every
installation and every update, so after `git pull` it is the interface of the pulled code that gets
installed — and the installation receives the result, not the sources. That takes `git`, Node.js
LTS (the installers offer it: `winget` on Windows, Debian's own packages on Debian) and internet
access for the npm dependencies.

```bash
git clone https://github.com/TryHackX/media-server.git
cd media-server
```

**The additional packs.** The collections whose licences forbid publishing them (listed under
[What the interface includes](#what-the-interface-includes)) are kept in a separate **private**
repository, <https://github.com/TryHackX/media-server-vendor>, which opens only for the accounts it
has been shared with. Without it the interface is the public set and everything else works the same.
With access, clone it into `frontend/vendor` **before** running the installer:

```bash
git clone https://github.com/TryHackX/media-server-vendor.git frontend/vendor
```

- **Windows:** `git` comes with [Git for Windows](https://git-scm.com/download/win)
  (`winget install --id Git.Git -e`); the first clone of a private repository opens a GitHub
  sign-in in the browser. Some MilkDrop preset names are long — up to 210 characters below
  `frontend\vendor` — so run `git config --global core.longpaths true` once before cloning, or a
  clone in a deeper folder stops with *Filename too long*.
- **Debian:** `sudo apt install git`. GitHub asks for a user name and, in place of the password, a
  token: a *fine-grained personal access token* limited to `media-server-vendor`, with
  *Contents: Read-only* (GitHub → Settings → Developer settings).
- **Without git:** on the repository's page *Code → Download ZIP*, then unpack it so that its folders
  (`avs-presets`, `fontawesome-pro`, `milkdrop-presets`, …) lie directly in `frontend/vendor`, not in
  `frontend/vendor/media-server-vendor-main`.

Then run the installer as below. It names the packs it found — on Windows in the *Interface* row of
the requirements page, on Debian in the question before the build — which is the moment to check
that the list is complete. The build takes a few minutes.

**Updating** an installation made from clones: pull both, then run the installer's update, which
builds the interface again.

```bash
git pull
git -C frontend/vendor pull
```

On Windows: `Install.cmd` → *Update*. On Debian: `sudo bash zainstaluj-debian.sh --zmien aktualizacja`.

### Windows (WampServer)

**Before you start**

1. Install [WampServer](https://www.wampserver.com/en/) 64-bit (Apache 2.4, PHP 8.1+, MySQL 8.0.19+
   or MariaDB 10.5.2+) together with the Visual C++ packages it asks for, and start it once: its
   tray icon must turn green.
2. Download the `-windows.zip` archive, open its *Properties* and tick **Unblock** (otherwise Windows
   asks for permission at the first start), then unpack the whole archive — or use a clone
   ([above](#from-a-clone-of-this-repository)).
3. Python 3.11+ and FFmpeg can wait: when they are missing, the wizard offers to install them with
   `winget`, links to the official pages, or lets you point at an existing `ffmpeg.exe`.

**Running the wizard**

Double-click `Install.cmd` and approve the administrator prompt — the wizard changes the Apache
configuration, the Windows firewall and Task Scheduler. The account that approves the prompt owns
the installation: both scheduled tasks run as that account, and only it (besides SYSTEM and the
administrators) can read the private configuration. The wizard then walks through ten pages:

1. **Welcome** — the language and what is about to happen.
2. **Requirements** — WampServer, Apache modules, PHP extensions, the database server, Python,
   FFmpeg, the interface (built, or to be built from a clone), ports 80, 443 and 8765 and the free
   disk space, each with its state and a fix. An Apache module that is switched off is switched on
   by the wizard; a missing PHP extension is enabled from WampServer's menu.
3. **Location** — a new folder (`C:\TryHackX\MediaServer` by default; the files are copied there) or
   the unpacked folder itself.
4. **Database** — WampServer's MySQL or MariaDB, an administrator login checked with *Test
   connection*, and the names of the database and of the application's own account, which the
   wizard creates.
5. **Media folders** — each folder with its kind: Music, Movies or Mixed; at least one.
6. **Access** — how the server is reached; see the table below.
7. **Administrator** — the first account of the web interface: name, optional e-mail and a password
   typed twice (12 characters or more).
8. **Summary** — every change that will be made; the optional ones can be unticked.
9. **Progress** — each step with its state and a live log (passwords masked); *Try again* after an
   error.
10. **Done** — the local, home-network and public addresses, *Open in browser* and, in VPS mode, the
    folder with the files for the VPS.

| Access mode | Who can open it | What the wizard sets up |
|---|---|---|
| This computer only | this PC, at `http://localhost/` | the Apache file, nothing else |
| Home network (HTTP) | devices in your home network | the firewall opens port 80 to the local subnet only; passwords travel unencrypted and the app cannot be installed on a phone, which needs HTTPS |
| Your own domain, directly | everyone, at `https://your-domain/` | an HTTPS host with your certificate (PEM files, e.g. from win-acme, or a temporary self-signed one) and HSTS; ports 80 and 443 open; on the router forward 80 and 443 |
| Through a VPS | everyone, at your domain on the VPS; the home address stays hidden | an HTTPS host with a home certificate the VPS pins; port 443 open to the VPS only; `runtime\vps-bundle` with the two VPS hosts, the certificate, a maintenance page, the instructions and `vps-setup.sh`, which sets the VPS up with checks and rollback; on the router forward 443 |

Run the wizard again at any time: it shows the state of the installation and offers six actions —
*Media folders*, *Access mode*, *Add administrator* (also the way back in after a lost password),
*Update* (from a newer package, with a full database backup first), *Repair* and *Uninstall*. Your
media files are never touched.

### Debian 13

**Before you start**

1. A Debian 13 machine with `sudo`, systemd and internet access (packages from `apt`, Python
   dependencies from PyPI). Installed with a root password and no `sudo`? Use `su -` and run
   `bash zainstaluj-debian.sh`.
2. Media folders outside `/home` and `/root` (for example `/srv/media/music`), readable by
   `www-data`. The service runs with `ProtectHome=true` and would not see anything under `/home`, so
   the installer refuses such a path at once.
3. For shape **S** (below): a domain whose DNS record points at this machine, with ports 80 and 443
   reachable from the internet. For shape **P**: a domain, a rented VPS with Debian or Ubuntu, and
   port 443 forwarded on the home router.

**Running the installer**

```bash
tar xzf TryHackX-Media-Server-X.Y.Z-debian.tar.gz
cd TryHackX-Media-Server-X.Y.Z
sudo bash zainstaluj-debian.sh            # --lang en: English; --dry-run: print the plan, change nothing
```

It asks how the server is reached and then only what that shape needs, the media folders (path and
kind), the administrator account and whether to set up the firewall. It creates the database
`media_server` with two accounts of its own — one for the data, one for schema changes. Then it
prints every command and file it is about to run or write, waits for *yes*, and installs:

1. the missing Debian packages (Apache, PHP, MariaDB, FFmpeg; `ufw`, `certbot` and `fail2ban` when
   the chosen options need them) and the Apache modules;
2. the private configuration in `/etc/tryhackx-media-server` and the database;
3. a release in `/opt/tryhackx-media-server/releases/` behind a `current` symlink, with its own
   Python environment and the migrations;
4. the systemd service and timers, the first administrator and the firewall rules;
5. the Apache site — tested with `apache2ctl configtest` and put back as it was if the test fails —
   and, in shape S, the Let's Encrypt certificate; in shape P, the bundle for the VPS;
6. a final check that the service, the site and the bridge answer. The first indexing starts in the
   background.

| Shape | For | Certificate |
|---|---|---|
| **S** — standalone, public | a machine with a public address and its own domain | Let's Encrypt through `certbot` (renews itself), your own files, or a temporary self-signed one |
| **P** — private home + public VPS | a home server whose address stays hidden behind a VPS | the home server's own certificate (10 years), pinned on the VPS; the VPS gets Let's Encrypt. The VPS is set up over SSH right away, or with a bundle you run there |
| **D** — home network only | devices in your home network, over HTTP | none — passwords travel unencrypted |
| **C** — this machine only | the machine itself | none |

Afterwards: `sudo bash zainstaluj-debian.sh --zmien` changes the media folders, the access or the
administrator, or updates to a newer package; `--odnow` replaces the home certificate of shape P
without downtime; `--odinstaluj` removes what the installer set up (never your media files, never
Debian packages); `--status` shows what is installed. Every system file it writes starts with the
line `# TRYHACKX-MEDIA-SERVER-MANAGED v1`, and a copy of every file it replaces is kept in
`/var/backups/tryhackx-media-server/`.

### What the interface includes

The release archives carry every visualiser whose code and presets may be passed on: **Internal**
(the project's own WebGL 2 visualisations), **Favourites**, **MilkDrop** with butterchurn's presets,
**Geiss** (Ryan Geiss's Geiss 4.30, ported from its BSD source), **VoltViz**, **Sound Forms** and
**Retro Classics** (the Atari Video Music and tracker screens). Collections whose licences forbid
redistribution — Winamp AVS preset packs, further MilkDrop packs and their textures, the
Shadertoy-based shaders, Cthugha, VoltViz's non-commercial shaders, Font Awesome Pro — are not in
this repository. They live in the private
[media-server-vendor](https://github.com/TryHackX/media-server-vendor) repository; whoever has
access puts it in `frontend/vendor/` before installing from a clone
([above](#from-a-clone-of-this-repository)), or builds the interface by hand. A build made that way
includes them and offers them on its own (AVS and *Shaders* appear only then). The layout of
`frontend/vendor/` is described in [docs/FRONTEND.md](docs/FRONTEND.md).

Icons are Font Awesome Free and need nothing. With the packs above, the build also carries Font
Awesome Pro (`frontend/vendor/fontawesome-pro/`, the unchanged *web* download — it must never go
into a public repository), and the admin panel offers its sixteen styles (*Appearance → Icons*).

### Installing by hand

The guides describe the same steps as commands, for anyone who wants to see what the installers do
or prefers to do it alone: *Instalacja ręczna* in [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md)
and in [docs/INSTALL-DEBIAN.md](docs/INSTALL-DEBIAN.md). On Windows, from a clone:

```powershell
$env:MEDIA_SERVER_DB_PASSWORD = 'a-separate-strong-password'
python scripts\install.py --dev --build-frontend --music-root 'D:\Music' --movies-root 'D:\Movies'
scripts\start-windows.bat
```

`scripts/install.py` never overwrites an existing configuration, does not touch Apache, does not
create the database user and does not run migrations without `--migrate`. Python dependencies are
installed from hash-verified locks; caches default to `runtime/` in the project tree. A clone has no
built interface, so `--build-frontend` needs Node.js.

## Why Python for transfers

PHP only checks the session and issues a ticket. It does not read the file, build the ZIP, or hold
a long-running process. An asynchronous Python service moves the bytes, so a PHP worker is never
blocked. Apache can act as a plain reverse proxy without raising global PHP limits or the global
`Timeout`: a connection that is actively transferring is not idle, and an interrupted client can
resume with a Range request.

## Releases on Debian

The installer uses this script for every release; it can also be run by hand:

```bash
sudo bash scripts/release-debian.sh --build-frontend --migrate \
    --migrate-config /etc/tryhackx-media-server/config.migrate.toml   # deploy beside the running version
sudo bash scripts/release-debian.sh --rollback                         # back to the previous release
bash scripts/release-debian.sh --list                                  # what is installed, what is active
```

`--migrate-config` names the configuration of the schema account: the application's own account
only reads and writes data, so migrations need the other one (the Debian installer creates both).
The scripts are run through `bash` because a git checkout does not keep them executable.

Each release is built in its own directory and `current` is switched only after the install, the
migrations, the service restart and `health/ready` all succeed; a release that does not answer is
rolled back automatically.

## The first account

Both installers create the first administrator. After an installation by hand there is no account
yet and registration is switched off, so nobody can sign in. Create the first account from the
command line, after the migrations:

```text
media-server account-create --username owner --email owner@example.org
```

It asks for the password twice without echoing it (at least 12 characters). For a script, pass the
password on the first line of standard input with `--password-stdin`; there is deliberately no
option that takes it on the command line, where other users could read it in the process list. The
account is active, confirmed and in the system *user* group; `--role` (`super_admin` by default,
or `admin`, `user`) decides access to the admin panel, and everything else is set there afterwards.
The password is hashed by PHP's own `password_hash()`, the function the bridge verifies it with, so
PHP must be on `PATH` or named with `--php`.

## Commands

```text
media-server check
media-server check --database
media-server migrate
media-server migrate --as-user root                       # DDL as an administrator; the app account has data rights only
media-server account-create --username owner              # see "The first account"
media-server roots sync --kind music=music --kind movies=movies   # record what a folder holds, without scanning it
media-server scan --root music --kind music
media-server scan --root music --kind music --metadata --apply
media-server scan --root music --kind music --metadata --apply --fingerprint-limit 10000
media-server metadata-worker --limit 500 --timeout-seconds 15
media-server scan --root movies --kind movies --apply
media-server maintenance                    # one scheduled run: scan, metadata queue, film lookups
media-server maintenance --only metadata
media-server serve
media-server token file music "Artist/Album/song.flac" --inline
media-server token file movies "Film.mkv" --inline --purpose compat
```

A scan fills in up to 2000 missing content fingerprints per run (two 64 KiB reads per file, about
30 ms on a spinning disk); `--fingerprint-limit` takes a whole backlog in one go. Every transfer
token carries the purpose it was issued for (`download`, `play`, `thumb`, `compat`), and the
transfer service opens a route only for its own purpose — a playback or thumbnail token never
starts transcoding.

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
- [Changelog](docs/CHANGELOG.md)
- [Releasing and private backups](docs/RELEASE.md)
- [Catalogue worker](docs/CATALOG-WORKER.md)
- [Shared frontend](docs/FRONTEND.md)
- [Security policy](SECURITY.md)

## Requirements

Python 3.11+, PHP 8.1+ with `pdo_mysql`, `openssl`, `mbstring`, `curl` and SimpleXML, MySQL 8.0.19+
or MariaDB 10.5.2+, Apache 2.4 with `proxy`, `proxy_http` and `headers` — plus `ssl` for anything
reachable over a network, because signing in over plain HTTP is refused. FFmpeg is required for the
video compatibility mode, thumbnails and subtitle extraction. Node.js is needed only to build the
interface from source. The installers check all of this and add what they can.

## Licence

MIT — see [LICENSE](LICENSE). Attribution and the origin of the transfer design are described in
[NOTICE.md](NOTICE.md). Third-party preset packs and Font Awesome Pro, when an owner adds them to a
private build, keep their own licences and are never part of this repository.
