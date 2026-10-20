# Version 1.1: upgrading to Gladys 5.2

Requires **Gladys 5.2+** and SDK 0.15. Scheduling and regulation belong to
Gladys's native thermostat service. Axenco commands still need its cloud:
the local schedule does not make Neomitis devices work without Internet.

## Migration

Update Gladys and the integration image, then use **Update** in Discovery for
each existing device. Do not delete and recreate devices. All legacy external
ids are retained, so existing scenes can keep using them. New states are only
published after their features have been created by the user.

## Direct control without a Gladys thermostat

A Gladys thermostat is optional for each device. **Mode Axenco** selects the
manufacturer modes. **Température de consigne** is the shared target for direct
controls, scenes and Gladys's thermostat. Its historical `target-temperature`
identifier is retained. Manufacturer programmes, per-mode setpoints, sensors,
the Neomitis widget and scene actions remain available independently.

On EV30, changing this target in standby remembers it without waking the
heater. Resume using **Chauffage** on **Mode du radiateur**, an active Axenco
mode, or the widget/scene action **Apply an override**. This explicit override
starts heating with the requested temperature in one captured Axenco command.
Other models retain their historical temperature command behaviour.

Scan and choose **Update** in Discovery. Already-created mode switches retain
their identifiers for existing scenes; new devices use the selector alone.
**Dérogation (consigne actuelle)** applies the last observed Axenco target;
on EV30 this is the effective target for its current mode. Auto codes `0`, `60`
and `61` share one Auto option. The widget displays **Auto (Confort)** or
**Auto (Éco)** and unknown codes from observed hardware state, without an
extra text feature on new devices with a selector. An already-created text
feature remains as **Mode actuel (compatibilité)** to preserve its references.
Devices without a selector, such as UFH, retain their read-only indication.

## EV30: real thermostat

Create a **real thermostat** in Gladys's Thermostat integration. Select
**Température de consigne** as its target, **Mode du radiateur** as its operating
mode and **Température actuelle** for room temperature. Leave heating state
empty: no hardware heating indication has been verified.

**Mode du radiateur** is the renamed **Mode thermostat Gladys**, retaining its
identifier. It represents physical OFF/HEATING. Configure it so Gladys can
both put the heater into standby and resume it. The EV30 regulates itself;
no second hysteresis/TPI loop is added.

Disable the manufacturer's programme before using a Gladys schedule.
**Gladys Schedule** and **MyNeomitis Auto** are separate programmes. To keep a
scheduled zone stopped, stop the Gladys scheduling thermostat: an active
schedule may otherwise resume control of the heater.

### Existing duplicate targets

New devices no longer create **Consigne thermostat Gladys**. If already
created, it is retained as **Consigne (compatibilité)** with the same
`thermostat-temperature` identifier and history. It is a synchronized alias
of the shared target: both commands and observed states use the same logic.

Gladys deletes omitted features when updating a device, and this integration
cannot migrate other thermostats' or scenes' references. Before removing the
old feature, select **Température de consigne** in the existing thermostat and
replace references to the old target in scenes and widgets. Do not delete the
device. A removed alias is not recreated on later scans.

### OFF, resume and feedback

OFF sends the measured Axenco standby command. The frost fallback written
afterwards is remembered without sending `targetMode: 8`, which would wake the
heater. Stop intent and the parked target persist in `/data` across container
restarts. Cloud failures and ignored commands are still reported as failures.
Resume and its following target are combined into one temperature command;
resume alone uses the remembered target. A subsequent OFF or direct Axenco
mode cancels a delayed resume.

While stopped, the target is a remembered value, not a temperature currently
applied to the hardware. While running, it follows actual device observations,
including Comfort/Eco in Auto. A stale `overrideTemp` cannot overwrite the
effective target. HTTP 200 is not confirmation. Explicit Axenco mode commands
synchronize stop intent, as do observed physical mode changes when no mode
command is awaiting confirmation.

