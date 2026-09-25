#!/usr/bin/env python3
"""Operate this bridge's official managed tunnel without storing credential values."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path.home() / '.local/state/personal-agents-bridge'
BINARY = ROOT / 'tunnel-client/tunnel-client'
ALIAS = 'personal-agents-bridge'

def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ''
    if action not in ('connect', 'status', 'stop', 'doctor'):
        raise ValueError('Usage: python3 tunnel.py connect|status|stop|doctor')
    env = {k: v for k, v in os.environ.items() if k in (
        'PATH', 'HOME', 'USER', 'LANG', 'OPENAI_API_KEY', 'CODEX_API_KEY',
        'OPENAI_EXECUTOR_API_KEY')}
    env.update(XDG_CONFIG_HOME=str(ROOT / 'tunnel-config'),
               XDG_STATE_HOME=str(ROOT / 'tunnel-state'),
               HEALTH_LISTEN_ADDR='127.0.0.1:0',
               LOG_HTTP_RAW_UNSAFE='false', OPEN_WEB_UI='false')
    if action == 'connect':
        if not env.get('OPENAI_API_KEY'):
            raise ValueError('Existing OPENAI_API_KEY must be supplied in the process environment')
        config = json.loads((ROOT / 'personal-tunnel.json').read_text())
        tunnel_id = config['tunnel_id']
        # The MCP server also enforces live association checks on startup/every call.
        import re
        if not re.fullmatch(r'tunnel_[A-Za-z0-9_-]+', tunnel_id):
            raise ValueError('Invalid tunnel ID')
        command = f'/usr/bin/env BRIDGE_TUNNEL_ID={tunnel_id} {Path(__file__).resolve().parent}/run.sh'
        args = ['runtimes', '--json', 'connect', '--alias', ALIAS,
                '--tunnel-id', tunnel_id, '--profile', ALIAS,
                '--profile-dir', str(ROOT / 'tunnel-profiles'),
                '--runtime-api-key', 'env:OPENAI_API_KEY', '--mcp-command', command]
    elif action == 'doctor':
        args = ['doctor', '--json', '--explain', '--profile', ALIAS,
                '--profile-dir', str(ROOT / 'tunnel-profiles')]
    else:
        args = ['runtimes', '--json', action, ALIAS]
    result = subprocess.run([str(BINARY), *args], env=env, text=True,
                            capture_output=True, timeout=60)
    if result.returncode:
        print(json.dumps({'operation': action, 'ok': False, 'exit_code': result.returncode}))
        return result.returncode
    data = json.loads(result.stdout)
    if action == 'doctor':
        summary = {'operation': action, 'result': data.get('result'),
                   'checks': [{'id': c.get('id'), 'status': c.get('status')}
                              for c in data.get('checks', [])]}
    else:
        summary = {k: data[k] for k in ('alias', 'tunnel_id', 'launched',
                   'already_running', 'process_running', 'healthy', 'ready',
                   'stopped', 'already_stopped', 'health_url', 'error') if k in data}
    print(json.dumps(summary, indent=2))
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Tunnel operation failed; no credentials or raw subprocess output emitted.', file=sys.stderr)
        sys.exit(1)
