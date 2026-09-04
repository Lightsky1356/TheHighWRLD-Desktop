# TheHighWRLD Desktop (native app)

A native desktop shell around the [TheHighWRLD Dashboard](https://thehighwrlddashboard.pages.dev),
built with **Electron**. It adds:

- A native **Downloads-ready** desktop app for Windows (EXE), macOS (DMG), and Linux (AppImage/.deb).
- **Optional Discord Rich Presence** (native-app only, OFF by default).

> **The website / PWA / mobile browser never initializes Discord Rich Presence.**
> This is a native-app-only feature, implemented entirely in this folder.

---

## Requirements

- Node.js 18+ and npm
- Internet access (to install Electron + discord-rpc)

## Install

```bash
cd thehighwrld-desktop
npm install
```

## Run (development)

```bash
npm start
```

The window loads the live dashboard at `https://thehighwrlddashboard.pages.dev`.
To point at a local dev server instead:

```bash
# Windows PowerShell
$env:THEHIGHWRLD_DASHBOARD_URL="http://localhost:8788"; npm start
```

## Discord Rich Presence

### 1. Get a Discord Application Client ID

1. Go to https://discord.com/developers/applications
2. **New Application** → name it TheHighWRLD
3. Copy the **Application ID** (a 15-20 digit number)
4. Under **Rich Presence → Art Assets**, upload at least one image named
   **`thehighwrld_logo`** if you want it to appear on your profile card.

The Client ID is already baked into `src/rpc.js` (`1533294159039827988`).
You can override it with the `THEHIGHWRLD_DISCORD_CLIENT_ID` env var at launch.

### 2. Use it

- Open **Settings** in the native app and toggle **Discord Rich Presence** to ON.
- The setting persists across restarts and takes effect **without restarting**.
- Turning it OFF immediately clears your Discord activity.
- If Discord isn't running, Rich Presence is simply "unavailable" — it does
  **not** retry in a loop, and never blocks the app.

#### Activity states

| Where you are            | Details             | State                                        |
| ------------------------ | ------------------- | -------------------------------------------- |
| Lobby                    | TheHighWRLD         | In the Lobby                                 |
| WRLD Player (browsing)   | TheHighWRLD         | Browsing the WRLD Player                     |
| WRLD Player (playing)    | TheHighWRLD         | Listening to [CURRENT TRACK]                 |
| The Vault                | TheHighWRLD         | Exploring the Vault                          |
| Community                | TheHighWRLD         | Browsing Community                           |
| Downloads                | TheHighWRLD         | Exploring Downloads                          |

We only ever show the **current track title + page** — never chat text or typed
input. Updates are throttled (only pushed when the state actually changes).

---

## CI / Auto-build (GitHub Actions)

This repo includes `.github/workflows/` so every platform is built
automatically — no Mac required on your side.

### How it works

1. Push a **git tag** matching `v*` (e.g. `v1.0.0`).
2. GitHub Actions spins up three runners (Ubuntu, macOS, Windows).
3. Each builds its platform with `electron-builder`.
4. A release is created automatically at `https://github.com/Lightsky1356/TheHighWRLD-Dashboard/releases`
   with all binaries attached.

### One-time setup

In the GitHub repo → **Settings → Secrets and variables → Actions**:
- `CLOUDFLARE_API_TOKEN` — for the site deploy workflow (optional).

### Manual trigger

Workflows also run on **workflow_dispatch** (the ▶ button on the Actions tab).

### Build commands (local)

```bash
npm run dist                 # all platforms the runner supports
npm run dist -- --win        # Windows EXE only (NSIS, x64 + ia32)
npm run dist -- --linux      # Linux AppImage + .deb
npm run dist -- --mac        # macOS DMG (x64 + arm64)
```

Output lands in `release/`.

| Platform  | Output                                   |
| --------- | ---------------------------------------- |
| Windows   | `TheHighWRLD Setup 1.0.0.exe` (NSIS)     |
| macOS     | `TheHighWRLD-1.0.0.dmg` (x64 + arm64)    |
| Linux     | `TheHighWRLD-1.0.0.AppImage` + `.deb`    |

> Building macOS DMGs requires a macOS runner (GitHub provides one free).
> Windows EXEs are built on Windows; Linux on Ubuntu.
> Each platform must be built on its own OS — electron-builder enforces this.

### Site deployment

Pushing to `main` also triggers `.github/workflows/deploy-site.yml`, which
deploys the website to Cloudflare Pages via `cloudflare/pages-action`.
Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repo secrets to enable it.
The site's `pages_build_output_dir` is `.` (see `wrangler.toml`).

After building, drop the binaries into the site's `downloads/` folder so the
**Downloads** page links resolve (or use the GitHub release URL directly):

```
downloads/TheHighWRLD-Setup.exe
downloads/TheHighWRLD.ipa        (iOS - built separately with Xcode/Capacitor)
downloads/TheHighWRLD.apk        (Android - built separately with Android Studio)
downloads/TheHighWRLD.dmg
downloads/TheHighWRLD-Linux.AppImage
```

---

## Layout

```
src/main.js        Electron main process (window, settings window, IPC)
src/preload.js     Safe bridge for the Settings window only
src/rpc.js         Discord Rich Presence lifecycle (OFF default, async, throttled)
settings.html      Native Settings window with the Rich Presence toggle
```

## Notes / safety

- **No infinite reconnect**: Discord login is attempted once per ON transition.
  Toggle OFF→ON (or restart) to try again.
- **Zero impact when OFF**: no client, no timers, no network requests.
- **Non-blocking**: Rich Presence never blocks startup, navigation, the WRLD
  Player, Community, realtime replies, typing, Online Status, or auth.
- This folder lives **outside** the Cloudflare Pages `pages_build_output_dir`,
  so it is never deployed with the website.
