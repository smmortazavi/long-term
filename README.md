# Long-term

A small, self-hosted workspace in one browser tab, written in Node.js. Three things, done simply:

- **Terminals**: real shells (or any command) in tmux, up to four side by side. They survive closing the tab, a laptop sleep and a server restart, and `tmux attach` from a shell reaches the same session.
- **Editor**: a file tree and a Monaco editor over a sandboxed workspace folder, with tabs, Ctrl/Cmd+S, conflict detection and a live markdown preview.
- **Tests**: an AI browser-test engineer. You write scenarios like a QA sheet, describe the app under test and its sign-in accounts, and press Run. A [Claude Code](https://claude.com/claude-code) session drives a real Chromium through Playwright and ends with a report whose first line is the verdict, plus a numbered screenshot per step.

It is a single small server with no database and no build step. State is a few JSON files and a folder.

> **Read this first.** A terminal is a shell. Anyone who can sign in can run any command as the user who started the server. Long-term listens on `127.0.0.1` by default and needs an access token; if you expose it, put TLS and a firewall in front (see [Security](#security)).

## Requirements

- Node.js 20.6 or newer
- `tmux` on the `PATH`
- For **Tests** only: the `claude` CLI, signed in, and the browser toolkit (`npm run testkit`)

Linux and macOS. On Windows use WSL.

## Quick start

```bash
git clone <this repository> long-term
cd long-term
npm install
npm start
```

The server prints the address and an access token:

```
long-term listening on http://127.0.0.1:8787
  workspace: /home/you/.long-term/workspace
  token:     Xb3...  (saved in /home/you/.long-term/token)
```

Open the address, paste the token, and you are in. To work on your own projects, point the workspace at them:

```bash
LONG_TERM_WORKSPACE=~/projects npm start
```

Settings can also live in a file: copy `.env.example` to `.env` and run `node --env-file=.env server.js`.

## Configuration

Everything comes from the environment. All settings are optional.

| Variable | Default | What it does |
|---|---|---|
| `LONG_TERM_HOST`, `LONG_TERM_PORT` | `127.0.0.1`, `8787` | Where to listen. |
| `LONG_TERM_WORKSPACE` | `~/.long-term/workspace` | The folder the Editor shows and new terminals start in. |
| `LONG_TERM_DATA_DIR` | `~/.long-term` | Token, test targets and runs, and the test lab. |
| `LONG_TERM_TOKEN` | generated | Access token (12 characters or more). If unset, one is generated on first start and kept in `$LONG_TERM_DATA_DIR/token`. |
| `LONG_TERM_ALLOWED_HOSTS` | loopback names | Comma-separated `Host` names accepted. Set this when serving under a real domain. |
| `LONG_TERM_TRUST_PROXY` | off | `1` to honour `X-Forwarded-Proto` behind a proxy, so the cookie is marked `Secure`. |
| `LONG_TERM_MAX_TERMINALS` | `12` | Concurrent browser terminals. |
| `LONG_TERM_TMUX_SOCKET` | `long-term` | The `tmux -L` socket, keeping these sessions apart from your own tmux. |
| `LONG_TERM_TEST_COMMAND` | `claude` | Command that starts the test engineer. |
| `LONG_TERM_TEST_TIMEOUT_MIN` | `30` | A run with no report after this long is failed. |
| `LONG_TERM_TEST_BOOT_MS` | `4000` | Time the engineer gets to start before its prompt is pasted in. |

## Terminals

**New** creates a tmux session with an optional name, a working directory (relative to the workspace) and an optional command; with no command you get your shell. Click a session to open or close its pane, **Detach** closes the pane but leaves the session running, and the **✕** kills the session.

Every pane is `tmux attach` in a pty, bridged byte for byte over a WebSocket. Nothing in between interprets keystrokes, so `Ctrl+C`, `Shift+Tab` and full-screen programs behave as they do over SSH. Panes reconnect on their own after a network drop or a server restart. The mouse wheel scrolls tmux's own history.

From a shell on the same machine, the sessions live on a private tmux socket:

```bash
tmux -L long-term ls
tmux -L long-term attach -t term-1
```

## Editor

A tree of the workspace on the left, tabs on the right. `Ctrl/Cmd+S` saves.

- Saves are atomic. If the file changed on disk since you opened it, you are asked whether to overwrite it or reload the disk version, so an external edit is never silently lost.
- Paths are confined to the workspace, including through symlinks: a link that points outside cannot be read, written or listed, though the link itself can be renamed or deleted. A symlink that stays inside is written through, not replaced.
- Files over 2 MB and binary files are refused rather than mangled.
- Markdown files get a **Preview** toggle. The preview is sanitised with DOMPurify, so a hostile `.md` in a repository cannot run script in the app.

## Tests

The Tests view has three tabs: **Targets**, **Scenarios** and **Runs**.

1. **Target**: the app under test. A name, a base URL, one or more **roles** (a name, username and password each), and optionally CSS selectors for its sign-in page.
2. **Scenario**: a markdown QA sheet: preconditions, a role, and a table of steps with expected results. Scenarios are files, `<lab>/scenarios/<name>/scenario.md`.
3. **Run**: pick a scenario, a target and a role. Runs are queued and executed one at a time, since each is a browser plus a model.

A run starts a tmux session `test-<id>` in the **lab** folder (`$LONG_TERM_DATA_DIR/testlab`), runs `LONG_TERM_TEST_COMMAND` there and pastes in a prompt. The lab is a Claude Code project: `CLAUDE.md` is the engineer's instructions, `LEARNINGS.md` is what it has learned about your product, and `lib/` has small Playwright helpers for signing in and taking screenshots. The engineer writes:

```
runs/<scenario>__<role>__<id>/
  report.md               first line: "# <title> — <ROLE> — <VERDICT>"
  screenshots/01-login.png, 02-…
```

The verdict is one of `PASS`, `FAIL`, `UNCERTAIN` (couldn't tell) or `NEEDS-HUMAN` (blocked, for example by a CAPTCHA or a second factor). The parser is tolerant of the way a model formats a title (a hyphen for the dash, bold, lower case) and reads only the last segment, so a scenario called "Payment fails gracefully" is never mistaken for a failure.

While a run is active, **Open terminal** on the run takes you to its live session, which is also where you answer a permission prompt if the engineer asks for something the lab does not pre-approve. A restart of Long-term loses nothing: runs are files and tmux sessions, and the next poll picks up whatever finished.

### Setting up the browser toolkit

```bash
npm run testkit
```

This scaffolds the lab and runs `npm install` and `npx playwright install chromium` inside it. On a bare Linux server you may also need Chromium's system libraries (`npx playwright install-deps chromium`, which needs root). The Tests view shows what is still missing.

### How credentials are handled

- Passwords are stored in `$LONG_TERM_DATA_DIR/testlab.json`, which is mode `0600`, and are never returned by the API. Editing a target and leaving a password blank keeps the stored one.
- They reach the engineer **only through environment variables**: `TARGET_BASE_URL`, `TARGET_<ROLE>_USERNAME` and `TARGET_<ROLE>_PASSWORD` (`shop manager` becomes `SHOP_MANAGER`). The prompt names the variables and never their values.
- To keep them out of process arguments, they are written to a private file that the session sources and deletes before the engineer starts.
- The engineer's instructions forbid printing a credential or writing one to a report. That is an instruction to a model, not a guarantee. Use test accounts, not real ones.

### What the engineer is allowed to do

The lab ships `.claude/settings.json` that pre-approves reading and editing files and running `node`, `ls`, `mkdir` and `cat`. Everything else prompts, and the prompt is waiting in the run's terminal. If you want fully unattended runs, set `LONG_TERM_TEST_COMMAND="claude --permission-mode bypassPermissions"`, understanding that it then runs any command it likes as you.

## Security

What Long-term enforces:

- **An access token** (constant-time comparison, rate-limited after 10 failures per 5 minutes) exchanged for an `HttpOnly`, `SameSite=Strict` session cookie that expires on the server. Everything except the sign-in page itself needs it: every API route, script, vendored library and WebSocket.
- **Loopback by default.** Binding elsewhere prints a warning.
- **DNS-rebinding guard**: the `Host` header must be an allowed name, and by default only loopback names are.
- **Same-origin checks** on every write and on every WebSocket upgrade, as well as `SameSite=Strict`.
- A strict **Content-Security-Policy** (`script-src 'self'`, no inline script), `nosniff`, `no-referrer`, and `X-Frame-Options: DENY`.
- Session names, paths and file operations are handled as arguments, never spliced into a shell string, so they cannot become commands. (The command you type into **New terminal**, and `LONG_TERM_TEST_COMMAND`, are run by a shell on purpose.) The server's own token is removed from the environment handed to sessions.

What it does not do: separate you from the shell you are handing out. There is one token and one user, no roles, and terminals run as whoever started the server. The workspace sandbox limits the *editor*, not the terminal.

### Serving it beyond localhost

Put a TLS-terminating reverse proxy in front, keep `LONG_TERM_HOST=127.0.0.1`, and set `LONG_TERM_ALLOWED_HOSTS` and `LONG_TERM_TRUST_PROXY=1`. The proxy must pass WebSocket upgrades and the `Host` and `Origin` headers unchanged. For nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 1d;
}
```

Known limits: paths are checked and then used, so a process that swaps a directory for a symlink in the instant between the two could slip past the editor's sandbox. That requires code already running as you, which is the shell you have already granted. State is not encrypted at rest.

## Development

```bash
npm test          # unit and integration tests
npm run dev       # restart on change
```

The tests start a real server on an ephemeral port with a private tmux socket. They cover authentication, the file sandbox (traversal and symlink escapes), the terminal WebSocket, and a full test run driven by a stand-in for `claude`, so no tokens are spent. tmux is required; tests that need it are skipped if it is missing.

```
server.js              wiring: app, WebSocket upgrade, startup
src/
  config.js            environment → settings
  auth.js              token, sessions, Host/Origin checks, rate limit
  tmux.js              every tmux call, as argument arrays
  terminals.js         WebSocket ↔ pty bridge
  workspace.js         the editor's filesystem sandbox
  testlab.js           targets, scenarios, runs and the driver
  verdict.js           report parsing and naming helpers
  routes.js            the JSON API
public/                the client: plain ES modules, no bundler
  views/               terminals.js, editor.js, tests.js
lab-template/          files copied into the test lab on first use
scripts/               npm run testkit
test/                  node:test suites and a fake engineer
```

xterm.js, Monaco, marked and DOMPurify are served straight from `node_modules` after sign-in, so there is nothing to build.

## Background

Long-term is a from-scratch rewrite of three ideas from [Loom](https://github.com/aliemam/loom), a larger Rust workspace by Ali Emamhadi that also covers pull-request review, plans, Jira and multi-user accounts. No code is shared. This project keeps only the tmux-backed terminals, the workspace editor and the report-driven test runner, as a single-user Node.js tool.

## Licence

MIT. See [LICENSE](LICENSE).
