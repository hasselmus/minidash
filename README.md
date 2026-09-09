# MiniDash

A deliberately quiet, always-on LAN dashboard intended for a small OLED phone used as a status display. The first screen is a climate view backed by the `humidity-logger` dashboard API.

The project has no npm dependencies. Node.js serves the phone UI and proxies the humidity API, so Safari/PWA requests remain same-origin and no CORS changes are needed in the logger.

## Design goals

- legible at a distance on an iPhone 12 mini-sized portrait display
- very low visual clutter and low OLED luminance
- true near-black background with no animated decoration
- large temperature and RH figures, optional small absolute-humidity values
- current wall condensation margin and optional probe/dew-point detail
- small door/dehumidifier state strip
- stale/offline indication without blanking the last known readings
- tiny whole-layout pixel shift every five minutes to reduce static OLED exposure
- horizontally scroll-snapping page container ready for later dashboard screens

## Configuration and privacy

No installation-specific configuration belongs in this public repository. `config.local.json` and `config.json` are ignored by Git.

For a normal Pi installation, keep the live configuration outside the repository:

```bash
mkdir -p ~/.config/minidash
cp config.example.json ~/.config/minidash/config.json
nano ~/.config/minidash/config.json
```

The important fields are:

- `humidity.base_url`: the LAN/local base URL of the existing humidity dashboard, normally `http://127.0.0.1:8787` when both services run on the same Pi
- `sensors[].source`: exact sensor names returned by the humidity logger API
- `sensors[].label`: short labels shown on the phone
- `wall`: wall-margin label and quiet caution/warning thresholds
- `status`: labels for the door and dehumidifier state

The server listens on port `8788` by default. `MINIDASH_HOST`, `MINIDASH_PORT` and `MINIDASH_CONFIG` can override the local configuration.

## Test interactively

```bash
cd ~/minidash
MINIDASH_CONFIG="$HOME/.config/minidash/config.json" npm start
```

Then open:

```text
http://<pi-address>:8788/
```

`/status` is a small service health endpoint. `/api/state` is the normalised read-only state consumed by the phone UI.

## Install as a system service

With the private config already present:

```bash
cd ~/minidash
npm run service-install
```

The installer generates `/etc/systemd/system/minidash.service` using the current repository path, current user and private config path; those installation-specific values are therefore not committed.

Useful commands:

```bash
npm run service-status
npm run service-logs
sudo systemctl restart minidash
```

## iPhone use

Open the MiniDash URL in Safari, use **Add to Home Screen**, then launch the installed Home Screen web app. The page declares standalone mode and a black status-bar/theme background.

For a dedicated display, configure iOS separately not to auto-lock. MiniDash itself performs no wake-lock tricks: if iOS suspends or reloads the page, it refreshes immediately when visible again. The last good state is also cached locally so a temporary logger/network failure leaves useful readings on screen, clearly marked stale/offline.

## Humidity logger API

MiniDash expects the existing endpoint:

```text
GET /api/data?hours=1
```

It uses the API's `latest` climate readings plus the newest wall-data bucket. It does not read SQLite, Homebridge, Matter or Tuya directly and does not write to the humidity logger.
