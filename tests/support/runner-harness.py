# Runs bin/fm-cli-run with test-only substitutions, so the tests can stand in
# fixtures for the root-owned system locations the runner trusts. Nothing here
# is reachable from the plugin: it exists only under tests/.
#
#   python3 -I -S -B tests/support/runner-harness.py '<json config>' <mode> [args...]
#
# config keys (all optional):
#   package_candidates  list of paths standing in for /usr/bin/fm-cli
#   pinned_sha256       digest pinned for this machine
#   tool_directory      a directory whose entries count as trusted tools
#   setup_steps         list of argv lists run in place of install/sign-in
import importlib.machinery
import importlib.util
import json
import os
import platform
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "..", "..", "bin", "fm-cli-run")


def load():
    loader = importlib.machinery.SourceFileLoader("fm_cli_run", os.path.realpath(RUNNER))
    spec = importlib.util.spec_from_loader("fm_cli_run", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def main():
    config = json.loads(sys.argv[1])
    runner = load()
    if "package_candidates" in config:
        runner.CLI_PACKAGE_CANDIDATES = tuple(config["package_candidates"])
    if "pinned_sha256" in config:
        runner.CLI_PINNED_SHA256 = {platform.machine(): config["pinned_sha256"]}
    tools = config.get("tool_directory")
    if tools:
        runner.OMARCHY_DIRECTORIES = (tools,)
        runner.RUNNER_TOOLS = {name: (tools,) for name in runner.RUNNER_TOOLS}
        trusted = runner.system_file_problem

        def tool_problem(path):
            if os.path.dirname(path) == tools:
                return None
            return trusted(path)

        runner.system_file_problem = tool_problem
    steps = config.get("setup_steps")
    if steps is not None:
        def fixture_steps(self):
            environment = {"PATH": runner.PATH_ENVIRONMENT}
            return [lambda argv=argv: self.run_argv(argv, environment) for argv in steps]

        runner.Setup.steps = fixture_steps
    runner.__file__ = os.path.realpath(RUNNER)
    sys.exit(runner.main(["fm-cli-run"] + sys.argv[2:]))


if __name__ == "__main__":
    main()
