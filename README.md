# SMART Disk Health – OPNsense dashboard widget

A dashboard widget that shows the health of the firewall's drives: temperature, overall SMART verdict, wear, total data written, bad blocks, error counters and power-on time. Built for OPNsense 26.7.x.

## Features

- Per-disk card with a Healthy / Warning / Critical / Unknown badge and the reasons behind it.
- Supports NVMe, SATA/ATA SSD and HDD (and SCSI grown defects). Devices without SMART (VMs, some USB) show "Unknown" instead of failing.
- **Widget options** (Edit dashboard ▸ pencil icon on the widget):
  - **Temperature unit**: Celsius or Fahrenheit
  - **Disks to show**: any subset of detected disks
  - **Health information to show**: overall health, temperature, wear, total written, bad blocks, error counters, power-on time, model details
- Refreshes every 5 minutes (each refresh runs `smartctl` once per selected disk).

### How status is decided

| Level | Triggers |
|---|---|
| Critical | SMART overall check failed; NVMe critical warning; attribute failing now; endurance used ≥ 100%; spare ≤ threshold; temperature ≥ 80 °C (SSD/NVMe) or ≥ 60 °C (HDD) |
| Warning | Reallocated / pending / uncorrectable sectors, NVMe media errors, grown defects; CRC errors; endurance used ≥ 90%; failed last self-test; attribute failed in the past; temperature ≥ 70 °C (SSD/NVMe) or ≥ 50 °C (HDD) |

Temperature limits above are generic defaults; if the drive reports its own composite limits (NVMe usually does, e.g. 90/95 °C) those are used instead.

"Total written" uses, in order: NVMe data units, ATA device statistics (Logical Sectors Written), then vendor attributes (`Total_LBAs_Written`, `Host_Writes_*`, `Lifetime_Writes_GiB`). Units of vendor attributes differ between manufacturers; if a value looks off for your drive, the vendor attribute is likely not in 512-byte LBAs. Values the drive does not report show as "—".

## Requirements

The widget is client-side only. It reads `smartctl` JSON through the API of the **os-smart** plugin (`/api/smart/service/list` and `/info`), so:

1. Install **os-smart** under *System ▸ Firmware ▸ Plugins* (it brings in `smartmontools`).
2. Users other than root need the *Services: SMART* privilege.

Without the plugin the widget displays an install hint.

## Install

From your workstation (needs SSH access as a user that can write to the OPNsense web root, typically root):

```sh
./install.sh root@<firewall-ip>
```

Or manually:

```sh
scp src/opnsense/www/js/widgets/SmartHealth.js            root@<fw>:/usr/local/opnsense/www/js/widgets/
scp src/opnsense/www/js/widgets/Metadata/SmartHealth.xml  root@<fw>:/usr/local/opnsense/www/js/widgets/Metadata/
```

No service restart is needed. Hard-reload the dashboard (Ctrl/Cmd+Shift+R), click **Edit**, **Add widget**, then **SMART Disk Health**.

Files live outside package management, so firmware updates normally leave them in place; re-check the widget after major upgrades since the dashboard framework is internal to OPNsense.

## Uninstall

Remove the two files listed above from the firewall, then reload the dashboard.

## Development

```sh
npm test    # node --test, no dependencies
```

Tests cover the smartctl-JSON normalisation, status rules, unit conversion, rendering and the widget's option handling (with stubbed dashboard globals). Fixtures in `tests/fixtures/` are hand-built from smartctl's JSON schema, plus three real, anonymized captures (`permission_denied.json`, `nvme_team_tm8fpw001t.json` – a TEAM TM8FPW001T NVMe, and `ata_hdd_seagate_st16000nt001.json` – a Seagate SATA HDD, trimmed of irrelevant log directories). Pull requests with real `smartctl -x --json=c` captures from other drives are welcome as new fixtures.

## Notes

- Spun-down HDDs are woken by `smartctl -x`; if that matters, deselect those disks.
- Only the disks you select are polled.
