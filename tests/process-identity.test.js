const test = require("node:test")
const assert = require("node:assert/strict")
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Model = require("../Model.js")

const root = path.join(__dirname, "..")
const context = Model.runtimeContext("/usr/bin/python3", root)
const tools = {
  "omarchy-launch-webapp": "/usr/bin/omarchy-launch-webapp",
  "omarchy-notification-send": "/usr/bin/omarchy-notification-send",
  "omarchy-launch-floating-terminal-with-presentation": "/usr/bin/omarchy-launch-floating-terminal-with-presentation",
  "xdg-open": "/usr/bin/xdg-open",
  "wl-copy": "/usr/bin/wl-copy"
}

function source(name) {
  return readFileSync(path.join(root, name), "utf8")
}

function everyCommand(ctx, table) {
  return {
    probe: Model.probeCommand(ctx),
    accounts: Model.accountListCommand(ctx),
    box: Model.boxCommand(ctx, 50, true, "all", "Newsletters"),
    seen: Model.seenCommand(ctx, "AB5kIMdwqots", "u12345678"),
    watch: Model.watchCommand(ctx),
    setupLock: Model.setupLockCheckCommand(ctx),
    toast: Model.toastCommand(ctx, table, "Fastmail\nHello", "Body", 0, "tui", "", "AB5kIMdwqots", "StmlKEsTVdXB"),
    openTui: Model.openCommand(ctx, table, "tui", "", "AB5kIMdwqots", "StmlKEsTVdXB"),
    openApp: Model.openCommand(ctx, table, "app", "https://app.fastmail.com/mail/Inbox/T1"),
    openBrowser: Model.openCommand(ctx, table, "browser", "https://app.fastmail.com/mail/Inbox/T1"),
    copy: Model.copyCommand(table, Model.setupCommand),
    setup: Model.setupPlan(false, false, false, "ninepointlabs.fastmail", ctx, table).launchCommand
  }
}

