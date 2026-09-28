const test = require("node:test")
const assert = require("node:assert/strict")
const { spawn, spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const Model = require("../Model.js")

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForProcessExitSync(pid, attempts = 200) {
  for (let i = 0; i < attempts && fs.existsSync(`/proc/${pid}`); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

const context = Model.runtimeContext("/usr/bin/python3", path.join(__dirname, ".."))
const tools = {
  "omarchy-launch-webapp": "/usr/bin/omarchy-launch-webapp",
  "omarchy-notification-send": "/usr/bin/omarchy-notification-send",
  "xdg-open": "/usr/bin/xdg-open"
}
const openTui = (...target) => [context.python, "-I", "-S", "-B", context.runner, "open-tui", ...target]

test("accountListCommand asks fm-cli for its mail accounts", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.accountListCommand(context)), ["fm-cli", "account", "list", "--json"])
  assert.deepEqual(Model.accountListCommand(null), [])
})

test("boxCommand reads the all box by default for the panel's threads through a bounded capture", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, false)),
    ["fm-cli", "box", "view", "all", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 20, true)),
    ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "20", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, "garbage", false)),
    ["fm-cli", "box", "view", "all", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 500, true, "all", "")),
    ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, true, "unexpected", "")),
    ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json"], "an unknown mode is the default")
})

test("boxCommand reads the Inbox alone in inbox mode and ignores excludes there", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, true, "inbox", "Finance, Family")),
    ["fm-cli", "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, false, "inbox")),
    ["fm-cli", "box", "view", "inbox", "--limit", "50", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, true, " Inbox ")),
    ["fm-cli", "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"])
})

test("boxCommand appends one --exclude pair per configured folder in all mode", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, true, "all", "Finance, Other Services/Gmail")),
    ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json",
      "--exclude", "Finance", "--exclude", "Other Services/Gmail"])
  // An already parsed list is accepted as it is.
  assert.deepEqual(Model.capturedCommandPayload(Model.boxCommand(context, 50, true, "all", ["Finance"])).slice(-2),
    ["--exclude", "Finance"])
})

test("exclude entries are argv elements: kept verbatim, never quoted or split by a shell", () => {
  const hostile = `Bob's "Stuff" $(rm -rf ~) ;|& \`x\` \\n`
  const command = Model.boxCommand(context, 50, true, "all", hostile + ", Family")
  const payload = Model.capturedCommandPayload(command)
  assert.deepEqual(payload.slice(-4), ["--exclude", hostile, "--exclude", "Family"])
  // No shell anywhere between the service and fm-cli: the supervisor execs
  // the runner, which execs fm-cli, each with an argv list.
  assert.equal(command.indexOf(hostile), command.length - 3)
  assert.equal(command.includes("-c"), false)
  for (const argument of command) assert.equal(typeof argument, "string")
})

test("parseExcludeFolders trims, drops empties and flags, and bounds count and length", () => {
  assert.deepEqual(Model.parseExcludeFolders(" Finance ,, Family ,  "), ["Finance", "Family"])
  assert.deepEqual(Model.parseExcludeFolders("Other Services/Gmail"), ["Other Services/Gmail"])
  assert.deepEqual(Model.parseExcludeFolders("--json, -x, Finance"), ["Finance"], "an entry that reads as a flag is dropped")
  assert.deepEqual(Model.parseExcludeFolders("Fin\tance\u0000, New\nsletters"), ["Finance", "Newsletters"], "control characters are removed")
  assert.deepEqual(Model.parseExcludeFolders(""), [])
  assert.deepEqual(Model.parseExcludeFolders(null), [])
  assert.deepEqual(Model.parseExcludeFolders(undefined), [])
  assert.deepEqual(Model.parseExcludeFolders({ folders: "Finance" }), [])
  assert.deepEqual(Model.parseExcludeFolders(["A", " B ", "", "-C"]), ["A", "B"])

  const long = Model.parseExcludeFolders("x".repeat(500) + ", y")
  assert.equal(long.length, 2)
  assert.equal(long[0].length, Model.excludeFolderCharacterLimit)
  assert.equal(Model.excludeFolderCharacterLimit, 160)

  const many = Model.parseExcludeFolders(Array.from({ length: 100 }, (_, index) => "f" + index).join(","))
  assert.equal(many.length, Model.maximumExcludeFolderCount)
  assert.equal(Model.maximumExcludeFolderCount, 32)
  assert.equal(many[0], "f0")
  assert.equal(many[31], "f31")

  const huge = Model.parseExcludeFolders("a,".repeat(20000))
  assert.equal(huge.length, Model.maximumExcludeFolderCount)
  // Supervisor prefix (14), runner prefix and mode (6), the box arguments (9).
  assert.equal(Model.boxCommand(context, 50, true, "all", "a,".repeat(20000)).length <= 14 + 6 + 9 + 2 * Model.maximumExcludeFolderCount, true)
})

