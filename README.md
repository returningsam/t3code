# T3 Code (fork)

A personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It tracks upstream `main` and adds the small changes listed below. The fork has no releases. The desktop app is built locally from source.

For what T3 Code is and which agents it supports, see the [upstream README](https://github.com/pingdotgg/t3code#readme).

## Changes from upstream

- **wt worktree layout.** Support for the layout from [wt](https://github.com/returningsam/wt), a Claude Code plugin with worktree hooks and skills. In a repo with a `.wt` file (written by `/wt:setup`), new worktrees go in `<repo>/worktrees/wt-<branch>` on `wt/<branch>` branches instead of `~/.t3/worktrees` on `t3code/...` branches. A new project opened at `<repo>/main` takes its title from the `.wt` file's name.
- **Sidebar PR CI status.** Threads with a linked PR show its CI state in the sidebar. The server keeps polling an open PR while its checks are pending, even after the agent has finished.
- **Claude plugin skills.** Skills from enabled Claude Code plugins appear in the skill pickers.
- **Skill names as written.** The skill pickers show skill names verbatim instead of title-casing them.
- **Mid-prompt slash menu.** Typing `/` after a space in the middle of a prompt opens the slash menu, not only at the start.
- **Dark favicon contrast.** In dark mode, dark project favicons sit on a tile in the sidebar icon color, including behind the project filter button.

## Build and install (macOS, Apple Silicon)

Install and authenticate at least one provider first. See [Install and first run](./docs/user/install.md).

T3 Code uses Vite+, so install the global `vp` tool and the dependencies:

```bash
curl -fsSL https://vite.plus | bash
vp i
```

The resource monitor needs a cargo that supports the 2024 edition. Homebrew's cargo works, so put it first on `PATH` when building:

```bash
PATH="/opt/homebrew/bin:$PATH" pnpm dist:desktop:dmg:arm64
```

Then replace the installed app with the new build. Run this outside T3 Code, since it quits the app:

```bash
osascript -e 'quit app "T3 Code (Alpha)"'
rm -rf "/Applications/T3 Code (Alpha).app"
ditto -x -k "$(ls -t release/*-arm64.zip | head -1)" /Applications
codesign --force --deep --sign "T3 Fork Local" "/Applications/T3 Code (Alpha).app"
open -a "T3 Code (Alpha)"
```

The `codesign` step re-signs the app with a local self-signed certificate named "T3 Fork Local". A stable signature across rebuilds stops the keychain from asking for a password at every launch. Skip it, or use your own certificate name, if you don't have one.

To run a dev server instead of a build, use `pnpm dev` (or `pnpm dev:desktop` for the Electron shell).

## Syncing with upstream

```bash
git fetch upstream
git merge upstream/main
```

## Documentation

Full docs live in [docs/](./docs). They describe upstream T3 Code and apply to the fork too.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

For build internals, start at [docs/internals/overview.md](./docs/internals/overview.md).
