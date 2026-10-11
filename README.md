# Personal Agents Bridge

A single-owner demonstration of **ChatGPT → MCP → Agents API → self-hosted Codex
→ sandboxed Git worktree → independent review → exact-tree draft PR publication**.

ChatGPT invokes six MCP tools through Secure MCP Tunnel. By default the bridge creates Agents
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

## Opt-in Local Codex controller slice

`start_task` accepts optional `execution_backend`: omitted or `agents_api` retains
the existing default; `local_codex` explicitly opts into subscription-authenticated
execution for an allowlisted `repository_id` only. Selection is immutable and part
of request deduplication. Omitted/explicit default selections keep the legacy
fingerprint representation, including retries of pre-integration tasks.

The Controller remains the sole authority. Both paths share registration checks,
pinned base commits, task-private Git stores/worktrees, contracts, baseline capture,
SQLite task records, request IDs, ownership, audit and expiration. Local tasks receive
a local-policy `TASK.md` and the same contract inline, not an assertion of the
Agents API repository sandbox. They never create Agents API sessions. The API client
is constructed lazily; local-only controller operation does not require an inference
`OPENAI_API_KEY`. Existing tunnel authorization credentials are still independently
required and unchanged.

This slice supports **start → get → native human response → same turn → cleanup**.
`get_task` reports persisted
`execution_backend` and `implementer.local` observations: phase/execution state,
thread/turn IDs, model, submission-attempt/acknowledgement flags, terminal observation,
bounded diagnostics and human-attention requirements. Codex IDs are not Agents API
session IDs. Latest bounded output is labeled `model`; command counts are not
certified command/test evidence. A completed turn is not a test PASS.

Synchronous lifecycle callbacks save identity before the next inference step.
Submission intent is recorded before dispatch; absence of an acknowledgement is
not proof of delivery or non-delivery. After restart unfinished local records require
attention, with known IDs retained and **no automatic replay**. Completed records
are retained. A process surviving a controller crash is not automatically reattached
or killed: unknown ownership/termination remains a cleanup blocker.

### Durable native human requests

Command/file approvals and `item/tool/requestUserInput` requests remain pending in
the original live turn. The synchronous lifecycle callback saves each request in
the existing SQLite task record before exposing it. Raw JSON-RPC request IDs and
accepted response contents remain private. MCP exposes an opaque `request_ref`,
task/thread/turn IDs, request method, bounded description, expected response type,
available decisions or exact question IDs/options, status and delivery diagnostics.
Model prose never creates an authoritative pending request.

`get_task` returns `waiting_for_approval` or `waiting_for_clarification`, with
`human_attention_required: true` and `implementer.pending_human_requests`.
Obtain the human's explicit response, then call the existing `continue_task`:

```json
{
  "task_id": "task_<returned UUID>",
  "request_id": "unique_human_response_operation",
  "human_response": {
    "request_ref": "<returned request UUID>",
    "thread_id": "<returned thread ID>",
    "turn_id": "<returned turn ID>",
    "decision": "accept"
  }
}
```

Approvals require `accept`, `decline` or `cancel` (also constrained by native
available decisions); prose such as "yes" is not a decision. For clarification,
replace `decision` with `"answers":{"<exact question ID>":{"answers":["human answer"]}}`.
Every question must be answered, with no extra IDs. Advertised options are required
unless the question allows free text. Do not send `instruction` for local replies;
Agents API continuation still uses its existing `instruction` input unchanged.

The Controller records the response, original native identity and operation
fingerprint atomically before releasing the callback. The adapter sends exactly
one JSON-RPC response to that request, not another `turn/start` or thread. Identical
operation retries return current state without redelivery; conflicting input or a
new operation answering an already handled request fails. Responses cannot change
task ownership or thread/turn binding. Waiting never extends the task deadline.

