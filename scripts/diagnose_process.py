"""Compare Windows venv redirector and direct CPython process identity, without TCP."""
import json
import os
import subprocess
import sys


CHILD = """
import json, os, sys
import exit_link, pydantic
print(json.dumps({
    "pid": os.getpid(), "parent_pid": os.getppid(),
    "executable": sys.executable, "prefix": sys.prefix,
    "pydantic_version": pydantic.__version__, "exit_link_file": exit_link.__file__,
}))
"""


def observe(executable, env):
    process = subprocess.Popen([executable, "-c", CHILD], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                               encoding="utf-8")
    try:
        output, errors = process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError(errors)
    result = {"popen_pid": process.pid, "runtime": json.loads(output)}
    result["pid_matches"] = result["popen_pid"] == result["runtime"]["pid"]
    return result


def main():
    env = dict(os.environ, PYTHONUTF8="1")
    ordinary = observe(sys.executable, env)
    executable = sys.executable
    if sys.platform == "win32" and sys.prefix != sys.base_prefix:
        executable = sys._base_executable
        env["__PYVENV_LAUNCHER__"] = sys.executable
    direct = observe(executable, env)
    checks = {"direct_pid_matches": direct["pid_matches"],
              "direct_parent_matches": direct["runtime"]["parent_pid"] == os.getpid(),
              "venv_prefix_preserved": direct["runtime"]["prefix"] == sys.prefix,
              "venv_executable_preserved": direct["runtime"]["executable"] == sys.executable}
    print(json.dumps({"ordinary": ordinary, "direct": direct, "checks": checks}, ensure_ascii=False, indent=2))
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
