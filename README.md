# Personal Agents Bridge

A single-owner demonstration of **ChatGPT → MCP → Agents API → self-hosted Codex
→ sandboxed Git worktree → independent review → exact-tree draft PR publication**.

ChatGPT invokes six MCP tools through Secure MCP Tunnel. The bridge creates Agents
API sessions and connects a local Codex executor. For an allowlisted repository,
implementation happens in an isolated Git worktree backed by a task-private Git
store. Command networking is disabled; writes are confined to the task worktree
and task scratch. Implementation agents cannot push or merge.

A separate session independently reviews bounded controller evidence. Only after
a completed PASS can `publish_task` freeze the task and publish the exact reviewed
Git tree through the trusted controller. The human retains the merge decision.

This is a public source demonstration, **not a multi-user production service or
an official OpenAI project**. Repository sandboxes permit broad reads; use a
dedicated host/account without unrelated secrets. See [SECURITY.md](SECURITY.md)
and [architecture](docs/ARCHITECTURE.md) for the actual guarantees and limits.
Publishing this source does not make its private MCP deployment publicly accessible.

## Local Codex backend prototype

`local-codex-backend.mjs` is an **opt-in, disconnected prototype** for trusted
repositories on the owner's dedicated VM. Production still uses the Agents API.
It uses the installed `codex app-server` over stdio with no added dependencies.
Codex Runner's SDK pattern is simpler for batch execution, but its adapter uses
`never` approvals; app-server supplies the bidirectional native approvals needed here.
No containers, namespace launchers or managed-policy framework are involved.

`LocalCodexBackend({cwd, codexPath, codexHome, onApproval, onQuestion, onProgress})`
requires an absolute, caller-approved workspace. `connect()` checks the existing
ChatGPT login, subscription plan and effective OpenAI provider configuration without
logging in, copying credentials or setting `forced_login_method`. API-key/custom
provider routes and enabled configured MCP servers fail preflight. The child receives
an explicit environment allowlist, not API keys/tokens/proxy overrides. Apps, plugins,
hooks, web search and subagents are disabled. Existing authentication/config files
are not edited by this module; Codex itself manages its ordinary state/token refresh.

Before each execution, `model/list` must return exactly one visible default across
all pages. That model is recorded in `result.model` and explicitly sent to thread
creation/resume and turn execution; the configured model is not a fallback.
Resume first checks the stored thread model matches the selected default, and the
thread response must confirm the same model. Missing/ambiguous catalogs, model
mismatches and unavailable models fail without trying another model. This selects
the catalog default, not proof of account entitlement or successful inference.

`run({prompt, allowedFiles, threadId?, signal?})` starts a thread or resumes the
explicit ID, reapplies workspace-write/on-request/user-review policy, disables command
networking and returns `completed`, `failed`, `interrupted` or `uncertain`.
File scopes containing `TASK.md`, `.codex` or `.git` path components are rejected
before any task RPC, along with absolute paths and traversal. This validates the
requested scope; it does not add a model-process filesystem enforcement boundary. Persist
the returned thread ID in the caller; a new backend instance can resume it using
the same Codex home. One turn per instance is allowed. There is no automatic retry
of uncertain submissions. `cancel()` requests interruption; await the `run()` result
for terminal confirmation. `close()` terminates the owned server process group,
best-effort; escaped descendants and restart reconciliation are not independently
attested. Always close in `finally`.

`onApproval(request)` must obtain a human decision and return `accept`, `decline`
or `cancel`; absent handlers decline. Session-wide grants are not accepted.
`onQuestion(request)` returns `{questionId:{answers:["answer"]}}`. Unsupported
permission/clarification requests interrupt rather than silently grant access.
`onProgress(event)` is a synchronous observer of active-turn notifications.
Requests cleared by Codex or interrupted turns cannot receive late approvals.

**Accepted limitation:** native approvals do not intercept every in-sandbox action.
File scope, asking before dependency changes/destruction/secret reads/network or
LAN/Tailscale access, and prohibiting Git publication are explicit **behavioral
instructions**, not universal pre-execution enforcement. Workspace-write is not
PAB's existing per-path repository sandbox. Use only trusted repositories; do not
connect this prototype to publication or assert security equivalence.

