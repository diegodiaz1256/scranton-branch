# Scranton Branch 1.1.3

## What's new

- **MCP servers that log in with a key in a header can be imported.** A remote server that authenticates with `Authorization: Bearer …` or `X-API-Key` (found in Claude Code, Cursor and the other tools' settings, or added by hand) now imports in one click. The key goes to the encrypted store and agents reach the server through the app's MCP gateway, so they can use its tools without ever seeing the key. The add and edit form has header rows with a secret toggle.

## License

From 1.0.0 Scranton Branch is licensed under the **Apache License 2.0**. If you redistribute it, changed or not, keep the [NOTICE](https://github.com/diegodiaz1256/scranton-branch/blob/main/NOTICE) file with it. The parts that come from Munder Difflin, and the fork up to 1.0.0, stay under the MIT License.

## Earlier releases

| Version | Highlights |
|---|---|
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
| Universal (Apple Silicon + Intel) | [`Scranton-Branch-1.1.3-mac-universal.dmg`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.1.3-mac-universal.dmg) |

### Windows
| | |
|---|---|
| Installer (x64), *recommended* | [`Scranton-Branch-1.1.3-win-x64-setup.exe`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.1.3-win-x64-setup.exe) |
| Portable (x64, no install) | [`Scranton-Branch-1.1.3-win-x64-portable.exe`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.1.3-win-x64-portable.exe) |

### Linux
| | |
|---|---|
| AppImage (x86_64) | [`Scranton-Branch-1.1.3-linux-x86_64.AppImage`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/Scranton-Branch-1.1.3-linux-x86_64.AppImage) |
| Server, no GUI (x64) | [`scranton-branch-server-1.1.3-linux-x64.tar.gz`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/scranton-branch-server-1.1.3-linux-x64.tar.gz) |
| Server, no GUI (arm64) | [`scranton-branch-server-1.1.3-linux-arm64.tar.gz`](https://github.com/diegodiaz1256/scranton-branch/releases/latest/download/scranton-branch-server-1.1.3-linux-arm64.tar.gz) |

Server: unpack, then run `sudo ./install.sh`. Setup, Docker and secrets are in [SERVER.md](https://github.com/diegodiaz1256/scranton-branch/blob/main/SERVER.md).

Builds are not code-signed yet: macOS asks you to allow the app in System Settings → Privacy & Security, and Windows SmartScreen asks you to confirm ("More info" → "Run anyway").

Source: [`v1.1.3`](https://github.com/diegodiaz1256/scranton-branch/archive/refs/tags/v1.1.3.tar.gz)

## About Scranton Branch

Scranton Branch began as the branch office of [Munder Difflin](https://github.com/HarnessMD/munder-difflin) 0.4.6, and adds offices that work together (post-quantum sealed), a headless server edition, Factories, WSL offices and secrets agents use but never see. No product analytics. From 1.0.0 it has its own versions; the in-app updater follows this repository only.
