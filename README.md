# MyNeomitis (Axenco) — external integration for Gladys Assistant

🇬🇧 **English** · 🇫🇷 [Français](README.fr.md)

Control **Neomitis / Axenco** heaters, thermostats and modules — the ones the
**MyNeomitis** mobile app manages — from [Gladys
Assistant](https://gladysassistant.com).

Built on the official
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
It started as a port of the Home Assistant `myneomitis` integration and of the
`pyaxencoapi` library it relies on, and it no longer matches them everywhere:
several behaviours were measured against real hardware and captured from the
official app, and they contradict the reference. See
[Divergences from the reference](#divergences-from-the-reference).

📘 **User documentation: [`docs/en.md`](docs/en.md) · [`docs/fr.md`](docs/fr.md)**

## Supported models

`EV30` · `ECTRL` · `ESTAT` · `RSS-ECTRL` (thermostats) · `NTD` · `ETRV`
(sub-devices behind a gateway) · `EWS` (dry-contact relay **and** fil pilote) ·
`UFH` (underfloor heating/cooling).

Only two of them have been verified against real hardware. The rest keep the
reference library's behaviour, which is a hypothesis, not a guarantee — the
table below says exactly which is which.

| Model                                | Mode list                   | Per-mode setpoints   | Command routing                 |
| ------------------------------------ | --------------------------- | -------------------- | ------------------------------- |
| `EV30`                               | measured + app capture      | **yes**, app capture | measured                        |
| `EWS` fil pilote (`deviceType: 1`)   | measured + capture + manual | no (no sensor)       | measured                        |
| `EWS` relay (`deviceType: 0`)        | inherited                   | no                   | inherited                       |
| `EWS` fil pilote, other `deviceType` | inherited                   | no                   | inherited                       |
| `ECTRL`, `ESTAT`, `RSS-ECTRL`        | inherited                   | **yes — UNVERIFIED** | inherited                       |
| `NTD`, `ETRV`                        | inherited                   | no                   | inherited, gateway never tested |
| `UFH`                                | inherited                   | no                   | inherited, gateway never tested |

> **Unverified:** `ECTRL`, `ESTAT` and `RSS-ECTRL` get the three per-mode
> setpoints (Consigne Confort / Éco / Hors gel) purely because they are
> thermostats of the same family as the `EV30`, with the same `overrideTemp`
> and `comfLimitMin`/`comfLimitMax` fields. Nobody has confirmed that these
> models accept the write. If you own one, see
> [Reporting your model](#reporting-your-model).

## Divergences from the reference

Each of these is backed by a measurement or by a capture of the official app's
network traffic, and each contradicts `pyaxencoapi` and the Home Assistant
integration.

| Subject                  | Reference                                             | Reality                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Auto**                 | `targetMode: 60`                                      | `targetMode: 0`. 60 and 61 answer `200` and change nothing — Auto does not work under Home Assistant either. Hardware in Auto _reports_ 60 (Auto Confort) or 61 (Auto Éco), which is what made 60 look right |
| **Derogation**           | write `targetMode: 8`, then the temperature           | mode 8 alone is ignored; the app sends `targetTemp` + `overrideTemp` + `targetMode: 8` in a single call                                                                                                      |
| **Per-mode setpoints**   | not exposed at all                                    | `comfTemp` / `ecoTemp` / `antifTemp` are writable, all three together                                                                                                                                        |
| **Free sensors**         | not exposed at all                                    | signal, presence, open window, child lock and system fault ride along in the state already fetched                                                                                                           |
| **`UFH`**                | `select.py` writes the mode on the device's own `_id` | a UFH is a sub-device whose mode lives on `changeOverUser`; the dedicated route `pyaxencoapi` provides for it is used instead                                                                                |
| **`EWS` fil pilote**     | 10 presets for any module                             | 8 on the measured one, and `comfort_plus` is refused. The MyNeomitis app menu hides two orders the hardware really emits (Éco 1K / Éco 2K)                                                                   |
| **`parents`**            | a string in `api.py`, a dict in `climate.py`          | both shapes are handled; either source crashes on the other                                                                                                                                                  |
| **Link / unlink events** | provided but never used                               | wired, so pairing a device in the app triggers a rescan                                                                                                                                                      |
| **WebSocket token**      | passed once at connect                                | renewed before every reconnection: `socket.io-client` treats a rejected handshake as terminal, which silently downgraded everything to the periodic poll                                                     |

## How it works

```
                       REST (login, devices, commands)
  Gladys  ◀── SDK ──▶  index.js  ◀────────────────────▶  Axenco cloud
                          │        Socket.IO (push)
                          ├── src/devices/   what a device looks like in Gladys
                          └── src/gladys/    how state reaches Gladys
```

| Path                                | Role                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `index.js`                          | SDK wiring and session lifecycle: connect, discover, route commands, retry          |
| `src/axenco/client.js`              | Port of `pyaxencoapi`: auth + token refresh, REST, Socket.IO, reconnection          |
| `src/axenco/const.js`               | Presets, per-model mode lists, protocol constants                                   |
| `src/axenco/utils.js`               | Gateway / `rfid` / `parents` helpers                                                |
| `src/devices/profiles.js`           | What each model exposes, as capabilities                                            |
| `src/devices/features.js`           | The Gladys feature layout, and why the mode is a set of switches                    |
| `src/devices/index.js`              | Axenco state ⇄ Gladys states, and command routing                                   |
| `src/gladys/publisher.js`           | Deduplication, batching, transport badge                                            |
| `src/gladys/reconciler.js`          | Post-command re-read: Axenco answers `200` even when the device ignores the command |
| `src/config.js` · `src/selector.js` | Configuration defaults, collision-free selectors                                    |

Two design points worth knowing before reading the code:

**The mode is a set of exclusive binary switches**, not a dropdown. Gladys picks
a widget from a static type map and every list widget has its options hard-coded
in the front, so a binary switch is the only writable control whose labels and
values are ours. The full reasoning, including the upstream `preact-i18n` bug
that rules out `supported_options`, is in [`docs/en.md`](docs/en.md).

**States published right after a command are optimistic and may be wrong.**
Axenco answers `200` to values the device then ignores, and these heaters drop
commands sent seconds apart. `src/gladys/reconciler.js` re-reads the device 30 s
later and publishes what it actually reports, logging any difference.

## Development

```bash
npm install
npm test            # node --test, no framework
npm run lint
npm run format:check
```

Run it against a local Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="myneomitis-axenco" \
LOG_LEVEL=debug \
npm start
```

Validate the way the store does, before releasing:

```bash
npx github:GladysAssistant/integration-store .
```

### Debug scripts

They talk to the Axenco API with your own account, asking for the credentials
interactively so nothing lands in your shell history, and never print a token.

```bash
node scripts/dump-devices.mjs                     # raw state of every device
node scripts/sweep-modes.mjs                      # list devices
node scripts/sweep-modes.mjs <deviceId>           # read-only report
node scripts/sweep-modes.mjs <deviceId> --apply   # what the device really accepts
```

`sweep-modes.mjs --apply` changes the mode of a real heater many times over a
couple of minutes, then restores every field it touched. Pick a device you do
not currently depend on. It observes through the WebSocket and confirms a
baseline before each test, reporting _non conclusive_ rather than a verdict when
it cannot — no data beats wrong data.

### Reporting your model

If your device shows modes it does not have, misses one it does, or refuses a
setpoint, two commands settle it:

```bash
node scripts/dump-devices.mjs
node scripts/sweep-modes.mjs <deviceId> --apply
```

Open an [issue](https://github.com/Dreamthy/gladys-neomitis/issues) with both outputs and the mode list the MyNeomitis app shows for
that device. Sub-devices (`NTD`, `ETRV`, `UFH`) go through their gateway, whose
response shape has never been observed, so the sweep refuses them — the dump
alone is already useful there.

## Testing a build in Gladys

1. **Actions → Build and publish image → Run workflow** on any branch.
2. Open the run's **Job Summary**: it contains the manifest with `docker_image`
   already pointing at the image just pushed.
3. In Gladys: **Integrations → Install an integration → Developer mode**, paste
   that manifest.

The GHCR package must be public for Gladys to pull it anonymously
(Package settings → Change visibility → Public), on the first build only.

## Release

**Actions → Release → Run workflow**, pick `patch` / `minor` / `major`. The
workflow bumps `package.json` and the manifest (`version` **and** the
`docker_image` tag), pushes the `vX.Y.Z` tag and builds the multi-arch image
(`linux/amd64` + `linux/arm64`).

For the store indexer to pick it up, the repository also needs the
`gladys-assistant-integration` GitHub topic.

## Credits

- Home Assistant integration [`myneomitis`](https://www.home-assistant.io/integrations/myneomitis) by @Epyes
- Python library `pyaxencoapi`, whose protocol this port started from

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
