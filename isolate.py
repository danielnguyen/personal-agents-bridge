"""Fail-closed Linux Landlock wrapper for a single task's executor/commands."""
import ctypes
import os
import sys

lib = ctypes.CDLL(None, use_errno=True)
class Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]
class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]
def checked(value):
    if value < 0:
        raise OSError(ctypes.get_errno(), 'filesystem isolation unavailable')
    return value

workspace, runtime, mode, binary, *args = sys.argv[1:]
# ABI 1 handles all thirteen original filesystem rights. No fallback to no sandbox.
rights = (1 << 13) - 1
read = 1 | 4 | 8
rules = Ruleset(rights)
fd = checked(lib.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
paths = [('/usr', read), ('/etc', read), ('/dev', read | 2),
         (os.path.realpath('/etc/resolv.conf'), 4), (binary, 1 | 4),
         (workspace, rights if mode == 'implementer' else read), (runtime, rights)]
# Only the task-private Git store is readable; it is never writable by the executor.
git_read_root = os.environ.pop('BRIDGE_GIT_READ_ROOT', '')
if git_read_root:
    paths.append((git_read_root, read))
for path, access in paths:
    parent = os.open(os.path.realpath(path), os.O_PATH | os.O_CLOEXEC)
    rule = PathRule(access, parent)
    checked(lib.syscall(445, fd, 1, ctypes.byref(rule), 0))
    os.close(parent)
checked(lib.prctl(38, 1, 0, 0, 0))
checked(lib.syscall(446, fd, 0))
os.close(fd)
os.chdir(workspace)
os.execve(binary, [binary, *args], dict(os.environ))
