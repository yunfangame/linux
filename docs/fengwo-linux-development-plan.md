# Fengwo Linux Port

## Baselines And Scope

- Target: `codex/fengwo-linux`, Linux only.
- Upstream: official `v2.5.6`, commit `b057bd964ccd156f68bc43a3a8ed66cf3cb1cd7b`.
- Business reference: `codex/desktop-upstream-0897-port`, commit `a0d81b915a3f48ae22abac67bde5ff82c241ffe2`.
- Architectures: x86_64 and aarch64 together in one `.run` installer.
- Initial desktop targets: Debian 12 and Ubuntu 24.04. Fedora RPM support requires separate runtime qualification.
- Networking remains Clash Verge: mihomo, service authorization, system proxy, TUN, connection monitoring, modes and proxy selection.
- Measurement follows desktop logic: batches of 50, nested selected-node resolution, provider identity, offline metadata, actual latency without artificial compensation.

This is a source implementation and integration baseline, not a production-qualified release. Native package build and installation results are recorded below; no production release has been published.

## Feature Map

| Area | Linux implementation |
|---|---|
| Acceleration home | Usage/expiry, selected node, connect/disconnect, system proxy/TUN, modes, subscription refresh, announcements |
| Plans | Periods, cents-based prices, current/sold-out plans, sanitized content, order creation, payment methods, QR/link checkout and polling |
| Nodes | Online status, group selection, search/sort, batch/single latency, Clash Verge selection |
| Proxy rules | Live connections, search/pause/close/details, rules from connections, account-owned create/edit/enable/reorder/delete |
| Traffic | Raw and multiplier-billed records, local-day/month totals, remaining quota |
| Orders | Status filters, details, cancellation confirmation, resume payment |
| Invitations | Codes/links, commission totals/details, balance transfer, withdrawal ticket |
| Personal center | Balances, reminders, password change, login-IP history/block/unblock, security reset |
| Advanced settings | Clash Verge network/application settings, campus hosts, Linux service/environment diagnostics and updates |
| Tools | Speed-test sites, Cloudflare IP optimization/application, IP lookup, upstream media-unlock and proxy-chain tools, application links |
| Offline/logout | Owned cached profile, paused business requests, stale-response guards, proxy/TUN shutdown before logout |

The upstream proxy-chain editor replaces Flutter's external SOCKS/HTTP chain editor. Secure V2 is required: legacy/gray-list login fallback is **not** enabled. Accounts outside secure rollout receive an explicit error, not a silent protocol downgrade.

## Architecture

- UI: `src/pages/fengwo/`; business/session adapter: `src/services/fengwo.ts`; measurement: `src/services/fengwo-delay.ts`.
- Native business/profile ownership: `src-tauri/src/cmd/fengwo.rs`.
- Crypto: `fengwo_crypto.rs`, using ring Ed25519, X25519, HKDF-SHA256 and AES-256-GCM.
- Updates: `fengwo_linux.rs`; bounded network tools/campus parsing: `fengwo_tools.rs`.
- Profiles are validated/applied through existing Clash Verge APIs. Failed core validation retains the previous valid runtime configuration.
- Encrypted session file: `fengwo-session.enc`, mode 0600 inside an owner-only app directory. Passwords are not persisted.
- Login activates the correct account before refresh. Accounts without a subscription receive an empty reject profile, never another account's nodes.
- Session IDs reject stale responses. Public summary/user fields are allowlisted; business IPC does not return auth data or device keys.
- Credential expiry and signing-key rotation require password reauthentication. Cached local subscriptions remain available offline; secure sessions never fall back to token-based device registration. Older encrypted stores remain readable.
- Cloudflare optimization and IP lookup release the session mutex while probing. Results are rejected after account changes, logout or entering offline mode.
- Plaintext node configuration necessarily reaches mihomo on disk; it is not hidden from the local account owner/root.
- Product: `Fengwo Linux`; app-data ID: `com.fengwo.linux` (`.dev` in development). Native binary/service names remain upstream-compatible.
- Packages conflict with `clash-verge` because of shared native binaries/services. **No side-by-side installation.** Upstream user configuration is not imported or deleted.

## Build And Install

The bundler requires these four real, architecture-checked inputs:

```text
fengwo-x86_64.deb
fengwo-aarch64.deb
fengwo-x86_64.rpm
fengwo-aarch64.rpm
```

It verifies the actual package name, architecture, version and RPM release across all four inputs. It embeds archive and per-package checksums and writes a whole-file `.sha256` and `.json` build record. The installer validates before elevation, detects architecture and apt/dnf, and lets the package manager resolve dependencies. It does not install a desktop, modify firewall settings or automatically enable proxy/TUN.

```sh
sh Fengwo-Linux-universal.run --check
sh Fengwo-Linux-universal.run
# Skip package confirmation, but not administrator authentication:
sh Fengwo-Linux-universal.run --yes
```

Runtime dependencies include WebKitGTK 4.1, AppIndicator, TLS certificates and polkit. Debian/Ubuntu use `pkexec` and `polkitd`, not `policykit-1`. GUI updates need a desktop polkit agent; terminal installation can use sudo. Running the app requires a graphical desktop.