Results retain command text, cwd, status, exit code, bounded output and native item
provenance. Missing start/output/exit/completion and local truncation remain explicit;
upstream evidence completeness is unverified. `completed` means the **turn** completed,
not that tests passed. Model messages are separately labeled, never trusted test
evidence. Keep results/events private: they can contain repository contents and paths.
Authentication checks and token usage do not independently establish billing attribution.

Offline validation (no model turns):

```bash
node --test test/local-codex-backend.test.mjs
npm test
git diff --check
```

Prototype closeout validation: **33/33 focused tests and 178/178 full offline tests passed**;
`git diff --check` passed. Offline tests do not establish live authentication or billing.

### Operator-only fixture acceptance

The operator reports successful live fixture acceptance after the model-selection fix:

- Model: `gpt-6-astra`.
- Turn completed and terminal observed.
- Fixture contents verified.
- One validation command with successful execution evidence.
- No reported failure codes.

These are operator-reported results, not a new live run by the coding agent.
**Subscription billing attribution remains independently unverified.** This single
fixture does not verify live resume, cancellation or security equivalence with PAB.
Earlier attempts encountered `CODEX_DISCONNECTED` in the coding-agent environment
and an operator-reported unavailable configured model (`gpt-6.1-sol`); the subsequent
operator acceptance above establishes success for the bounded fixture, not those
other environments or capabilities. No additional live turn is run for this closeout.

For future operator-authorized reproduction only, from this checkout in the owner's
ordinary shell, the following creates a fresh disposable workspace and may consume
Codex subscription allowance. It neither logs in nor runs PAB's paid live tests:

