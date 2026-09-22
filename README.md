# MiniDash

A deliberately quiet, always-on LAN dashboard intended for a small OLED phone used as a status display. The first screen is a climate view backed by the `environment-logger` native JSON API.

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
- horizontally scroll-snapping pages with configurable 24 h plots for the most important environmental metrics

## Configuration and privacy

No installation-specific configuration belongs in this public repository. `config.local.json` and `config.json` are ignored by Git.

For a normal Pi installation, keep the live configuration outside the repository:

```bash
mkdir -p ~/.config/minidash
cp config.example.json ~/.config/minidash/config.json
nano ~/.config/minidash/config.json
```

The important fields are:

- `environment.base_url`: the LAN/local base URL of `environment-logger`
- `sensors[].source`: exact sensor names returned by the environment logger API
- `sensors[].label`: short labels shown on the phone
- `wall.source`: sensor name supplying `dew_margin`, `probe_temperature` and `dew_point`
- `status`: state entity/field mappings for door and dehumidifier
- `plots`: swipeable plot pages, their metric, sensors and time window

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

## Environment logger API

MiniDash now uses the native environment-logger endpoints:

```text
GET /api/v1/latest
GET /api/v1/series?hours=24
```

The first screen uses the latest measurements and states. Configurable additional pages proxy the time-series endpoint and render local, dependency-free Canvas plots. Swipe horizontally on the iPhone to move between the live climate screen and plots.

MiniDash still accepts the old `humidity.base_url` configuration as a compatibility mode, but plot pages require the native `environment` source.

MiniDash does not read SQLite, Homebridge or Matter directly and does not write to environment-logger.