`.github/workflows/fengwo-linux.yml` builds both architectures natively inside Debian 12 containers, keeping the glibc baseline consistent. It uploads artifacts but never publishes. Use this workflow for this branch, not inherited upstream multi-platform release workflows.

The build repository is `https://github.com/yunfangame/linux` (public), with `codex/fengwo-linux` as its development branch. `origin` points there; `upstream` preserves the official repository. The optional workflow download URL can be omitted for artifact-only test builds, which do not produce an online update entry. Bootstrap keys belong in Actions Secrets, never Git. Inherited upstream workflows are disabled in repository settings.

Build secrets/settings:

- `REMOTE_CONFIG_AES_KEY`: existing remote-config AES key.
- `REMOTE_CONFIG_SIGNING_PUBLIC_KEY`: existing remote-config Ed25519 public key.
- `FENGWO_BUILD_NUMBER`: positive, globally increasing Linux release number, identical for both architectures.
- Optional `FENGWO_ENV_FILE`: private JSON file outside Git containing those values.

```sh
export FENGWO_BUILD_NUMBER=2
export FENGWO_ENV_FILE=/private/path/to/env.json
pnpm install --frozen-lockfile
pnpm prebuild x86_64-unknown-linux-gnu
pnpm linux:build --target x86_64-unknown-linux-gnu
# Repeat on native ARM64 with aarch64-unknown-linux-gnu.
pnpm linux:bundle linux-packages artifacts/Fengwo-Linux-universal.run
```

The build number enters the Tauri package version and RPM release field, allowing upgrades within the same upstream version. Keep the same exported build number when bundling and generating update metadata; mismatches fail the build. The existing desktop `env.json` has the two required key fields and can be reused by path, without copying it into this repository.

## Updates From Configuration

Fengwo Linux uses its own product version starting at `1.0.0`; the upstream source baseline remains official `v2.5.6`. Build numbers continue increasing independently. Release packages use epoch `1` (DEB `1:1.0.0+7`, RPM epoch `1`, version `1.0.0+7`, release `7`) so package managers accept the transition from the earlier `2.5.6+6` test packages. Run `scripts/linux/collect.mjs` after native builds to apply the Debian epoch using `python3-debian`; the universal bundler rejects packages with a missing epoch. Displayed versions and update manifest versions never contain a package-manager epoch.

Update checks require fresh verified main configuration instead of silently falling back to the cached main configuration. Read-only configuration requests retry transient transport/502/503/504 errors once; signature, permission and format errors are not retried. The UI distinguishes update configuration/signature errors and missing or redirected downloads. Downloads still require explicit installation confirmation and SHA-256 validation.

1. Verify/decrypt the existing remote configuration and read its `UpdateUrl` HTTPS URL.
2. Fetch and verify/decrypt its `fengwo-config` envelope using the same trusted bootstrap keys.
3. Require inner `Authentication: FengWo`, `format: fengwo-update`, `schemaVersion: 1`.
4. Read only `packages.linux-universal`, preserving other platforms.
5. Require a higher build number, bind installation to the exact build/hash the user confirmed, download the unified installer, verify SHA-256, and invoke the package manager. A changed manifest requires new confirmation.

Example **inner** entry to merge into the existing manifest before signing/encryption:

```json
{
  "linux-universal": {
    "enabled": true,
    "version": "2.5.6+2",
    "buildNumber": 2,
    "installerFormat": "fengwo-universal-run-v1",
    "downloadUrl": "https://downloads.example.org/Fengwo-Linux-universal.run",
    "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_SHA256",
    "title": "Fengwo Linux"
  }
}
```

`scripts/linux/update-entry.mjs` generates the entry using the real installer, its `.json` build record, `FENGWO_BUILD_NUMBER` and `FENGWO_DOWNLOAD_URL`. It rejects a mismatched build record or installer hash. It does not sign/publish and must not replace the entire multi-platform manifest. The existing configuration publisher owns signing/encryption; private signing/server keys never belong in client builds.

Missing/disabled Linux entries mean no update. Unsigned manifests, altered payloads, HTTP downloads and downgrades are rejected. Checks run daily, can be disabled, and pause offline. The sidebar update dialog works before login, including manual checks when automatic checks are disabled. Install requires explicit confirmation and administrator authorization. Upstream application updates are disabled on Linux; Clash Verge still owns core updates.

## Verification

Current local results: 50 frontend tests, 18 native Fengwo tests, and 10 installer tests pass. Type checking, focused ESLint, frontend production build, CI YAML parsing and ten-page desktop/mobile Playwright smoke checks also pass. Browser coverage additionally exercises expired-session reauthentication, offline access to a retained subscription, logout, and confirmed installation from the signed-out update dialog. These are native IPC fixtures, not live installation. The frontend build reports non-fatal shared Markdown chunk warnings.

```sh
pnpm typecheck
pnpm test
pnpm linux:test
pnpm web:build
cargo test --locked -p clash-verge --features clippy fengwo --lib
```