Delivery states distinguish durable preparation, attempted write, unconfirmed
write, and server clearing. **SQLite commit and pipe delivery are not atomic.** A
crash or transport/storage failure between them leaves uncertain delivery, never
an automatic resend. Pipe writes are not remote acknowledgements. As documented
by [Codex app-server](https://developers.openai.com/codex/app-server),
`serverRequest/resolved` can mean answered **or cleared**; a clear before a human
response invalidates the request, not an implicit approval. A server-side clear
can also race a response already being written; no exactly-once remote-consumption
guarantee is claimed. Only a real terminal observation completes execution.

Restart retains request identity and marks pending/intermediate delivery for
attention; persisted JSON cannot recreate a native callback. Cleanup, expiration
and shutdown invalidate requests and stop execution without waiting for human
answers. Unsupported request types, secret-input questions, unrepresentable
questions/options and overflow fail closed. Approvals with incomplete/redacted
descriptions cannot be accepted (decline/cancel remain available). There are at
most 32 requests per turn, eight questions per request and 20 options per question.

Post-completion/new-turn continuation and restart reattachment remain unsupported.
Local `review_task` and `publish_task` still reject with `LOCAL_REVIEW_UNSUPPORTED`
and `LOCAL_PUBLISH_UNSUPPORTED`; separate evidence integration is required.

Cleanup initiates cancellation before waiting on a local job, closes the owned
app-server, and bounds each wait. Shutdown does the same. Files remain unless
`delete_workspace=true`; deletion reuses the task worktree removal mechanism and
is blocked when execution/closure is unresolved. Task/audit records survive.
`server_closed` reports the owned server only; escaped-descendant termination is
not attested. No app-server event is promoted to Agents API command/file-RPC evidence.

### Local execution adapter

`local-codex-backend.mjs` remains a reusable adapter for trusted repositories on the
owner's dedicated VM. Agents API remains the default backend; no deployment is included.
It uses the installed `codex app-server` over stdio with no added dependencies.
Codex Runner's SDK pattern is simpler for batch execution, but its adapter uses
`never` approvals; app-server supplies the bidirectional native approvals needed here.
No containers, namespace launchers or managed-policy framework are involved.

`LocalCodexBackend({cwd, codexPath, codexHome, onApproval, onQuestion, onProgress, onLifecycle})`
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
`close()` returns whether the owned server's exit was observed (or no server was
started), not a guarantee about escaped descendants.

`onApproval(request)` must obtain a human decision and return `accept`, `decline`
or `cancel`; absent handlers decline. Session-wide grants are not accepted.
`onQuestion(request)` returns `{questionId:{answers:["answer"]}}`. Unsupported
permission/clarification requests interrupt rather than silently grant access.
`onProgress(event)` is a synchronous observer of active-turn notifications.
Requests cleared by Codex or interrupted turns cannot receive late approvals.
`onLifecycle(event)` is synchronous: model selection, thread acknowledgement,
pre-dispatch submission intent, turn acknowledgement, terminal observation and
human requests. It exposes no account credentials; human request payloads remain
private and must be bounded/redacted by the receiver. Throwing or returning a
promise fails closed rather than allowing unsaved identity to advance.
The Controller sets `deferHumanRequests: true`: supported callbacks remain in the
adapter until `respondToRequest({requestId, threadId, turnId, response})`, cancellation
or terminal completion. This synchronous method accepts only the original active
native callback identity. Lifecycle events include the native ID, response dispatch
and server clearing. Standalone `onApproval`/`onQuestion` behavior remains available
when deferral is disabled; no pending controller callback promises are introduced.

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
node --test test/local-codex-backend.test.mjs test/local-controller-integration.test.mjs
node --test test/controller.test.mjs
npm test
git diff --check
```

This controller slice passes **61 focused, 17 controller, and 207 full offline tests**,
with **0 failures and 0 skipped tests** in each run; `git diff --check` also passes.
Validation uses injected adapters, never real model turns. Offline tests do not
establish live authentication, billing attribution or controller live acceptance.

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
This acceptance was for the standalone adapter, not this controller integration.
PR #6 must establish durable human-response routing and safe same-thread continuation,
including uncertain-submission reconciliation, before enabling local `continue_task`.
Local independent review and publication remain separately blocked; this PR does not
change their existing Agents API gates or authorize deployment.

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
and publication for the default Agents API path. Local execution is the limited
opt-in slice described above; local review/publication are unsupported. Agents API
execution/review uses paid API sessions. Publication accepts only
`task_id`, `title`, optional `body`, and `draft:true` (the default), never arbitrary
paths, commands or branches. It verifies unchanged state and commit-tree equality,
then pushes only its task branch without force. Deletes, renames, modes, symlinks
and binary files retain their Git semantics. Submodules are unsupported. PRs target
the registered GitHub repository's default branch; the bridge never merges them.

Agents API tasks' commands use `codex sandbox -P bridge_task -C <worktree> -- <command>` with a trusted
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
