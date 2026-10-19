# Version 1.1: upgrading to Gladys 5.2

Requires **Gladys 5.2+** and SDK 0.15. Scheduling and regulation belong to
Gladys's native thermostat service. Axenco commands still need its cloud:
the local schedule does not make Neomitis devices work without Internet.

## Migration

Update Gladys and the integration image, then use **Update** in Discovery for
each existing device. Do not delete and recreate devices. All legacy external
ids are retained, so existing scenes can keep using them. New states are only
published after their features have been created by the user.

## EV30: real thermostat

Create a **real thermostat** in Gladys's Thermostat integration. Select
**Consigne thermostat Gladys** as its target and **Mode thermostat Gladys** as
its operating mode. Select **Température actuelle** for the room temperature.
Leave the heating-state input empty: no hardware heating indication has been
verified. These two new controls are a pair; selecting the legacy
**Température cible** does not provide the stop protection below.

Disable the manufacturer's programme before using a Gladys schedule.
**Gladys Schedule** and **MyNeomitis Auto** are separate programmes. For a zone
scheduled by Gladys, scenes should target the preset/mode/target of the
thermostat created by Gladys, not the direct Axenco commands. The EV30 still
regulates itself; no second hysteresis/TPI loop is added.

OFF sends the measured Axenco standby command. The frost fallback Gladys writes
afterwards is parked without sending `targetMode: 8`, which would wake the
heater. Stop intent and the parked target are persisted in `/data` across
container restarts. They cannot guarantee a physical stop while Axenco is down
or the heater ignores an order. Resume and its following target are combined
into one temperature command; resume alone restores the remembered target.
A subsequent OFF cancels a resume still waiting to be sent.

While stopped, the new target is a parked resume value, not a temperature
currently applied to the hardware. The legacy temperature feature remains
available for Axenco diagnostics. While running, only observed temperatures
are published on the new native target: HTTP 200 is not confirmation.

Device-reported bounds are retained and the EV30 control declares a 0.5 °C
step. A device advertising 16–21 °C cannot promise a numeric frost target of
7 °C: Gladys clamps it to 16 °C. OFF still sends standby. Hardware measurements
are required before widening the override bounds; no unverified payload is
invented to bypass them.

When an order is ignored, the native control retains its last confirmed target
instead of presenting the correction as a human manual override. The failure
event and logs report it and the schedule can retry. Divergent values are not
treated as manual changes on that control while its target is pending; the
legacy features remain available for diagnostics.

Native control is exposed on **EV30 only**, whose protocol was measured.
ECTRL, ESTAT, RSS-ECTRL, NTD and ETRV retain their legacy controls; expanding
native support requires real hardware/gateway validation.

## EWS and window contacts

- Relay EWS: **Marche / Arrêt** sends real ON and OFF commands and can be used
  by a virtual thermostat with a separate room sensor. Its inherited protocol
  still needs testing on your installation.
- Pilot-wire EWS: **Ordre fil pilote** translates the supported standard modes
  to Axenco codes. Legacy Auto and Boost remain. Gladys 5.2's virtual thermostat
  does not accept a pilot-wire mode as its actuator. Legacy preset switches
  ignore OFF and must not be used as binary heating actuators.
- The legacy window feature retains its values. Verify raw `windowStatus` on
  opening/closing before selecting its polarity in the integration settings.
  The default is **Not verified (disabled)**. Scan and update the device to
  create **Contact fenêtre pour thermostat**, then select that feature in
  the thermostat. It reports `0` open / `1` closed, as Gladys expects.

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
