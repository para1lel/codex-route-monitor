# Magpie companion source patch

These are **unofficial, version-matched Magpie core companion patches** for this plugin's manual buttons in the Codex account editor. Upgrading only `codex-route-monitor` is insufficient: unmodified Magpie lacks the account-provider panel hook, provider filtering, and the own-tool bridge used by these buttons. The existing CLI/MCP tools do not require this GUI extension.

- Upstream: [yetone/magpie](https://github.com/yetone/magpie).
- Example baseline: [`f435aadbf387fab1347b239d0477df2f2328ca27`](https://github.com/yetone/magpie/commit/f435aadbf387fab1347b239d0477df2f2328ca27), **v0.1.2522**. Other supported exact bases are listed below.
- This is a patch of that baseline, **not an upgrade or an official upstream release**. Do not apply it blindly to another version or downgrade a newer installation to use it. Newer versions require their own exact-base forward port, tests, and build; retain the installed version and platform build mode.
- The source patch is available here independently of any binary release. If using a separately supplied companion binary, verify its matching source base, patch, platform/architecture, and published checksum. This document does not claim that release assets have been published.
- Upstream is MIT, Copyright (c) 2026 yetone. [MAGPIE-LICENSE.txt](<MAGPIE-LICENSE.txt>) is an unmodified copy of the upstream license. Distributions of modified core binaries must retain it and the applicable upstream third-party notices; this patch does not replace those notices.

## Supported exact versions

| Version | Upstream source base | Patch |
| --- | --- | --- |
| 0.1.2522 | `f435aadbf387fab1347b239d0477df2f2328ca27` | [0.1.2522 patch](<magpie-0.1.2522-manual-panels.patch>) |
| 0.1.2523 | `fb3942ee67a719a4e4733cdb632873defd42f28b` | [0.1.2523 patch](<magpie-0.1.2523-manual-panels.patch>) |
| 0.1.2605 | `7d1f2ecba35bdaee25ea1b131a7f294900c4dcd8` | [0.1.2605 patch](<magpie-0.1.2605-manual-panels.patch>) |

The 2522 and 2523 patches have identical contents, independently checked against both exact source trees. The 2605 forward port retains its upstream model-filter hint and updates its existing GUI/CLI parity declaration. All three keep JavaScript within the upstream script-size budget; only the shared bridge header comment was shortened, with the complete security/design documentation retained.

Use the matching base/patch/version together. Examples below use **2522**; for **2523** or **2605**, replace the source commit, patch filename and `main.version` value together. Do not install the 2522 binary over a newer release. Checksums and bases are also recorded in [manifest.json](<manifest.json>).

## Apply to a clean, exact checkout

The examples assume the plugin repository and a new upstream checkout are sibling folders. Set `PATCH` to the actual absolute patch path if they are not. No account data, credentials, configuration, or generated build resources are part of the patch.

```sh
# Git Bash / POSIX shell. Use a new destination, not a running installation.
git clone https://github.com/yetone/magpie.git magpie-manual-panels
cd magpie-manual-panels
git checkout --detach f435aadbf387fab1347b239d0477df2f2328ca27
BASE=f435aadbf387fab1347b239d0477df2f2328ca27
test "$(git rev-parse HEAD)" = "$BASE" || exit 1
test -z "$(git status --porcelain --untracked-files=all)" || exit 1
PATCH="$(cd ../codex-route-monitor/patches && pwd)/magpie-0.1.2522-manual-panels.patch"
git apply --check --whitespace=error-all "$PATCH" || exit 1
git apply --whitespace=error-all "$PATCH" || exit 1
git diff --check || exit 1
```

For PowerShell, after creating and entering the clean checkout:

```powershell
$Base = 'f435aadbf387fab1347b239d0477df2f2328ca27'
if ((git rev-parse HEAD) -ne $Base) { throw 'Wrong Magpie base' }
if (git status --porcelain --untracked-files=all) { throw 'Checkout must be clean' }
$Patch = (Resolve-Path ..\codex-route-monitor\patches\magpie-0.1.2522-manual-panels.patch).Path
git apply --check --whitespace=error-all $Patch
if ($LASTEXITCODE) { throw 'Patch check failed' }
git apply --whitespace=error-all $Patch
if ($LASTEXITCODE) { throw 'Patch apply failed' }
git diff --check
if ($LASTEXITCODE) { throw 'Whitespace check failed' }
```

Do not use `--reject`, ignore failed hunks, or copy only the tracked diff. The three added Go files are essential, not optional tests/resources.

## Build flags for this baseline

The commands below are reproduction instructions, **not installation, restart, or deployment commands**. They require build dependencies to have been installed separately. They do not run Magpie or its plugin tools. Build in the patched source checkout; generated resources belong only there and are deliberately absent from the patch.

### Windows amd64 desktop: portable Go 1.26.8

Set `$Go` to the executable from an unpacked **Go 1.26.8** toolchain (not an older `go` from `PATH`). The GUI uses WebView2, not cgo. These are the current Windows production flags: `production,comlauncher`, `-trimpath`, and `-ldflags '-s -w -X main.version=0.1.2522 -H windowsgui'`. Keep the embedded console launcher: building the app with `comlauncher` requires generating it first.

```powershell
# $Go must already name the portable toolchain's bin\go.exe.
if (-not $Go) { throw 'Set $Go to the portable Go 1.26.8 executable' }
$Go = (Resolve-Path $Go).Path
$env:GOTOOLCHAIN = 'local'
if ((& $Go version) -notmatch '^go version go1\.26\.8 windows/amd64$') {
  throw 'Expected portable Go 1.26.8 for Windows amd64'
}
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
New-Item -ItemType Directory -Force dist | Out-Null

# Upstream's pinned resource generator: icon, version, DPI-aware manifest.
& $Go run github.com/tc-hib/go-winres@v0.3.3 make --in build/windows/winres.json --arch amd64 --out rsrc --file-version '0.1.2522' --product-version '0.1.2522'
if ($LASTEXITCODE) { throw 'Windows resources failed' }

# Launcher bytes intentionally omit VCS metadata, as upstream requires.
& $Go build -trimpath -buildvcs=false -ldflags '-s -w' -o internal/update/launcher-amd64.com ./internal/update/launcher
if ($LASTEXITCODE) { throw 'Console launcher build failed' }
& $Go build -tags production,comlauncher -trimpath -ldflags '-s -w -X main.version=0.1.2522 -H windowsgui' -o dist/magpie-windows-amd64.exe .
if ($LASTEXITCODE) { throw 'Desktop build failed' }
& $Go version -m dist/magpie-windows-amd64.exe
Get-FileHash -Algorithm SHA256 dist/magpie-windows-amd64.exe
```

The version string deliberately stays `0.1.2522`; it does **not** identify patched vs. stock builds. Record the source base, this patch's checksum, and the binary checksum alongside the artifact. This is source/flag reproducibility, not a promise of byte-identical binaries across arbitrary module caches or VCS environments. `-trimpath` removes source-directory paths from the build. To build Windows arm64, use the corresponding `GOARCH`, resource architecture, launcher filename, and output name; do not reuse the amd64 launcher.

### Linux headless / web-service build

This is the correct mode for an existing `nogui`, `CGO_ENABLED=0` service. `nogui` still embeds the web UI and this bridge; it only excludes native desktop window integration. It needs neither GTK nor `comlauncher`. The following command is **only for this exact v0.1.2522 patch**; do not stamp or deploy it as a replacement for a newer installed version.

```sh
# Run with Go 1.26.8 on PATH; no transparent toolchain substitution.
export GOTOOLCHAIN=local
test "$(go version | awk '{print $3}')" = go1.26.8 || exit 1
mkdir -p dist
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui -trimpath \
  -ldflags '-s -w -X main.version=0.1.2522' \
  -o dist/magpie-linux-amd64 . || exit 1
go version -m dist/magpie-linux-amd64
sha256sum dist/magpie-linux-amd64
```

Use `GOARCH=arm64` and the matching output name for an arm64 target. When forward-porting to another installed release, use that release's source, toolchain requirements, version ldflag, and build mode, rather than downgrading it to this base.

### Linux native desktop is different

A Linux desktop build requires native cgo, GTK 3 and WebKitGTK 4.1 development packages (`libgtk-3-dev`, `libwebkit2gtk-4.1-dev` on Debian/Ubuntu), plus a C toolchain. Build on the target architecture. With the same Go 1.26.8 and exact patched base:

```sh
CGO_ENABLED=1 go build -tags production,gtk3 -trimpath \
  -ldflags '-s -w -X main.version=0.1.2522' \
  -o dist/magpie-linux-desktop .
```

Do not copy Windows' `comlauncher` or `-H windowsgui` flags to Linux. Do not replace a headless service with a GTK desktop build.

## Scope and security properties

The patch changes the provider-editor integration and its permission boundary only:

- The account-provider editor receives the existing provider panel slot. Optional `panels.providers` filters by exact provider id **before** heading/frame creation. Omitted means all; an explicitly empty or malformed list matches none. Native editor label/control grid styling replaces card decoration for provider panels, with matching light/dark frame canvas and narrow layout.
- Optional `magpie.tools` is an explicit allowlist of **this plugin's own** tool names, not a blanket permission or an MCP-prefixed cross-plugin lookup. Malformed declarations grant nothing.
- The host window binds messages by `ev.source`, supplies the installed entry's spec, and ignores a spec claimed by the frame. The server independently checks the enabled plugin's live window manifest, explicit declaration, actual tool ownership under the same spec, and the existing Plugin tools gate; it rechecks the declaration/gate after listing tools.
- Sandboxed frames retain `allow-scripts` only and `connect-src 'none'`. CSP, `noFramedAPI`, API web guards, and existing read permissions are unchanged. No iframe network access, parent DOM access, credentials, or arbitrary core API is granted by this extension.
- Tool arguments must be a JSON object at most 64 KiB; the request envelope is bounded at 128 KiB. The host's existing timeout applies. Encoded tool replies are at most 1 MiB; oversized replies/errors fail rather than becoming successful tool text. Denials are HTTP 403.
- This bridge does **not** make manual scans read-only: clicking a test button invokes the plugin's real scan and consumes provider quota, applying its existing enabled/disabled-account policy. Do not click one merely to verify installation.

The patch does not modify account credentials, login/refresh handling, account ordering or on/off policy, subscription behavior, model fingerprint rules, schedule, routing groups, fallbacks, gateway routing policy, or provider configuration. Existing scheduled/manual scan semantics remain the plugin's responsibility.

## Coverage and packaging validation

Patch SHA-256:

```text
baf0080ea0bbdb69e457d5dac43d85a437bab9ca4a7165c537ab0341f29a26e2
```

Size of the 2522 patch: **53,294 bytes**. Check independently with `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum` on Linux.

Packaging validation: **PASS**. A fresh temporary tree was extracted from `git archive` of the exact base and all **7,301** original file contents were verified against that archive. `git apply --check --whitespace=error-all` passed, then the patch was applied successfully. All **12** intended changed paths were byte-for-byte identical to the working source, including all three added Go files. A full-tree SHA-256 comparison confirmed exactly the base plus these changes (**7,304** files), with no extra resources or artifacts. The source worktree's status, index checksum, and changed source bytes remained unchanged. The three no-index fragment commands each returned the expected difference exit code **1**.

Included paths (9 existing files and 3 newly added files):

```text
docs/subsystems/plugin-runtime.md
docs/subsystems/plugin-tools.md
internal/gui/assets/app.css
internal/gui/assets/app.js
internal/gui/assets/pluginpages.js
internal/gui/pagebridge.js
internal/gui/pluginpage.go
internal/gui/tests/plugin-panels.test.cjs
internal/plugin/page.go
internal/gui/pluginpage_tools.go                 NEW
internal/gui/pluginpage_tools_test.go            NEW
internal/plugin/page_permissions_test.go         NEW
```

Generation uses `git diff --binary --full-index` against the exact base for all tracked intended paths, plus `git diff --binary --full-index --no-index -- /dev/null relative/new.go` for **each** of the three added files. For those no-index diffs, exit **1** means differences and is intentionally accepted; exit greater than 1 is a failure. No staging or source modification is needed. All fragments have `a/` / `b/` relative paths and normal Git new-file headers. The resulting patch is UTF-8 without BOM and LF-only; it contains source, tests, and subsystem docs, not generated resources or binaries.

The patch includes manifest allowlist/filter tests, own-plugin tool ownership and denial tests, invalid input/size/failure tests, iframe/API isolation tests, and real-editor browser regressions for all five languages, both themes, narrow/wide viewports, Chromium and WebKit. Test execution is separate from patch packaging. Optional isolated regression commands, with Playwright and browsers provisioned separately:

```sh
go test -tags nogui ./internal/plugin -run '^TestWindowProviderFiltersAndToolAllowlist$'
go test -tags nogui ./internal/gui -run '^TestPluginPageTool'
# Playwright must be resolvable, e.g. through an already provisioned NODE_PATH.
node --test --test-concurrency=1 internal/gui/tests/plugin-panels.test.cjs
```

This packaging operation performs no build, live server run, account/vendor call, scan, restart, or installation. It does not claim that the optional regression commands were rerun during packaging.

## Updates and rollback

**Upstream updates, including manually replacing Magpie with a stock download, overwrite the patched executable and remove this core functionality.** Updating the plugin alone cannot restore it. Keep this patch, exact source base, build metadata, checksums, and a backup of the prior executable. For a newer upstream version, first produce and validate a matching forward port, then build with that version's own settings; never silently downgrade. No updater setting is changed by this patch.

To roll back, stop the relevant application/service deliberately and restore the saved original executable (and its matching launcher, if applicable). This source patch changes no user configuration or credentials. Do not blindly reverse-apply it in a checkout containing unrelated work, and do not remove user data as part of binary rollback.
