# Architecture and trust boundaries

```mermaid
flowchart TD
    Human[Human in ChatGPT] --> Tunnel[Secure MCP Tunnel]
    Tunnel --> MCP[MCP server and trusted controller]
    MCP --> API[Agents API sessions]
    API <--> Transport[Networked Codex exec-server forwarder]
    Transport --> Dispatch[Controller RPC dispatcher]
    Dispatch --> Commands[Network-disabled command sandbox]
    Dispatch --> Files[Sandboxed file-RPC worker]
    Commands --> Worktree[Task worktree and scratch]
    Files --> Worktree
    MCP --> Packet[Frozen evidence and Git tree]
    Packet --> Review[Separate independent review session]
    Review --> Gate[Completed PASS and unchanged-tree gate]
    Gate --> Publish[Trusted controller commit and push]
    Publish --> PR[Draft PR]
    PR --> Merge[Human merge decision]
```

## Trusted control plane

`server.mjs` defines six strict-purpose MCP tools; `controller.mjs` owns task
lifecycle, sessions, locks, durable records, expiry and review. The server has no
public HTTP listener. `tunnel.py` operates the official outbound tunnel client.
This demonstration assumes a sole authorized owner. Tunnel association checks do
not supply per-user OAuth or multi-tenant authorization.

The host OS, local operator, bridge source/state, Codex binary, controller publisher
and tunnel process are trusted. A local operator can change the program or state;
this is not a defense against a malicious host administrator.

## Repository isolation

`repositories.mjs` resolves operator-registered logical IDs, validates canonical
path and directory/Git identities, and rejects the bridge source and overlapping
state/workspace paths. Callers never supply arbitrary repository paths. A pinned
commit is fetched into a task-private Git store with no shared writable objects or
copied source hooks/configuration. A unique branch and worktree are created there.
The ordinary checkout, its dirty files, and its Git administration are not copied
as implementation inputs or modified. Registration does not relax contract scope.

## Execution and information flow

The Agents API handles the model loop; the self-hosted Codex executor handles local
execution. The outer transport needs network access. Repository commands and file
mutations are dispatched through a different, kernel-enforced boundary, described
below. That distinction is delivered as controller-generated startup attestation.
A label such as `danger-full-access` on the outer transport is not the effective
command policy. Missing enforcement evidence stops implementation.

Broad filesystem reads are allowed for repository tasks. The sandbox confines
writes and command networking; it is **not a confidentiality boundary**. Files
read by the agent may enter model context through the networked transport. Use a
dedicated VM/account without unrelated secrets. Reviewer instructions restrict it
to the packet, but repository-mode read access is not a kernel-level packet-only
restriction. Reviewers have scratch writes only.

Disposable tasks without a repository ID retain the older `isolate.py` Landlock
path. Do not claim repository command-network enforcement for that mode. Neither
mode grants an agent a publishing tool or authority to merge.

## Review, publication and retention

The independent reviewer uses a distinct session, a frozen bounded packet, and
requirement-level findings. Controller observations are separated from API command
records and implementer claims. PASS is necessary but not proof of correctness or
absence of vulnerabilities. No missing finding is automatically upgraded to PASS.

`publication.mjs` is called only by the trusted controller. It verifies the review
packet and exact current worktree state, stops owned executors, permanently freezes
the task, and creates a commit from the reviewed tree using Git objects. No files
are reconstructed through GitHub contents APIs. The commit tree must equal the
reviewed tree before pushing the fixed task branch. An existing unexpected branch
is rejected, including a race caught by the controller's pre-push hook. There is no
force-push, default-branch push or merge operation. The human decides whether to
merge the draft PR. Partial publication is audited and retries reconcile exact
saved identities rather than blindly replaying writes.

SQLite stores task/session ownership, bounded diagnostics, invocation correlation
and publication evidence. Evidence and worktrees live outside the source checkout.
Cleanup can remove the worktree while retaining the bounded task/audit record.
Runtime data is private operational material, even when credential values have
been redacted. It must never be committed to the public source repository.

## Detailed repository evidence and sandbox implementation

### Repository review evidence (version 3)

Before repository task execution, the controller records registry validation and
origin, a normal-checkout snapshot, and the task-private Git state. Review captures
these observations again. Clean and dirty checkouts are compared as they actually
were; neither a clean checkout nor unchanged status alone is assumed sufficient.
Snapshots hash file bytes, paths, modes and change timestamps (including ignored
and untracked files), plus HEAD, index, refs, Git configuration, and Git administration
including reflogs. Git objects are excluded from metadata traversal. Each traversal
is limited to 20,000 entries, 256 MiB and ten seconds; incomplete, unstable or
unreadable snapshots are explicitly unavailable, never evidence of equality.

