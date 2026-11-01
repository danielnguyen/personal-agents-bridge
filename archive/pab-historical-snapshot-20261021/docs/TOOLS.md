# MCP tools and contracts

## Tool list

- `start_task({contract, request_id, repository_id?, base_ref?})`: create a disposable
  repository, or a private task worktree for an allowlisted repository ID. `base_ref`
  defaults to `HEAD` and is resolved to an exact commit before execution. Returns
  immediately with stable task ID and state.
- `get_task({task_id})`: reconcile API session, pending actions, latest turn outcome
  and assistant output. Excludes reasoning. Includes session/turn/environment IDs,
  clarification status, review findings and expiry. No new model work is submitted.
- `continue_task({task_id, instruction, request_id})`: answer a pending
  `request_clarification` call with its original turn/call IDs, or submit a new
  instruction to the idle existing session. Conflicting active writes are rejected.
- `review_task({task_id, request_id})`: after a terminal implementer turn, stop
  its executor, snapshot evidence, and create a separate reviewer session. Return
  progress immediately; retrieve structured findings using `get_task`.
- `publish_task({task_id, title, body?, draft:true})`: freeze a completed repository
  task with an independent PASS and publish its exact reviewed Git tree as a draft
  PR. See the publication boundary below. No repository path or branch input exists.
- `cleanup_task({task_id, delete_workspace:false})`: stop/cancel task-owned
  executors and delete task-owned remote sessions, verify deletion with GET/404,
  and report partial failures. Retain workspace by default. `true` deletes it.
  The `cleanup` result includes aggregate `executor_stopped`,
  `remote_session_deleted`, `workspace_deletion_requested`, and `workspace_deleted`
  booleans alongside existing per-session details. `workspace_deleted` is true
  only after a filesystem check confirms absence. `workspace_id` (256 characters)
  and `workspace_path` (1024 characters) are bounded and redacted;
  `cleanup_diagnostic` is null or a bounded (512-character) list of failure codes.
  Failed or incomplete deletion is reported and can be retried. Task and audit
  records remain in the separate controller state directory.

An active review freezes implementation. After the reviewer finishes, an explicit
continue_task resumes the original implementer session and marks the earlier review
stale. A new review uses a fresh packet, runtime directory and reviewer session.
Cleanup includes earlier reviewer sessions. Nothing silently repairs or commits a
rejected candidate.

Contract shape:

```json
{
  "goal": "First run pwd and python3 -B --version. Ask which name to use via request_clarification before writing greeting.txt. Wait for the human answer.",
  "allowed_files": ["greeting.txt"],
  "requirements": [
    {"id": "R1", "text": "Write exactly Hello, <human-supplied name>! followed by a newline."}
  ],
  "invariants": [
    {"id": "I1", "text": "Do not change TASK.md or Git state; do not commit."}
  ],
  "initial_files": {},
  "test_commands": []
}
```

Requirement/invariant IDs must be unique. `SCOPE` and `TEST_EVIDENCE` are reserved
review findings. Paths must be relative, cannot contain `..`/`.git`, and cannot
replace the controller-generated `TASK.md`. Initial files may include read-only
baseline inputs. The Markdown task contract is generated from this structured
contract. Only the allowed paths may be changed by the implementer.

New tasks are limited to three uncleared tasks. Remote resources automatically
expire after 15 minutes; `continue_task` and `review_task` reset the deadline. The
returned `expires_at` makes this explicit. Files are retained. During controller
downtime expiration cannot run; on restart expired tasks are reconciled/cleaned.
For long human pauses, resume within the deadline or start another task.

Request IDs are unique per controller and bound to the operation payload hash.
Retries do not create new work. A network error after submission is marked uncertain;
use `get_task` rather than changing IDs to force a replay. Session creation uses
ownership metadata and bounded API reconciliation; ambiguous creation never causes
an automatic second create. Failed provisioning remains attached to the task for
cleanup. No message or reasoning archive is stored in SQLite.

