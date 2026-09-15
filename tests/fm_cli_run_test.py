"""Tests for bin/fm-cli-run: executable identity, closed environments, and the
setup lock. Run with: python3 -I -B -m unittest discover -s tests -p '*_test.py'
"""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNNER = os.path.join(ROOT, "bin", "fm-cli-run")
HARNESS = os.path.join(ROOT, "tests", "support", "runner-harness.py")
PYTHON = "/usr/bin/python3"


def load_runner():
    loader = importlib.machinery.SourceFileLoader("fm_cli_run_under_test", RUNNER)
    spec = importlib.util.spec_from_loader("fm_cli_run_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


runner = load_runner()


def closed_scratch():
    """A scratch directory on a path the runner's ownership checks accept:
    /tmp is world-writable, so it cannot hold a trusted fm-cli fixture."""
    for base in (os.environ.get("XDG_RUNTIME_DIR"), os.path.expanduser("~")):
        if not base:
            continue
        try:
            path = tempfile.mkdtemp(prefix="fm-cli-run-test-", dir=base)
        except OSError:
            continue
        os.chmod(path, 0o700)
        try:
            probe = os.path.join(path, "probe")
            open(probe, "w").close()
            runner.check_path(probe, (0, os.geteuid()))
            os.unlink(probe)
            return path
        except runner.Refused:
            shutil.rmtree(path, ignore_errors=True)
    raise unittest.SkipTest("no scratch directory outside world-writable paths")


def run_harness(config, *args, env=None, **kwargs):
    return subprocess.run([PYTHON, "-I", "-S", "-B", HARNESS, json.dumps(config)] + list(args),
                          env=env if env is not None else {"PATH": "/usr/bin", "HOME": "/nonexistent"},
                          capture_output=True, text=True, timeout=30, **kwargs)


class Scratch(unittest.TestCase):
    def setUp(self):
        self.scratch = closed_scratch()
        self.addCleanup(shutil.rmtree, self.scratch, True)

    def mise_install(self, source="/usr/bin/env", mode=0o755):
        home = os.path.join(self.scratch, "home")
        directory = os.path.join(home, ".local", "share", *runner.CLI_MISE_RELATIVE[:-1])
        os.makedirs(directory, mode=0o755)
        binary = os.path.join(directory, "fm-cli")
        shutil.copyfile(source, binary)
        os.chmod(binary, mode)
        with open(binary, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        return home, binary, digest


class EnvironmentTest(unittest.TestCase):
    def test_closed_environment_keeps_only_named_valid_values(self):
        hostile = {
            "PATH": "/home/me/bin:/usr/bin", "BASH_ENV": "/tmp/evil", "LD_PRELOAD": "/tmp/evil.so",
            "HOME": "/home/me", "XDG_RUNTIME_DIR": "relative/dir", "LANG": "en_US.UTF-8\nX=1",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus", "FM_API_TOKEN": "tok",
            "XDG_DATA_DIRS": "/usr/share:relative",
        }
        env = runner.cli_environment(hostile)
        self.assertEqual(env["PATH"], runner.PATH_ENVIRONMENT)
        self.assertEqual(env["HOME"], "/home/me")
        self.assertEqual(env["FM_API_TOKEN"], "tok")
        self.assertEqual(env["DBUS_SESSION_BUS_ADDRESS"], "unix:path=/run/user/1000/bus")
        for name in ("BASH_ENV", "LD_PRELOAD", "XDG_RUNTIME_DIR", "LANG"):
            self.assertNotIn(name, env)
        session = runner.session_environment(hostile)
        self.assertEqual(session["PATH"], runner.SESSION_PATH_ENVIRONMENT)
        self.assertNotIn("FM_API_TOKEN", session)
        self.assertNotIn("XDG_DATA_DIRS", session)
        self.assertNotIn("/home", runner.PATH_ENVIRONMENT + runner.SESSION_PATH_ENVIRONMENT)


class TrustTest(Scratch):
    def test_system_tools_resolve_from_root_owned_directories_only(self):
        self.assertIsNone(runner.system_file_problem("/usr/bin/env"))
        self.assertIn(runner.python_path(), runner.PYTHON_CANDIDATES)
        self.assertEqual(runner.find_tool("env", runner.TRUSTED_DIRECTORIES), "/usr/bin/env")
        mine = os.path.join(self.scratch, "env")
        shutil.copyfile("/usr/bin/env", mine)
        os.chmod(mine, 0o755)
        self.assertIn("owned by uid", runner.system_file_problem(mine))
        self.assertIsNone(runner.find_tool("definitely-not-a-tool", runner.TRUSTED_DIRECTORIES))

    def test_world_writable_directory_and_symlink_hops_are_refused(self):
        with self.assertRaises(runner.Refused):
            runner.check_path("/tmp/anything", (0, os.geteuid()))
        link = os.path.join(self.scratch, "link")
        os.symlink("/tmp", link)
        with self.assertRaises(runner.Refused):
            runner.check_path(link + "/x", (0, os.geteuid()))
        with self.assertRaises(runner.Refused):
            runner.check_path(link, (0, os.geteuid()), allow_symlinks=False)

    def test_tui_targets_accept_only_jmap_ids(self):
        self.assertEqual(runner.tui_target(["--thread", "AB5k", "--email", "Stm_l-1"]),
                         ["--thread", "AB5k", "--email", "Stm_l-1"])
        self.assertEqual(runner.tui_target([]), [])
        for bad in (["--thread", "-rf"], ["--thread", "a;b"], ["--thread"], ["--remote"],
                    ["--thread", "a", "--thread", "b"], ["--thread", "x" * 65]):
            self.assertIsNone(runner.tui_target(bad), bad)


class IdentityTest(Scratch):
    def test_missing_cli_is_reported_and_nothing_runs(self):
        home = os.path.join(self.scratch, "home")
        os.mkdir(home)
        result = run_harness({"package_candidates": []}, "probe", env={"PATH": "/usr/bin", "HOME": home})
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertTrue(lines[0].startswith("tools "))
        self.assertEqual(lines[1], "missing")
        result = run_harness({"package_candidates": []}, "exec", "--version", env={"PATH": "/usr/bin", "HOME": home})
        self.assertEqual(result.returncode, 127)
        self.assertEqual(json.loads(result.stderr)["code"], "missing")

    def test_pinned_mise_binary_runs_from_a_sealed_copy_of_the_verified_bytes(self):
        home, _binary, digest = self.mise_install("/usr/bin/readlink")
        result = run_harness({"package_candidates": [], "pinned_sha256": digest},
                             "exec", "/proc/self/exe", env={"PATH": "/usr/bin", "HOME": home})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("/memfd:fm-cli"), result.stdout)

    def test_modified_mise_binary_fails_closed(self):
        home, binary, digest = self.mise_install()
        with open(binary, "ab") as handle:
            handle.write(b"\0")
        marker = os.path.join(self.scratch, "ran")
        env = {"PATH": "/usr/bin", "HOME": home}
        result = run_harness({"package_candidates": [], "pinned_sha256": digest}, "exec", "touch", marker, env=env)
        self.assertEqual(result.returncode, 126)
        self.assertIn("does not match", json.loads(result.stderr)["error"])
        self.assertFalse(os.path.exists(marker))
        probe = run_harness({"package_candidates": [], "pinned_sha256": digest}, "probe", env=env)
        self.assertEqual(probe.returncode, 0)
        self.assertIn("does not match", probe.stdout)
        self.assertNotIn("identity", probe.stdout)

    def test_group_writable_or_symlinked_mise_install_fails_closed(self):
        home, binary, digest = self.mise_install(mode=0o775)
        env = {"PATH": "/usr/bin", "HOME": home}
        result = run_harness({"package_candidates": [], "pinned_sha256": digest}, "exec", env=env)
        self.assertEqual(result.returncode, 126)
        self.assertIn("writable by group or others", result.stderr)

        os.chmod(binary, 0o755)
        version_dir = os.path.dirname(binary)
        moved = version_dir + "-real"
        os.rename(version_dir, moved)
        os.symlink(moved, version_dir)
        result = run_harness({"package_candidates": [], "pinned_sha256": digest}, "exec", env=env)
        self.assertEqual(result.returncode, 126)
        self.assertIn("symlink", result.stderr)

    def test_package_binary_wins_and_must_be_root_owned(self):
        home, _binary, digest = self.mise_install("/usr/bin/true")
        env = {"PATH": "/usr/bin", "HOME": home}
        result = run_harness({"package_candidates": ["/usr/bin/echo"], "pinned_sha256": digest},
                             "exec", "from-the-package", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "from-the-package")

        mine = os.path.join(self.scratch, "fm-cli")
        shutil.copyfile("/usr/bin/echo", mine)
        os.chmod(mine, 0o755)
        result = run_harness({"package_candidates": [mine], "pinned_sha256": digest}, "exec", "x", env=env)
        self.assertEqual(result.returncode, 126)
        self.assertIn("owned by uid", result.stderr)

    def test_exec_hands_fm_cli_a_closed_environment(self):
        home, _binary, digest = self.mise_install("/usr/bin/env")
        hostile = {
            "PATH": self.scratch + ":/usr/bin", "HOME": home, "BASH_ENV": "/tmp/evil",
            "ENV": "/tmp/evil", "PYTHONPATH": "/tmp", "http_proxy": "http://evil",
            "FM_API_TOKEN": "fmu1-token", "XDG_RUNTIME_DIR": "/run/user/1",
        }
        result = run_harness({"package_candidates": [], "pinned_sha256": digest}, "exec", env=hostile)
        self.assertEqual(result.returncode, 0, result.stderr)
        seen = dict(line.split("=", 1) for line in result.stdout.splitlines())
        self.assertEqual(seen, {
            "PATH": runner.PATH_ENVIRONMENT, "HOME": home, "FM_API_TOKEN": "fmu1-token",
            "XDG_RUNTIME_DIR": "/run/user/1",
        })

    def test_probe_prints_tools_identity_version_then_status(self):
        env = {"PATH": "/usr/bin", "HOME": "/nonexistent"}
        result = run_harness({"package_candidates": ["/usr/bin/echo"]}, "probe", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        tools = json.loads(lines[0][len("tools "):])
        for path in tools.values():
            self.assertTrue(path.startswith("/"))
        self.assertEqual(json.loads(lines[1][len("identity "):]), {"path": "/usr/bin/echo", "source": "package"})
        # echo's own --version line is not an fm-cli version line, so none is
        # printed; the status command follows.
        self.assertEqual(lines[2], "auth status --json")

    def test_open_tui_refuses_malformed_ids_before_running_anything(self):
        result = run_harness({"package_candidates": ["/usr/bin/true"]}, "open-tui", "--thread", "$(id)")
        self.assertEqual(result.returncode, 2)


class SetupTest(Scratch):
    target = "ninepointlabs.fastmail"

    def setUp(self):
        super().setUp()
        self.runtime = os.path.join(self.scratch, "runtime")
        os.mkdir(self.runtime, 0o700)
        self.tools = os.path.join(self.scratch, "tools")
        os.mkdir(self.tools, 0o755)
        self.log = os.path.join(self.scratch, "completion.log")
        shell = os.path.join(self.tools, "omarchy-shell")
        with open(shell, "w") as handle:
            handle.write("#!/bin/sh\nprintf '%%s\\n' \"$*\" >>'%s'\n" % self.log)
        os.chmod(shell, 0o755)
        self.env = {"PATH": "/usr/bin", "HOME": self.scratch, "XDG_RUNTIME_DIR": self.runtime}

    def config(self, *steps):
        return {"tool_directory": self.tools, "setup_steps": [list(step) for step in steps]}

    def lock_path(self):
        return os.path.join(self.runtime, "ninepointlabs.fastmail-%d" % os.geteuid(), "setup-lock")

    def lock_check(self):
        return run_harness(self.config(), "setup-lock-check", env=self.env).returncode

    def completions(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as handle:
            return handle.read().splitlines()

    def wait_for(self, check, message):
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if check():
                return
            time.sleep(0.05)
        self.fail(message)

    def test_completion_runs_after_failure_and_preserves_the_status(self):
        for code in (42, 130):
            result = run_harness(self.config(["/bin/sh", "-c", "exit %d" % code]), "setup", "signin", self.target, env=self.env)
            self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(self.completions(), ["-q ninepointlabs.fastmail setupFinished"] * 2)
        self.assertEqual(stat.S_IMODE(os.stat(self.lock_path()).st_mode), 0o700)

    def test_a_failing_step_stops_the_ones_after_it(self):
        marker = os.path.join(self.scratch, "second-step")
        result = run_harness(self.config(["/bin/sh", "-c", "exit 3"], ["/usr/bin/touch", marker]),
                             "setup", "install", self.target, env=self.env)
        self.assertEqual(result.returncode, 3)
        self.assertFalse(os.path.exists(marker))

    def test_planted_symlink_lock_is_refused_without_touching_its_target(self):
        base = os.path.dirname(self.lock_path())
        os.mkdir(base, 0o700)
        victim = os.path.join(self.scratch, "victim.txt")
        with open(victim, "w") as handle:
            handle.write("keep this content")
        os.symlink(victim, self.lock_path())
        result = run_harness(self.config(["/usr/bin/true"]), "setup", "signin", self.target, env=self.env)
        self.assertEqual(result.returncode, 76)
        with open(victim) as handle:
            self.assertEqual(handle.read(), "keep this content")
        self.assertEqual(self.lock_check(), 76)

    def test_runtime_directory_open_to_others_is_refused(self):
        os.chmod(self.runtime, 0o777)
        result = run_harness(self.config(["/usr/bin/true"]), "setup", "signin", self.target, env=self.env)
        self.assertEqual(result.returncode, 76)
        self.assertFalse(os.path.exists(os.path.dirname(self.lock_path())))

    def test_invalid_mode_or_target_is_a_usage_error(self):
        for args in (("setup", "signin", "target's name"), ("setup", "rm", self.target), ("setup",)):
            self.assertEqual(run_harness(self.config(), *args, env=self.env).returncode, 2, args)

    def test_concurrent_setup_is_refused_and_a_hangup_still_reports_completion(self):
        first = subprocess.Popen([PYTHON, "-I", "-S", "-B", HARNESS, json.dumps(self.config(["/usr/bin/sleep", "30"])),
                                  "setup", "signin", self.target], env=self.env, start_new_session=True)
        try:
            self.wait_for(lambda: self.lock_check() == 1, "setup did not take its lock")
            second = run_harness(self.config(["/usr/bin/true"]), "setup", "signin", self.target, env=self.env)
            self.assertEqual(second.returncode, 75)
            self.assertIn("already running", second.stdout)

            os.killpg(first.pid, signal.SIGHUP)
            self.assertEqual(first.wait(timeout=10), 129)
            self.assertEqual(self.completions(), ["-q ninepointlabs.fastmail setupFinished"])
            self.assertEqual(self.lock_check(), 0)
        finally:
            if first.poll() is None:
                os.killpg(first.pid, signal.SIGKILL)
                first.wait()

    def test_a_killed_setup_releases_its_lock(self):
        first = subprocess.Popen([PYTHON, "-I", "-S", "-B", HARNESS, json.dumps(self.config(["/usr/bin/sleep", "30"])),
                                  "setup", "signin", self.target], env=self.env, start_new_session=True)
        try:
            self.wait_for(lambda: self.lock_check() == 1, "setup did not take its lock")
            os.killpg(first.pid, signal.SIGKILL)
            first.wait(timeout=10)
            self.wait_for(lambda: self.lock_check() == 0, "lock was not released")
            self.assertEqual(self.completions(), [])
        finally:
            if first.poll() is None:
                os.killpg(first.pid, signal.SIGKILL)
                first.wait()

    def test_a_lock_probe_does_not_make_setup_report_busy(self):
        # The panel's setup-lock-check takes the lock for an instant; a setup
        # starting at that moment must wait it out rather than refuse.
        probe_source = (
            "import fcntl, os, sys\n"
            "while True:\n"
            "    try:\n"
            "        fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)\n"
            "    except OSError:\n"
            "        continue\n"
            "    try:\n"
            "        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "        fcntl.flock(fd, fcntl.LOCK_UN)\n"
            "    except OSError:\n"
            "        pass\n"
            "    os.close(fd)\n")
        probe = subprocess.Popen([PYTHON, "-I", "-S", "-B", "-c", probe_source, self.lock_path()])
        try:
            for attempt in range(40):
                result = run_harness(self.config(["/usr/bin/true"]), "setup", "signin", self.target, env=self.env)
                self.assertEqual(result.returncode, 0, "attempt %d: %s" % (attempt, result.stdout + result.stderr))
        finally:
            probe.kill()
            probe.wait()


if __name__ == "__main__":
    unittest.main()
