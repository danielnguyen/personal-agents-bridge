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

**Current disposition: NO-GO for authenticated qualification or inference.** The
networked managed-launcher candidate fails its OS-facility attestation before
app-server initialization (`MANAGED_OS_FACILITIES_UNVERIFIED`). See the integration
experiment below. `login` and `run` are now explicitly disabled before root access;
there is no authorized authenticated zero-inference qualification mode. The earlier
operator attempt remains blocked on an unidentified pre-inference MCP notification.
The operator reports completing fresh isolated device login, followed by an attempt
with configuration and standalone boundary VERIFIED, authentication UNVERIFIED,
zero model turns submitted, and `RUNTIME_UNCERTAINTY`. The latest report from head
`fc311b60a7a389db884fc58ddc2c3822bad05b3c` identifies `account_updated` during
authentication, then `mcp_activity` during pre-inference. That identifies the
rejecting MCP branch, **not the exact MCP method, server, source or activity**.
The existing root is claimed and is off limits: do not access, diagnose, reset,
delete, reuse or attempt inference in it. The coding agent has not inspected the
operator's private authentication state or rerun that attempt. The following are actual acceptance
statuses, not predictions based on synthetic tests:

**Managed-policy follow-up:** private Linux mount namespaces now demonstrate
source-level prevention for the configured stdio fixture, including user, trusted
project and CLI override attempts. This does not qualify all plugin/authenticated
sources or authorize acceptance. The earlier CLI-empty-table clearing conclusion
is withdrawn: corrected environment-bound tests show that it retains a user server.
See the managed-requirements experiment and subsequent integration attempt below.
The following table preserves the **earlier operator report**, not a successful
run of the new launcher.

| Criterion | Status | Evidence / outstanding work |
| --- | --- | --- |
| Disposable configuration verified | VERIFIED | New private Codex home; effective config/layers/requirements checked against controller pins; no inherited nonempty layer accepted |
| Narrow standalone boundary verified | VERIFIED | Actual `command/exec`: fixture readable, worktree creation denied, private Codex-home sentinel read denied, loopback connection denied |
| Authentication verified | UNVERIFIED | Fresh login reported; the later MCP blocker revokes any intermediate local-account qualification |
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
forwarded. Authentication files are never copied. The retained, currently disabled
login implementation refuses an existing
auth file, uses only fresh ChatGPT device login with the file credential store,
and records a private token-free identity binding after successful login. It never
submits a turn. A login for an unsupported/unknown/free or explicitly usage-based
plan is not enough for this subscription gate; plan naming alone also cannot prove
usage attribution.

The entire permission/configuration table is supplied at CLI precedence and checked
through `config/read` and `configRequirements/read`. Only the known null defaults
and the forced-ChatGPT login requirement are normalized. The integrated validator
additionally requires exactly `featureRequirements:{apps:false,plugins:false}`;
missing, enabled or additional feature requirements fail closed. Nonempty system, project,
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

The retained inference protocol (currently reachable only in synthetic tests) requires
the wrapper's fresh-login marker, validates file ownership/modes,
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
in private SQLite under the disposable root. Any blocker now revokes authentication,
inference, identity, fallback and model-command qualification, including a blocker
observed during shutdown. Upstream command completeness remains unknown. Usage counters cannot
upgrade `subscriptionUsageAttribution`; that field deliberately remains UNVERIFIED
until separate operator/service evidence is reviewed. The harness never authorizes
the next stage or production migration by itself.

### Running this gate

**The reported failures supersede the historical sequence below. The login/run
commands now fail with authorization blockers before accessing a root. They
are retained as design history, not working procedures or instructions to run
now. Do not access the claimed root, including through `diagnose-auth`. A fresh
authenticated inference attempt is not yet justified. Offline tests may run.**

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
operator confirms completion and separately authorizes a future attempt, the minimal acceptance is:

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

For a future home, after evidence review the operator may authorize its removal as a unit.
This does not authorize deletion of the currently claimed root.
No cleanup command should touch the existing Codex home. `/tmp` is not durable
retention; preserve any required private evidence before host cleanup. On the
validation machine Node requires its existing `libatomic.so.1` compatibility path;
that library is needed by Node only and is not inherited by the Codex child.

### Follow-up validation record

The initial 23 deterministic offline tests cover authentication/configuration rejection,
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
was inspected or changed. Those results preceded the operator-reported failure;
live authentication qualification and all model observations remain unverified.

