# Local Codex execution: feasibility assessment

**Decision: PAB is not ready for full migration.** This change supplies isolated
experiments and a migration design, not an authorized execution backend. No model
turns, paid Agents API sessions, or PAB live tests were invoked. Production
credentials/configuration were neither read by the probes nor changed. No
production controller, MCP schema, sandbox, review gate, or publisher is replaced.

## Follow-up gate: authenticated acceptance harness

This follow-up starts from public main
`7bc0e6fefdbd36e935e866d71db50f0a0239a233` (merged PR #2). It adds only
`feasibility/local-codex/authenticated-acceptance.mjs`, its offline tests, and this
section. The previous unauthenticated probe remains unchanged. The original normal
checkout, dirty files, private predecessor history, production login and backend
are untouched.

**Current disposition: blocked on fresh operator authentication.** The new real
unauthenticated preflight passed with the pinned 0.157.1 runtime. No authenticated
model turn has been submitted for this gate. The following are actual acceptance
statuses, not predictions based on synthetic tests:

| Criterion | Status | Evidence / outstanding work |
| --- | --- | --- |
| Disposable configuration verified | VERIFIED | New private Codex home; effective config/layers/requirements checked against controller pins; no inherited nonempty layer accepted |
| Narrow standalone boundary verified | VERIFIED | Actual `command/exec`: fixture readable, worktree creation denied, private Codex-home sentinel read denied, loopback connection denied |
| Authentication verified | UNVERIFIED | Requires fresh operator device login and unambiguous `account/read` |
| Inference verified | UNVERIFIED | Requires one correlated, successfully completed model turn with the exact fixture response and validated usage |
| Subscription usage attribution verified | UNVERIFIED | Neither auth type nor token counters prove subscription billing attribution |
| API-key fallback excluded for live execution | UNVERIFIED | Offline exclusion checks pass; fresh file auth and runtime identity/config must pass before and after a real turn |
| Narrow model-issued command verified | UNVERIFIED | Requires paired runtime command items for the fixed `cat fixture.txt` command, expected cwd/output and exit zero |
| Subscription authentication qualified / next model-tool stage | UNVERIFIED / BLOCKED | Do not advance on synthetic success or account-read alone |

The harness uses the existing `AppServerRpc`, `SessionLedger`, environment builder
and command observation mechanism. It connects to a new stdio app-server process,
not a shared daemon. Its default launcher inherits no environment variables:
`HOME`, `CODEX_HOME`, scratch, PATH, locale and Git settings are explicitly generated.
API keys, access tokens, proxy/CA overrides and unrelated configuration are never
forwarded. Authentication files are never copied. `login` refuses an existing
auth file, uses only fresh ChatGPT device login with the file credential store,
and records a private token-free identity binding after successful login. It never
submits a turn. A login for an unsupported/unknown/free or explicitly usage-based
plan is not enough for this subscription gate; plan naming alone also cannot prove
usage attribution.

The entire permission/configuration table is supplied at CLI precedence and checked
through `config/read` and `configRequirements/read`. Only the known null defaults
and the forced-ChatGPT login requirement are normalized. Nonempty system, project,
managed or other user layers, custom providers, alternate base URLs, MCP/plugin
configuration, unexpected requirements, or differing permissions block inference.
The model is selected once from the single visible default returned by `model/list`
with complete pagination, then pinned and checked in `thread/start`; the catalog is
not treated as an entitlement check. Failure does not select another model/provider.

The disposable role grants read access to the runtime's `:minimal` paths, the exact
checksum-pinned Codex executable, and the fixture workspace, plus scratch writes.
Both private home directories are denied to commands; network is disabled. An
initial boundary trial failed because `:minimal` did not expose the Codex executable
installed outside system directories. The exact executable read grant fixed that
prerequisite; no broad host read/write grant was added. The one known warning about
using bundled bubblewrap is accepted only verbatim and remains subject to the real
boundary test; all other configuration warnings fail closed. Disabled remote-control
status is checked without retaining host/account identifiers.

`run` requires the wrapper's fresh-login marker, validates file ownership/modes,
canonical directories, runtime digest, exact config and fixture bytes, and parses
only the new home's auth file in memory. It rejects any stored API key or alternate
authentication mode. No token or account value is printed. Before the first thread
creation it exclusively creates and syncs `inference.claim`. SQLite persists
operation intent before sending requests. Each root permits at most one submission;
an error, timeout, restart or lost acknowledgement cannot replay it. A claimed root
is never automatically reset. Codex's own internal transport retries are outside
this harness's visibility; this does not claim exactly-once upstream inference.

The single model turn asks only for `cat fixture.txt` and the fixed final marker.
The fixture and prompt have no user-supplied content. The collector checks fresh
thread/session identity, empty inherited instructions, the active role profile,
turn IDs, start/completion ordering, one paired command, exact safe command/cwd,
exit/output, exact final response, and numeric usage. It rejects other model tools,
unexpected notifications, auth changes, incomplete/duplicate records and transport
uncertainty. Configuration, file auth and account identity are checked again before
reporting live API-key fallback exclusion or inference success. Runtime events are
observations; notification validation is not a pre-execution tool enforcement hook.
The full native-tool sandbox and process-descendant guarantees remain separate gates.

The sanitized report separates all four requested auth/inference/usage/fallback
criteria. Command evidence keeps `codex_app_server_item` provenance and substitutes
`<disposable-workspace>` for cwd. It exposes only the fixed allowlisted command and
fixture output, numeric usage and boolean identity binding, never account/email,
tokens, thread/session IDs, runtime paths or raw errors. IDs and attempt state stay
in private SQLite under the disposable root. `authentication=VERIFIED` refers to
the preflight account snapshot; a later uncertain turn does not become verified
inference. Upstream command completeness remains unknown. Usage counters cannot
upgrade `subscriptionUsageAttribution`; that field deliberately remains UNVERIFIED
until separate operator/service evidence is reviewed. The harness never authorizes
the next stage or production migration by itself.

### Running this gate

Use Node 24+ and the existing checksum-pinned binary on a Linux host that permits
the required namespaces. Do not update Codex, restart daemons, launch PAB, or use
its paid live tests. These commands concern only the disposable acceptance home:

```bash
node --test test/local-codex-feasibility.test.mjs test/local-codex-authenticated.test.mjs
npm test
git diff --check

pab_auth_root=$(node feasibility/local-codex/authenticated-acceptance.mjs prepare "$(command -v codex)")
node feasibility/local-codex/authenticated-acceptance.mjs preflight "$pab_auth_root"
```

`prepare` prints an absolute `/tmp/pab-auth-acceptance-*` directory. Preserve that
path privately. `preflight` runs no authentication flow or inference, and must show
configuration and standalone boundary VERIFIED, with no blocker. Exit zero here
does **not** mean the authentication gate passed. Stop for the operator to execute:

```bash
node feasibility/local-codex/authenticated-acceptance.mjs login "$pab_auth_root"
```

The wrapper rechecks preflight and launches the pinned CLI's `login --device-auth`
with the explicit disposable environment and file credential store. Complete the
browser/device interaction yourself; do not paste codes, credentials, auth files or
account details into the PR/chat. Do not fall back to copied auth caches, API keys,
external tokens or a different provider. If device login is unavailable, stop and
report that blocker. The wrapper does not run inference after login. Once the
operator confirms completion, the already-authorized minimal acceptance is:

```bash
node feasibility/local-codex/authenticated-acceptance.mjs run "$pab_auth_root"
```

This can consume the selected ChatGPT plan's Codex allowance. Inspect the sanitized
report and retain private state outside Git. An uncertain outcome or unexpected
command/response must not be retried in that root. Do not delete the claim or reuse
the persisted session to work around a failed check. Investigate first; any newly
authorized attempt needs another freshly prepared/login-approved home. Operator
account usage/billing evidence, if available, must be assessed separately for this
specific attempt; general account activity or simultaneous other sessions cannot
establish attribution. Do not publish screenshots or raw account responses.

After evidence review, the operator may remove this disposable home as a unit.
No cleanup command should touch the existing Codex home. `/tmp` is not durable
retention; preserve any required private evidence before host cleanup. On the
validation machine Node requires its existing `libatomic.so.1` compatibility path;
that library is needed by Node only and is not inherited by the Codex child.

### Follow-up validation record

The 23 new deterministic offline tests cover authentication/configuration rejection,
explicit environment exclusion, fresh-login gating, session/policy validation,
uncertain submission persistence and duplicate prevention, transport loss, timeout,
account changes, command/response/usage validation, sanitized output, and a
zero-inference preflight. They invoke a fake RPC transport, not Codex inference.
The existing transport tests still exercise real synthetic subprocesses. Successful
mock authentication or mock usage is never published as live acceptance evidence.

Offline validation on 2026-10-10: the requested focused command passed **42/42**
tests, and `npm test` passed **168/168**, with zero failures or skips. The full
suite took approximately 91 seconds. `git diff --check` passed. These results
include existing real kernel/subprocess checks, not any paid live tests or model
turns. The final conservative plan-type rejection assertions were also included
in a subsequent focused rerun.

The real unauthenticated preflight passed on the pinned runtime. The surrounding
CLI sandbox initially blocked namespace/subprocess checks; the host-permission
run passed without disabling enforcement. A full filesystem was resolved by
removing only the dependency copy and npm cache created for the preceding
feasibility task, preserving source/history/evidence. No production authentication
was inspected or changed. Live authentication and all model observations remain
pending operator interaction.

## Scope and reproducibility

Inspected on 2026-10-10:

| Input | Revision/version |
| --- | --- |
| Public PAB baseline | `deb52d33954f794c1c6d261857c2d424e0a33f0f` |
| Codex Runner reference | `b9e75863939869526f442e3580154e3f2de1e354` |
| Runner's TypeScript SDK | `@openai/codex-sdk@0.146.0` |
| Installed standalone Codex | `codex-cli 0.157.1` |
| Codex executable SHA-256 | `3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970` |
| SDK npm archive SHA-256 | `c82e52c81d7c32db9738e699d370cefab08296563f1d84ea1f00eb3d9583fedc` |
| Validation host | Linux `5.15.0-194-generic`, Node `v26.5.1` |

The original working directory has unrelated uncommitted public-source preparation
and security work and private predecessor Git history. Work was performed in a
clean clone of the public baseline; none of that local history or pending work is
part of this PR. The inspected local `controller.mjs` matches the public baseline.
Codex Runner is reference material only; no dependency on its service or code is
introduced. Installed runtime and SDK versions differ deliberately: observations
about one are not silently attributed to the other or to a future release.

## Existing PAB contracts

`server.mjs` exposes six MCP tools: start, get, continue, review, publish, cleanup.
`Controller` owns SQLite records, request correlation/deduplication, locks, expiry,
clarification, session ownership, and recovery. Its constructor selects metered
Agents API sessions. `openSession`, `observe`, `viewRole`, `continue`, `cleanup`,
and command collection in `buildPacketData` are coupled to that API. Merely replacing
`LocalExecutor` does not move the model loop locally.

`repositories.mjs` allows registered repository IDs, pins canonical identity and
baseline, rejects bridge self-targeting, and constructs a private Git store/worktree.
`repository-sandbox.mjs` separates a networked forwarder from a controller-owned
allowlisted RPC dispatcher. It pins the entire Codex permission table at CLI
precedence, probes enforcement before implementation, confines commands and file
workers, protects `.git`, `TASK.md`, `.codex`, backing checkout, and controller
state, and disables command networking including loopback and Unix connections.
Reviewers have scratch-only writes. Reads remain broad; this is not a confidentiality
boundary. The legacy non-repository Landlock path has a different contract and
cannot publish. A migration must explicitly support that path or leave its existing
backend in place; it must not silently reinterpret its guarantees.

`file-rpc-evidence.mjs` persists controller-owned before/after operation records,
pending outcomes, generation coverage, and sealing status. `review-evidence.mjs`
collects checkout/Git/sandbox observations. `packet-budget.mjs` preserves mandatory
sections within 128 KiB or rejects construction. Command/test records currently
come from Agents API `command_execution` items, separately from implementer prose.
`reviewer-instructions.mjs` distinguishes structural enforcement from required
operation history and optional diagnostics. A missing fact needed by an obligation
must fail that finding; missing optional diagnostics are not a blanket scope failure.

The reviewer is a separate session consuming a frozen packet. `Controller.publish`
requires completed implementation, distinct completed PASS review, packet identity,
repository revalidation and stopped executors. `publication.mjs` verifies unchanged
state, freezes the task, commits the exact reviewed Git tree, and pushes only the
fixed task branch for a draft PR. A new local backend must establish process-tree
quiescence before these existing snapshots/gates, not merely receive an interrupt
acknowledgement. PAB remains the only publisher and orchestration system.

The baseline suite exercises these contracts with fake API sessions, actual kernel
sandboxes, file RPCs, local Git remotes, and mocked GitHub publication. All **126
baseline tests passed** on this host outside the surrounding CLI sandbox. This is
evidence for the existing backend, not security equivalence for the proposed one.

## SDK versus app-server

| Requirement | TypeScript SDK 0.146.0 | App-server 0.157.1 | Assessment |
| --- | --- | --- | --- |
| Subscription login | Wraps local `codex exec`; environment/auth selection remains important | `account/read` identifies auth type; local login is available | Supported route documented; authenticated inference unverified here |
| Start/continue/recover | `startThread`, repeated `run`, `resumeThread`; process per execution | `thread/start`, `thread/resume`, `thread/read`, turn/item listing, `turn/start` | Interfaces exist; durable PAB reconciliation still required |
| Cancel | `AbortSignal` to spawned CLI | `turn/interrupt` plus terminal notification | Neither acknowledgement proves descendants stopped |
| Explicit clarification | No bidirectional server-request callback in inspected SDK | `item/tool/requestUserInput`; experimental dynamic tool calls | App-server is the better candidate; interruption semantics are a blocker |
| Exact PAB policy | Basic sandbox/approval/network options plus config overrides | Named profiles at thread/resume/command boundaries are experimental | Basic `workspace-write` alone is insufficient |
| Command evidence | command/output/status/exit code, no cwd in inspected item type | command/cwd/output/status/exit code, correlated thread/turn/item IDs | Neither observed schema certifies exhaustive command/file history |
| Separate reviewer | Separate fresh thread | Separate fresh thread and independently checked session identity | No fork, shared transcript, or built-in review mode substitution |

The actual SDK archive (`dist/index.js`, `dist/index.d.ts`) shows execution via
`codex exec --experimental-json`; it passes `AbortSignal` to `spawn`, reads JSONL,
and resumes using a CLI argument. Its default behavior copies the process
environment; supplying `apiKey` sets `CODEX_API_KEY`. The synthetic SDK experiment
checks start, same-thread continuation, reconstruction by ID, cancellation, command
items, and explicit environment/policy arguments. It proves wrapper behavior only.

Codex Runner's [`OpenAICodexAdapter`](https://github.com/danielnguyen/codex-runner/blob/b9e75863939869526f442e3580154e3f2de1e354/src/codex/openai-codex-adapter.ts)
starts a new SDK thread with `workspace-write`, `never` approvals, and repository
network policy. It intentionally inherits environment/configuration, so its absence
of an explicit SDK API key does not itself prove subscription-only execution.
Its normalized command events discard command text/output/cwd, and file events keep
counts/kinds. Those are progress signals, insufficient for PAB test or mutation-history
review. Its execution service marks abandoned runs interrupted; it does not resume
them or expose cancellation/clarification. Its registry uses the normal checkout,
not PAB's private worktree/store. Its fake-adapter tests demonstrate service behavior,
not kernel confinement or subscription billing. Useful patterns are explicit local
adapter ownership, synced persistence, and honest interruption status. PAB should
not inherit Runner's API, approval workflow, or event reduction.

The reference execution service also marks normal iterator exhaustion completed
without independently requiring a terminal turn event. A PAB adapter must require
an explicit terminal outcome; EOF or an empty stream cannot become successful work.

Generated stable and experimental bindings from the installed binary are the
version-specific protocol evidence. The stable schema has sandbox modes and lifecycle
methods. Experimental bindings add `ThreadStartParams.permissions`,
`ThreadResumeParams.permissions`, `CommandExecParams.permissionProfile`,
`activePermissionProfile`, and `dynamicTools`. The profile response is an identifier
and parent identifier, not a kernel attestation or full effective policy. The inspected
thread schema does not establish a supported connection to PAB's existing external
RPC dispatcher. Experimental environment fields are not proof of such a connection.
Do not invent an exec-server URL option or depend on undocumented rollout files.

## What the implementation proves

All code is under `feasibility/local-codex/` and the new offline test file. Nothing
imports it from the production server/controller. There are no new dependencies.

| Experiment | Observed evidence | Limit |
| --- | --- | --- |
| `probe.mjs` | Actual app-server initialize/account-read/standalone command execution; 20 assertions per role; unauthenticated accounts rejected | No authenticated thread or model turn; no native file-tool proof |
| Native command profile | Scratch writes; implementer worktree writes; reviewer worktree write denial; protected existing-file write/truncate denial; outside creation and symlink escape denial; INET/INET6/Unix/UDP denial | Standalone `command/exec` only; no claim for every model tool or platform |
| `sdk-probe.mjs` | Real pinned SDK, synthetic executable; four calls cover creation, continuation, resume, abort and command evidence | No Codex authentication, real threads, descendants, or sandbox proof |
| `SessionLedger` tests | Synced SQLite state, independent thread/session IDs, before-send uncertain operations, duplicate suppression, durable pending questions, interrupted/reply-uncertain recovery | Single-controller, one-task prototype; no real thread reconciliation or successful clarification lifecycle |
| RPC tests | Correlation, malformed/oversized transport rejection, timeout/disconnect failure, rejection of unexpected server requests | Probe transport deliberately denies every server-initiated request |
| Command normalization | Runtime provenance, thread/turn identity, bounded output, explicit unknown upstream completeness; prose not accepted | No redaction adapter or production evidence collector; use only synthetic records here |

`SessionLedger` and `AppServerRpc` are intentionally separate experiments. They are
not wired into a runnable model backend. The store does not promote an ambiguous
clarification to answered: `serverRequest/resolved` can also mean a request was
cleared. A late answer, connection-generation mismatch, nonblocking/expiring input,
or interrupted request remains blocked. This conservative behavior proves retention
and non-replay, not successful recovery of an app-server pending request. The
prototype deliberately has no path from these results to production publication;
`migrationDecision()` always reports the unresolved blockers.

## Blockers and regressions to avoid

1. **Subscription-only execution is not yet demonstrated.** Official authentication
   documentation distinguishes ChatGPT subscription login from API usage billing.
   No operator login, token refresh, successful authenticated inference, quota failure,
   or provider-route verification was performed. An auth type check alone cannot
   establish billing or entitlements. Use a dedicated execution account/config home,
   explicit environment allowlist, OpenAI provider pin, and reject API-key/custom
   provider fallback. Do not expose controller keys in command environments. Never
   run `forced_login_method` against existing production auth as a probe: a mismatch
   can sign the user out. Subscription limits are still relevant.
2. **Native tools bypass the existing RPC journal.** App-server runs its own tools.
   A successful standalone command probe does not prove native patch/file tools,
   code-mode tools, plugins, hooks, MCP servers, subagents, or future execution paths
   use the same boundary. Thread/turn/resume policy must be pinned and validated,
   including project/managed configuration precedence. Web search and MCP can use
   networked harness paths even when shell networking is disabled. Disable unaudited
   surfaces or independently constrain and test them. Stop before implementation if
   any effective policy cannot be established.
3. **Evidence coverage is not equivalent.** The inspected `commandExecution` schema
   has nullable output/exit code and no positive upstream truncation/completeness
   attestation. An uninterrupted client stream does not prove all executions were
   represented. `fileChange` lists patch changes, not all file RPC attempts, denied
   operations, or arbitrary shell writes. Do not label these as controller file-RPC
   observations or infer compliance from the final tree. Preserve unknown outcomes,
   dropped events, incomplete pages, truncation and coverage generations. Existing
   API test matching uses substring inclusion: preserve compatibility deliberately,
   but do not mistake text such as `echo npm test` for independently executed tests.
4. **Durable clarification is unresolved.** Native requests include blocking and
   auto-resolution semantics. Request IDs are transport-scoped; replaying one after
   reconnect is unsafe. `serverRequest/resolved` is not proof the answer was consumed.
   Dynamic `request_clarification` is a closer semantic match but experimental and
   also needs an accepted/lost-response recovery contract. Do not substitute an agent
   prose question or nonblocking request for PAB's explicit wait requirement.
5. **Cancellation/recovery need process ownership proof.** Persist intent before
   start/answer/interrupt, never auto-replay ambiguous mutations, and reconcile owned
   thread/turn IDs after restart. Kill/reap and verify the entire owned process tree
   before snapshot, review, publication, or deletion. App-server EOF, an SDK abort,
   a terminal turn, and a process PID alone are not that proof. Recovered event history
   must not fabricate first-execution sandbox coverage.
6. **Review separation must extend beyond IDs.** Give reviewer/implementer independent
   threads and session histories, runtime state and roles. Shared memories, skills,
   tools, inherited repository instructions, or a fork can compromise independence.
   Reviewer instructions and scratch-only writes still apply. Runtime logs and
   credentials must remain outside agent-writable roots. Broad reads remain an
   acknowledged PAB limitation, not a new confidentiality claim.

These blockers stop authorization for a backend switch. Further model execution
and production wiring are outside this feasibility implementation.

## Recommended design and sequence

Prefer a **PAB-owned app-server backend**, conditional on resolving the blockers.
The TypeScript SDK is simpler for batch work but does not expose enough bidirectional
control for PAB clarification. The official SDK page also describes a Python SDK
over app-server; adding a second language/runtime would not by itself solve these
protocol and evidence issues and was not experimentally evaluated here.

1. Extract a backend interface from the controller, keeping its public MCP, repository
   registry, durable task/operation tables, locks/expiry, packet budgeting, review
   validation and publisher. Backend operations should cover create/inspect/continue,
   clarification, interrupt, evidence capture, and stop-and-confirm. Run the existing
   fake-API contract suite unchanged against the old backend and an offline local
   backend fake. Persist backend/version per role; never resume existing API tasks
   silently as local tasks. Avoid a fake Agents API compatibility layer that invents
   remote required-actions or command provenance.
2. Qualify a pinned Codex release and dedicated subscription-authenticated service
   account using the operator matrix below. Add a private read-only auth preflight;
   reject absent/API/custom-provider auth before any turn. Specify renewal, subscription
   limit and reauthentication behavior without API-key fallback. Keep credentials
   out of repository/task inputs and agent command environments.
3. Resolve the execution boundary first. Either establish a supported route through
   the existing PAB dispatcher, or qualify native fine-grained permissions for **all**
   enabled execution/file paths and replace the journal with equivalent trusted
   observations. A named profile alone is not sufficient. If neither route can be
   proven, stop migration; do not use full access or waive review obligations.
4. Implement supervised per-role processes with controller-owned runtime directories,
   version/policy hashes, startup probes and fresh role-specific attestations.
   Pin launch/thread/turn/resume settings; disallow caller-selected permissions,
   environments, provider URLs and plugins. Test restart, cancellation, daemonized
   children, termination failure, and cleanup before claiming quiescence.
5. Add a durable local request/response outbox and clarification state machine,
   binding task/role/thread/turn/item/transport generation. Persist requests before
   exposure and answers before sending; keep uncertain outcomes blocked until a
   supported reconciliation proves delivery or allows a newly authorized turn.
   Re-authentication must not discard unanswered questions.
6. Adapt trusted command/file/test evidence with explicit provenance and completeness.
   Independently execute required test commands in the same pinned sandbox when
   runtime records cannot prove them; tie results to the exact tree. Controller test
   runs cannot recover missing edit history. Feed existing packet/reviewer semantics
   without changing missing-evidence requirements. Add overflow, lost-page, storage
   failure, denied file operation, event reorder/duplication and tampering tests.
7. Start a fresh reviewer with frozen packet and independent context; require the
   existing completed PASS and exact-tree publication gates. Run cross-backend
   contract tests and separately authorized authenticated acceptance tests before
   requesting migration authorization. Keep rollback possible for new tasks without
   mixing histories or credentials. No merge/deployment is authorized by this report.

## Validation instructions

Recorded results on the host/version above: **145 tests passed, zero failed or
skipped** (126 existing plus 19 feasibility tests; 89.07 seconds). The actual
app-server standalone command probe passed all 20 assertions for each role and
rejected unauthenticated accounts. The SDK wrapper probe passed four synthetic
invocations. `git diff --check` passed. There were **zero model turns** across these
checks. These results do not clear the blockers listed above.

Offline checks, from a clean checkout with Node 24+ and the pinned Codex binary:

```bash
npm ci --ignore-scripts
node --test test/local-codex-feasibility.test.mjs
npm test
node feasibility/local-codex/probe.mjs /absolute/path/to/codex
codex app-server generate-ts --out /tmp/pab-stable-schema
codex app-server generate-ts --experimental --out /tmp/pab-experimental-schema
git diff --check
```

The existing suite requires writable `/var/tmp/personal-agents-bridge`, local
listeners and Linux namespaces. The new unit tests use `/tmp`. The standalone probe
creates a fresh private HOME/Codex home, no auth, no inherited API keys and no
`turn/start`; its only command payload is the fixed Python boundary test. Exit zero
means that narrow probe passed; `migration.authorized` must still be false. A
namespace or policy failure exits nonzero, never skips or falls back. Reports omit
account details, source/output bodies and private paths. Disposable probe directories
are removed on normal success/failure; externally killing a probe can leave its
temporary fixture for operator cleanup.

For the SDK-only offline experiment, download/extract the pinned package into a
temporary directory without changing PAB dependencies, verify the hash above, then:

```bash
pab_sdk_probe_root=$(mktemp -d /tmp/pab-sdk-inspect-XXXXXX)
curl --fail --location --silent --show-error \
  https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-0.146.0.tgz \
  --output "$pab_sdk_probe_root/sdk.tgz"
sha256sum "$pab_sdk_probe_root/sdk.tgz"
tar -xzf "$pab_sdk_probe_root/sdk.tgz" -C "$pab_sdk_probe_root"
node feasibility/local-codex/sdk-probe.mjs "$pab_sdk_probe_root/package/dist/index.js"
```

The SDK probe always supplies its own synthetic executable and explicit environment;
it never selects an installed Codex binary. Expect four synthetic invocations and zero
real Codex/model invocations. Both prototypes are test instruments, not supported
entry points for user tasks.

On this validation host Node needed the operator-provided `libatomic.so.1` library
directory in `LD_LIBRARY_PATH`. Initial restricted runs could not create baseline
fixtures and interfered with Node child-process pipes. Reruns with host permissions
passed; no test was altered to skip missing enforcement. Package installation also
reported one existing high-severity dependency advisory; dependencies are unchanged
and that advisory was not remediated as part of this backend study.

## Operator-authenticated acceptance (not executed)

Use a dedicated disposable OS account/VM with no production credentials, a fresh
Codex home, and a disposable PAB repository fixture. Authenticate there through
`codex login` or `codex login --device-auth`, never an API key. Do not reuse/copy the
production auth file. Use the pinned binary and regenerate its schemas. Inspect
provider configuration and start app-server through a PAB-owned explicit environment
allowlist. Pin the provider to `openai`; prohibit custom provider/base-URL overrides,
API-key variables, alternate auth tokens and inherited MCP/plugin configuration.
Check `account/read` with `refreshToken:false`; require `account.type=chatgpt` and
`requiresOpenaiAuth=true` before submitting a turn. Record only auth method and
pass/fail, never tokens or email. A dedicated config may set
`forced_login_method="chatgpt"`; never apply it to production auth for this test.

For example, on that disposable account, set up separate paths before login:

```bash
pab_acceptance_root=$(mktemp -d /tmp/pab-codex-acceptance-XXXXXX)
pab_codex_binary=/absolute/path/to/pinned/codex
mkdir -m 700 "$pab_acceptance_root/home" "$pab_acceptance_root/codex" \
  "$pab_acceptance_root/work" "$pab_acceptance_root/scratch"
env -i PATH=/usr/bin:/bin HOME="$pab_acceptance_root/home" \
  CODEX_HOME="$pab_acceptance_root/codex" \
  "$pab_codex_binary" login --device-auth
```

Create the controller-owned role profiles in that new Codex home's `config.toml`,
using the explicit absolute filesystem map from `probe.mjs`: root read, scratch
write, implementer worktree write, protected `.git`/`TASK.md`/`.codex` read, network
false; reviewer omits the worktree write grant. Keep controller auth/state outside
both writable roots. Set `model_provider="openai"`,
`forced_login_method="chatgpt"`, `approval_policy="never"`,
`web_search="disabled"`, and shell environment inheritance to none. Launch with
the same `env -i` prefix and `app-server --listen stdio://`; pass the complete
permission table at CLI precedence as the probe does. Do not submit model input
until generated-schema checks and unauthenticated boundary probes have passed.
This manual diagnostic setup is not a substitute for the production controller's
future launcher/config validation or the all-tool coverage tests below.

Perform the following in order, retaining private controller logs and publishing only
sanitized results. Stop on any missing policy, evidence, auth, or delivery guarantee.

| Check | Reproducible action and required result |
| --- | --- |
| Auth/route | Initialize app-server; inspect account and selected OpenAI provider; submit one read-only fixture prompt. Require completed inference under the authenticated subscription and verify usage attribution with the operator. Repeat absent/API-key/mismatched auth using synthetic or disposable configuration; no turn may start and no fallback is allowed. |
| Lifecycle | `thread/start` with pinned role profile; persist returned thread/session IDs; `turn/start`; require `turn/completed.status=completed`. Continue with a second turn, stop/restart process and `thread/resume` by ID only. Verify fixture fact/history and reapply identical policy. A different thread/session or missing history blocks. |
| Clarification | Register experimental dynamic `request_clarification` with a required string `question`, or qualify native blocking input. Ask for a fixture choice before creating a file. Require an actual server tool request and no write before the answer. Persist it, deliver the answer, verify the same turn consumes it. |
| Interrupted questions | Restart at request-received, persisted-before-display, answer-persisted-before-send, sent-before-ack, and resolved-notification points. Reconcile from supported APIs; no stale RPC ID replay or automatic default answer. If delivery cannot be established, keep question visible as needs-attention and block execution. |
| Cancel/process death | Interrupt a long command with a delayed file write, including a child that backgrounds itself. Wait for terminal status and verify all owned descendants are gone and no delayed writes occur. Repeat after killing app-server/controller and during pending input. |
| Native enforcement | Repeat baseline sandbox tests through **model-issued** shell, patch/file, enabled code-mode/MCP/plugin paths and after resume: worktree/scratch allowed, protected paths/symlink/hardlink/rename/copy escapes denied; INET/INET6/UDP/loopback/Unix and explicit-URL push denied. Inject project config and environment override attempts. Reviewer cannot change packet/worktree. Unsupported paths must fail closed. |
| Evidence | Run passing and failing required tests, missing exit/output, large/truncated output, denied file operations and shell mutations. Drop/reorder/duplicate events; restart mid-command and mid-file-write. Require explicit gaps/unknown outcomes and appropriate FAIL findings, not fabricated complete history or PASS from prose. |
| Independent review | Fresh reviewer thread/session and runtime context (no fork/shared memory), frozen packet only as input, scratch-only writes, full per-obligation findings. Confirm implementer transcript/instructions cannot masquerade as evidence. |
| Publication | First use local bare remotes/mocked GitHub. Repeat missing/failed/stale review, changed tree, unstopped child, binary/mode/symlink/delete/rename and retry/race cases. Require exact reviewed tree, draft-only branch publication and no force/default-branch push. A real GitHub acceptance publish needs separate operator authorization. |

For protocol reproduction, send JSON lines over stdio. Initialize with
`capabilities:{experimentalApi:true}`, wait for its response, then notify
`initialized`. `thread/start` uses `cwd`, `approvalPolicy:"never"`, and
`permissions:"<controller-pinned-role-profile>"` (do not also send `sandbox`).
Persist its IDs before `turn/start` with `input:[{type:"text",text:"<fixture prompt>"}]`.
`turn/interrupt` takes `threadId` and `turnId`; its response is not the terminal event.
Use the installed schemas for pagination and resume; incomplete item pages cannot
be complete evidence. Experimental dynamic tools use
`{type:"function",name:"request_clarification",description:"Ask and wait",inputSchema:{type:"object",properties:{question:{type:"string"}},required:["question"],additionalProperties:false}}`.
Their server request is `item/tool/call`, answered with matching RPC ID and
`result:{contentItems:[{type:"inputText",text:"<answer>"}],success:true}`.
Native `item/tool/requestUserInput` instead takes
`result:{answers:{"<question-id>":{answers:["<answer>"]}}}`. These are distinct
protocols; do not send one response shape to the other. The production adapter and
authenticated harness needed to automate this matrix are explicitly not implemented.

## Sources

- [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth): subscription versus API login, auth caching, forced login method behavior.
- [OpenAI SDK documentation](https://learn.chatgpt.com/docs/codex-sdk): local thread lifecycle and Python/TypeScript interfaces.
- [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server): stdio lifecycle, generated schemas, request resolution cleanup semantics.
- [Codex Runner reference revision](https://github.com/danielnguyen/codex-runner/tree/b9e75863939869526f442e3580154e3f2de1e354): adapter, execution service/store, registry and fake-adapter tests.
- Installed binary-generated schemas and the checksum-pinned SDK archive listed above: version-specific fields and implementation observations. Regenerate locally; do not assume rolling web docs exactly match this binary.