test("foldersMode accepts all and inbox and defaults to all", () => {
  assert.deepEqual(Model.foldersModeChoices, ["all", "inbox"])
  assert.equal(Model.foldersMode("all"), "all")
  assert.equal(Model.foldersMode("inbox"), "inbox")
  assert.equal(Model.foldersMode(" INBOX "), "inbox")
  assert.equal(Model.foldersMode("archive"), "all")
  assert.equal(Model.foldersMode(""), "all")
  assert.equal(Model.foldersMode(undefined), "all")
  assert.equal(Model.foldersMode(null), "all")
  assert.equal(Model.foldersMode(42), "all")
})

test("newMailForToast toasts the Inbox alone in inbox mode", () => {
  const inbox = Model.watchLine('{"change":"added","new":true,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"a"}}')
  const finance = Model.watchLine('{"change":"added","new":true,"box":{"id":"Pibo","kind":"","name":"Finance"},"posting":{"id":"b"}}')
  const archive = Model.watchLine('{"change":"added","new":true,"box":{"id":"P-A","kind":"archive","name":"Archive"},"posting":{"id":"c"}}')
  assert.equal(Model.newMailForToast(inbox, "inbox", []), true)
  assert.equal(Model.newMailForToast(finance, "inbox", []), false)
  assert.equal(Model.newMailForToast(archive, "inbox", []), false)
  assert.equal(Model.newMailForToast(inbox, "inbox", ["Inbox"]), true, "the exclude list has no say over the Inbox read")
})

test("newMailForToast toasts every included folder in all mode", () => {
  const line = (kind, name, id) => Model.watchLine(JSON.stringify({
    change: "added", new: true, box: { id: id || "Px", kind, name }, posting: { id: "t" }
  }))
  assert.equal(Model.newMailForToast(line("inbox", "Inbox"), "all", []), true)
  assert.equal(Model.newMailForToast(line("", "Finance"), "all", []), true)
  assert.equal(Model.newMailForToast(line("", "Finance"), "all", ""), true)
  assert.equal(Model.newMailForToast(line("", "Finance"), "all", "Family, Newsletters"), true)
  assert.equal(Model.newMailForToast(line("", "Finance"), "all", "finance"), false, "excluded by name, case-insensitively")
  assert.equal(Model.newMailForToast(line("", "Finance"), "all", ["Finance"]), false)
  assert.equal(Model.newMailForToast(line("", "Finance", "Pibo"), "all", "pibo"), false, "excluded by id")
  assert.equal(Model.newMailForToast(line("", "Gmail"), "all", "Other Services/Gmail"), false, "a path excludes the folder it ends in")
  assert.equal(Model.newMailForToast(line("", "Other Services"), "all", "Other Services/Gmail"), true)
  assert.equal(Model.newMailForToast(line("", "Gmail"), "all", "Other Services/"), true)
  for (const kind of Model.quietBoxKinds) {
    assert.equal(Model.newMailForToast(line(kind, kind), "all", []), false, `${kind} never toasts`)
  }
  assert.deepEqual(Model.quietBoxKinds, ["junk", "trash", "drafts", "sent", "snoozed", "scheduled", "archive"])
  assert.equal(Model.newMailForToast(line("JUNK", "Junk"), "all", []), false, "roles are matched case-insensitively")
  assert.equal(Model.newMailForToast(line("", "Finance"), undefined, []), true, "no mode is the default, all")

  const notNew = Model.watchLine('{"change":"updated","new":false,"box":{"kind":"","name":"Finance"},"posting":{"id":"t"}}')
  assert.equal(Model.newMailForToast(notNew, "all", []), false)
  assert.equal(Model.newMailForToast(Model.watchLine('{"change":"ready"}'), "all", []), false)
  assert.equal(Model.newMailForToast(null, "all", []), false)
  assert.equal(Model.folderExcluded(null, "Finance"), false)
  assert.equal(Model.folderExcluded({ boxName: "Finance" }, "Finance"), true)
  assert.equal(Model.folderExcluded({ boxKind: "archive" }, "archive"), true)
  assert.equal(Model.folderExcluded({ boxName: "" }, "Other Services/"), false)
})

test("toastBoxName names the one box of a burst or counts several", () => {
  assert.equal(Model.toastBoxName([{ boxName: "Inbox" }]), "Inbox")
  assert.equal(Model.toastBoxName([{ boxName: "Inbox" }, { boxName: "Inbox" }]), "Inbox")
  assert.equal(Model.toastBoxName([{ boxName: "Inbox" }, { boxName: "Finance" }]), "2 folders")
  assert.equal(Model.toastBoxName([{ boxName: "Inbox" }, { boxName: "Finance" }, { boxName: "Family" }]), "3 folders")
  assert.equal(Model.toastBoxName([]), "")
  assert.equal(Model.toastBoxName(null), "")
  assert.equal(Model.composeMailToast(Model.toastBoxName([{ boxName: "Inbox" }, { boxName: "Finance" }]), [{ id: "a" }, { id: "b" }]).headline,
    "Fastmail\n2 new in 2 folders")
})

