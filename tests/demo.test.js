const test = require("node:test")
const assert = require("node:assert/strict")
const { mkdtempSync, rmSync } = require("node:fs")
const { tmpdir } = require("node:os")
const path = require("node:path")
const { spawn, spawnSync } = require("node:child_process")
const Model = require("../Model.js")

const cli = path.join(__dirname, "..", "demo", "bin", "fm-cli")

function demo(args, stateDir) {
  return spawnSync(cli, args, {
    encoding: "utf8",
    env: { ...process.env, FM_DEMO_STATE_DIR: stateDir }
  })
}

function successfulJson(args, stateDir) {
  const result = demo(args, stateDir)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function withState(run) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "fm-demo-test-"))
  try {
    return run(stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

async function withStateAsync(run) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "fm-demo-test-"))
  try {
    return await run(stateDir)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

test("demo CLI fixtures follow the fm-cli scripting contract", () => {
  withState(stateDir => {
    const version = demo(["--version"], stateDir)
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), "fm-cli version 0.3.0")
    assert.equal(Model.parseProbe(version.stdout).version, "0.3.0")
    assert.equal(Model.cliVersionTooOld(Model.parseProbe(version.stdout).version), false)

    const auth = successfulJson(["auth", "status", "--json"], stateDir)
    assert.equal(auth.data.authenticated, true)
    assert.equal(auth.data.auth_type, "oauth")
    assert.equal(auth.data.username, "alex@example.com")

    const setup = demo(["setup", "--silent-success"], stateDir)
    assert.equal(setup.status, 0, setup.stderr)
    assert.equal(setup.stdout, "")

    const accountsResult = successfulJson(["account", "list", "--json"], stateDir)
    assert.equal(accountsResult.data.filter(account => account.active).length, 1)
    const accounts = Model.parseAccounts(JSON.stringify(accountsResult))
    assert.equal(accounts.ok, true)
    assert.equal(accounts.accounts.length, 3)
    assert.ok(accounts.accounts.every(account => /^u[0-9a-f]{8}$/.test(account.id)))

    const box = successfulJson([
      "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    assert.equal(box.data.kind, "inbox")
    assert.equal(box.data.name, "Inbox")
    assert.equal(box.data.unread_count, 7)
    assert.equal(box.data.total_count, 8)
    assert.ok(box.data.folders.every(folder => folder.kind === "inbox"), "an Inbox read lists the Inbox alone")
    assert.equal(box.data.folders.length, 3)
    const notifications = Model.parseNotifications(JSON.stringify(box), 50, accounts.accounts)
    assert.equal(notifications.ok, true)
    assert.equal(notifications.items.length, 8)
    assert.equal(notifications.items.filter(item => item.unread).length, 7)
    assert.ok(notifications.items.every(item => item.boxKind === "inbox"))
    assert.ok(box.data.postings.every(item => item.app_url === ""))
    assert.ok(box.data.postings.every(item => item.thread_id === item.id))
    assert.ok(box.data.postings.every(item => item.box_kind === "inbox" && item.box_name === "Inbox"))
    assert.ok(box.data.postings.every(item => typeof item.creator.email_address === "string"))
    assert.ok(box.data.postings.every(item => Number.isFinite(Date.parse(item.active_at))))
    assert.ok(box.data.postings.every(item => item.seen === (item.unseen_count === 0)))
    assert.equal(notifications.items.find(item => item.id === "Tk3f9qLm2Xa1").unreadCount, 2)
  })
})

test("demo CLI serves the all box with folders and unseen threads from other folders", () => {
  withState(stateDir => {
    const accounts = Model.parseAccounts(JSON.stringify(successfulJson(["account", "list", "--json"], stateDir))).accounts
    const box = successfulJson(Model.capturedCommandPayload(Model.boxCommand(50, true, "all", "")).slice(1), stateDir)
    assert.equal(box.data.id, "all")
    assert.equal(box.data.kind, "all")
    assert.equal(box.data.name, "All folders")
    assert.equal(box.data.unread_count, 11)
    assert.equal(box.data.postings.length, 12)
    assert.deepEqual(box.data.folders.map(folder => [folder.name, folder.kind, folder.unread_count, folder.account_id]), [
      ["Inbox", "inbox", 2, "u1a2b3c4d"],
      ["Finance", "", 2, "u1a2b3c4d"],
      ["Family", "", 1, "u1a2b3c4d"],
      ["Inbox", "inbox", 3, "u2b3c4d5e"],
      ["Newsletters", "", 1, "u2b3c4d5e"],
      ["Inbox", "inbox", 2, "u3c4d5e6f"]
    ])
    assert.ok(box.data.folders.every(folder => typeof folder.id === "string" && folder.id !== "" && typeof folder.total_count === "number"))
    assert.ok(box.data.postings.every(item => typeof item.box_id === "string" && typeof item.box_kind === "string" && typeof item.box_name === "string"))
    assert.ok(box.data.postings.filter(item => item.box_kind !== "inbox").every(item => item.seen === false), "other folders contribute unseen threads only")
    assert.ok(box.data.postings.some(item => item.box_kind === "inbox" && item.seen === true), "the Inbox contributes its newest threads, seen or not")

    const parsed = Model.parseNotifications(JSON.stringify(box), 50, accounts)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.items.length, 12)
    assert.equal(parsed.folders.length, 6)
    const chips = Model.folderChips(parsed.folders, "")
    assert.deepEqual(chips.map(chip => [chip.name, chip.unreadCount]), [["Inbox", 7], ["Finance", 2], ["Family", 1], ["Newsletters", 1]])
    assert.equal(Model.unreadCount(parsed.items, ""), 11)
    assert.equal(Model.filterNotifications(parsed.items, "", "unread", chips[1].id, chips).length, 2)
    assert.equal(Model.filterNotifications(parsed.items, "", "unread", chips[0].id, chips).length, 7)
    assert.equal(Model.filterNotifications(parsed.items, "", "previous", "", chips).length, 1)
    assert.equal(Model.folderChips(parsed.folders, "u2b3c4d5e").map(chip => chip.name).join(","), "Inbox,Newsletters")
  })
})

