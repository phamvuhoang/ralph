# Keep Ralph Alive While AFK

Ralph's `ralph-afk` / `ralph-ghafk` bins acquire an OS wake-lock for the lifetime of the loop so a sleeping laptop doesn't kill an overnight run. This is on by default — no flag, no manual OS recipe.

## What's automatic (Phase 1)

| OS      | Mechanism                                                                                            | Scope                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Windows | long-lived `powershell` child calling `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` | system sleep only — display can still dim                                                    |
| macOS   | `caffeinate -i -w <pid>`                                                                             | system sleep only; ties caffeinate's lifetime to the parent pid so a SIGKILL still cleans up |
| Linux   | `systemd-inhibit --what=sleep --mode=block sleep infinity`                                           | system sleep only                                                                            |
| WSL2    | Linux path runs (blocks WSL idle), **plus** a warning that it does not block Windows host sleep      | see caveat below                                                                             |

The wake-lock is acquired before iteration 1 and released on any exit path:

- clean completion (sentinel hit or iteration cap reached)
- thrown exception in any stage
- `SIGINT` (Ctrl-C) — process exits 130 after release
- `SIGTERM` — process exits 143 after release

## Opt out

Pass `--no-keep-alive` to skip wake-lock acquisition entirely. Useful for short interactive runs where Ctrl-C should be instant.

```bash
ralph-afk --no-keep-alive "<plan>" 3
```

`--print-config` shows the current state:

```
keep-alive            on (system sleep only)
```

or:

```
keep-alive            off
```

## Per-OS notes

### Windows

No admin required. `SetThreadExecutionState` is a user-level Win32 API; the wake-lock holds for the lifetime of the `powershell` child, which is killed when the loop releases. Verify with:

```powershell
powercfg /requests
```

You should see a `SYSTEM` request while the loop is running, and no requests after it exits.

### macOS

`caffeinate -i` blocks idle system sleep but allows the display to dim/sleep — that's intentional so a battery laptop doesn't burn through the night with the screen on. Verify with:

```bash
pmset -g assertions | grep PreventUserIdleSystemSleep
```

The `-w <pid>` flag makes caffeinate self-terminate if the parent dies first, so a `kill -9` on `ralph-afk` still releases the inhibitor.

### Linux

Requires `systemd-inhibit` (ships with systemd). Verify with:

```bash
systemd-inhibit --list
```

If `systemd-inhibit` is missing (minimal container, chroot, etc.), the loop logs one warning to stderr and continues without the wake-lock — it never crashes on a missing utility.

### WSL2

WSL2 is detected by sniffing `/proc/version` for `microsoft`. The Linux path still runs (and blocks WSL idle if systemd is enabled in `/etc/wsl.conf`), but **it cannot block Windows host sleep**. A one-line warning is emitted at acquisition.

If you're running overnight AFK loops from WSL2, configure the Windows power plan separately:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
```

A WSL2 → Windows host wake-lock bridge would require a Windows-side helper process; that's out of scope for v1.

## Coming in later phases

- **Phase 2** — per-iteration retry with exponential backoff (`--max-retries`).
- **Phase 3** — `--detach` fork-and-exit so closing the terminal doesn't kill the loop (`--log <path>` to override the log target).
- **Phase 4** — `--notify` for OS-native notifications + terminal bell on terminal events.

## Out of scope (v1)

- **Power-loss / battery-death** — a dead battery kills the loop. Use a UPS if you care about overnight resilience to power events.
- **Resume on restart** — if the host reboots, the loop does not auto-resume from iteration N+1. The git commits the loop has already produced are the practical resume mechanism.
- **WSL2 → Windows host wake-lock bridge** — see WSL2 section above. Run natively on Windows for AFK use, or set the Windows power plan manually.