On normal controller exit, executors stop and remote session IDs remain available
for restart/explicit cleanup. Executors also exit when their parent stdin closes.
Cleanup validates process identity (boot ID and start time), never just a reused PID.

## Review boundary

Review uses one frozen `evidence.json`, limited to 100 files and 128 KiB total.
It contains the original contract, baseline/current source, baseline/current Git
state, full tracked diff, changed-file list including untracked/ignored files, and
actual test command output retrieved from API command-execution items. It never
includes implementer messages, reasoning, or the controller's credentials.
Oversized and special-file evidence is rejected, not truncated. Disposable tasks
also reject binary and symlink evidence. Repository packets include binary byte
counts/hashes, symlink targets, file modes and a controller-generated Git tree SHA;
symlink targets are never followed. The reviewer must still fail requirements that
these bounded representations cannot establish.

The reviewer must produce a PASS/FAIL entry with concrete evidence for each
requirement/invariant plus SCOPE and TEST_EVIDENCE. Malformed, incomplete or
contradictory JSON is `needs_attention`, never an implicit PASS. The packet hash is
checked when returning findings. Passing tests do not override a negative review.
Human-discussion/procedural requirements may be FAIL when the bounded packet cannot
prove them; that is an evidence limitation, not a controller approval.

## Publication boundary

`publish_task` accepts only `task_id`, a nonblank `title` (maximum 200 characters,
no control characters), optional `body` (maximum 16,000 characters), and `draft`
(literal `true`, also the default). Unknown fields and `draft:false` are rejected.
It returns `task_id`, `reviewed_tree_sha`, `commit_sha`, `pushed_branch`,
`pr_number`, `pr_url`, `commit_tree_matches_reviewed_tree`, and `draft:true`.

The trusted controller requires completed implementation, a completed independent
PASS bound to the frozen packet, valid current registration, the original task
worktree, unchanged origin configuration, and unchanged worktree/index/Git metadata.
All changed paths must satisfy the contract. Legacy packets without the recorded
Git tree require a fresh independent review; a previous PASS is not retrofitted.

During review the controller uses a temporary Git index in the existing task
repository to capture the tree, excluding its own `TASK.md`. Publication stops
owned executors and durably freezes continuation/review, then creates a single
controller-authored commit from that exact tree and the task baseline parent.
The real index and local task HEAD remain unchanged. Git objects preserve deletes,
renames, symlinks, executable bits, binary content and multi-file changes. The
commit tree is checked against the reviewed tree before any push. Submodules are
currently rejected.

Only the fixed `bridge/task_<uuid>` branch can be pushed, and it cannot be the
registered repository's current default branch. Existing remote branches are
rejected; a controller-owned pre-push hook also requires a zero advertised old
object ID, protecting the check/push race. There is no force-push or merge path.
GitHub's API is used only for repository metadata and draft PR creation/recovery,
never to reconstruct repository files. Implementation command/RPC sandboxes remain
network-disabled; controller publication alone uses network access.

Publication phases, reviewer/packet identity, tree/commit equality, remote branch
and PR identifiers are persisted. Identical retries reconcile a previously
attempted push only when its remote commit matches the saved commit. An uncertain
PR creation is recovered by lookup, never blindly repeated. A partial failure
leaves the task frozen and any already-pushed branch intact; ambiguous outcomes
require operator reconciliation. Cleanup retains the audit record.

Production publication supports `github.com` origins and requires `/usr/bin/gh`
with controller-accessible GitHub authentication (existing gh login or
`GH_TOKEN`/`GITHUB_TOKEN`) authorized to push and create PRs. Credentials are not
passed to implementation agents. Commits use a fixed controller identity and are
unsigned; repository rules may reject them. Local tests use bare repositories and
a mocked PR service; live GitHub authentication/publication needs acceptance testing.


Tool calls can incur API costs or publish code. Only the trusted owner should have tunnel access.
