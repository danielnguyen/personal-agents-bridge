# Security model

This is a single-owner demonstration, not an audited multi-tenant service. Treat
the OS, local operator, bridge/controller code and state, Codex runtime and tunnel
client as trusted. Do not expose it to shared users or untrusted MCP callers.
Every accepted caller can operate the owner's tasks. There is no per-user OAuth,
per-task authorization, or proof of human intent supplied by the tunnel.

## Enforced repository-task boundaries

- Repository targets are a local allowlist of canonical Git identities; callers
  cannot submit arbitrary paths. The bridge source cannot target itself.
- Implementation runs in a task-private worktree/store. The normal checkout and
  registered backing repository are not writable from command/file RPC sandboxes.
- Command and file-write RPC paths use a controller-pinned Codex permission profile.
  Writes are limited to the worktree and scratch, with protected Git metadata,
  contract and local Codex configuration. Reviewers can write only scratch.
- Command/file-worker network access is disabled, including loopback and Unix
  connections. The separate API transport remains networked. Startup probes and
  RPC initialization must pass before implementation input is submitted.
- Agents cannot push or merge. Only `publish_task` in the trusted controller can
  publish an unchanged, independently PASS-reviewed tree, as a draft PR on the
  fixed task branch. It never force-pushes, pushes the default branch or merges.
- Unsupported RPCs and missing/conflicting sandbox attestation fail closed.

These guarantees depend on a compatible Linux kernel/Codex runtime. Run the local
boundary tests after upgrades. No sandbox protects against every kernel exploit.
Tasks without a repository ID use a legacy Landlock path and do not inherit the
repository command-network guarantee; they cannot invoke publication.

## Confidentiality limits

Repository-task reads are intentionally broad. Disabling command networking does
not prevent file contents reaching the model through the authorized API transport.
Do not put unrelated private files or secrets on this executor host/account. An
empty agent environment is not proof that credential files elsewhere are unreadable.
Independent review has separate session state, but its repository-mode filesystem
reads are broad too. Neither redaction nor a PASS verdict is a confidentiality or
security audit. Source comments and task inputs may contain prompt injection.

Controller credentials must not be supplied to agent commands or task contracts.
Keep tunnel profiles, local registry, gh authentication, SQLite databases/WALs,
audit records, evidence packets, task workspaces and logs private. Bounded records
can still expose paths, account/session IDs, source content and operational history.
Known credentials and common patterns are redacted, but unknown secrets may escape
pattern matching. Do not publish raw diagnostics or investigation bundles.

Use scoped credentials and spending limits. Revoke/rotate an exposed credential
before addressing Git history. Removing a file in a later commit does not remove
its earlier contents. `.gitignore` also does not protect tracked files or history.

## Public-source preparation

Include only source, tests, documentation, lockfile and empty/example configuration.
Review `git ls-files` and `git ls-files --others --exclude-standard`, scan both
current content and historical objects, and inspect the exact publication file
list before committing. Never copy the private `.git` directory into a public
snapshot: old history can retain account identifiers even after working-tree cleanup.
The initial private history requires separate sanitization or a fresh public history
before publication. No automated history rewrite is part of the application.

## Reporting concerns

Do not put credentials, private source, task evidence or live IDs in public issues.
If the eventual GitHub repository enables private vulnerability reporting, use its
Security tab. Otherwise request a private contact channel from the maintainer using
only a non-sensitive description. No dedicated security inbox or response SLA is
currently configured. The project is licensed under [Apache-2.0](LICENSE).
