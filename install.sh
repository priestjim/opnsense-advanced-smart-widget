#!/bin/sh
# Copy the SMART Disk Health widget onto an OPNsense firewall.
#
#   ./install.sh root@firewall.example     # push over scp from your workstation
#   ./install.sh                   # run as root on the firewall itself
#
# Only copies two files; nothing is restarted or removed.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/src/opnsense/www/js/widgets"
DEST=/usr/local/opnsense/www/js/widgets

if [ $# -ge 1 ]; then
    scp "$SRC/SmartHealth.js" "$1:$DEST/SmartHealth.js"
    scp "$SRC/Metadata/SmartHealth.xml" "$1:$DEST/Metadata/SmartHealth.xml"
else
    install -m 0644 "$SRC/SmartHealth.js" "$DEST/SmartHealth.js"
    install -m 0644 "$SRC/Metadata/SmartHealth.xml" "$DEST/Metadata/SmartHealth.xml"
fi

echo "Installed. Hard-reload the dashboard, then Edit > Add widget > SMART Disk Health."
echo "Requires the os-smart plugin (System > Firmware > Plugins)."