test("no plugin source runs a shell, setpriv, a login shell, or a bare program name", () => {
  for (const name of ["Model.js", "Service.qml", "Panel.qml", "MailIcon.qml", "PlainTextDropdown.qml"]) {
    const text = source(name)
    assert.doesNotMatch(text, /["']bash["']|bash -c|-lc\b|["']sh["']/, `${name} starts a shell`)
    assert.doesNotMatch(text, /["']setpriv["']|["']fm-cli["']\s*,/, `${name} names a program without a path`)
    assert.doesNotMatch(text, /Qt\.openUrlExternally|bar\.run\(|execDetached\(\s*\[/, `${name} launches through an ambient path`)
  }
})

test("every Process clears the inherited environment and gets a closed one", () => {
  const service = source("Service.qml")
  const blocks = service.split(/\n  Process \{/).slice(1).map(block => block.slice(0, block.indexOf("\n  }")))
  assert.equal(blocks.length, 7)
  for (const block of blocks) {
    assert.match(block, /\n    clearEnvironment: true\n/)
    assert.match(block, /\n    environment: root\.(cli|session)Environment\n/)
  }
  for (const name of ["Service.qml", "Panel.qml"]) {
    const detached = source(name).match(/Quickshell\.execDetached\([^\n]*/g) || []
    assert.ok(detached.length > 0)
    for (const call of detached) assert.match(call, /clearEnvironment: true/, call)
  }
})

test("every command starts from a fixed interpreter or a trusted absolute tool", () => {
  for (const [name, command] of Object.entries(everyCommand(context, tools))) {
    assert.ok(command.length > 0, `${name} is empty`)
    const first = command[0]
    assert.ok(Model.pythonCandidates.includes(first) || Object.values(tools).includes(first), `${name} starts with ${first}`)
    assert.equal(command.includes("bash"), false, name)
    assert.equal(command.includes("-c"), false, name)
    assert.equal(command.includes("setpriv"), false, name)
    if (command[0] === "/usr/bin/python3") {
      assert.deepEqual(command.slice(1, 4), ["-I", "-S", "-B"], name)
      assert.ok(command[4] === context.supervisor || command[4] === context.runner, name)
    }
  }
})

test("every fm-cli command runs under the supervisor and through the runner", () => {
  const all = everyCommand(context, tools)
  for (const name of ["probe", "accounts", "box", "seen", "watch", "setupLock"]) {
    assert.equal(all[name][4], context.supervisor, name)
    assert.deepEqual(all[name].slice(13, 19), ["--", "/usr/bin/python3", "-I", "-S", "-B", context.runner], name)
  }
  assert.equal(all.watch[10], "0")
  assert.deepEqual(Model.capturedCommandPayload(all.seen), ["fm-cli", "seen", "AB5kIMdwqots", "--account", "u12345678", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(all.probe), ["fm-cli-run", "probe"])
})

test("commands fail closed without a runtime or with an untrusted tool", () => {
  for (const [name, command] of Object.entries(everyCommand(null, tools))) {
    if (name === "openApp" || name === "openBrowser" || name === "copy") continue
    assert.deepEqual(command, [], name)
  }
  const shadowed = Object.fromEntries(Object.keys(tools).map(key => [key, `/home/me/.local/bin/${key}`]))
  const withShadows = everyCommand(context, shadowed)
  for (const name of ["toast", "openApp", "openBrowser", "copy", "setup"]) assert.deepEqual(withShadows[name], [], name)
  assert.deepEqual(Model.openCommand(context, { "xdg-open": "/usr/bin/wl-copy" }, "browser", ""), [])
  assert.equal(Model.runtimeContext("python3", root), null)
  assert.equal(Model.runtimeContext("/home/me/bin/python3", root), null)
  assert.equal(Model.runtimeContext("/usr/bin/python3", "relative/dir"), null)
  assert.equal(Model.runtimeContext("/usr/bin/python3", "/opt/../etc"), null)
})

test("closed environments keep only named, well-formed values", () => {
  const hostile = {
    PATH: "/home/me/bin:/usr/bin", BASH_ENV: "/home/me/.evil", LD_PRELOAD: "/home/me/evil.so",
    HOME: "/home/me", XDG_RUNTIME_DIR: "run/user/1000", LANG: "C.UTF-8\nBASH_ENV=/x",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", FM_API_TOKEN: "fmu1-token",
    WAYLAND_DISPLAY: "wayland-1", XDG_DATA_DIRS: "/usr/share:share"
  }
  const cli = Model.cliEnvironment(name => hostile[name])
  assert.deepEqual(cli, {
    PATH: Model.trustedPathEnvironment, HOME: "/home/me",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", FM_API_TOKEN: "fmu1-token"
  })
  const session = Model.sessionEnvironment(name => hostile[name])
  assert.deepEqual(session, {
    PATH: Model.trustedSessionPathEnvironment, HOME: "/home/me",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", WAYLAND_DISPLAY: "wayland-1"
  })
  assert.doesNotMatch(Model.trustedPathEnvironment + Model.trustedSessionPathEnvironment, /home|local/)
})

test("a hostile PATH and BASH_ENV never get to run anything", t => {
  if (existsSync("/usr/bin/fm-cli")) {
    t.skip("a packaged fm-cli is installed; the probe would run it")
    return
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "fm-path-shadow-"))
  try {
    const fake = path.join(scratch, "bin")
    const markers = path.join(scratch, "markers")
    const home = path.join(scratch, "home")
    for (const directory of [fake, markers, home]) mkdirSync(directory)
    const plant = `#!/bin/sh\n: >"${markers}/$(basename "$0")"\nexit 0\n`
    for (const name of ["bash", "sh", "python3", "fm-cli", "setpriv", "head", "env", "flock", "omarchy-shell"]) {
      writeFileSync(path.join(fake, name), plant)
      chmodSync(path.join(fake, name), 0o755)
    }
    const evil = path.join(scratch, "bash_env")
    writeFileSync(evil, `: >"${markers}/BASH_ENV"\n`)
    const hostile = {
      ...process.env, PATH: `${fake}:${process.env.PATH}`, BASH_ENV: evil, ENV: evil,
      HOME: home, XDG_DATA_HOME: path.join(home, ".local", "share")
    }

    // What the service does: a closed environment built from the hostile one.
    const closed = Model.cliEnvironment(name => hostile[name])
    assert.equal(closed.PATH, Model.trustedPathEnvironment)
    // And the same commands even if the environment were not cleared at all.
    for (const env of [closed, hostile]) {
      const probe = Model.probeCommand(context)
      const probed = spawnSync(probe[0], probe.slice(1), { env, encoding: "utf8", timeout: 20000 })
      assert.equal(probed.status, 0, probed.stderr)
      assert.match(probed.stdout, /^tools \{.*\}\nmissing\n$/)

      const accounts = Model.accountListCommand(context)
      const listed = spawnSync(accounts[0], accounts.slice(1), { env, encoding: "utf8", timeout: 20000 })
      assert.equal(listed.status, 127, listed.stderr)
      assert.equal(JSON.parse(listed.stderr).code, "missing")
    }
    assert.deepEqual(readdirSync(markers), [], "a planted program or BASH_ENV ran")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