```bash
node --input-type=module <<'JS'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { LocalCodexBackend } from './local-codex-backend.mjs';
const cwd = await mkdtemp('/tmp/pab-local-acceptance-');
const backend = new LocalCodexBackend({ cwd, timeoutMs: 120000, onApproval: async () => 'decline' });
try {
  console.log({ workspace: cwd, route: await backend.connect() });
  const command = `/usr/bin/python3 -B -c "from pathlib import Path; assert Path('answer.txt').read_text() == '42\\n'; print('PAB_LOCAL_OK')"`;
  const result = await backend.run({ allowedFiles: ['answer.txt'], prompt:
    `Use apply_patch to create answer.txt containing exactly 42 and a newline. Run exactly one command: ${command}. No other commands, unrelated reads, network, dependencies or Git. Report the actual result.` });
  await writeFile(`${cwd}/result.private.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  const fixtureMatches = await readFile(`${cwd}/answer.txt`, 'utf8').then(value => value === '42\n', () => false);
  const evidence = result.commands;
  const passed = result.status === 'completed' && result.terminalObserved && fixtureMatches && evidence.length === 1 &&
    evidence[0].exitCode === 0 && evidence[0].status === 'completed' && !evidence[0].missing.length &&
    !evidence[0].locallyTruncated && evidence[0].output?.includes('PAB_LOCAL_OK');
  console.log({ status: result.status, passed, fixtureMatches, commandCount: evidence.length });
  if (!passed) process.exitCode = 1;
} finally { await backend.close(); }
JS
```

Inspect the private command evidence as well as the fixture; do not publish raw logs
or rerun an uncertain turn automatically. The reported live success is limited to
the bounded fixture acceptance above.
The next small step is independent review, then a separate opt-in controller adapter
that persists thread/turn IDs, bridges human approvals and maps native evidence
without changing existing review/publication gates. No production switch is included.

## Setup

Requires Linux, Node.js 24+, npm, Python 3, Git, `flock`, and standalone Codex with
`sandbox -P`, `exec-server`, `exec-server forward`, and its sandbox runtime. The
host must permit the required Linux namespaces and Landlock operations. Publication
also requires `/usr/bin/gh` and controller-accessible GitHub authentication.
Dependency versions are pinned in `package-lock.json`; Codex and the tunnel binary
are external prerequisites. Protocol/kernel compatibility must be tested on your host.

```bash
npm ci --ignore-scripts
npm test
```

Tests use fake Agents API sessions, real local kernel sandboxes and local Git
remotes. They need namespace creation and local listeners; missing enforcement
fails tests rather than silently skipping them. They do not publish to GitHub.
If Node reports a missing `libatomic.so.1`, install your OS compatibility package.
`run.sh` also supports an operator-provided library under the private state directory.

Review [.env.example](.env.example) for variable names; the application does not
load dotenv files automatically. Supply secrets via the process environment or a
private secret manager. Never put credentials in MCP arguments or committed files.
Follow [TUNNEL.md](TUNNEL.md) for the private tunnel, owner confirmation and
self-hosted execution setup. Start the production bridge with `./run.sh` only under
the configured tunnel; its singleton lock prevents two controllers using one store.

Register a separate, explicitly approved repository locally:

```bash
node register-repository.mjs example /absolute/path/to/approved-repository
```

The command pins canonical path and filesystem/Git identity in an owner-only local
registry. It rejects this bridge's source repository. Never register the bridge as
its own implementation target. MCP callers use only `repository_id: "example"`.
No repository registrations or account configuration are shipped with this source.

## Workflow

| Tool | Purpose |
| --- | --- |
| `start_task` | Start a contract in a disposable workspace or allowlisted repository worktree. |
| `get_task` | Inspect bounded progress, clarification, review and publication state. |
| `continue_task` | Answer clarification or explicitly request further implementation. |
| `review_task` | Freeze evidence and request independent review in a separate session. |
| `publish_task` | Freeze a completed PASS-reviewed repository task and create a draft PR. |
| `cleanup_task` | Stop execution/delete remote sessions; optionally remove the worktree. |

[Tool schemas and contracts](docs/TOOLS.md) describe scope, costs, retries, review
and publication. Execution/review uses paid API sessions. Publication accepts only
`task_id`, `title`, optional `body`, and `draft:true` (the default), never arbitrary
paths, commands or branches. It verifies unchanged state and commit-tree equality,
then pushes only its task branch without force. Deletes, renames, modes, symlinks
and binary files retain their Git semantics. Submodules are unsupported. PRs target
the registered GitHub repository's default branch; the bridge never merges them.

Commands use `codex sandbox -P bridge_task -C <worktree> -- <command>` with a trusted
pinned profile. File-write RPCs have equivalent sandbox enforcement. The outer
exec-server transport retains the network access required by the Agents API.
Startup probes and controller attestation must succeed before implementation.
Tasks without `repository_id` retain the legacy disposable-workspace isolation;
they do not have the repository command-network guarantee and cannot use publication.

## Private runtime data

Default state is under `~/.local/state/personal-agents-bridge/`; disposable task
workspaces and evidence are under `/var/tmp/personal-agents-bridge/`. These are
portable defaults, not paths to a registered repository. `/var/tmp` may be cleared
by the OS. Preserve required artifacts before cleanup or host replacement.

Task expiry cleans remote resources after 15 minutes while retaining files.
Explicit workspace deletion verifies absence; bounded audit/task records survive
in controller state. Logs, evidence, databases, registry, tunnel configuration and
credentials are private operational data and excluded by `.gitignore` if copied
into this checkout. Ignore rules do not sanitize already-tracked files or history.

`npm run test:live` is a separate, paid manual integration check. It creates real
sessions and must not run alongside the production controller. It is not part of
`npm test` and was not used for public-source preparation.

## Status and license

The [local Codex feasibility assessment](docs/LOCAL_CODEX_FEASIBILITY.md) records
isolated offline experiments, migration blockers, and operator validation steps.
It does not change the production execution backend or authorize migration.

See [VERIFICATION.md](VERIFICATION.md) for local coverage and limitations. Live
GitHub publication requires a separate, explicitly authorized acceptance test.
Licensed under the [Apache License 2.0](LICENSE). Third-party dependencies retain
their own licenses.
