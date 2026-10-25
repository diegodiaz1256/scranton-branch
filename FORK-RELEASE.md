# Scranton Branch 1.2.0

## What's new

- **Agents cannot leave their sandbox.** When the app does not answer, an agent's file tools are refused outside its folders instead of let through; `dangerouslyDisableSandbox` no longer works; agents cannot edit their own settings, hooks or the hive's commands; and an agent the office could not prepare is not started without its sandbox. Pi and agy run in an OS sandbox the app builds on Linux and WSL floors, and agy's hooks load again so its tool calls are checked. A human-only "Run without sandbox" switch exists for when you really need it, with a red badge and an audit line.
- **Your keys and logins stay yours.** Agents no longer read `~/.ssh`, `~/.gnupg` or 1Password's socket. When you allow it, git over SSH, Git LFS and commit signing go through the office: the app uses your key outside the sandbox and the agent never sees it. Cloud CLI logins (gh, aws, az, gcloud, kubectl, docker, npm, netrc, git credentials) are hidden too, and you can allow them one by one per agent.
- **Critical connections.** Mark a Jira or Confluence connection critical and only one custodian agent reaches it. It keeps raw material in a confidential vault only it and you can open, its mail is redacted, and nothing it sends out leaves without your sign-off.
- **Deliverables, redone.** One way to organise at a time (recent, task, agent, folders), every file listed newest first, HTML rendered for real in a sandboxed frame, big documents no longer freeze the window, a path an agent prints opens the file in Deliverables, and the history shows the agent that made each change.
- **WSL floors work better.** The key broker is reachable from the sandbox, relative paths are checked where the shell really is, Claude's temp folder no longer breaks after a restart, finished temps archive themselves after a restart too, hive messages no longer pile up unsent in an agent's prompt, and opening an agent's terminal no longer marks it as working.
- **More:** edit, cancel and reopen tasks; three office levels (full, no walking, no office) with an automatic mode; a warning to agents near your 5-hour and weekly limits; Skills as their own page, with big skills installing; pi's usage in the fleet stats; a temp near its token cap is told to wrap up; agents default to Sonnet 5.5; the hive's commands are `sb-*` (the `md-*` names still work); and the docs and site say Scranton Branch.

## License

From 1.0.0 Scranton Branch is licensed under the **Apache License 2.0**. If you redistribute it, changed or not, keep the [NOTICE](https://github.com/diegodiaz1256/scranton-branch/blob/main/NOTICE) file with it. The parts that come from Munder Difflin, and the fork up to 1.0.0, stay under the MIT License.

## Earlier releases

| Version | Highlights |
|---|---|
| 1.1.3 | MCP servers that log in with a key in a header can be imported. |
| 1.1.2 | Office browser spends fewer tokens, keys work in a Windows floor, Linux launcher survives updates. |
| 1.1.1 | WSL offices: agents write in their own folders again, fewer freezes. |
| 1.1.0 | Subagents checked against their agent's limits, runner proposals in the app, clearer Settings. |
| 1.0.1 | Factories and agent page layout fixes. |
| 1.0.0 | Own versions, Apache-2.0, Memory that explains itself, best on Windows with WSL. |
| fork.38 | Clearer Memory, temps that keep working and keep what they learn, faster on slow disks; the step to 1.0.0. |
| fork.37 | Windows: removing an agent's isolated copy no longer empties your project's node_modules. |
| fork.36 | Several offices at once, half the size, freeze log, an orchestrator that knows the app, your own skill marketplaces, PDF previews. |
| fork.35 | No freezes on a busy floor, lighter agents, git and folder guard, office skills, Backlog, deliverable diffs. |
| fork.34 | Inbox as a chat per agent, task history, deliverables with authors, agents keep their conversation. |
| fork.33 | Now view, a tidier sidebar, fewer tokens spent, safer engine installs. |
| fork.32 | The office browser comes up when a page fails, and uses less memory. |
| fork.31 | Office browser for pages a plain fetch cannot read, a lighter Floor view, Manager shows the office starting. |
| fork.30 | Offline dictation, agents stop searching your disk, Pi and OpenCode record session and cost. |
| fork.29 | Pi reaches your own providers with their key; text boxes stay typeable after dialogs on Windows. |
| fork.28 | APIs (Jira) apply to running agents at once, Pi keeps its model after a restart, your own models in New agent. |
| fork.27 | Pi and OpenCode sign-in and models in the app, local models, REST API access per role. |
| fork.26 | Connections with per-role permissions, Deliverables linked to tasks, readable agent steps, MCP managed in the app. |
| fork.25 | Memory by project and lists, model and effort per role, Spanish everywhere, 5h/weekly usage in the title bar. |
| fork.24 | Memory offline with a concept graph, hires as a CV, Remote Control button, WSL orchestrator always starts. |
| fork.23 | Upgrades install over the previous version instead of running its uninstaller. |
| fork.22 | Offices in deeply nested folders keep their agents' hooks. |
| fork.21 | The fallback uninstaller no longer stops on "in use"; the WSL folder picker opens in Linux. |
| fork.20 | "Uninstall without uninstaller" entry; trust company or local certificates. |
| fork.19 | WSL offices: memory, workers, runners and Slack replies inside the distribution. |
| fork.18 | Clear WSL errors (blocked wsl.exe, timeouts, missing distribution or node). |
| fork.17 | **WSL offices** and **MCP import** from your other tools. |
| fork.16 | **Environment**: variables for agents, and secrets they use but never see. |
| fork.11–15 | **Factories**: send work to a software factory and watch it work. |
| fork.8–10 | Publisher name, agents close cleanly on quit, image previews. |

## Downloads

### macOS
| | |
|---|---|
| Universal (Apple Silicon + Intel) | [`Scranton-Branch-1.2.0-mac-universal.dmg`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.2.0-mac-universal.dmg) |

### Windows
| | |
|---|---|
| Installer (x64), *recommended* | [`Scranton-Branch-1.2.0-win-x64-setup.exe`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.2.0-win-x64-setup.exe) |
| Portable (x64, no install) | [`Scranton-Branch-1.2.0-win-x64-portable.exe`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.2.0-win-x64-portable.exe) |

### Linux
| | |
|---|---|
| AppImage (x86_64) | [`Scranton-Branch-1.2.0-linux-x86_64.AppImage`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.2.0-linux-x86_64.AppImage) |
| Server, no GUI (x64) | [`scranton-branch-server-1.2.0-linux-x64.tar.gz`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/scranton-branch-server-1.2.0-linux-x64.tar.gz) |
| Server, no GUI (arm64) | [`scranton-branch-server-1.2.0-linux-arm64.tar.gz`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/scranton-branch-server-1.2.0-linux-arm64.tar.gz) |

Server: unpack, then run `sudo ./install.sh`. Setup, Docker and secrets are in [SERVER.md](https://github.com/diegodiaz1256/scranton-branch/blob/main/SERVER.md).

Builds are not code-signed yet: macOS asks you to allow the app in System Settings → Privacy & Security, and Windows SmartScreen asks you to confirm ("More info" → "Run anyway").

Source: [`v1.2.0`](https://github.com/diegodiaz1256/scranton-branch/archive/refs/tags/v1.2.0.tar.gz)

## About Scranton Branch

Scranton Branch began as the branch office of [Munder Difflin](https://github.com/HarnessMD/munder-difflin) 0.4.6, and adds offices that work together (post-quantum sealed), a headless server edition, Factories, WSL offices and secrets agents use but never see. No product analytics. From 1.0.0 it has its own versions; the in-app updater follows this repository only.