`scripts/linux/ui-smoke.mjs` runs Playwright with **test-only native IPC fixtures** against `pnpm web:dev --host 127.0.0.1 --port 4319 --strictPort`. Set `PLAYWRIGHT_MODULE`/`PLAYWRIGHT_CHANNEL` for an external runtime. Screenshots: ignored `target/fengwo-ui/`. This verifies React views and interactions, not a live Tauri/payment backend.

2026-09-29 test-host audit:

| Host | CPU/RAM | GUI | Result |
|---|---|---|---|
| Supplied Debian VPS | x86_64 / 751 MiB | None | Debian 12, glibc 2.36; runtime dependencies resolve after package-index refresh |
| Supplied Ubuntu VPS | x86_64 / 894 MiB | None | Ubuntu 24.04.2, glibc 2.39; runtime dependencies resolve after package-index refresh |

Only package indexes were refreshed and installation simulated. No app package, desktop, proxy service, firewall rule or production release was installed/changed. Credentials are not stored in the repository.

2026-09-30 initial follow-up: the Debian host still had 751 MiB RAM, no swap, and no Node/Rust toolchain. Its actual `dpkg --compare-versions` confirmed `2.5.6+2` upgrades `2.5.6+1`. This check was read-only, not an application build or installation test. The code was subsequently pushed to the user-provided `yunfangame/linux` repository; the official upstream remote remains unchanged.

### Build 1 And Fresh Installation

On 2026-09-30 (Asia/Shanghai), [Actions run 36597968807](https://github.com/yunfangame/linux/actions/runs/36597968807) completed successfully from commit `19779762394165560602fea2029c54a484807eb9`. Each native architecture passed type checking, 50 frontend tests, 18 native Fengwo tests and 10 installer tests before producing DEB and RPM packages. An earlier run exposed GNU tar's external `gzip` dependency in the isolated test PATH; the installer now checks for it explicitly and the test fixture includes it.

The `fengwo-linux-universal` artifact contains `Fengwo-Linux-universal.run`, its SHA-256 file and its JSON build record. All four embedded packages have package name `fengwo-linux` and version `2.5.6+1`; RPM release is `1`. DEB architectures are `amd64`/`arm64`, and RPM architectures are `x86_64`/`aarch64`. The bundle job verified these fields before packaging. Artifacts are retained for 14 days, not published as a GitHub Release.

Installer SHA-256:

```text
8cb3c57bf7ebf92160e30d865124741bb838b2d4c1e3f8574799f0b472d4285f
```

Both authorized test hosts downloaded the same artifact, verified its GitHub artifact digest and installer checksum, and passed `sh Fengwo-Linux-universal.run --check`. Installation used `--yes` as root with `DEBIAN_FRONTEND=noninteractive` and `NEEDRESTART_MODE=l`; unrelated service restarts were deferred.

| Host | Fresh installation | Post-install result |
|---|---|---|
| Debian 12 x86_64, glibc 2.36 | `fengwo-linux 2.5.6+1`, 147 runtime dependencies resolved by apt; no existing packages upgraded or removed | Package integrity and all six executable dependency checks passed |
| Ubuntu 24.04.2 x86_64, glibc 2.39 | `fengwo-linux 2.5.6+1`, 140 runtime dependencies resolved by apt; no existing packages upgraded or removed | Package integrity and all six executable dependency checks passed |

`dpkg --verify fengwo-linux` returned no differences on either host. `ldd` found no unresolved libraries for the app, both cores and all three service binaries. Both `verge-mihomo -v` (v1.19.31) and `verge-mihomo-alpha -v` (alpha-63bd52e) executed successfully. The desktop entry is named `Fengwo Linux` and runs `clash-verge %u`. The proxy service remains inactive; the graphical app was not launched, and no proxy/TUN or firewall settings were changed. The client and its runtime dependencies remain installed on both test hosts.

No online update entry was generated or published for this build. ARM64 passed native compilation and unit tests, but has not had a real-device desktop installation test. Fresh installation does not establish upgrade, uninstall, GUI, proxy/TUN or business-backend correctness.

## Release Gates Still Open

- Test upgrade, uninstall and interrupted-install recovery with real packages. Dual-architecture compilation, package metadata inspection and x86_64 fresh installation are complete for build 1.
- Real ARM64 and Fedora runtime tests.
- GNOME/KDE launch, system proxy, polkit/TUN and recovery as a normal desktop user, not root.
- Staging-account login, tickets, node metadata, billing, payments, invitations and IP controls. The checked-out XBoard main source does not dispatch `get_nodes`; the `20260922_subscription_v2_nodes` deployment candidate does. Linux now validates its `{ nodes: [...] }` contract and allowlists the same metadata fields, but the live deployed backend still needs verification.
- Publish a signed test `linux-universal` entry and exercise installation/restart. No release has been published.
- Live credential-expiry/key-rotation, disk-write-failure, account-switch and slow-network fault testing. Expiry/rotation decisions, stale diagnostic-result rejection and frontend reauthentication now have local regression coverage.
- Runtime profile application still precedes encrypted-store persistence; disk-full rollback/recovery requires additional native integration work. Plan changes within a logged-in session also need profile-scope refresh coverage.
