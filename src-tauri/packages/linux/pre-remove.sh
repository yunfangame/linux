#!/bin/bash
# Debian prerm upgrade and RPM preun with remaining package instances preserve the service.
case "${1:-}" in
    upgrade|failed-upgrade|1|2) exit 0 ;;
esac
/usr/bin/clash-verge-service-uninstall

. /etc/os-release

if [ "$ID" = "deepin" ]; then
    if [ -f "/usr/share/applications/clash-verge.desktop" ]; then
        echo "Removing deepin desktop file"
        rm -vf "/usr/share/applications/clash-verge.desktop"
    fi
fi
