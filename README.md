# Personal Agents Bridge

A single-owner demonstration of **ChatGPT → MCP → Agents API → self-hosted Codex
→ sandboxed Git worktree → independent review → exact-tree draft PR publication**.

ChatGPT invokes eight MCP tools through Secure MCP Tunnel. By default the bridge creates Agents
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

This slice supports **start → get → native human response → same turn → independent
validation/review → qualified exact-tree draft publication → cleanup**.
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
Local `review_task` supports the bounded independent analysis described below.
Local `publish_task` now requires the qualified independent PASS and exact-tree
gates below. Human routing alone cannot authorize publication.

Pinned Codex **0.157.1** supports the `item/tool/requestUserInput` protocol request,
but its blocking `request_user_input` tool is available in Plan mode, not Default
mode unless `default_mode_request_user_input` is enabled. That feature is
under development and disabled by default. PAB does not select Plan mode or enable
that feature; its pinned feature subset does not attest every other effective
feature. Therefore the protocol's existence is not proof that the default PAB
turn can generate a live callback. See the pinned [mode gate](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/tools/src/tool_config.rs#L17)
and [feature default](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/features/src/lib.rs#L1605).
The separate [async-question tool](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/core/src/tools/handlers/request_user_input_async.rs)
emits agent-message items, not this JSON-RPC callback. PAB does not substitute
those messages for native authorization. The retained acceptance had no native
pending request; it cannot establish whether the model attempted an unavailable
tool or used async messaging. Qualifying real human routing requires separately
authorized mode/capability work and live exact-callback/turn continuity evidence.
Native command/file approvals remain supported when actually requested; the
harmless acceptance command did not trigger one. No capabilities are enabled by
this correction.

### Local evidence and independent analysis

The Controller synchronously retains bounded `item/started` and `item/completed`
command/file-change notifications in `task.local_execution_evidence` in its existing
SQLite store. Source task/thread/turn/item identity, command, cwd, status, exit code,
output, missing fields, redaction/truncation and rejected/omitted event counts remain
explicit. File-change claims are separate from controller-observed file bytes.
Model prose, reasoning, human answers and raw notification logs are excluded.
Final adapter summaries cannot reconstruct missing notification history.

Native aggregate output now retains distinct `absent`, `null`, `empty`, `present`
and `malformed` availability. The [pinned output projection](https://github.com/openai/codex/blob/36650394c5b38c2990ccf2a3457165ca3e9d9726/codex-rs/app-server-protocol/src/protocol/item_builders.rs#L116)
can encode an empty aggregate as null. This explains why missing output need not
mean failed execution, but PAB never converts absent/null into verified empty
stdout or stderr. Optional output gaps stay in the notification ledger and the
review result's `scope_qualification.command_output_limitations`, not fatal
adapter diagnostics. Start/completion, identity, command/cwd, status and exit
evidence remain mandatory; malformed/conflicting records and unrelated runtime
uncertainty still block qualification. Truncation/redaction remains explicit.
The reviewer must FAIL an output-dependent obligation without sufficient evidence;
controller-owned independent execution remains mandatory for required tests.
This neither generates PASS findings nor weakens exact-tree publication gates.
Old acceptance records and FAIL reviews are not rewritten or automatically
requalified; missing availability provenance in old command records fails closed.

The internal `Controller.buildPacket(task)` path can prepare a
`pab.local-codex-review.v1` packet after the local job is finished and the owned
app-server is confirmed closed. The existing `review_task` uses this internal path;
no new MCP operation is added. It reuses pinned-baseline/worktree validation, contract checks,
controller before/after repository snapshots, current file hashes, unauthorized
file detection and Git state checks. Agents API packet behavior is unchanged;
native notifications never populate Agents API or file-RPC evidence structures.

Limits: at most 64 command/file records together and 24 KiB of record JSON;
commands/output are each bounded to 2048 characters, cwd to 1024, and file-change
records to 16 entries with 1024-character paths/diffs. Overflow is counted, not
silently treated as complete history. Packets share the existing 128 KiB UTF-8
limit and reject overflow without dropping required sections. Sensitive text uses
existing controller redaction; evidence remains private operational data.

Required tests correlate only exact command strings at the approved cwd, not
substrings or inferred shell wrappers. References to native records are **not
independently verified validation**, even with exit code zero. Unmatched tests,
incomplete starts/completions, missing output/exit codes, truncation and uncertain
or interrupted turns remain visible. Old tasks without a ledger report unavailable
history. Upstream output completeness and exhaustive command/file coverage remain
unverified. Notifications cannot prove absence of prohibited operations.

Snapshots are sampled state, not a syscall/network audit or immutable freeze.
Existing Git diff enumeration can omit ignored writes; the normal-checkout snapshot
includes ignored files. App-server closure does not attest descendant termination,
and concurrent external changes remain a possible capture race despite before/after
Git checks. Evidence capture alone produces no independent PASS or publication
authorization; validation, independent review and controller publication gates follow.

Bounded A/B acceptance at `c11a3caa2abbb94380eb71579f07a5e4056bba97` observed four
ChatGPT-authenticated turns, correct fixture bytes, independently passing validation
and a separate terminal reviewer. The Controller overrode model PASS with
`SCOPE_EXECUTION_UNCERTAIN` because a completed zero-exit write had unavailable
output. That actual FAIL remains unchanged. Native test-command correlation was
unmatched (shell wrapper); no native file-change event was retained. Human routing
remains **UNVERIFIED**. This correction is offline-tested only: fresh qualified
SCOPE acceptance and separately authorized exact-tree publication remain outstanding.
No billing attribution guarantee or deployment authorization follows. No live
turns are needed for tests:

```bash
node --test test/publication.test.mjs test/local-validation.test.mjs test/local-reviewer.test.mjs test/local-evidence.test.mjs test/local-codex-backend.test.mjs test/local-controller-integration.test.mjs
npm test
git diff --check
```

### Independent local reviewer

After a confirmed completed implementation, `review_task` independently executes
the persisted contract's required tests as described below, then freezes a bounded packet
into a separate reviewer directory and starts a fresh `LocalCodexBackend` instance
and thread. No implementer thread is resumed, no conversation history is supplied,
and the implementer must already be closed. Reviewer mode requests native
`read-only` sandboxing and command networking disabled at thread/turn creation,
retains subscription authentication and unique-default model checks, and rejects
writable scopes, existing thread history and resumption. Native reviewer human
requests are not approved or routed in this slice; they interrupt analysis.
These use the existing [app-server protocol](https://developers.openai.com/codex/app-server),
not another isolation framework. Tests verify requested/returned policies using
mocks, not independent live kernel enforcement.

The reviewer is instructed to read only `evidence.json`, not execute implementation
tests, install dependencies, access unrelated contexts or use network services.
Native read-only mode is not a narrow filesystem **read** boundary. Evidence-only
read scope is behavioral; no OS-enforced read isolation from other host files or
Codex history is claimed. Read-only instructions are not themselves enforcement.

The Controller owns the packet hash, reviewed Git tree/state, separate reviewer
model/thread/turn identity, submission/acknowledgement and terminal observations.
It verifies packet file type/mode/hash, task identity/contract, implementation tree
and normal-checkout state before and after review. `get_task` rechecks integrity
before exposing a retained result while the workspace exists. Mutations invalidate
the result. Closing the owned server and checking sampled state is not proof of
escaped-descendant termination or an immutable freeze against external writers.

The distinct local instruction contract requires all requirement/invariant IDs plus
SCOPE and TEST_EVIDENCE. Strict JSON, exact IDs, nonempty bounded evidence, consistent
overall verdict, 16 KiB output and 2000-character per-finding limits are validated;
malformed/incomplete output yields `needs_attention`, not PASS. Findings remain
model analysis, not independently certified truth. Controller overrides are explicit:

- Required test commands cannot obtain TEST_EVIDENCE PASS from native matches,
  completion/exit zero or reviewer assertions. Only complete controller-owned
  validation, bound to the exact reviewed tree/state, can remove that failure floor.
- SCOPE uses `pab.local-scope.bounded.v1`: validated registration/task identity and
  pinned baseline, unchanged normal checkout and protected `TASK.md`/`.codex`,
  unchanged Git index/refs/config/operation state, approved final file scope, and
  authenticated, acknowledged, terminal and closed local execution. Missing or
  contradictory provenance, unresolved safeguard uncertainty, rejected/omitted
  notifications and observed prohibited-operation indications fail qualification.
  Native command text is screened conservatively for Git mutation indications;
  this is not a universal shell parser or historical audit. The reviewer must
  assess every retained command/file record and each additional contract obligation.
- Missing optional diagnostics do not invent additional tests or violations.

SCOPE may PASS under the accepted single-owner, trusted-repository dedicated-VM
model, **not as proof of exhaustive historical compliance or Agents API sandbox
equivalence**. Minimum gates only downgrade findings, never generate PASS or override
the reviewer's FAIL on a requirement/invariant. Coverage limitations are retained
in every review result, including PASS. A legitimate FAIL remains useful. The persisted `review_result`
includes validated findings, controller overrides, model-proposed overall result,
packet hash, bounded qualification and reviewed-tree/thread/turn binding, using
`pab.local-review.v2`. Invalid, cancelled, incomplete,
unacknowledged or uncertain execution cannot produce a review result.

Request retries never submit twice. There is one local reviewer attempt per task
in this slice; a failed/uncertain attempt is not automatically replaced. Restart
preserves completed findings and marks unfinished execution/validation for attention,
without replay. There is no atomic transaction spanning app-server dispatch and
SQLite persistence; missing acknowledgements remain uncertain. Cleanup, expiration
and shutdown cancel/close both owned roles before any workspace deletion. Local
post-completion implementation continuation remains unsupported.

### Qualified local publication

`publish_task` uses the existing controller-owned `publication.mjs` path, not a
second publisher. Both local roles must be completed, terminal, acknowledged and
closed, with distinct implementer/reviewer threads and no active owned processes,
unresolved human requests or unknown execution diagnostics. The three adapter
coverage warnings (non-exhaustive upstream output, untrusted model prose, and no
independent escaped-descendant attestation) remain explicit accepted limitations,
not claims of exhaustive enforcement.

The Controller rechecks strict findings and their persisted digest, packet hash,
reviewed tree/state, task/registration/normal-checkout identity, protected paths,
and exact-tree independent validation including confirmed termination. Empty test
lists still require a completed validation lifecycle. Legacy tasks lacking the new
pre-execution protected snapshot or review binding cannot qualify retrospectively.

The shared publisher freezes implementation/review changes, uses only the fixed
task branch, builds a commit from the reviewed tree, verifies tree identity, refuses
default-branch or conflicting-ref updates, and creates only draft PRs. Retry input
fingerprints and uncertain push/PR reconciliation remain unchanged; missing remote
acknowledgements do not authorize duplicate PR creation. Local thread/turn identities
are recorded without fabricating Agents API session IDs. Required tests must pass
independently; a completed validation attempt or native exit zero is insufficient.

Snapshot checks cannot exclude external change-and-restore races, ignored artifacts,
broad host reads or escaped descendants. A persisted findings digest detects changed
records, not a compromised Controller/database owner. Existing immutable Git tree
publication preserves exact reviewed bytes; it is not universal execution confinement.
No live publication acceptance or deployment authorization is implied by these tests.

### Controller-owned local validation

`review_task` owns one durable validation attempt before reviewer execution. No new
MCP operation is added. The implementer must be terminal with its app-server closed.
The Controller checks the registered worktree, contract and `reviewedGitState()`;
it executes **only exact `test_commands` from persisted `contract.json`**, using
`/bin/sh -c`. Every command starts from a fresh disposable copy of that Git tree's
blob bytes and executable modes. No checkout filters, Git metadata, `TASK.md`,
ignored files, external dependencies or prior test artifacts are copied. Symlinks,
submodules, invalid paths, more than 2000 files or 16 MiB make capture unavailable.
Dependencies must already be usable without installation; unavailable tools fail.

`local-validation.mjs` uses the same supported native `codex sandbox` permission
table/profile mechanism as the repository sandbox, without its Agents API/RPC
workers. CLI-pinned permissions allow writes only to the disposable candidate and
scratch, protect `.git`/`.codex`, and disable command networking. HOME/CODEX_HOME
are disposable; the child environment is an explicit allowlist with system PATH,
no inherited API keys, tokens, credential helpers or agent sockets. There is no
model execution or authentication. **Host filesystem reads remain broad**, as in
the existing repository policy: this is not credential-read isolation. Use only
trusted repositories/contracts on the dedicated host without unrelated secrets.

The task's SQLite `local_validation` record is exposed under
`get_task.reviewer.independent_validation` and copied into the local packet's
`independent_validation` section with version `pab.controller-local-validation.v1`.
It retains the operation/task/attempt correlation, exact candidate tree and sampled
Git state, per-command attempt and cwd identity, start intent/observations, completion,
exit code/signal, timeouts, termination uncertainty, and redacted stdout/stderr.
Output is capped at 2048 bytes per stream per command; truncation or redaction
cannot qualify as verified passing evidence. At most ten 1000-character commands
run, with a maximum 60-second process deadline each, also bounded by task expiration.
Existing packet-size rejection remains in force; no evidence is silently discarded.

Results are synchronously saved before packet construction. Candidate and normal
checkout snapshots are compared after execution; mismatch blocks reviewer startup.
Absent or different-tree validation cannot satisfy TEST_EVIDENCE. Aggregate
`completed` means the validation attempt finished, **not that its tests passed**.
Only all required commands with observed start/completion, zero exit, complete
output, unchanged original and confirmed termination can qualify. Test design and
requirement sufficiency remain review questions; native notifications/model prose
never supply independent results. SCOPE is qualified separately under the bounded
contract above; independent test success cannot override a scope or requirement FAIL.

Cancellation kills the owned process group before waiting; missing close or live
group members leave termination unconfirmed and block workspace deletion. This
does not prove termination of deliberately escaped descendants. Test copies are
retained for inspection until explicit task-workspace deletion. SQLite intent and
OS spawn/exit cannot be atomic: a crash in between is uncertain, never replayed.
Restart retains identity/results without killing guessed PIDs or reattaching;
unconfirmed termination requires operator reconciliation. The review operation and
one-attempt-per-task policy deduplicate validation as well as reviewer execution.
Before/after snapshots cannot exclude external change-and-restore races; no new
filesystem freeze, historical audit or security infrastructure is claimed.

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

`LocalCodexBackend({cwd, codexPath, codexHome, onApproval, onQuestion, onProgress, onLifecycle, reviewOnly})`
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
PAB's existing per-path repository sandbox. Use only trusted repositories; publication
must go through the Controller's qualified review gates, never the executor. Do not
assert security equivalence.

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

The initial PR #5 controller slice recorded **61 focused, 17 controller, and 207 full offline tests**,
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
PR #6 adds offline-tested durable human-response routing to the same live turn;
its live human-routing acceptance remains unverified. Uncertain delivery is not replayed.
Local validation, bounded PASS qualification and exact-tree publication integration
have offline coverage only; end-to-end live qualification remains outstanding.
Existing Agents API gates and deployment authorization are unchanged.

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

Register a separate, explicitly approved repository locally (still supported):

```bash
node register-repository.mjs example /absolute/path/to/approved-repository
```

The command pins canonical path and filesystem/Git identity in an owner-only local
registry. It rejects this bridge's source repository. Never register the bridge as
its own implementation target. MCP callers use only `repository_id: "example"`.
No repository registrations or account configuration are shipped with this source.

### Remote registration of owned GitHub repositories

After one-time deployment and trusted GitHub authentication, eligible registrations
require **no SSH session or per-repository host approval**. Ask ChatGPT to discover
registrations with `list_registered_repositories`, explain the requested registration
and obtain your consent, then call:

```json
{"repository":"danielnguyen/browser-trust-inspector"}
```

on `register_github_repository`. The result contains `status`, `repository_id`
(`github_<numeric GitHub repository ID>`), numeric GitHub repository/owner IDs,
canonical full name, visibility and a confirmed baseline commit. Separately
authorize `start_task` with that returned ID, a complete contract, a unique
`request_id`, and **`execution_backend: "local_codex"`**. Registration never starts
a task or changes the default Agents API backend. Discovery is read-only and
returns no local paths; legacy local registrations may lack numeric GitHub metadata.

The Controller, not ChatGPT or an implementation agent, enforces authorization:
GitHub's authenticated `/user` must be a user account whose numeric ID matches the
repository owner's numeric ID and whose login matches the API repository identity.
Accessible owned private repositories are supported. Organizations, collaborator-only
access, missing access/identity and the PAB source repository are rejected. The
source denylist pins this distribution's GitHub repository ID `1388046916` as well
as its canonical name, so renaming that repository does not evade self-protection.
Forked deployments must retain equivalent protection for their own source identity.
The single-owner tunnel gate applies to both tools; conversational consent is **not**
independently authenticated human identity. Every accepted caller has the owner's
registration authority within this policy.

Repositories are provisioned beneath the fixed, private
`~/.local/share/personal-agents-bridge/repositories`, never a caller-selected path.
Only generated HTTPS GitHub URLs are used. No URL, path, credential, Git option or
shell command is accepted through MCP. The Controller obtains GitHub credentials
through its existing `gh` login/environment; no credential value or helper setting
is copied into a repository or task. Hooks/templates and global/system Git config
are disabled during provisioning. Filters have no configured executable drivers;
submodules and symlink entries are rejected rather than followed. No dependencies
or repository code are executed. This is not a new confidentiality boundary: the
existing broad-read limitations in [SECURITY.md](SECURITY.md) still apply.

Provisioning fetches the default branch history into a staged checkout, verifies
the API-pinned commit, checks the tree before checkout, and rechecks GitHub ownership
and identity afterward. The existing version-1 registry retains its canonical
path/directory/Git identities, with a separate `github_repositories` binding map.
Task resolution verifies the origin and registered baseline; publication also checks
GitHub numeric identity to reject repository replacement or transfer. All existing
worktree, validation, review and exact-tree publication gates still apply.

Identical requests revalidate and return `already_registered`; they do not refresh
the baseline or alter an existing checkout. Rename, transfer, origin/identity changes
and local ID/path collisions fail closed. An existing host-registered GitHub origin
is discovered by its original logical ID, not silently duplicated. Empty, archived,
disabled, oversized or unsupported-content repositories are rejected. API-reported
repository size and checked-out file bytes are each capped at 128 MiB; at most
20,000 entries are inspected, with bounded Git/API output. The registry remains
capped at 64 KiB, with at most 100 discovery entries. These are admission and
evidence limits, **not a filesystem quota** on downloaded history. API commands have
15-second limits. Existing coreutils `/usr/bin/timeout` bounds the fetch process
group at 120 seconds, with a 125-second parent fallback and discarded transport
output; no network retry is automatic. Unexpected termination remains fail-closed.

#### Failure recovery and deployment

Both registration writers share an exclusive `repositories.json.lock` directory.
Controller requests serialize; another process receives `REPOSITORY_REGISTRY_BUSY`.
Registry updates use exclusive private temporary files, file synchronization, atomic
rename and parent synchronization. Completed checkouts are published before registry
entries. A failure cannot advertise a partial checkout as registered.

A crash may leave the lock, a `.stage-github_<id>` directory, a registry temporary
file, or an unregistered `github_<id>` checkout. Fetch failure retains its stage,
because subprocess termination can be uncertain; retries do not reuse it. A registry
write failure after checkout publication retains that unregistered destination.
No startup replay, automatic lock stealing, orphan adoption, destructive replacement
or hash repair is performed. A lost acknowledgement after a successful registry
replacement can return the existing entry only after complete identity validation.
`REGISTRATION_INCOMPLETE_REQUIRES_INSPECTION`, `REGISTRATION_DESTINATION_EXISTS`, or
a persistent `REPOSITORY_REGISTRY_BUSY` require a trusted operator to stop further
registration, establish that the original Controller/fetch/helper processes have
exited, inspect registry identities and private artifacts, and remove **only confirmed
unregistered** leftovers/abandoned locks before a new explicit request. Do not delete
registered repositories. Ordinary successful registrations need no host intervention;
uncertain filesystem/process failures deliberately do.

For deployment, independently review and merge first, stage a clean release with
locked dependencies, preserve/backup the existing registry and state, ensure the
managed runtime has `/usr/bin/timeout` and its user has an authenticated GitHub **user** account with repository
read access and storage available under the fixed provisioning root, and switch the
existing launch profile only during an owner-authorized idle restart. No credential
or registry migration is required. Use this release's local registration CLI, not
an older writer that lacks the shared lock. The managed tunnel does not forward
`GH_TOKEN`/`GITHUB_TOKEN`; its existing private `gh` login is the supported route.
Do not copy credentials, acceptance state or fixtures into a release/task checkout.

Post-deployment acceptance requires separate authorization: discover registrations;
register a small, owner-owned disposable public/private GitHub fixture; verify numeric
identity and baseline, repeat once and confirm no second checkout; verify organization
and collaborator-only denial; then separately authorize a local task with a minimal
contract and confirm isolated worktree execution. Validation, review and publication
remain separate approvals. Offline mocks do not establish live credential, transport,
or production acceptance. No live registration is part of implementation validation.

## Workflow

| Tool | Purpose |
| --- | --- |
| `list_registered_repositories` | Discover bounded logical IDs and GitHub identity without host paths. |
| `register_github_repository` | Controller-register an eligible GitHub user-owned repository; never starts execution. |
| `start_task` | Start a contract in a disposable workspace or allowlisted repository worktree. |
| `get_task` | Inspect bounded progress, clarification, review and publication state. |
| `continue_task` | Answer clarification or explicitly request further implementation. |
| `review_task` | Freeze evidence and request independent review in a separate session. |
| `publish_task` | Freeze a completed PASS-reviewed repository task and create a draft PR. |
| `cleanup_task` | Stop execution/delete remote sessions; optionally remove the worktree. |

[Tool schemas and contracts](docs/TOOLS.md) describe scope, costs, retries, review
and publication for the default Agents API path. Local execution is the limited
opt-in path described above; local publication requires the bounded qualification gates. Agents API
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
