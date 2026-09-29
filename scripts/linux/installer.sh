#!/bin/sh
set -eu

payload_sha256='@PAYLOAD_SHA256@'
bundle_version='@VERSION@'
bundle_build='@BUILD@'
mode=install
assume_yes=0
extract_dir=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --yes) assume_yes=1 ;;
    --extract) mode=extract; shift; extract_dir=${1:?Missing extraction directory} ;;
    --help) printf 'Fengwo Linux %s\nUsage: sh %s [--check | --extract DIRECTORY | --yes]\n' "$bundle_version" "$0"; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Linux ] || { printf 'This installer supports Linux only.\n' >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) arch=x86_64; deb_arch=amd64; rpm_arch=x86_64 ;;
  aarch64|arm64) arch=aarch64; deb_arch=arm64; rpm_arch=aarch64 ;;
  *) printf 'Unsupported CPU architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
  manager=apt; format=deb
elif command -v dnf >/dev/null 2>&1 && command -v rpm >/dev/null 2>&1; then
  manager=dnf; format=rpm
else
  printf 'Supported package managers: apt (Debian/Ubuntu), dnf (Fedora).\n' >&2
  exit 1
fi
for utility in sha256sum tar awk tail mktemp; do
  command -v "$utility" >/dev/null 2>&1 || { printf 'Required utility missing: %s\n' "$utility" >&2; exit 1; }
done
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/fengwo-install.XXXXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
payload_line=$(awk '/^__FENGWO_PAYLOAD__$/ { print NR + 1; exit }' "$0")
[ -n "$payload_line" ] || { printf 'Installer payload is missing.\n' >&2; exit 1; }
tail -n +"$payload_line" "$0" > "$work_dir/payload.tar.gz"
printf '%s  %s\n' "$payload_sha256" "$work_dir/payload.tar.gz" | sha256sum -c - >/dev/null
tar -tzf "$work_dir/payload.tar.gz" | while IFS= read -r entry; do
  case "$entry" in
    ./|./SHA256SUMS|./fengwo-x86_64.deb|./fengwo-aarch64.deb|./fengwo-x86_64.rpm|./fengwo-aarch64.rpm) ;;
    *) printf 'Unexpected archive entry.\n' >&2; exit 1 ;;
  esac
done
tar -xzf "$work_dir/payload.tar.gz" -C "$work_dir" --no-same-owner --no-same-permissions
(cd "$work_dir" && sha256sum -c SHA256SUMS >/dev/null)
package="$work_dir/fengwo-$arch.$format"
[ -f "$package" ] || { printf 'This bundle is missing the selected package.\n' >&2; exit 1; }
if [ "$format" = deb ]; then
  [ "$(dpkg-deb -f "$package" Architecture)" = "$deb_arch" ] || { printf 'DEB architecture mismatch.\n' >&2; exit 1; }
  [ "$(dpkg-deb -f "$package" Package)" = fengwo-linux ] || { printf 'DEB package name mismatch.\n' >&2; exit 1; }
  [ "$(dpkg-deb -f "$package" Version)" = "$bundle_version" ] || { printf 'DEB version mismatch.\n' >&2; exit 1; }
else
  [ "$(rpm -qp --queryformat '%{ARCH}' "$package")" = "$rpm_arch" ] || { printf 'RPM architecture mismatch.\n' >&2; exit 1; }
  [ "$(rpm -qp --queryformat '%{NAME}' "$package")" = fengwo-linux ] || { printf 'RPM package name mismatch.\n' >&2; exit 1; }
  [ "$(rpm -qp --queryformat '%{VERSION}' "$package")" = "$bundle_version" ] || { printf 'RPM version mismatch.\n' >&2; exit 1; }
  [ "$(rpm -qp --queryformat '%{RELEASE}' "$package")" = "$bundle_build" ] || { printf 'RPM release mismatch.\n' >&2; exit 1; }
fi
printf 'Fengwo Linux %s | CPU: %s | Package manager: %s\n' "$bundle_version" "$arch" "$manager"
if [ "$mode" = check ]; then printf 'Package checks passed. Dependencies will be resolved by %s during installation.\n' "$manager"; exit 0; fi
if [ "$mode" = extract ]; then
  [ -n "$extract_dir" ] && [ ! -e "$extract_dir" ] || { printf 'Extraction directory must not already exist.\n' >&2; exit 1; }
  mkdir -p "$extract_dir"
  cp "$work_dir"/fengwo-* "$work_dir/SHA256SUMS" "$extract_dir/"
  exit 0
fi
if [ "$assume_yes" -ne 1 ]; then
  printf 'Install or update Fengwo and required system dependencies? [y/N] '
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) exit 0 ;; esac
fi
run_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v pkexec >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then pkexec "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else printf 'Administrator access is required. Run this installer with sudo.\n' >&2; return 1
  fi
}
case "$manager" in
  apt)
    run_root apt-get update
    run_root apt-get install -y --no-install-recommends "$package"
    ;;
  dnf) run_root dnf install -y "$package" ;;
esac
printf 'Fengwo Linux installed. Open Fengwo Linux from your application menu.\n'
exit 0
__FENGWO_PAYLOAD__