test("demo CLI honors repeated --exclude pairs on the all box", () => {
  withState(stateDir => {
    const command = Model.capturedCommandPayload(Model.boxCommand(50, true, "all", "newsletters, Family")).slice(1)
    assert.deepEqual(command.slice(-4), ["--exclude", "newsletters", "--exclude", "Family"])
    const box = successfulJson(command, stateDir)
    assert.equal(box.data.unread_count, 9)
    assert.deepEqual(box.data.folders.filter(folder => folder.kind !== "inbox").map(folder => folder.name), ["Finance"])
    assert.ok(box.data.postings.every(item => !["Newsletters", "Family"].includes(item.box_name)))

    const withoutAccount = successfulJson(["box", "view", "all", "--limit", "50", "--json", "--exclude", "Pfin1"], stateDir)
    assert.ok(withoutAccount.data.folders.every(folder => folder.id !== "Pfin1"), "an id excludes too")
    assert.equal(withoutAccount.data.postings.filter(item => item.box_name === "Finance").length, 0)
  })
})

test("demo CLI drops a folder from the all box once its last unseen thread is seen", () => {
  withState(stateDir => {
    const before = successfulJson(["box", "view", "all", "--account", "all", "--limit", "50", "--json"], stateDir)
    assert.ok(before.data.folders.some(folder => folder.name === "Family"))
    successfulJson(["seen", "Tg4r7Dm2Kx9p", "--account", "u1a2b3c4d", "--json"], stateDir)
    const after = successfulJson(["box", "view", "all", "--account", "all", "--limit", "50", "--json"], stateDir)
    assert.ok(after.data.folders.every(folder => folder.name !== "Family"))
    assert.equal(after.data.postings.find(item => item.id === "Tg4r7Dm2Kx9p"), undefined)
    assert.equal(after.data.unread_count, 10)
  })
})