### PR #3 correction: notification diagnostics and read-only auth reconciliation

The original PR head `824a68274bd3bac5a4a7e99a1c8f0e956e569174` had one
`RUNTIME_UNCERTAINTY` branch in `TurnEvidence.receive`, reached by exactly four
notification categories:

| Incoming method | New sanitized category | Original behavior |
| --- | --- | --- |
| `error` | `runtime_error` | Unconditionally stop |
| `account/updated` | `account_updated` | Unconditionally stop, even before initial account qualification |
| Any `hook/` prefix | `hook_activity` | Unconditionally stop |
| Any `mcpServer/` prefix | `mcp_activity` | Unconditionally stop |

The original callback recorded only the shared blocker; `AppServerRpc` then failed
the transport and pending requests. The supplied statuses place the failure around
boundary completion/initial account qualification, before the model catalog, claim,
thread or turn paths. Asynchronous notifications can share a transport chunk with a
request response; completed flags cannot identify the precise notification or RPC.
`account/updated` during `account/read` is a **hypothesis**, not an observed cause.
The historical blocker remains unresolved; new diagnostics cannot reconstruct its
lost event history. Errors/hooks/MCP remain unconditional failures. Post-reconciliation
account notifications also retain `RUNTIME_UNCERTAINTY`.

`notificationDiagnostics` contains at most 32 entries, each containing a
fixed recognized category and controller execution phase. MCP entries now also have
the fixed, payload-free classification described in the next correction section.
Unknown method names map
to `unsupported_notification`; names and payloads are never copied into diagnostics.
No account values, IDs, tokens, event payloads, raw errors or timestamps are retained
there. Overflow fails closed instead of discarding evidence. Additional categories
cover configuration warnings, remote-control status and prohibited diagnostic-mode
model activity. The phase labels are initialization, configuration, boundary,
authentication, model selection, thread creation, pre-inference, inference,
post-inference, completion and shutdown (underscore-separated identifiers in JSON).

Pre-inference `account/updated` is **not ignored**. Its only acceptance rule is:

1. Reconciliation must be enabled, still unqualified, and in initialization,
   configuration, boundary or authentication. The unauthenticated preflight keeps
   its strict rejection behavior.
2. Exactly the pinned schema's `authMode` and `planType` fields are required, with
   managed `chatgpt` auth and an existing supported subscription-plan value. Null,
   other auth modes, unknown fields, free/unknown plans and more than eight updates
   fail closed. Only a non-published in-memory projection hash is retained.
3. Two consecutive `account/read` requests with `refreshToken: false` must produce
   identical validated account bindings. Fresh-login/file identity checks bracket
   the reads; effective configuration/layers/requirements are checked again. Every
   pending notification's mode/plan must match the final snapshot. Read failure,
   transport loss, file mutation or disagreement prevents qualification; there is
   no reconciliation retry loop.
4. Reconciliation locks before model selection or any inference claim. **Every**
   subsequent account update, including an apparently identical mode/plan, fails
   closed through inference, completion and shutdown. Such notifications do not
   carry enough identity information to prove an active account stayed unchanged.
   A late blocker revokes reported qualification rather than leaving VERIFIED flags.

