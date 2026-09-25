# Private Secure MCP Tunnel setup

This guide contains placeholders only. Keep actual account IDs, confirmation,
profiles and credentials outside the source checkout. Publishing the source is
separate from deploying an MCP service.

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
connects private MCP servers using outbound HTTPS. No inbound public listener is
needed. It supports private/developer-mode connections, not public plugin-store
submission. Follow the official guide for account permissions and current UI.

## Prerequisites and host preparation

1. Install the runtime prerequisites in [README.md](README.md) and run `npm test`.
   Confirm standalone Codex supports the required sandbox and exec-server commands.
   See the [self-hosted execution guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted).
2. In Platform tunnel settings, create a dedicated personal tunnel. This bridge
   supports only a sole authorized owner, not shared organization-wide access.
   Inspect both organization and ChatGPT workspace associations and membership.
3. Obtain the official tunnel-client binary from Platform settings or the release
   link in the official guide, verify its published checksum, and install it at
   `~/.local/state/personal-agents-bridge/tunnel-client/tunnel-client`. Keep the
   executable and any downloaded archive outside this repository.
4. Supply controller `OPENAI_API_KEY` and a distinct environment-connect credential
   as `OPENAI_EXECUTOR_API_KEY` (or `CODEX_API_KEY`) through the process environment.
   Do not use command-line credential values. See [.env.example](.env.example).

The [self-hosted guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted)
describes `codex exec-server` as the local execution component. This bridge adds
its own repository command/file-RPC sandbox; it does not place the networked API
transport inside the network-disabled command sandbox.

## Local owner confirmation

After actually verifying exclusive personal access, create the following JSON at
`~/.local/state/personal-agents-bridge/personal-tunnel.json`, with file mode `0600`
and an owner-only state directory. Replace placeholders locally. Do not copy the
result back into source control. Confirmation expires within 24 hours; renew only
after checking the actual associations again.

```json
{
  "tunnel_id": "<YOUR_TUNNEL_ID>",
  "platform_organization_id": "<YOUR_ORGANIZATION_ID>",
  "chatgpt_workspace_id": "<YOUR_WORKSPACE_ID>",
  "associated_organizations": ["<YOUR_ORGANIZATION_ID>"],
  "associated_workspaces": ["<YOUR_WORKSPACE_ID>"],
  "personal_only": true,
  "sole_authorized_user": true,
  "verification_method": "owner_checked_platform_settings",
  "verified_at": "<ACTUAL_UTC_VERIFICATION_TIME>",
  "expires_at": "<UTC_TIME_WITHIN_24_HOURS_OF_VERIFICATION>"
}
```

Startup and each tool call validate the file and fetch live tunnel metadata.
Missing/stale confirmation, unsafe permissions or additional/mismatched associations
fail closed. The owner assertion is not a substitute for checking membership, and
the bridge does not receive a verified individual ChatGPT user identity.

## Run the managed bridge

From the source directory, with credentials already supplied in the environment:

```bash
python3 -B tunnel.py connect
python3 -B tunnel.py status
python3 -B tunnel.py doctor
```

The helper configures the managed alias `personal-agents-bridge`, private profile
and state directories, and a stdio command targeting this checkout's absolute
`run.sh` path. It supplies `BRIDGE_TUNNEL_ID` from local confirmation. It stores an
environment-key reference rather than a key value and disables raw HTTP logging.
The helper currently uses `OPENAI_API_KEY` for tunnel runtime access as well as the
controller; that key must have the necessary tunnel-use permissions. The standalone
metadata lookup also supports `CONTROL_PLANE_API_KEY`, but the managed helper does
not forward that override. Consult `tunnel-client help quickstart` for CLI details.

Require `process_running`, `healthy` and `ready` before discovery. Connect the
verified tunnel from ChatGPT developer-mode plugin settings and inspect all six
MCP tools, including `publish_task`. Discovery should not start a task.
Use a disposable example repository for the first explicitly authorized execution.

Before restart, inspect owned sessions/turns and executor processes. Do not stop
active work unintentionally. When idle, use `python3 -B tunnel.py stop` followed by
`connect`, then verify health/readiness, tool discovery and preservation of retained
task records. Do not launch a second controller against the same SQLite store.

For controller publication, `/usr/bin/gh` must be authenticated to the intended
GitHub account with push and PR permissions. The managed tunnel helper does not
forward `GH_TOKEN`/`GITHUB_TOKEN`; an existing owner-controlled gh login is the
supported managed-launch setup. Never copy that login into a task workspace.
Because repository reads are broad, a dedicated host without unrelated credentials
is essential; see [SECURITY.md](SECURITY.md).