test("seenCommand marks an opaque thread id seen in its account through a bounded capture", () => {
  assert.deepEqual(Model.capturedCommandPayload(Model.seenCommand(context, "AB5kIMdwqots", "u12345678")),
    ["fm-cli", "seen", "AB5kIMdwqots", "--account", "u12345678", "--json"])
  assert.deepEqual(Model.capturedCommandPayload(Model.seenCommand(context, "AB5kIMdwqots", "")),
    ["fm-cli", "seen", "AB5kIMdwqots", "--json"])
  assert.deepEqual(Model.seenCommand(context, "x".repeat(500), "u12345678"), [], "an over-long thread id is refused, not shortened into another id")
  assert.deepEqual(Model.capturedCommandPayload(Model.seenCommand(context, "AB5kIMdwqots", "y".repeat(500))),
    ["fm-cli", "seen", "AB5kIMdwqots", "--json"], "an over-long account id is dropped")
})

test("watchCommand follows every mailbox without a finite-command deadline", () => {
  const command = Model.watchCommand(context)
  assert.deepEqual(Model.capturedCommandPayload(command),
    ["fm-cli", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
  assert.equal(command[9], "--deadline")
  assert.equal(command[10], "0")
  assert.equal(command[6], String(Model.watchOutputByteLimit))
})

// The supervisor tests run the real bin/bounded-run; the payloads are fixed
// test programs by absolute path, with a closed environment.
const supervisorEnv = { PATH: Model.trustedPathEnvironment }

test("supervisedCommand caps each stream and says which cap ended the job", () => {
  const command = Model.supervisedCommand(context, [
    "/usr/bin/bash", "-c",
    "printf '%100s' '' | tr ' ' x; sleep 0.2; printf '%100s' '' | tr ' ' y >&2"
  ], 16, 8)
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env: supervisorEnv })

  assert.deepEqual(command.slice(0, 5), ["/usr/bin/python3", "-I", "-S", "-B", context.supervisor])
  assert.equal(result.status, 201, result.stderr)
  assert.equal(Buffer.byteLength(result.stdout), 16)
  assert.equal(Model.supervisorMessage(result.status), "The fm-cli response exceeded its size limit")
  assert.equal(command[10], String(Model.finiteCommandTimeoutSec))
  assert.equal(command[12], String(Model.finiteCommandKillGraceSec))

  const errors = Model.supervisedCommand(context, ["/usr/bin/bash", "-c", "printf '%100s' '' >&2; sleep 5"], 16, 8)
  const flooded = spawnSync(errors[0], errors.slice(1), { encoding: "utf8", env: supervisorEnv })
  assert.equal(flooded.status, 202)
  assert.equal(Buffer.byteLength(flooded.stderr), 8)
})

test("supervisedCommand refuses a relative program or a missing runtime", () => {
  assert.deepEqual(Model.supervisedCommand(context, ["bash", "-c", "true"]), [])
  assert.deepEqual(Model.supervisedCommand(null, ["/usr/bin/true"]), [])
  assert.deepEqual(Model.supervisedCommand(context, []), [])
  assert.equal(Model.supervisorMessage(124), "fm-cli did not answer in time")
  assert.equal(Model.supervisorMessage(202), "fm-cli wrote more error output than allowed")
  assert.equal(Model.supervisorMessage(1), "")
})

test("capturedCommandPayload returns an unwrapped command as it is", () => {
  assert.deepEqual(Model.capturedCommandPayload(["fm-cli", "tui"]), ["fm-cli", "tui"])
  assert.deepEqual(Model.capturedCommandPayload(null), [])
  assert.deepEqual(Model.capturedCommandPayload(openTui("--thread", "AB5k")), ["fm-cli-run", "open-tui", "--thread", "AB5k"])
})