This establishes only a consistent current local snapshot, not historical account
continuity, service-side token validity, subscription billing attribution or a
completed inference. The [official app-server auth interface](https://learn.chatgpt.com/docs/app-server)
documents optional refresh and account-update notifications; it does not establish
which event occurred in the failed operator attempt.

#### Operator-only read-only diagnostic

Historical interface, **not authorized for the currently claimed root**:

```bash
node feasibility/local-codex/authenticated-acceptance.mjs diagnose-auth "$pab_auth_root"
```

The earlier request permitted inspecting the existing root; the latest request
revokes that access. Do not run this command on it. The mode's restrictions are
preserved, not relaxed to bypass startup failure. It never calls `model/list`, `thread/start`,
`turn/start`, `command/exec`, login, logout, token refresh or any mutation RPC. It
does not open the acceptance ledger or create/reset a claim, and prints only the
sanitized report without writing a result file into the root.

A separate disposable launcher places the existing root, including auth and claim
files, behind a kernel-enforced read-only boundary and disables **all** app-server
networking. No auth file is copied, symlinked, chmodded or rewritten. A separate
empty private control home and scratch hold launcher/runtime bookkeeping and are
removed on exit. Explicit `TMPDIR` and
[`CODEX_SQLITE_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables)
direct temporary/SQLite runtime bookkeeping to that scratch; no inherited override
is accepted. Original app-server configuration and model-tool policy pins remain
unchanged. Before/after private auth-file digests must match and are never printed.
Missing kernel support or inability to start without writes/network is a blocker,
not permission to make the root writable, refresh auth, or retry inference.

The diagnostic's `standaloneBoundary` remains UNVERIFIED: it deliberately does not
repeat the acceptance `command/exec`. Its protective outer sandbox is not model-tool
equivalence. Even a successful local auth reconciliation leaves inference,
subscription usage attribution, live API-key fallback exclusion and model command
evidence UNVERIFIED. It never authorizes the next sandbox stage. Share only the
sanitized JSON result; no raw logs, account responses, device codes or credentials.

**Additional observed blocker:** strict read-only app-server startup is not proven
on this pinned runtime. A newly created synthetic fixture reproduced
`APP_SERVER_DISCONNECTED` in `initialization`, before any notification or account
response, while preserving every original file and an existing synthetic claim.
The same result occurred after initializing that fixture with the unauthenticated
preflight and supplying a synthetic installation ID. Separate credential-free
syscall checks observed denied startup writes beneath `codex/tmp/arg0` and
`codex/installation_id`. Redirecting SQLite bookkeeping removed an earlier
read-only SQLite prerequisite but did not establish successful initialization.
Those are synthetic startup findings, **not evidence about the operator's original
`RUNTIME_UNCERTAINTY`**. The mode remains implemented, but may stop at this earlier
boundary and produce no notification categories; it is not currently authorized
against the claimed root.
An empty diagnostic list means no captured notifications, not absence of a problem.

Do not make the private root writable to bypass that blocker. A supported way to
inspect app-server authentication without its startup writes remains necessary if
the operator reproduces this result. Current code proves the reconciliation rule
only with synthetic RPCs and proves fail-closed read-only protection with real
kernel checks; it does **not** prove successful live read-only authentication
inspection. `blockerPhase` supplies the fixed controller phase for failures without
a captured notification. Unknown raw exceptions are collapsed to
`ACCEPTANCE_UNCERTAIN`, never exposed as error text.

#### Correction validation record

- Focused command: **55/55 passed**, zero failures/skips (~9 seconds).
- `npm test`: **181/181 passed**, zero failures/skips (~96 seconds).
- `git diff --check`: passed.
- Thirteen added regression tests cover bounded payload-free diagnostics, stable
  pre-qualification reconciliation, rejected mode/plan/account/file changes,
  post-qualification invalidation, hooks/MCP/errors, unknown raw-error suppression,
  notification flooding, transport/read uncertainty, diagnostic RPC restrictions,
  real read-only/network enforcement and the pinned runtime's fail-closed startup.
- The real diagnostic CLI test is a **negative compatibility result**, not a
  successful authentication check. Its fixture is generated entirely by the test;
  all file contents, names and modes, including its uncertain claim, remain unchanged.
- No real model turns, metered sessions, paid live tests or operator-private-root
  inspection were performed for this correction. Only the three authorized PR
  files change. Authenticated acceptance still requires independent evidence review;
  no further sandbox stage, migration, deployment or merge is authorized.

### PR #3 MCP investigation: pinned protocol, not a telemetry allowance

This correction starts at `fc311b60a7a389db884fc58ddc2c3822bad05b3c` and retains
Codex 0.157.1 and its existing executable checksum. No production configuration,
authentication, dependencies, daemon or backend changes. Only the three authorized
feasibility files change. The existing claimed operator root was never accessed.

#### Established notification semantics

The pinned runtime's generated `ServerNotification.ts` and v2 payload schemas
contain exactly three `mcpServer/` notification methods:

| Exact method | Established meaning | Zero-server policy |
| --- | --- | --- |
| `mcpServer/startupStatus/updated` | A named server's lifecycle: `starting`, `ready`, `failed`, `cancelled`; thread ID or null app scope; error and failure-reason fields | Reject every state. Not a global empty-startup completion, not proof of a tool invocation |
| `mcpServer/oauthLogin/completed` | A named server's OAuth completion, scoped to an app or thread | Reject; no MCP OAuth operation was authorized |
| `mcpServer/event/stream/notification` | Notification on a subscribed server event stream, with subscription identity and nested method/params | Reject; no stream subscription was authorized |

The [app-server reference](https://learn.chatgpt.com/docs/app-server) documents these
distinct operations. Model tool use is separately represented by `mcpToolCall`
items and `item/mcpToolCall/progress`; those are now classified as tool activity
and rejected too. An unknown method is not promoted to a known lifecycle event.
No pinned v2 method establishes a benign, identity-free “zero servers started”
notification. The legacy raw `mcp_startup_complete` event is not one of these
methods and supplies no authorization to ignore this family.

The new MCP diagnostic projection records only fixed method-category, semantics,
schema-recognition, scope/binding, identity-presence/authorization and startup-state
enums/booleans, plus the existing phase/category. It retains no names, URLs, IDs,
error text, nested methods, credentials, payloads or hashes of private names.
“Recognized” means the checked shape, **not trust or permission**. The allowed
server/subscription/tool identity set is empty; authorization is always false.
App-scoped, matching-thread, cross-thread and not-yet-bound events all reject.
Duplicate/out-of-order/terminal events cannot clear the first failure. This is
diagnostic refinement and additional checks, **not a correction that permits the
reported event**; its precise semantics/source remain unknown.

#### Effective configuration and source prevention

An empty `config.toml` MCP table alone does not prove zero runtime servers. Layers,
managed policy, plugins/apps and the live inventory must also be considered.
Existing CLI pins, empty plugin configuration, disabled apps/remote-plugin features,
owned-layer validation and repeated file/configuration checks remain unchanged.
No guessed server name or unverified feature flag has been added.

The pinned `mcpServerStatus/list` accepts app-wide or thread-scoped requests and
returns server records, runtime state, tools/resources and pagination. Empty tools
alone are insufficient: a server may be starting, disabled, failed or have discovery
errors. Acceptance now demands exactly `{data: [], nextCursor: null}` for a full
app inventory before creating a claim/thread, then the bound thread before and after
inference. Any record (even disabled), malformed/missing response, further page,
transport failure or notification blocks without retries. Diagnostic/preflight modes
do not acquire these extra RPCs. Reports contain at most three fixed empty-inventory
snapshots, not server records. `zeroActiveMcpServers` deliberately stays UNVERIFIED:
these are point-in-time runtime observations, not process-tree confinement or proof
that a server cannot start between checks. Inventory checks can detect a violation;
they do not prevent a subprocess that already started.

The [managed-configuration interface](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
documents an empty **requirements.toml** MCP allowlist as disabling all servers;
that is different from an empty ordinary configuration table. Its documented local
Linux location is `/etc/codex/requirements.toml`, not a dedicated `CODEX_HOME` file.
The pinned requirements RPC schema does not expose that allowlist for this harness
to attest. We did not alter host policy or invent a disposable requirements override.
A supported, isolated and attestable deny-all source policy remained unestablished
at that revision; the follow-up below establishes it for configured stdio sources,
not universal startup prevention. Explicit `enabled=false` with a complete
synthetic transport definition prevented that fixture from starting; it is not an
allowance to accept unexpected configured/disabled servers in this harness.

#### Reproducible offline runtime evidence

The added tests create only new disposable homes, verify the executable hash,
remove inherited environment, disable networking for the **entire app-server and
its descendants** using an outer kernel sandbox, and allow writes only to synthetic
state. A separate outer profile avoids conflating this experiment with the unchanged
read-only diagnostic. The real RPC allowlist excludes `turn/start`, tool invocation,
login, refresh, config mutation and stream/OAuth operations. `model/list` reads the
bundled catalog; `thread/start` creates an ephemeral thread without a model turn.
Synthetic cached auth uses deliberately non-service-valid fixture strings, never
copied operator credentials; it proves no live authentication or entitlement.

| Synthetic fixture | Effective MCP entries | Observed notifications | Process marker / inventory tools |
| --- | --- | --- | --- |
| Empty configuration, no auth | 0 | None | Empty app/thread inventories |
| Empty configuration, synthetic cached ChatGPT identity | 0 | None | Empty app/thread inventories |
| User-file server with CLI empty table (corrected rerun) | 1 | `starting`, `ready` | Fixture process starts; one server/tool entry; earlier contrary result withdrawn |
| Explicitly enabled stdio fixture | 1 | Thread-bound `starting`, then `ready`, before inference | Fixture process starts; inventory exposes one synthetic tool |
| Same fixture explicitly disabled | 1 | None | No process marker; one disabled record, zero tools |

The enabled fixture waits for both startup notifications **before** calling status
list, demonstrating that `thread/start` itself initiates this startup. The fixture
records process execution, implements MCP initialization/tool discovery locally,
and never submits a model turn. This proves that pre-inference lifecycle telemetry
can accompany real server process startup and tool exposure. It does **not** prove
which of the three methods occurred in the operator attempt. The earlier conclusion
that CLI `{}` cleared the user-file table was invalid: the outer sandbox filtered
the child environment and the test had not bound the actual Codex home. The follow-up
restores only the explicit disposable environment and asserts the initialization
home. The user-file server now survives the empty-table override. The earlier
synthetic-cached-auth result also did not establish use of the intended home; that
case has been rerun with the home binding. Neither a short event-free window nor
synthetic cached auth establishes absence of authenticated/cloud/plugin sources.

Reproduce all checks without authenticating:

```bash
node --test test/local-codex-feasibility.test.mjs test/local-codex-authenticated.test.mjs
npm test
git diff --check
```

The validation host needs the previously documented Node compatibility library and
kernel namespace permissions. Tests do not weaken a boundary or skip on failure.
Historical validation at `255aabe`, before correcting the test-home binding:
the focused suite passed **69/69** (~19 seconds); `npm test` passed **195/195**
(~108 seconds), both with zero failures/skips. `git diff --check` passed.
Negative cases cover unexpected startup,
duplicates/order, cross-thread/unbound identities, malformed payloads, OAuth/stream/
tool activity, changed config/inventory, missing/paginated evidence and transport loss;
existing auth, hooks/errors, uncertainty, claim and read-only tests remain in place.

**Disposition:** zero configured/listed servers is demonstrated only for controlled
synthetic snapshots, and prevention only for the known fixture sources. Zero active
MCP servers for the operator's authenticated execution is UNVERIFIED. The conservative
diagnostic/inventory correction preserves isolation but does not resolve the runtime
blocker. A fresh authenticated **inference acceptance attempt is not justified yet**.
Before separately authorizing a new disposable no-inference investigation, establish
a supported way to identify/deny every effective server source without exposing
private identities or relaxing app-server isolation. Never reuse the claimed root.
Authentication, inference, subscription attribution and live API-key fallback
exclusion remain UNVERIFIED. Independent acceptance evidence review is still required;
the next sandbox stage and full migration remain BLOCKED.

### Isolated managed-requirements experiment

Starting head: `255aabec09b915d4cd8b4682d5baa982a8c5c3c5`. This bounded follow-up
changes only this document and `test/local-codex-authenticated.test.mjs`: seven
managed-policy controls, reuse of the existing stdio fixture, and correction of the
test launcher's disposable-home binding. No acceptance-harness or production edits.

**Result: supported and enforced for the tested configured MCP sources; NO-GO for
authenticated acceptance at present.** The pinned 0.157.1 runtime honors a private
`/etc/codex/requirements.toml` supplied by standard Linux mount isolation. Denial is
observed before fixture process startup, not inferred merely from parsing a file,
an empty inventory or blocked networking. No universal MCP/plugin guarantee follows.

#### Supported mechanism and isolation

The [managed-configuration documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
specifies a Unix requirements file, an empty MCP allowlist, and managed apps/plugins
feature restrictions. The tested file is:

```toml
mcp_servers = {}
[features]
apps = false
plugins = false
```

The test controller creates an owner-private temporary policy directory **outside**
the app-server's writable fixture root. `unshare --user --map-root-user --mount
--net --propagation private` creates child-only namespaces. Only there, standard
`mount --bind` overlays the synthetic directory on `/etc`, then remounts it read-only.
No host `/etc/codex` path is created, written, copied or inspected. No Docker daemon,
container image, package installation, unsupported Codex flag or shared daemon is
needed. The ordinary documented requirements path is what Codex reads.

Inside that namespace, the original `pab_mcp_offline` kernel sandbox is retained:
`:minimal` and the exact pinned executable are readable; writes are limited to the
synthetic root; network is disabled. The model-tool `pab_auth_readonly` profile is
unchanged. No extra filesystem grant is added for `/etc` or the backing policy path.
Before app-server startup, in-sandbox checks require distinct mount/network namespace
IDs, expected policy-file presence, denied policy truncation/creation through both
namespace and backing paths, a rejected writable remount, and kernel-denied loopback
connection. Parent namespace IDs must remain unchanged. Any failure aborts startup
and fails the test, without skips or a fallback to a weaker boundary.

The sandbox's configured shell-environment filtering previously removed the intended
child `CODEX_HOME`. The test helper now executes `/usr/bin/env -i` with only the
existing explicit disposable environment **inside** the unchanged sandbox, and
checks `initialize.codexHome`. It neither inherits nor copies authentication or
operator configuration. This corrects the test control, not the production launcher.
The managed-policy cases use no auth files, account/login RPCs or model turns.

#### Enforcement evidence, including override attempts

Each source has a matched no-policy positive control and managed-denial control.
The project is a newly created, explicitly trusted fixture; the host's trust settings
are untouched. Each attempts `enabled=true` for the same stdio server and
`apps=true`, `plugins=true`. User/project cases omit the corresponding CLI pins so
that those layers are actually exercised. CLI cases supply explicit true overrides.
Tests require the intended non-disabled layer and server entry in `config/read`.

| Policy / configured source | Fixture process | Runtime inventory | Effective apps / plugins |
| --- | --- | --- | --- |
| No requirements / user | Starts | Connected, one tool | true / true |
| No requirements / trusted project | Starts | Connected, one tool | true / true |
| No requirements / CLI | Starts | Connected, one tool | true / true |
| Deny-all + feature pins / user | Does not start | Disabled, zero tools | false / false |
| Deny-all + feature pins / trusted project | Does not start | Disabled, zero tools | false / false |
| Deny-all + feature pins / CLI | Does not start | Disabled, zero tools | false / false |
| MCP deny-all only / CLI | Does not start | Disabled, zero tools | true / true |

All cases retain `config/read`'s `enabled=true` server declaration. Runtime inventory
instead reports `disabled` under requirements: configuration alone is not an
effective-policy attestation. `configRequirements/read` returns the feature pins;
the thread-scoped `experimentalFeature/list` independently reports both features
off despite each override. The MCP-only case isolates the empty MCP allowlist's
effect from disabling plugins/apps. Positive controls execute the fixture's process
marker and expose its one tool; denial controls have neither the marker nor tools,
nor startup notifications. Full inventory pagination and live transport are checked.
The direct negative controls can still start in the network-disabled sandbox, so
network denial is not the explanation for managed suppression.

**Separate configuration counterexample:** with the corrected home binding, ordinary
CLI `mcp_servers={}` retains a user-file server, which starts and exposes its tool.
An empty configuration table is not equivalent to the requirements deny-all rule.
This supersedes the earlier contrary PR result; it is not an explanation of the
operator's unidentified MCP event.

#### Coverage limits and remaining blockers

- **Configured stdio sources:** prevention demonstrated for user, trusted-project
  and CLI configuration, plus feature-pin precedence. This is source-level runtime
  enforcement for that fixture, not a complete process-tree security equivalence test.
- **Plugin/app gates:** both effective feature flags are constrained. The read-only
  local `plugin/list` metadata endpoint remains callable and returns an empty catalog
  with or without denial; it is not evidence of an execution bypass or universal
  plugin disablement. No installed plugin's MCP process or hook was exercised.
- **Other sources:** authenticated apps/connectors, remote/workspace/bundled plugins,
  plugin-bundled MCP, HTTP transports, cloud-policy merging, reload/resume and service
  startup paths remain UNVERIFIED. The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  documents a separate plugin-specific MCP allowlist; do not infer coverage of all
  plugin paths from top-level `mcp_servers={}`. No bypass of the tested deny-all rule
  was observed, but absence of these sources in an unauthenticated fixture is not
  negative execution evidence for them.
- **Acceptance integration:** the existing harness has not acquired this namespace
  launcher or policy-file attestation. Its requirements validator would reject the
  additional feature pins, and its inventory gate intentionally rejects even a
  disabled server record. Neither restriction is weakened here. Its read-only
  diagnostic startup limitation also remains unchanged.
- **Network/authentication:** these experiments disable all app-server networking;
  they do not establish a safe subscription-service route in a networked authenticated
  run. All live auth/inference/usage/fallback qualifications remain UNVERIFIED. The
  claimed operator roots are untouched and must not be reused.

The narrowly tested managed-policy mechanism is feasible; an authenticated attempt
is **not yet justified**. Independent review of the namespace design, actual coverage
of other server sources, and a separately authorized acceptance-integration design
are still required. No inference, next sandbox stage, migration, merge or deployment
is authorized. If the required source coverage or isolation cannot be established,
stop at NO-GO rather than adding notification allowances or compensating diagnostics.

#### Reproduction and validation

Use the unchanged checksum-pinned Codex binary, Node 24+, Python 3 and standard Linux
`unshare`/`mount`, on a host permitting unprivileged nested namespaces. The tests use
only generated disposable fixtures and remove their own state on exit:

```bash
node --test --test-name-pattern='private managed requirements|offline configured MCP' test/local-codex-authenticated.test.mjs
node --test test/local-codex-feasibility.test.mjs test/local-codex-authenticated.test.mjs
npm test
git diff --check
```

The ten targeted runtime controls passed. The requested focused suites passed
**76/76**, and `npm test` passed **202/202** (~124 seconds), with zero failures/skips.
`git diff --check` passed. No real model turns, metered
API sessions, API-key usage, login changes, paid live tests, operator-root access,
host configuration changes or changes to other repositories occurred.

### Managed launcher integration attempt: NO-GO

Starting head: `e687e670a48b8dc2f5782a80c5e8995824d5b156`. Only the authenticated
feasibility harness, its offline tests and this document change. The previous
managed-requirements section records the earlier experiment, not the current
launcher's qualification. No operator root was accessed or reused.

#### Implemented gates, not a qualified launcher

The candidate reuses exactly the earlier `requirements.toml` bytes and documented
`/etc/codex/requirements.toml` mechanism. The controller owns a separate private
temporary directory outside the app-server's writable root. It checks policy,
launcher and bootstrap bytes, root manifest, pinned runtime and parent namespace
identities; unexpected changes fail closed. This file attestation alone is **not**
evidence that Codex applied the policy.

Unlike the offline controls' empty `/etc`, the candidate creates a child-only mount
namespace and a private `/etc` mirror of read-only bind mounts of host entries,
excluding `codex`. It neither copies their contents nor modifies host mounts/files.
The private `codex` directory contains only the controller's requirements. The
model-parent sandbox retains host networking and minimal OS/runtime reads, with
writes only to the fresh fixture and read-only policy/bootstrap storage.
The existing model-command permission profile is unchanged: no network, private
home/auth directories denied, fixture read-only, scratch writable. Parent networking
is not a tool-network grant. No credential or environment inheritance is added.

Before any app-server initialization the candidate checks the effective namespace,
requirements digest, preservation of hosts/NSS/resolver/CA-bundle bytes, default CA
availability, localhost resolution, denied policy writes and rejected writable
remount. It repeats this bootstrap on each child launch. `verifyStartup()` first
attempts only `--version`; uncertainty prevents even creating `AppServerRpc`.
Only a sanitized fixed blocker is emitted; bootstrap stderr is never published.

If startup were to succeed, protocol gates would additionally require the exact
managed feature requirements, independently disabled apps/plugins from a complete
`experimentalFeature/list`, controller attestation and a fully empty server/tool
inventory. Rechecks bracket the retained synthetic inference protocol. Missing,
malformed, duplicate, paginated or enabled feature records and changed transport
fail closed. Feature order is immaterial; duplicate identities are not. Known null
requirements defaults remain normalized; arbitrary managed fields are not accepted.

The existing inventory validator still rejects **every** server record, including
`disabled` records. A configured-but-denied record proves the negative control's
suppression, not conformity to an acceptance home with no configured sources.
No MCP notification allowance was added. Configuration and notification identity
checks, independent account reconciliation and one-time claims remain intact.

#### Observed startup incompatibility

**Actual candidate result: `MANAGED_OS_FACILITIES_UNVERIFIED`, initialization phase,
zero threads/turns/claims, authentication and managed application UNVERIFIED.**
Fresh synthetic fixtures reproduce it without credentials. Controller file
attestation passes, but the sandbox-visible OS files do not all match the preserved
host view. Bounded characterization identified differences for `/etc/hosts` and
`/etc/nsswitch.conf`; explicit read grants did not establish byte preservation and
were not retained. No file contents, account information or raw errors are evidence
artifacts. The final test retains the strict comparison and expects the blocker.

This is an **attestation incompatibility**, not proof that DNS or TLS is intrinsically
broken in Codex. The failure occurs before the functional CA/localhost checks and
app-server startup. No external DNS lookup, TLS handshake, subscription-service
request or networked policy-application result was established. Secure coexistence
under this candidate is therefore UNVERIFIED, not demonstrated impossible for all
supported designs. We stopped rather than drop the check, broaden permissions or
invent an alternate launcher. The retained candidate is a reproducible negative
experiment, **not a safely qualified authenticated execution path**.

The diagnostic still cannot initialize the pinned app-server with its original
root read-only. Moving the new preflight into a user namespace exposed an old
warm-cache assumption in the synthetic diagnostic test: outer sandbox setup could
create UID-specific scratch files in the root. Its outer shell environment now
points only to the diagnostic's existing separate scratch directory. Root and
network permissions are unchanged, and the byte/mode snapshot test still requires
no changes to the synthetic auth root or uncertain claim. Its result remains
`APP_SERVER_DISCONNECTED`, not successful authentication. Do not use this diagnostic
on any claimed operator root.

#### Execution-source coverage and authorization

| Source or guarantee | Evidence / status |
| --- | --- |
| User, trusted-project and CLI stdio MCP configuration | VERIFIED only in the network-disabled controls: matched fixture startup/tool exposure without policy, no process marker/tools/events with denial; overrides fail |
| Managed apps/plugins feature pins | VERIFIED effective false in those controls despite true overrides; networked candidate application UNVERIFIED |
| Networked launcher startup, DNS/TLS preservation and managed application | UNVERIFIED; OS-file attestation blocks before initialization |
| Plugin-bundled MCP, installed hooks, bundled/remote/workspace plugins | UNVERIFIED; no installed execution fixture qualified |
| Authenticated apps/connectors, HTTP MCP, cloud policy merge, reload/resume | UNVERIFIED; empty unauthenticated inventory is not coverage |
| Authentication, inference, subscription usage attribution, live API-key exclusion | All UNVERIFIED; no authenticated execution performed |
| Complete model-tool sandbox/process/evidence equivalence | UNVERIFIED; unchanged standalone controls are insufficient |

The [managed policy documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration)
distinguishes plugin-bundled MCP identity policies under
`plugins.<plugin>.mcp_servers.<server>` and warns that bundled/workspace plugins are
separate from curated Git marketplace restrictions. The
[requirements reference](https://learn.chatgpt.com/docs/config-file/config-reference)
also describes a plugin allowlist. These rolling capabilities do not constitute
enforcement evidence for pinned 0.157.1. No untested plugin allowlist, marketplace
restriction or authenticated integration control was added. The original managed
feature pins are the only reused proven plugin/app controls; their flags are not
universal execution-source proof.

`login` fails `AUTHENTICATED_QUALIFICATION_NOT_AUTHORIZED`; `run` and every real
thread/turn RPC fail `INFERENCE_NOT_AUTHORIZED`. Both CLI entry-point guards run
before root access. Even a future successful unauthenticated startup/preflight
must stop at `EXECUTION_SOURCE_COVERAGE_UNVERIFIED`. There is no new authenticated
zero-inference mode: its startup/isolation prerequisites were not established.
No claim is created or reset by this experiment. Full mocked inference tests remain
offline regression tests, not permission to execute their protocol against a model.

**Fresh operator authentication/qualification is not justified. A subsequent single
inference cannot be authorized.** A reviewed, reproducibly safe DNS/TLS-compatible
namespace composition and negative execution evidence for the remaining sources
must precede any separately authorized fresh-home qualification. Billing attribution,
model-tool validation and independent acceptance review remain later gates. PAB is
not ready for migration; no merge, deployment or next sandbox stage is authorized.

#### Reproduction

Use the same pinned runtime, Node 24+, Python 3 and Linux namespace prerequisites
as the previous controls. These commands create only their own synthetic disposable
fixtures; the managed candidate test is explicitly a **negative** startup result.
They never submit real model turns or authenticate:

```bash
node --test --test-name-pattern='managed|diagnostic|preflight|effective feature|changed policy|CLI inference' test/local-codex-authenticated.test.mjs
node --test test/local-codex-feasibility.test.mjs test/local-codex-authenticated.test.mjs
npm test
git diff --check
```

Validation on the pinned host: **20/20** targeted checks (~25 seconds), **82/82**
focused tests (~46 seconds), **208/208** full offline tests (~132 seconds), no
failures/skips, and `git diff --check` passed. The initial focused run exposed the
diagnostic scratch regression described above; the final rerun preserves the full
snapshot assertion. Passing the candidate's negative test proves the blocker is
retained, not successful startup. There were zero real model turns, login flows,
API-key inference, Agents API calls, paid live tests or operator-root accesses.
Host configuration, production PAB, dependencies, shared daemons and other
repositories are unchanged.

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

**Historical future design only: the current managed-launcher NO-GO supersedes
these procedures. Do not run login or inference commands below.**

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