test("demo CLI keeps seen state for subsequent refreshes", () => {
  withState(stateDir => {
    const before = successfulJson([
      "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    assert.equal(before.data.postings.find(item => item.id === "Tk3f9qLm2Xa1").seen, false)

    const seen = successfulJson(["seen", "Tk3f9qLm2Xa1", "--account", "u1a2b3c4d", "--json"], stateDir)
    assert.deepEqual(seen.data, { ids: ["Tk3f9qLm2Xa1"], seen: true })

    const after = successfulJson([
      "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"
    ], stateDir)
    const posting = after.data.postings.find(item => item.id === "Tk3f9qLm2Xa1")
    assert.equal(posting.seen, true)
    assert.equal(posting.unseen_count, 0)
    assert.equal(after.data.unread_count, 6)
  })
})

test("demo CLI rejects a seen request for the wrong account", () => {
  withState(stateDir => {
    const result = demo(["seen", "Tk3f9qLm2Xa1", "--account", "u2b3c4d5e", "--json"], stateDir)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
    const failure = Model.parseFailure(result.stdout, result.stderr)
    assert.equal(failure.code, "remote")
    assert.match(failure.error, /Unknown demo posting/)
  })
})

test("demo watch becomes ready and stays alive", async () => {
  await withStateAsync(stateDir => new Promise((resolve, reject) => {
    const child = spawn(cli, ["--account", "all", "watch", "--events", "added,updated,deleted,new,resync"], {
      env: { ...process.env, FM_DEMO_STATE_DIR: stateDir }
    })
    let output = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("demo watch did not become ready"))
    }, 2000)
    child.stdout.on("data", chunk => {
      output += chunk
      if (!output.includes("\n")) return
      clearTimeout(timeout)
      assert.deepEqual(JSON.parse(output.trim()), { change: "ready" })
      assert.equal(Model.watchLine(output).change, "ready")
      child.once("exit", code => {
        assert.equal(code, 0)
        resolve()
      })
      child.kill("SIGTERM")
    })
    child.once("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
  }))
})

test("demo CLI accepts the terminal command the plugin focuses", () => {
  withState(stateDir => {
    for (const args of [["tui"], []]) {
      const result = demo(args, stateDir)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, "")
    }
  })
})

test("demo CLI rejects commands outside the plugin contract with a usage error", () => {
  withState(stateDir => {
    for (const args of [
      ["box", "view", "archive", "--json"],
      ["box", "view", "inbox", "--json"],
      ["box", "view", "all", "--json"],
      ["box", "view", "all", "--account", "all", "--limit", "50", "--json", "--exclude"],
      ["box", "view", "all", "--account", "all", "--limit", "50", "--json", "--exclude", "--json"],
      ["box", "view", "all", "--account", "all", "--limit", "50", "--json", "--exclude", "-x"],
      ["box", "view", "inbox", "--account", "all", "--limit", "50", "--json", "--exclude", "Finance"],
      ["box", "view", "all", "--account", "all", "--limit", "20", "--json"],
      ["box", "list", "--json"],
      ["inbox", "--json"],
      ["account", "list"],
      ["account", "list", "--json", "unexpected"],
      ["accounts", "list", "--json"],
      ["unseen", "Tk3f9qLm2Xa1", "--account", "u1a2b3c4d", "--json"],
      ["nonsense", "watch"],
      ["--account", "all", "watch", "--events", "added"],
      ["tui", "--remote"],
      ["seen", "Tk3f9qLm2Xa1", "--json"],
      ["seen", "all", "--account", "u1a2b3c4d", "--json"]
    ]) {
      const result = demo(args, stateDir)
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, "")
      assert.match(result.stderr, /Unsupported demo fm-cli command/)
      assert.equal(Model.parseFailure(result.stdout, result.stderr).code, "usage")
    }
  })
})