test("supervisedCommand times out a silent TERM-ignoring payload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-output-timeout-"))
  const pidPath = path.join(directory, "payload.pid")
  const command = Model.supervisedCommand(context, [
    "/usr/bin/bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", pidPath
  ], 16, 8, 1, 1)
  const startedAt = Date.now()

  try {
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 5000, env: supervisorEnv })
    const payloadPid = Number(fs.readFileSync(pidPath, "utf8"))
    assert.equal(result.status, 124, result.stderr)
    assert.ok(Date.now() - startedAt < 4000, "the deadline completed promptly")
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the timed-out process group was killed")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("supervisedCommand cleans up a descendant after its leader exits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-output-descendant-"))
  const pidPath = path.join(directory, "descendant.pid")
  const command = Model.supervisedCommand(context, [
    "/usr/bin/bash", "-c", '(trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"', "payload", pidPath
  ], 16, 8, 30, 1)

  try {
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 5000, env: supervisorEnv })
    const descendantPid = Number(fs.readFileSync(pidPath, "utf8"))
    assert.equal(result.status, 0, result.stderr)
    waitForProcessExitSync(descendantPid)
    assert.equal(fs.existsSync(`/proc/${descendantPid}`), false, "the descendant did not outlive the finite command")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("supervisedCommand terminates the payload process group with its supervisor", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-output-guard-"))
  const pidPath = path.join(directory, "payload.pid")
  const command = Model.supervisedCommand(context, [
    "/usr/bin/bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", pidPath
  ], 16, 8, 30, 1)
  const wrapper = spawn(command[0], command.slice(1), { stdio: "ignore", env: supervisorEnv })
  let payloadPid = 0

  try {
    for (let i = 0; i < 100 && payloadPid === 0; i++) {
      if (fs.existsSync(pidPath)) payloadPid = Number(fs.readFileSync(pidPath, "utf8"))
      if (payloadPid === 0) await delay(10)
    }
    assert.ok(payloadPid > 0, "the payload started")

    wrapper.kill("SIGTERM")
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("output guard did not exit")), 2000)
      wrapper.once("exit", () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    for (let i = 0; i < 300 && fs.existsSync(`/proc/${payloadPid}`); i++) await delay(10)
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the payload did not outlive its guard")
  } finally {
    if (wrapper.exitCode === null) wrapper.kill("SIGKILL")
    if (payloadPid > 0) {
      try { process.kill(payloadPid, "SIGKILL") } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("supervisedCommand exits with its Quickshell-style parent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fm-output-parent-"))
  const guardPath = path.join(directory, "guard.pid")
  const payloadPath = path.join(directory, "payload.pid")
  const command = Model.supervisedCommand(context, [
    "/usr/bin/bash", "-c", 'trap "exit 0" TERM; (trap "" TERM; while :; do sleep 30; done) & printf "%s" "$!" > "$1"; while :; do wait || true; done', "payload", payloadPath
  ], 16, 8, 30, 1)
  let guardPid = 0
  let payloadPid = 0

  try {
    const launcher = spawnSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process")
      const fs = require("node:fs")
      const command = JSON.parse(process.env.GUARDED_COMMAND)
      const child = spawn(command[0], command.slice(1), { stdio: "ignore" })
      fs.writeFileSync(process.env.GUARD_PID_PATH, String(child.pid))
      for (let i = 0; i < 100 && !fs.existsSync(process.env.PAYLOAD_PID_PATH); i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      child.unref()
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        GUARDED_COMMAND: JSON.stringify(command),
        GUARD_PID_PATH: guardPath,
        PAYLOAD_PID_PATH: payloadPath
      }
    })
    assert.equal(launcher.status, 0, launcher.stderr)
    guardPid = Number(fs.readFileSync(guardPath, "utf8"))
    payloadPid = Number(fs.readFileSync(payloadPath, "utf8"))

    for (let i = 0; i < 800 && (fs.existsSync(`/proc/${guardPid}`) || fs.existsSync(`/proc/${payloadPid}`)); i++) await delay(10)
    assert.equal(fs.existsSync(`/proc/${guardPid}`), false, "the guard did not outlive its parent")
    assert.equal(fs.existsSync(`/proc/${payloadPid}`), false, "the payload did not outlive its guard")
  } finally {
    for (const pid of [guardPid, payloadPid]) {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("parseFailure reads the CLI's error envelope from stderr", () => {
  const failure = Model.parseFailure("", '{"ok":false,"error":"not signed in","code":"auth","hint":"Run: fm-cli auth login"}')
  assert.equal(failure.code, "auth")
  assert.equal(failure.error, "not signed in")
  assert.equal(failure.hint, "Run: fm-cli auth login")
  assert.equal(Model.isAuthError(failure.code), true)
  assert.equal(Model.isAuthError("auth_required"), true)
  assert.equal(Model.isAuthError("network"), false)
  assert.equal(Model.parseFailure("", "").code, "")
  // A success envelope on a failed exit is still a failure.
  assert.deepEqual(Model.parseFailure('{"ok":true,"data":{}}', ""),
    { ok: false, error: "The fm-cli request failed", code: "", hint: "" })
  // An envelope without an error message gets the generic one.
  assert.equal(Model.parseFailure("", '{"ok":false,"code":"cli"}').error, "The fm-cli request failed")
})

test("failureMessage prefers the envelope, then raw output, then the fallback", () => {
  assert.equal(Model.failureMessage("", '{"ok":false,"error":"keyring locked","code":"cli"}', "fallback"), "keyring locked")
  assert.equal(Model.failureMessage('{"ok":false,"error":"on stdout","code":"cli"}', "", "fallback"), "on stdout")
  assert.equal(Model.failureMessage("", "keyring unavailable", "fallback"), "keyring unavailable")
  assert.equal(Model.failureMessage("plain stdout", "", "fallback"), "plain stdout")
  assert.equal(Model.failureMessage("", "  ", "fallback"), "fallback")
  assert.equal(Model.failureMessage("", "", "fallback"), "fallback")
  assert.equal(Model.failureMessage("", '{"ok":true,"data":{}}', "fallback"), "The fm-cli request failed")
  assert.equal(Model.failureMessage("", "{not json", "fallback"), "Could not parse the fm-cli response")
  assert.equal(Model.failureMessage("", "x".repeat(2000), "fallback").length, Model.remoteErrorCharacterLimit)
})

test("cliTooOld recognizes a CLI that lacks a command, flag, or event", () => {
  assert.equal(Model.cliTooOld("", 'Error: unknown command "watch" for "fm-cli"'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"unknown flag \\"--account\\"","code":"usage"}'), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"unknown event \\"new\\"","code":"usage"}'), true)
  assert.equal(Model.cliTooOld('unknown command "seen"', ""), true)
  assert.equal(Model.cliTooOld("", '{"ok":false,"error":"network error","code":"network"}'), false)
  assert.match(Model.cliTooOldMessage, /0\.3\.0/)
  assert.match(Model.cliTooOldMessage, /omarchy-mise-install github:ninepointlabs\/fm-cli@0\.3\.3 fm-cli/)
  assert.equal(Model.minimumCliVersion, "0.3.0")
})

test("probeCommand asks the runner for identity, version and auth status through a bounded capture", () => {
  const command = Model.probeCommand(context)
  assert.deepEqual(Model.capturedCommandPayload(command), ["fm-cli-run", "probe"])
  assert.equal(command[4], context.supervisor)
  assert.deepEqual(Model.probeCommand(null), [])
})

test("parseProbe splits the version line from the auth status", () => {
  const probe = Model.parseProbe('identity {"source":"mise","path":"/p"}\nfm-cli version 0.3.0\n{"ok":true,"data":{"authenticated":true}}\n')
  assert.equal(probe.version, "0.3.0")
  assert.equal(probe.state, "ok")
  assert.equal(Model.parseJson(probe.status).value.data.authenticated, true)
  assert.equal(Model.parseProbe('{"ok":true,"data":{"authenticated":false}}').status, '{"ok":true,"data":{"authenticated":false}}')
  assert.equal(Model.parseProbe("fm-cli version dev\n{}").version, "dev")
  assert.equal(Model.parseProbe("hey version 1.2.0\n{}").version, "", "another CLI's version line is not fm-cli's")
  assert.equal(Model.parseProbe("x".repeat(Model.probeResponseByteLimit + 1)).status, "")
})

test("cliVersionTooOld holds a release below the minimum against the CLI, and nothing else", () => {
  assert.equal(Model.cliVersionTooOld("0.1.1"), true)
  assert.equal(Model.cliVersionTooOld("v0.1.9"), true)
  assert.equal(Model.cliVersionTooOld("0.2.0"), true)
  assert.equal(Model.cliVersionTooOld("0.2.9"), true)
  assert.equal(Model.cliVersionTooOld("0.3.0"), false)
  assert.equal(Model.cliVersionTooOld("0.3.1"), false)
  assert.equal(Model.cliVersionTooOld("0.10.0"), false)
  assert.equal(Model.cliVersionTooOld("1.0.0"), false)
  assert.equal(Model.cliVersionTooOld("dev"), false)
  assert.equal(Model.cliVersionTooOld(""), false)
})

test("watchLine reads an fm-cli watch line: the change, the mailbox, and whether it is new mail", () => {
  const added = Model.watchLine('{"change":"added","new":true,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots","account_id":"u12345678","name":"Lunch on Thursday?"}}')
  assert.equal(added.change, "added")
  assert.equal(added.isNew, true)
  assert.equal(added.boxKind, "inbox")
  assert.equal(added.boxName, "Inbox")
  assert.equal(added.posting.id, "AB5kIMdwqots")
  assert.equal(added.posting.account_id, "u12345678")
  assert.equal(added.posting.name, "Lunch on Thursday?")
  assert.equal(added.boxId, "P-F")
  assert.equal(Model.newMailForToast(added, "inbox", []), true)

  const notNew = Model.watchLine('{"change":"updated","new":false,"box":{"kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots"}}')
  assert.equal(notNew.isNew, false)
  assert.equal(Model.newMailForToast(notNew, "inbox", []), false)

  const archive = Model.watchLine('{"change":"added","new":true,"box":{"id":"P-A","kind":"Archive","name":"Archive"},"posting":{"id":"Qx7"}}')
  assert.equal(archive.boxKind, "archive", "roles are lowercased")
  assert.equal(Model.newMailForToast(archive, "inbox", []), false, "new mail in another mailbox is not the Inbox's")

  const deleted = Model.watchLine('{"change":"deleted","new":false,"box":{"kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots","email_id":"StmlKEsTVdXB","thread_id":"AB5kIMdwqots"}}')
  assert.equal(deleted.change, "deleted")
  assert.equal(Model.newMailForToast(deleted, "inbox", []), false)

  const ready = Model.watchLine('{"change":"ready"}')
  assert.equal(ready.change, "ready")
  assert.equal(ready.isNew, false)
  assert.equal(ready.posting, null)
  assert.equal(ready.boxId, "")
  assert.equal(Model.newMailForToast(ready, "inbox", []), false)
  assert.equal(Model.watchLine("   "), null)
  assert.equal(Model.watchLine("not json"), null)
  assert.equal(Model.watchLine('{"posting":{}}'), null)
  assert.equal(Model.watchLine("x".repeat(Model.watchLineByteLimit + 1)), null)

  const bounded = Model.watchLine(JSON.stringify({
    change: "added",
    box: { id: "i".repeat(500), kind: "inbox", name: "B".repeat(500) },
    posting: {
      id: "1".repeat(100),
      account_id: "a".repeat(100),
      name: "T".repeat(500),
      summary: "S".repeat(1000),
      app_url: "/" + "u".repeat(3000),
      alternative_sender_name: "A".repeat(500),
      creator: { name: "C".repeat(500), email_address: "E".repeat(500) }
    }
  }))
  assert.equal(bounded.boxName.length, Model.remoteNameCharacterLimit)
  assert.equal(bounded.boxId.length, Model.remoteIdCharacterLimit)
  assert.equal(bounded.posting.id, "", "an over-long id is not an id")
  assert.equal(bounded.posting.account_id, "", "an over-long account id is not an id")
  assert.equal(bounded.posting.name.length, Model.remoteTitleCharacterLimit)
  assert.equal(bounded.posting.summary.length, Model.remoteExcerptCharacterLimit)
  assert.equal(bounded.posting.app_url.length, Model.remoteUrlCharacterLimit)
  assert.equal(bounded.posting.alternative_sender_name.length, Model.remoteNameCharacterLimit)
  assert.equal(bounded.posting.creator.name.length, Model.remoteNameCharacterLimit)
  assert.equal(bounded.posting.creator.email_address.length, Model.remoteNameCharacterLimit)
  assert.equal(Model.newMailForToast(null, "inbox", []), false)
})

test("composeMailToast puts Fastmail and the subject on separate headline lines", () => {
  const toast = Model.composeMailToast("Inbox", [
    { id: "AB5kIMdwqots", name: "Lunch on Thursday?", summary: "Are you free around noon?", app_url: "/mail/Inbox/TAB5kIMdwqots", account_id: "u12345678", creator: { name: "Maria Delgado" } }
  ])
  assert.deepEqual(toast, {
    headline: "Fastmail\nLunch on Thursday?",
    description: "Are you free around noon?",
    targetUrl: "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots",
    threadId: "AB5kIMdwqots",
    emailId: ""
  })
})

test("composeMailToast drops a description that already stood in for the subject", () => {
  const toast = Model.composeMailToast("Inbox", [
    { id: "AB5kIMdwqots", summary: "Your August invoice is attached.", creator: { email_address: "billing@example.com" } }
  ])
  assert.equal(toast.headline, "Fastmail\nYour August invoice is attached.")
  assert.equal(toast.description, "")
  assert.equal(toast.targetUrl, "https://app.fastmail.com/mail/Inbox", "no URL sends the click to the Inbox")
})

test("notificationPreview uses the first content line and truncates long bodies", () => {
  assert.equal(Model.notificationPreview("First line<br>Second line"), "First line")
  assert.equal(Model.notificationPreview("\\n\\nUseful line\\nIgnored line"), "Useful line")
  assert.equal(Model.notificationPreview("A message that keeps going", 10), "A message…")
})

test("composeMailToast counts a burst and lists the first senders", () => {
  const toast = Model.composeMailToast("Inbox", [
    { id: "t1", name: "Lunch on Thursday?", creator: { name: "Maria Delgado" }, alternative_sender_name: "Maria (personal)" },
    { id: "t2", name: "Invoice #4021", creator: { name: "Northwind Invoicing" } },
    { id: "t3", name: "Draft agenda for Monday", creator: { email_address: "sam@example.com" } },
    { id: "t4", name: "Photos from the offsite", creator: { name: "Priya Raman" } }
  ])
  assert.equal(toast.headline, "Fastmail\n4 new in Inbox")
  assert.equal(toast.description, "Maria (personal), Northwind Invoicing, sam@example.com, …")
  assert.equal(toast.targetUrl, "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.composeMailToast("", [{ id: "t1" }, { id: "t2" }]).headline, "Fastmail\n2 new in Inbox")
  assert.equal(Model.composeMailToast("Inbox", null).headline, "Fastmail\n0 new in Inbox")
})

test("toastCommand goes out as Fastmail with a generic mail icon, printed id, and the click argv last", () => {
  const first = Model.toastCommand(context, tools, "Fastmail\nLunch on Thursday?", "Are you free around noon?", 0)
  assert.deepEqual(first, [
    "/usr/bin/omarchy-notification-send",
    "--app-name", "Fastmail",
    "-u", "low",
    "-i", "mail-unread",
    "-p",
    "Fastmail\nLunch on Thursday?",
    "Are you free around noon?",
    "--exec"
  ].concat(openTui()))
  assert.equal(Model.toastIcon, "mail-unread")
  const second = Model.toastCommand(context, tools, "Fastmail\n2 new in Inbox", "", 42)
  assert.deepEqual(second.slice(8, 11), ["-r", "42", "Fastmail\n2 new in Inbox"])
  assert.equal(second[11], "--exec", "--exec follows the headline when there is no description")
  // A headline that is literally --exec stays text: the helper takes the
  // first --exec after the positionals, which is ours.
  const tricky = Model.toastCommand(context, tools, "--exec", "-rf", 0)
  assert.deepEqual(tricky.slice(8, 11), [Model.notificationText("--exec"), Model.notificationText("-rf"), "--exec"])
  assert.notEqual(tricky[8], "--exec", "dash-leading text is guarded before it reaches the helper")
  assert.deepEqual(Model.toastCommand(context, {}, "Fastmail\nx", "", 0), [], "no trusted sender, no toast")
})

test("TUI clicks go to the runner with checked ids only", () => {
  assert.deepEqual(Model.tuiOpenCommand(context, "AB5kIMdwqots", "StmlKEsTVdXB"),
    openTui("--thread", "AB5kIMdwqots", "--email", "StmlKEsTVdXB"))
  assert.deepEqual(Model.tuiOpenCommand(context, "AB5kIMdwqots", ""), openTui("--thread", "AB5kIMdwqots"))
  assert.deepEqual(Model.tuiOpenCommand(context, "", ""), openTui())
  assert.deepEqual(Model.tuiOpenCommand(null, "AB5kIMdwqots", ""), [])
  const command = Model.toastCommand(context, tools, "Fastmail\nLunch on Thursday?", "Are you free?", 0,
    "tui", "https://app.fastmail.com/mail/Inbox/AB5kIMdwqots.StmlKEsTVdXB", "AB5kIMdwqots", "StmlKEsTVdXB")
  assert.deepEqual(command.slice(command.indexOf("--exec") + 1), openTui("--thread", "AB5kIMdwqots", "--email", "StmlKEsTVdXB"))
  assert.deepEqual(Model.toastExecCommand(context, tools, "unexpected", "https://example.com"), openTui())
  assert.deepEqual(Model.openCommand(context, tools, "tui", "", "", ""), openTui(), "no ids: plain focus")
})

test("ids that are not JMAP ids never reach a command line", () => {
  for (const bad of ["AB5k;echo INJECTED", "$(id)", "a b", "x'y", "--remote", "-", "", null, "é", "a".repeat(65)]) {
    assert.equal(Model.validId(bad), "", `rejects ${JSON.stringify(bad)}`)
    assert.deepEqual(Model.seenCommand(context, bad, "u12345678"), [], `seen refuses ${JSON.stringify(bad)}`)
    assert.deepEqual(Model.tuiTargetArgs(bad, bad), [], `tui refuses ${JSON.stringify(bad)}`)
    assert.deepEqual(Model.tuiOpenCommand(context, bad, bad), openTui(), `open-tui refuses ${JSON.stringify(bad)}`)
  }
  assert.equal(Model.validId("AB5kIMdwqots"), "AB5kIMdwqots")
  assert.equal(Model.validId("  u5afe405d "), "u5afe405d")
  assert.deepEqual(Model.capturedCommandPayload(Model.seenCommand(context, "AB5kIMdwqots", "-a")),
    ["fm-cli", "seen", "AB5kIMdwqots", "--json"], "a bad account id is dropped, not passed")
  const items = Model.parseNotifications(JSON.stringify({ ok: true, data: { postings: [
    { id: "AB5k;echo", name: "bad" }, { id: "AB5kIMdwqots", email_id: "St'ml", account_id: "u$1", name: "ok" }
  ] } }), 10, []).items
  assert.equal(items.length, 1, "a posting with a bad id is dropped")
  assert.equal(items[0].emailId, "", "a bad email id is blanked")
  assert.equal(items[0].accountId, "", "a bad account id is blanked")
})

test("cleanText strips controls, bidi overrides and zero-width characters", () => {
  assert.equal(Model.cleanText("Inv\u202Efdp.exe\u001b[31m\u200bx\u0007y"), "Inv fdp.exe [31m x y")
  assert.equal(Model.cleanText("plain text"), "plain text")
})

test("fastmailBrowserUrl stays on the canonical Fastmail origin", () => {
  assert.equal(Model.fastmailWebUrl, "https://app.fastmail.com")
  assert.equal(Model.fastmailInboxUrl, "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots?x=1"), "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots?x=1")
  assert.equal(Model.fastmailBrowserUrl("HTTPS://APP.FASTMAIL.COM/mail/Inbox"), "HTTPS://APP.FASTMAIL.COM/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("https://app.fastmail.com"), "https://app.fastmail.com")
  assert.equal(Model.fastmailBrowserUrl("/mail/Inbox/TAB5kIMdwqots"), "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots")
  assert.equal(Model.fastmailBrowserUrl("https://app.fastmail.com.example.com/mail"), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("http://app.fastmail.com/mail/Inbox"), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("https://www.fastmail.com/"), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("javascript:alert(1)"), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl(""), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl(null), "https://app.fastmail.com/mail/Inbox")
  assert.equal(Model.fastmailBrowserUrl("https://app.fastmail.com/" + "u".repeat(3000)).length, Model.remoteUrlCharacterLimit)
})

test("toastCommand opens a message in the web app window or the browser as argv", () => {
  const app = Model.toastCommand(context, tools, "Fastmail\nLunch on Thursday?", "Are you free?", 0,
    "app", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots?from=notification")
  assert.deepEqual(app.slice(-3), ["--exec", "/usr/bin/omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots?from=notification"])
  assert.deepEqual(Model.toastExecCommand(context, tools, "app", "/mail/Inbox/TAB5kIMdwqots"),
    ["/usr/bin/omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots"])
  assert.deepEqual(Model.toastExecCommand(context, tools, "app", "https://example.com/mail/Inbox"),
    ["/usr/bin/omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox"])
  assert.deepEqual(Model.toastExecCommand(context, tools, "browser", "/mail/Inbox/TAB5kIMdwqots"), ["/usr/bin/xdg-open", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots"])
  assert.deepEqual(Model.toastExecCommand(context, tools, "browser", "javascript:alert(1)"), ["/usr/bin/xdg-open", "https://app.fastmail.com/mail/Inbox"])
  assert.deepEqual(Model.toastExecCommand(context, tools, "browser", "https://app.fastmail.com/mail/Inbox/T'quoted"), ["/usr/bin/xdg-open", "https://app.fastmail.com/mail/Inbox/T'quoted"])
  assert.deepEqual(Model.toastCommand(context, {}, "Fastmail\nx", "", 0, "app", ""), [], "no trusted launcher, no toast")
})
test("notificationText keeps mail text from being read as an option", () => {
  const command = Model.toastCommand(context, tools, "-r Systems Ltd — --help with the quarterly numbers", "-p please see attached", 0)
  for (const arg of command.slice(0, command.indexOf("--exec") + 1)) {
    if (arg.startsWith("-")) assert.ok(["--app-name", "-u", "--exec", "-i", "-p", "-r"].includes(arg), `mail text arrived as an option: ${arg}`)
  }
  assert.ok(command.includes("\u2060-r Systems Ltd — --help with the quarterly numbers"))
  assert.ok(command.includes("\u2060-p please see attached"))
  assert.equal(Model.notificationText("Lunch on Thursday?"), "Lunch on Thursday?")
})

test("replaceableToastId trusts the last id for ten minutes only", () => {
  const sentAt = 1_000_000
  assert.equal(Model.replaceableToastId(42, sentAt, sentAt + 60_000), 42)
  assert.equal(Model.replaceableToastId(42, sentAt, sentAt + Model.toastReplaceWindowMs + 1), 0, "a toast id from before a shell restart may belong to another application")
  assert.equal(Model.replaceableToastId(0, sentAt, sentAt), 0)
  assert.equal(Model.replaceableToastId("garbage", sentAt, sentAt), 0)
})

test("boundedString and boundedRemoteCount reject objects and keep surrogate pairs whole", () => {
  assert.equal(Model.boundedString({ a: 1 }), "")
  assert.equal(Model.boundedString("😀😀", 3), "😀")
  assert.equal(Model.boundedString("abc", 3), "abc")
  assert.equal(Model.boundedRemoteCount({}, 7), 7)
  assert.equal(Model.boundedRemoteCount(" 12 ", 7), 12)
  assert.equal(Model.boundedRemoteCount("-1", 7), 7)
  assert.equal(Model.boundedRemoteCount(String(Model.remoteCountMaximum + 5), 7), Model.remoteCountMaximum)
})