Device-reported bounds are retained, with a 0.5 °C step on EV30. On a device
advertising 16–21 °C, Gladys clamps a numeric frost target of 7 °C to 16 °C.
OFF still sends standby. No wider range or unverified payload is introduced.

An ignored target retains its last confirmed value instead of creating a
false manual override. The failure event and logs report it; the schedule can
retry. Divergent targets are not treated as manual changes while a target is
pending.

Stop protection and the standard mode remain **EV30-only**, whose protocol
was measured. ECTRL, ESTAT, RSS-ECTRL, NTD and ETRV retain historical controls;
expanding support requires hardware and gateway validation.

## EWS and window contacts

- Relay EWS: **Marche / Arrêt** sends real ON and OFF commands and can be used
  by a virtual thermostat with a separate room sensor. Its inherited protocol
  still needs testing on your installation.
- Pilot-wire EWS: **Ordre fil pilote** translates the supported standard modes
  to Axenco codes. Legacy Auto and Boost remain. Gladys 5.2's virtual thermostat
  does not accept a pilot-wire mode as its actuator. Legacy preset switches
  ignore OFF and must not be used as binary heating actuators.
- New devices expose one standard **Fenêtre ouverte** contact when reporting
  a boolean `windowStatus` or numeric `0` / `1`: Axenco `false` means closed
  (Gladys `1`), `true` means an opening is detected (Gladys `0`). No polarity
  setting is needed. Its `window-contact` identifier is retained: the former
  **Contact fenêtre pour thermostat** is renamed without changing references
  or values. Scan and update, then select **Fenêtre ouverte** in the thermostat.
- The legacy `open-window` feature is retained only when already created,
  as **Fenêtre ouverte (compatibilité)**. Its opposite values (`1` open,
  `0` closed) remain unchanged for existing scenes. Use the standard contact
  without “compatibilité” for new thermostats and scenes.
- No contact is created without a valid reported field. Temporary missing or
  invalid readings do not remove an already-created contact. This mapping is
  independent of model-specific native thermostat command support.

Before removing legacy compatibility features, replace their references in
scenes, widgets or thermostats. Removed features are not recreated. Do not
delete the device to remove individual duplicate features.

## Widget, scenes and status

The Neomitis heater widget shows reported temperatures, Axenco mode, cloud
status, real-time status and the age of the last REST read. Its forms send
direct modes and temperature overrides in **°C**, even if displayed readings
use Fahrenheit. Direct overrides keep their legacy behaviour and can wake a
standby heater. Use Gladys's native thermostat widget for a scheduled zone.

Scene actions choose an Axenco mode, apply a temperature override, resume the
MyNeomitis programme or start/stop the device control (EV30 or relay EWS).
The last action does not stop a Gladys schedule: use the generic mode action
on the thermostat created by Gladys for that. `accepted` acknowledges the
request, not the physical result. Unsupported per-model modes are rejected.

**Command not confirmed** exposes the device, feature and reason for a
notification scene. Main devices are re-read 30 seconds after commands. Auto
codes 0/60/61 compare semantically. Unverified gateway responses are not used
to claim confirmation of sub-devices.

Push failures mark the cloud transport degraded while REST refresh continues.
REST failure reports disconnected/unreachable; recovery clears these statuses.
No change is not a failure. Freshly re-read unchanged values are re-published
at most once per 30 minutes. Commands are ordered per device and expire after
one second waiting in the queue. Axenco writes, including token renewal, have
a 3.5-second budget to leave time for Gladys's acknowledgement. A timeout does
not prove the hardware did nothing: inspect its feedback.

## Development and publishing

Run `npm test`, `npm run lint` and `npm run format:check`. CI runs the official
store validator with `--skip-image-check` while the PR image is unpublished.
The release validates its published image before pushing the new manifest to
the branch and creating the GitHub release.

Local control data lives in ignored `.data/`, or `NEOMITIS_DATA_DIR` when set.
Production defaults to `/data`. No credentials are stored there. Automated
tests use doubles, including the official SDK fake; physical validation of
your heating is still required.