The packet separates controller observations from bounded Agents API
`command_execution` records. It includes the registered path/identity/origin,
canonical task worktree, private-store mapping and `worktree list --porcelain`,
baseline/HEAD, before/after comparisons, and file byte counts and SHA-256 hashes.
Small nonsensitive files also include complete hexadecimal bytes. All command
records are considered, including commands unrelated to contract test commands;
only bounded fields are retained (100 records / 32 KiB, a 500-item scan ceiling).
Truncation, omitted records and API retrieval failures are explicit. Reasoning and
implementer assertions are not used as controller evidence. The entire redacted
packet remains capped at 128 KiB.

These are observations, not automatic review verdicts. Metadata changes remain
conflicts even if HEAD is unchanged. Local state cannot independently establish
that no remote push occurred. New repository tasks additionally retain the enforced
command/file-RPC sandbox policy and successful startup probes. Only tasks covered
from their first executor receive complete enforcement evidence; resuming a legacy
task does not retroactively establish sandbox coverage. Missing pre-execution snapshots on older tasks cannot be reconstructed
retroactively. Review requirements remain unchanged, and absent/conflicting evidence
must not be silently converted into PASS. Review does not require modifying the implementation worktree.


### Repository command sandbox

`LocalExecutor.start` selects `repository-sandbox.mjs` for repository implementers
and reviewers (including reconnects). Disposable tasks keep the existing
`isolate.py` path. The repository supervisor uses Codex's built-in
`exec-server forward` for networked Agents API transport. A task-private loopback
WebSocket adapter dispatches only explicitly supported RPCs:

- `process/start` launches `codex sandbox -P bridge_task -C <worktree> -- ...`.
  The controller pins the complete permissions table at CLI precedence using a
  controller-owned config. Caller environment variables are applied inside the
  sandbox, never to its launcher. Launch-time shell snapshots, managed-network
  options and other caller-selected sandbox settings are not relayed.
- File RPCs go to a separate stdio exec-server running inside the same sandbox.
  Writes, removes, copies and streaming reads therefore have kernel enforcement.
  Unrecognized RPCs, HTTP proxy requests and configuration/capability discovery
  fail closed. The adapter advertises these unsupported capabilities as disabled.
- Reads are allowed broadly. Writes are limited to the implementer worktree and
  a fresh task-local scratch home/temp directory. The worktree's `.git`, `TASK.md`
  and `.codex` remain read-only. Reviewers receive scratch writes only. The normal
  checkout, private Git store, bridge source/state and trusted config are not
  writable. Agent commands and the file worker receive no API credentials.
- The profile disables command/file-worker networking, including TCP, UDP and
  Unix-socket connections. The transport forwarder remains outside that sandbox.
  No command or file RPC runs through the old Landlock wrapper.

Before connecting the forwarder, startup must prove scratch writes, outside
creation/truncation denial and INET/INET6/Unix connection denial, and initialize
both RPC workers. Failure prevents implementation input submission. Each recorded
attestation contains the policy, profile/config hash, dispatcher and Codex binary
hashes, successful probes and coverage since the first executor. This evidence
never turns a missing or conflicting reviewer finding into PASS.

Requires the installed standalone Codex with `sandbox -P` and `exec-server forward`
and its bundled bubblewrap on a Linux host permitting the required namespaces.
Host namespace permissions and the required Codex runtime must already be available. `ws` supplies the
local WebSocket transport. Local kernel/RPC regression tests require namespace
creation and local test listeners; they fail rather than skip if unavailable.
The adapter deliberately stops on a transport disconnect instead of reusing an
ambiguous RPC/process session. Explicit task continuation can create a fresh
supervisor. No live Agents API compatibility run is part of these local tests.

Repository implementers receive a bounded `controller_repository_sandbox` JSON
attestation in the initial input, after executor readiness and before implementation
submission. It includes task/repository identity, pinned baseline, worktree mapping,
effective profile/hash, successful probes, disabled command networking, writable
roots/read-only exceptions, and command/file-write RPC coverage. Future explicitly
authorized continuations refresh that metadata, including clarification responses.
The controller rejects missing, failed, incomplete or conflicting evidence with
`REPOSITORY_SANDBOX_ATTESTATION_UNAVAILABLE` before submitting implementation input.

The outer harness may display `danger-full-access`, and the dispatcher's own
process result may report `sandboxType=none`: neither describes the nested bridge
command/file-RPC policy. The attestation explains both layers without changing the
outer mode, asking the agent to ignore a discrepancy, or relaxing the task contract.
It is generated from controller startup evidence, not a contract or implementer
assertion. Repository-agent instructions require this evidence and require stopping
on missing/conflicting evidence. No attestation file is added to the worktree.
