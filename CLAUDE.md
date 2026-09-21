# Long-term: project instructions

Single-user, self-hosted Node.js app: browser terminals on tmux, a sandboxed file editor (Monaco), and an AI browser-test runner. ESM, Node >= 20.6, no build step, no database. User docs are in `README.md`; keep them in sync with behaviour.

## Commands

```bash
npm test                 # node:test, needs tmux; ~10 s
npm run dev              # server with --watch
npm run testkit          # installs Playwright + Chromium into the test lab
node --test test/workspace.test.js   # one suite
```

Run a dev server without touching the real data dir:

```bash
LONG_TERM_DATA_DIR=$(mktemp -d) LONG_TERM_PORT=8799 LONG_TERM_TMUX_SOCKET=lt-dev LONG_TERM_TOKEN=dev-token-123456 node server.js
```

## Layout

- `server.js`: app wiring, WebSocket upgrade. `createApp(cfg)` does not listen, so tests can use it.
- `src/`: `config` (env to settings), `auth`, `tmux` (every tmux call), `terminals` (WebSocket to pty bridge), `workspace` (editor sandbox), `testlab` (targets, scenarios, runs, driver), `verdict` (report parsing), `routes` (JSON API).
- `public/`: plain ES modules served as-is; `views/` has one file per tab. Libraries come from `node_modules` via `/vendor/*`.
- `lab-template/`: copied into the test lab on first use; existing files are never overwritten (except `CLAUDE.md` while it still has its marker line).
- `test/`: `helpers.js#startServer` boots a real server on an ephemeral port with its own tmux socket. `fixtures/fake-engineer.sh` stands in for `claude`, so no tokens are spent.

## Rules that must not regress

- **Everything except the sign-in page needs a session.** Sessions are HMAC-signed cookies (no server state), so they survive restarts. Inside `app.use('/api', ...)`, `req.path` has the prefix stripped: never gate on `req.path.startsWith('/api')`. `test/server.test.js` asserts every route returns 401 without a session; add new routes there.
- **Editor paths go through `Workspace.resolve()`** (realpath check, so symlinks cannot escape). Remove and rename use `resolveEntry()` so they act on a link itself. Never build a path from user input any other way.
- **No shell strings from user input.** tmux and pty calls use argument arrays. The only shell use is the terminal command the user types and `LONG_TERM_TEST_COMMAND`, on purpose.
- **Credentials reach test runs only through environment variables**, written to a 0600 file that the session sources and deletes, never in argv, prompts, logs, API responses or reports. Targets never return passwords.
- **Client:** CSP is `script-src 'self'`, so no inline scripts. Build DOM with `h()` from `common.js`; the only `innerHTML` is `renderMarkdown()`, which sanitises with DOMPurify. Do not call native `el.append(x)` with values that can be `null` (it renders the text "null"); pass them through `h()`.
- **WebSocket close codes:** 4404 means the tmux session is gone (final); anything else the client retries. 4429/4400 are refusals.
- Monaco is pinned to 0.52.2 because the client uses its AMD `min/vs` loader. Do not bump it without testing the editor in a browser.
- Env vars use the `LONG_TERM_` prefix; the tmux socket defaults to `long-term`.

## Verifying changes

Type checks and unit tests do not prove UI changes. For client changes, run the app and exercise the feature in a real browser (Playwright is available via the test lab; on a machine without Chromium's system libraries, unpack the `.deb`s into a scratch dir and set `LD_LIBRARY_PATH`). When testing, check the console for CSP violations.

Do not claim the Tests feature works against real Claude until a run with a real `claude` has been done; it has only been exercised with the fake engineer.

## Git

- Commit as the GitHub noreply address, without editing git config: `git -c user.email=smmortazavi@users.noreply.github.com commit ...`. The global identity is a work email that must stay out of this repo.
- Repo is private at github.com/smmortazavi/long-term. Ask before making it public, force-pushing, or rewriting history.
- End commits with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Origin: a from-scratch rewrite of ideas from a different project (aliemam/loom, no licence granted). Do not copy code from it.
