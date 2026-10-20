# Changelog

## 1.1.0 — 2026-10-20

Requires **Gladys 5.2 or newer** and uses integration SDK 0.15.

- Add a manufacturer mode selector for direct control without a Gladys thermostat.
- Share the existing setpoint between direct controls, scenes and the Gladys thermostat.
- Add physical stop/resume protection on EV30, ECTRL, ESTAT, RSS-ECTRL, NTD and ETRV. Stop intent survives container restarts; a fallback setpoint does not wake a stopped device.
- Route NTD/ETRV mode and target commands through their gateway with a shared timeout budget. NTD follows the reported heating/cooling changeover without changing it.
- Simplify pilot-wire EWS to its full **Mode du module** selector. Updating the device removes the duplicate `pilot-wire-mode` feature; replace references to that feature before updating. The relay variant keeps its binary control.
- Add the heater widget, scene actions and a command-failure trigger. Widget controls are limited to Mode and Setpoint where supported; mode details use observed cloud state.
- Map window feedback automatically and preserve existing compatibility features, except the explicitly retired EWS six-order control.
- Re-read commands after 30 seconds, including gateway devices through the account device list. An HTTP success is not physical confirmation.

Validation: 202 automated tests, ESLint and Prettier pass. The owner reports
that initial tests on their installation appear to work. **End-to-end testing
with Gladys's thermostat is still pending.** ECTRL, ESTAT, RSS-ECTRL, NTD,
ETRV, relay EWS and UFH still need hardware validation by their owners.

Update the integration, then use **Discovery → Update** on the existing
devices. Do not delete and recreate them. See the migration instructions:
[English](docs/upgrade.en.md) · [Français](docs/upgrade.fr.md).
