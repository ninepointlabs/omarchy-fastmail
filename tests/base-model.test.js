const test = require("node:test")
const assert = require("node:assert/strict")

const Model = require("../Model.js")

function response(data) {
  return JSON.stringify({ ok: true, data })
}

function posting(overrides = {}) {
  return {
    id: "AB5kIMdwqots",
    thread_id: "AB5kIMdwqots",
    email_id: "StmlKEsTVdXB",
    account_id: "u12345678",
    name: "A new message",
    summary: "Message summary",
    creator: { name: "Ada Lovelace", email_address: "ada@example.com" },
    active_at: "2025-02-03T12:00:00Z",
    app_url: "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots",
    seen: false,
    ...overrides
  }
}

const setupContext = Model.runtimeContext("/usr/bin/python3", "/opt/plugins/ninepointlabs.fastmail")
const terminal = "/usr/bin/omarchy-launch-floating-terminal-with-presentation"
const setupTools = { "omarchy-launch-floating-terminal-with-presentation": terminal, "wl-copy": "/usr/bin/wl-copy" }

function setupShell(mode) {
  return `'/usr/bin/python3' '-I' '-S' '-B' '/opt/plugins/ninepointlabs.fastmail/bin/fm-cli-run' 'setup' '${mode}' 'ninepointlabs.fastmail'`
}

test("setupPlan signs in when fm-cli is installed and current", () => {
  const plan = Model.setupPlan(true, false, false, "ninepointlabs.fastmail", setupContext, setupTools)

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "Please sign in")
  assert.equal(plan.buttonLabel, "Sign in to Fastmail…")
  assert.equal(plan.command, "fm-cli setup --silent-success")
  assert.equal(plan.mode, "signin")
  assert.deepEqual(plan.launchCommand, [terminal, setupShell("signin")])
})

test("setupPlan installs fm-cli before signing in", () => {
  const plan = Model.setupPlan(false, false, false, "ninepointlabs.fastmail", setupContext, setupTools)

  assert.equal(plan.needed, true)
  assert.equal(plan.title, "")
  assert.equal(plan.buttonLabel, "Install fm-cli…")
  assert.equal(plan.command, "")
  assert.deepEqual(plan.launchCommand, [terminal, setupShell("install")])
})

test("setupPlan updates an outdated signed-out CLI before setup", () => {
  const plan = Model.setupPlan(true, false, true, "ninepointlabs.fastmail", setupContext, setupTools)

  assert.equal(plan.needed, true)
  assert.equal(plan.buttonLabel, "Update fm-cli…")
  assert.deepEqual(plan.launchCommand, [terminal, setupShell("install")])
})

test("setupPlan prioritizes installation and is not needed when setup is complete", () => {
  assert.equal(Model.setupPlan(false, true, false, "ninepointlabs.fastmail", setupContext, setupTools).buttonLabel, "Install fm-cli…")
  assert.equal(Model.setupPlan(true, true, false, "ninepointlabs.fastmail", setupContext, setupTools).needed, false)
})

test("the setup launch fails closed without a trusted launcher, a runtime, or a plain IPC target", () => {
  assert.deepEqual(Model.setupPlan(true, false, false, "ninepointlabs.fastmail", setupContext, {}).launchCommand, [])
  assert.deepEqual(Model.setupPlan(true, false, false, "ninepointlabs.fastmail", null, setupTools).launchCommand, [])
  assert.deepEqual(Model.setupPlan(true, false, false, "target's name", setupContext, setupTools).launchCommand, [])
  assert.deepEqual(Model.setupPlan(true, false, false, "ninepointlabs.fastmail", setupContext,
    { "omarchy-launch-floating-terminal-with-presentation": "/home/me/bin/omarchy-launch-floating-terminal-with-presentation" }).launchCommand, [])
  assert.deepEqual(Model.setupLaunchCommand(setupContext, setupTools, "rm", "ninepointlabs.fastmail"), [])
})

test("the one string the terminal launcher evaluates splits back into the exact argv", () => {
  const odd = Model.runtimeContext("/usr/bin/python3", "/home/o'neil/My Plugins/$(touch x);fastmail")
  const [, shell] = Model.setupLaunchCommand(odd, setupTools, "signin", "ninepointlabs.fastmail")
  const { spawnSync } = require("node:child_process")
  const result = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-c", "printf '%s\\n' " + shell], { encoding: "utf8", env: {} })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trimEnd().split("\n"), [
    "/usr/bin/python3", "-I", "-S", "-B", "/home/o'neil/My Plugins/$(touch x);fastmail/bin/fm-cli-run",
    "setup", "signin", "ninepointlabs.fastmail"
  ])
})

test("setupLockCheckCommand runs the runner under the supervisor", () => {
  const command = Model.setupLockCheckCommand(setupContext)
  assert.equal(command[0], "/usr/bin/python3")
  assert.equal(command[4], setupContext.supervisor)
  assert.deepEqual(Model.capturedCommandPayload(command), ["fm-cli-run", "setup-lock-check"])
  assert.deepEqual(Model.setupLockCheckCommand(null), [])
})

test("copyCommand hands the text to the resolved wl-copy as one argument", () => {
  assert.deepEqual(Model.copyCommand(setupTools, "fm-cli setup --silent-success"),
    ["/usr/bin/wl-copy", "--", "fm-cli setup --silent-success"])
  assert.deepEqual(Model.copyCommand({}, "x"), [])
})

test("parseProbe reads the tool table, the identity, the version and the status", () => {
  const probe = Model.parseProbe('tools {"xdg-open":"/usr/bin/xdg-open","wl-copy":"/home/me/bin/wl-copy","omarchy-launch-webapp":"/usr/bin/xdg-open","evil":"/usr/bin/evil"}\n'
    + 'identity {"source":"package","path":"/usr/bin/fm-cli"}\nfm-cli version 0.3.1\n{"ok":true}')
  assert.deepEqual(probe.tools, { "xdg-open": "/usr/bin/xdg-open" })
  assert.equal(probe.state, "ok")
  assert.deepEqual(probe.identity, { source: "package", path: "/usr/bin/fm-cli" })
  assert.equal(probe.version, "0.3.1")
  assert.equal(probe.status, '{"ok":true}')

  assert.equal(Model.parseProbe("tools {}\nmissing\n").state, "missing")
  const untrusted = Model.parseProbe('tools not-json\nuntrusted {"reason":"bad\\u202ebytes"}\n')
  assert.equal(untrusted.state, "untrusted")
  assert.equal(untrusted.reason, "bad bytes")
  assert.equal(Model.parseProbe('untrusted nope').reason, "fm-cli failed verification")
  assert.equal(Model.parseProbe("x".repeat(Model.probeResponseByteLimit + 1)).status, "")
  assert.deepEqual(Model.parseProbe('{"ok":true}'), { tools: {}, state: "", identity: null, reason: "", version: "", status: '{"ok":true}' })
})

test("fileUrlPath accepts only plain absolute file URLs", () => {
  assert.equal(Model.fileUrlPath("file:///home/me/.config/omarchy/plugins/ninepointlabs.fastmail/"), "/home/me/.config/omarchy/plugins/ninepointlabs.fastmail")
  assert.equal(Model.fileUrlPath("file:///home/me/My%20Plugins"), "/home/me/My Plugins")
  for (const bad of ["http://x/", "file://relative", "file:///a/../b", "file:///a/%0Ab", "file:///a/%E0%A4%A", "", null]) {
    assert.equal(Model.fileUrlPath(bad), "", String(bad))
  }
})

test("parseJson accepts successful objects and reports CLI errors", () => {
  assert.deepEqual(Model.parseJson('{"ok":true,"data":{"authenticated":true}}'), {
    ok: true,
    value: { ok: true, data: { authenticated: true } }
  })
  assert.deepEqual(Model.parseJson('{"ok":false,"code":"auth","error":" Sign &amp; in ","hint":" Try again "}'), {
    ok: false,
    error: "Sign & in",
    code: "auth",
    hint: "Try again"
  })
})

test("parseJson rejects empty, malformed, primitive, and oversized responses", () => {
  assert.deepEqual(Model.parseJson(""), {
    ok: false, error: "fm-cli returned no data", code: ""
  })
  assert.deepEqual(Model.parseJson("{"), {
    ok: false, error: "Could not parse the fm-cli response", code: ""
  })
  assert.deepEqual(Model.parseJson("null"), {
    ok: false, error: "fm-cli returned invalid data", code: ""
  })
  assert.deepEqual(Model.parseJson("[]"), {
    ok: false, error: "fm-cli returned invalid data", code: ""
  })
  assert.deepEqual(Model.parseJson("42"), {
    ok: false, error: "fm-cli returned invalid data", code: ""
  })
  assert.deepEqual(Model.parseJson('{"ok":true}', 4), {
    ok: false, error: "The fm-cli response exceeded its size limit", code: ""
  })
  assert.equal(Model.exceedsUtf8ByteLimit("😀", 3), true)
  assert.equal(Model.exceedsUtf8ByteLimit("😀", 4), false)
})

test("parseAccounts removes the all keyword and normalizes names and order", () => {
  const parsed = Model.parseAccounts(response([
    { id: "all", name: "All" },
    { id: " u1 ", name: " Work &amp; Stuff ", email: "work@example.com" },
    { id: "u2", name: "", email: "second@example.com" },
    { id: "u3", name: "" },
    { id: "", name: "Missing" }
  ]))

  assert.deepEqual(parsed, {
    ok: true,
    error: "",
    accounts: [
      { id: "u1", name: "Work & Stuff", order: 0 },
      { id: "u2", name: "second@example.com", order: 1 },
      { id: "u3", name: "Account u3", order: 2 }
    ]
  })
})

test("parseAccounts caps its source array and every stored field", () => {
  const source = Array.from({ length: Model.maximumAccountCount + 20 }, (_, index) => ({
    id: String(index).repeat(100),
    name: "N".repeat(500)
  }))
  const parsed = Model.parseAccounts(response(source))

  assert.equal(parsed.accounts.length, Model.maximumAccountCount)
  assert.ok(parsed.accounts.every(account => account.id.length <= Model.remoteIdCharacterLimit))
  assert.ok(parsed.accounts.every(account => account.name.length <= Model.remoteNameCharacterLimit))
})

test("parseAccounts returns an empty list for CLI errors or missing data", () => {
  assert.deepEqual(Model.parseAccounts('{"ok":false,"error":"nope"}'), {
    ok: false, error: "nope", accounts: []
  })
  assert.deepEqual(Model.parseAccounts(response({ accounts: [] })).accounts, [])
})

test("parseNotifications normalizes postings and account metadata", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({
      creator: { name: "Ada &amp; Bob", email_address: "ada@example.com", initials: "AB" },
      name: "<b>Hello</b>",
      summary: "First<br>Second",
      unseen_count: 2,
      visible_entry_count: 3
    })
  ] }), 50, [{ id: "u12345678", name: "Personal", order: 3 }])

  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.items[0], {
    id: "AB5kIMdwqots",
    accountId: "u12345678",
    accountName: "Personal",
    accountOrder: 3,
    title: "Hello",
    excerpt: "First Second",
    project: "",
    creator: "Ada & Bob",
    initials: "AB",
    type: "email",
    timestamp: "2025-02-03T12:00:00Z",
    timestampMs: Date.parse("2025-02-03T12:00:00Z"),
    url: "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots",
    emailId: "StmlKEsTVdXB",
    boxId: "",
    boxKind: "inbox",
    boxName: "Inbox",
    unread: true,
    unreadCount: 2
  })
  assert.deepEqual(parsed.folders, [], "an Inbox read without a folders array lists no folders")
})

test("parseNotifications keeps the folder each posting is reported from", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({ id: "finance", box_id: "Pibo", box_kind: "", box_name: "FInance" }),
    posting({ id: "inbox", box_id: "P-F", box_kind: "inbox", box_name: "Inbox" }),
    posting({ id: "shouting", box_id: "P-A", box_kind: "ARCHIVE", box_name: "<b>Archive</b>" }),
    posting({ id: "nameless", box_id: "Pz", box_kind: "" }),
    posting({ id: "nameless-inbox", box_id: "P-F", box_kind: "inbox" }),
    posting({ id: "nulls", box_id: null, box_kind: null, box_name: null }),
    posting({ id: "bounded", box_id: "i".repeat(100), box_kind: "k".repeat(100), box_name: "N".repeat(500) })
  ] }), 50, [])
  const byId = Object.fromEntries(parsed.items.map(item => [item.id, item]))

  assert.deepEqual([byId.finance.boxId, byId.finance.boxKind, byId.finance.boxName], ["Pibo", "", "FInance"])
  assert.deepEqual([byId.inbox.boxId, byId.inbox.boxKind, byId.inbox.boxName], ["P-F", "inbox", "Inbox"])
  assert.deepEqual([byId.shouting.boxKind, byId.shouting.boxName], ["archive", "Archive"])
  assert.equal(byId.nameless.boxName, "Folder")
  assert.equal(byId["nameless-inbox"].boxName, "Inbox")
  assert.deepEqual([byId.nulls.boxId, byId.nulls.boxKind, byId.nulls.boxName], ["", "inbox", "Inbox"], "null box fields are missing ones")
  assert.equal(byId.bounded.boxId.length, Model.remoteIdCharacterLimit)
  assert.equal(byId.bounded.boxKind.length, Model.remoteTypeCharacterLimit)
  assert.equal(byId.bounded.boxName.length, Model.remoteNameCharacterLimit)
})

test("parseFolders normalizes and bounds the read's folders", () => {
  const parsed = Model.parseNotifications(response({ folders: [
    { id: "P-F", kind: "inbox", name: "Inbox", account_id: "u1", unread_count: 3, total_count: 162, app_url: "https://app.fastmail.com/mail/Inbox?u=1" },
    { id: "Pibo", kind: "", name: " <i>FInance</i> ", account_id: "u1", unread_count: "44", total_count: 241 },
    { id: "", name: "ignored" },
    null,
    { id: "Pn", kind: "INBOX" },
    { id: "Px", unread_count: -4, total_count: "lots" }
  ], postings: [] }), 50, [])

  assert.deepEqual(parsed.folders, [
    { id: "P-F", kind: "inbox", name: "Inbox", accountId: "u1", unreadCount: 3, totalCount: 162, url: "https://app.fastmail.com/mail/Inbox?u=1" },
    { id: "Pibo", kind: "", name: "FInance", accountId: "u1", unreadCount: 44, totalCount: 241, url: "" },
    { id: "Pn", kind: "inbox", name: "Inbox", accountId: "", unreadCount: 0, totalCount: 0, url: "" },
    { id: "Px", kind: "", name: "Folder", accountId: "", unreadCount: 0, totalCount: 0, url: "" }
  ])
  assert.deepEqual(Model.parseFolders(null), [])
  assert.deepEqual(Model.parseFolders({ folders: "Inbox" }), [])

  const many = Model.parseFolders({ folders: Array.from({ length: Model.maximumFolderCount + 10 }, (_, index) => ({
    id: String(index).repeat(100), name: "N".repeat(500), kind: "K".repeat(100), account_id: "a".repeat(100), app_url: "/" + "u".repeat(3000)
  })) })
  assert.equal(many.length, Model.maximumFolderCount)
  assert.equal(Model.maximumFolderCount, 64)
  for (const folder of many) {
    assert.ok(folder.id.length <= Model.remoteIdCharacterLimit)
    assert.ok(folder.name.length <= Model.remoteNameCharacterLimit)
    assert.ok(folder.kind.length <= Model.remoteTypeCharacterLimit)
    assert.ok(folder.accountId.length <= Model.remoteIdCharacterLimit)
    assert.ok(folder.url.length <= Model.remoteUrlCharacterLimit)
  }
})

const chipFolders = [
  { id: "P-F", kind: "inbox", name: "Inbox", accountId: "u1", unreadCount: 3 },
  { id: "Pibo", kind: "", name: "Finance", accountId: "u1", unreadCount: 44 },
  { id: "Pfam", kind: "", name: "Family", accountId: "u1", unreadCount: 0 },
  { id: "Pb-F", kind: "inbox", name: "Inbox", accountId: "u2", unreadCount: 2 },
  { id: "Pnws", kind: "", name: "Newsletters", accountId: "u2", unreadCount: 1 }
]

test("folderChips puts one Inbox first, then every folder with unseen mail", () => {
  assert.deepEqual(Model.folderChips(chipFolders, ""), [
    { id: "P-F", kind: "inbox", name: "Inbox", unreadCount: 5 },
    { id: "Pibo", kind: "", name: "Finance", unreadCount: 44 },
    { id: "Pnws", kind: "", name: "Newsletters", unreadCount: 1 }
  ])
})

test("folderChips follows the account filter", () => {
  assert.deepEqual(Model.folderChips(chipFolders, "u2"), [
    { id: "Pb-F", kind: "inbox", name: "Inbox", unreadCount: 2 },
    { id: "Pnws", kind: "", name: "Newsletters", unreadCount: 1 }
  ])
  assert.deepEqual(Model.folderChips(chipFolders, "u1").map(chip => chip.name), ["Inbox", "Finance"])
  // Folders without an account belong to every account.
  assert.deepEqual(Model.folderChips([{ id: "Pq", kind: "", name: "Quotes", unreadCount: 2 }], "u9").map(chip => chip.name), ["Inbox", "Quotes"])
})

test("folderChips is empty without folders and synthesizes a missing Inbox", () => {
  assert.deepEqual(Model.folderChips([], ""), [])
  assert.deepEqual(Model.folderChips(null, ""), [])
  assert.deepEqual(Model.folderChips([{ id: "Pibo", kind: "", name: "Finance", unreadCount: 2 }], ""), [
    { id: "inbox", kind: "inbox", name: "Inbox", unreadCount: 0 },
    { id: "Pibo", kind: "", name: "Finance", unreadCount: 2 }
  ])
  assert.deepEqual(Model.folderChips([{ id: "", name: "no id", unreadCount: 2 }, { id: "P-F", kind: "inbox", name: "" }], ""),
    [{ id: "P-F", kind: "inbox", name: "Inbox", unreadCount: 0 }])
  const many = Model.folderChips(Array.from({ length: Model.maximumFolderCount + 10 }, (_, index) => ({
    id: "f" + index, kind: "", name: "N".repeat(500), unreadCount: 1
  })), "")
  assert.equal(many.length, Model.maximumFolderCount + 1)
  assert.ok(many.every(chip => chip.name.length <= Model.remoteNameCharacterLimit))
})

test("folderFilterMatches matches the Inbox by role and other folders by id", () => {
  const chips = Model.folderChips(chipFolders, "")
  const inboxA = { id: "a", boxId: "P-F", boxKind: "inbox" }
  const inboxB = { id: "b", boxId: "Pb-F", boxKind: "inbox" }
  const finance = { id: "c", boxId: "Pibo", boxKind: "" }
  assert.equal(Model.folderFilterMatches(inboxA, "", chips), true)
  assert.equal(Model.folderFilterMatches(inboxA, "P-F", chips), true)
  assert.equal(Model.folderFilterMatches(inboxB, "P-F", chips), true, "every account's Inbox is the Inbox chip's")
  assert.equal(Model.folderFilterMatches(finance, "P-F", chips), false)
  assert.equal(Model.folderFilterMatches(finance, "Pibo", chips), true)
  assert.equal(Model.folderFilterMatches(inboxA, "Pibo", chips), false)
  assert.equal(Model.folderFilterMatches(finance, "Pibo", null), true, "an unknown chip matches by id alone")
  assert.equal(Model.folderFilterMatches(inboxB, "P-F", null), false)
  assert.equal(Model.folderFilterMatches(null, "Pibo", chips), false)
  assert.equal(Model.folderFilterMatches(null, "", chips), true)
})

test("parseNotifications badges the visible count when the unseen count is missing", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({ visible_entry_count: 3 }),
    posting({ id: "second", unseen_count: "x", visible_entry_count: 4 }),
    posting({ id: "third" })
  ] }), 50, [])

  assert.equal(parsed.items.find(item => item.id === "AB5kIMdwqots").unreadCount, 3)
  assert.equal(parsed.items.find(item => item.id === "second").unreadCount, 4)
  assert.equal(parsed.items.find(item => item.id === "third").unreadCount, 1)
})

test("parseNotifications uses fallbacks and ignores postings without IDs", () => {
  const parsed = Model.parseNotifications(response({ postings: [
    posting({ id: "", name: "ignored" }),
    posting({
      id: "Zq9",
      name: "",
      summary: "",
      creator: null,
      alternative_sender_name: "Grace Hopper",
      active_at: "not-a-date",
      created_at: "also-invalid",
      seen: true
    }),
    posting({
      id: "addressOnly",
      creator: { email_address: "billing@example.com" }
    })
  ] }), "invalid", [])

  assert.equal(parsed.items.length, 2)
  const fallback = parsed.items.find(item => item.id === "Zq9")
  assert.equal(fallback.title, "Fastmail email")
  assert.equal(fallback.creator, "Grace Hopper")
  assert.equal(fallback.initials, "GH")
  assert.equal(fallback.timestampMs, 0)
  assert.equal(fallback.unread, false)
  const addressOnly = parsed.items.find(item => item.id === "addressOnly")
  assert.equal(addressOnly.creator, "billing@example.com")
  assert.equal(addressOnly.initials, "B")
})

test("parseNotifications sorts unread first and applies a positive limit", () => {
  const postings = [
    posting({ id: "seen-new", active_at: "2025-03-01T00:00:00Z", seen: true }),
    posting({ id: "unread-old", active_at: "2025-01-01T00:00:00Z", seen: false }),
    posting({ id: "unread-new", active_at: "2025-02-01T00:00:00Z", seen: false })
  ]

  assert.deepEqual(
    Model.parseNotifications(response({ postings }), 2, []).items.map(item => item.id),
    ["unread-new", "unread-old"]
  )
})

test("parseNotifications caps its source array and every stored remote field", () => {
  const postings = Array.from({ length: Model.maximumPostingCount + 20 }, (_, index) => posting({
    id: "i" + String(index).padStart(3, "0") + "x".repeat(Model.remoteIdCharacterLimit - 4),
    account_id: "a".repeat(Model.remoteIdCharacterLimit),
    name: "T".repeat(500),
    summary: "E".repeat(1000),
    creator: { name: "C".repeat(500), initials: "I".repeat(100) },
    unseen_count: "9".repeat(Model.remoteCountCharacterLimit + 1),
    visible_entry_count: "9".repeat(Model.remoteCountCharacterLimit + 1),
    active_at: "D".repeat(100),
    app_url: "/" + "u".repeat(3000)
  }))
  const parsed = Model.parseNotifications(response({ postings }), Model.maximumPostingCount, [])

  assert.equal(parsed.items.length, Model.maximumPostingCount)
  for (const item of parsed.items) {
    assert.ok(item.id.length <= Model.remoteIdCharacterLimit)
    assert.ok(item.accountId.length <= Model.remoteIdCharacterLimit)
    assert.ok(item.title.length <= Model.remoteTitleCharacterLimit)
    assert.ok(item.excerpt.length <= Model.remoteExcerptCharacterLimit)
    assert.ok(item.creator.length <= Model.remoteNameCharacterLimit)
    assert.ok(item.initials.length <= Model.remoteTypeCharacterLimit)
    assert.ok(item.type.length <= Model.remoteTypeCharacterLimit)
    assert.ok(item.timestamp.length <= Model.remoteTimestampCharacterLimit)
    assert.ok(item.url.length <= Model.remoteUrlCharacterLimit)
    assert.equal(item.unreadCount, 1)
  }
})

test("parseNotifications reports malformed payloads and accepts missing postings", () => {
  assert.deepEqual(Model.parseNotifications("bad json", 50, []), {
    ok: false, error: "Could not parse the fm-cli response", items: []
  })
  assert.deepEqual(Model.parseNotifications(response({}), 50, []).items, [])
})

test("sortNotifications is non-mutating and uses account order then ID for ties", () => {
  const items = [
    { id: "z", unread: true, timestampMs: 1, accountOrder: 2 },
    { id: "b", unread: true, timestampMs: 1, accountOrder: 1 },
    { id: "a", unread: true, timestampMs: 1, accountOrder: 1 }
  ]
  const sorted = Model.sortNotifications(items)

  assert.notEqual(sorted, items)
  assert.deepEqual(sorted.map(item => item.id), ["a", "b", "z"])
  assert.deepEqual(items.map(item => item.id), ["z", "b", "a"])
  assert.deepEqual(Model.sortNotifications(null), [])
})

test("filterNotifications combines account and state filters", () => {
  const items = [
    { id: "a", accountId: "u1", unread: true },
    { id: "b", accountId: "u1", unread: false },
    { id: "c", accountId: "u2", unread: true }
  ]

  assert.deepEqual(Model.filterNotifications(items, "u1", "unread").map(item => item.id), ["a"])
  assert.deepEqual(Model.filterNotifications(items, "u1", "previous").map(item => item.id), ["b"])
  assert.deepEqual(Model.filterNotifications(items, "", "all").map(item => item.id), ["a", "b", "c"])
  assert.deepEqual(Model.filterNotifications(null, "", "all"), [])
})

test("filterNotifications narrows to a folder chip on top of account and state", () => {
  const chips = Model.folderChips(chipFolders, "")
  const items = [
    { id: "a", accountId: "u1", unread: true, boxId: "P-F", boxKind: "inbox" },
    { id: "b", accountId: "u1", unread: false, boxId: "P-F", boxKind: "inbox" },
    { id: "c", accountId: "u1", unread: true, boxId: "Pibo", boxKind: "" },
    { id: "d", accountId: "u2", unread: true, boxId: "Pb-F", boxKind: "inbox" },
    { id: "e", accountId: "u2", unread: true, boxId: "Pnws", boxKind: "" }
  ]

  assert.deepEqual(Model.filterNotifications(items, "", "unread", "", chips).map(item => item.id), ["a", "c", "d", "e"])
  assert.deepEqual(Model.filterNotifications(items, "", "unread", "P-F", chips).map(item => item.id), ["a", "d"])
  assert.deepEqual(Model.filterNotifications(items, "", "all", "P-F", chips).map(item => item.id), ["a", "b", "d"])
  assert.deepEqual(Model.filterNotifications(items, "", "unread", "Pibo", chips).map(item => item.id), ["c"])
  assert.deepEqual(Model.filterNotifications(items, "", "previous", "Pibo", chips), [], "seen items are the Inbox's by construction")
  assert.deepEqual(Model.filterNotifications(items, "u1", "unread", "P-F", chips).map(item => item.id), ["a"])
  assert.deepEqual(Model.filterNotifications(items, "u2", "unread", "Pibo", chips), [])
  assert.deepEqual(Model.filterNotifications(items, "", "unread", "missing", chips), [])
})

test("unreadCount ignores the folder filter: the bar counts every included folder", () => {
  const items = [
    { id: "a", accountId: "u1", unread: true, boxId: "P-F", boxKind: "inbox" },
    { id: "c", accountId: "u1", unread: true, boxId: "Pibo", boxKind: "" },
    { id: "e", accountId: "u2", unread: true, boxId: "Pnws", boxKind: "" }
  ]
  assert.equal(Model.unreadCount(items, ""), 3)
  assert.equal(Model.unreadCount(items, "u1"), 2)
})

test("unreadCount counts all accounts or a selected account", () => {
  const items = [
    { id: "new-a", accountId: "a", unread: true },
    { id: "new-b", accountId: "b", unread: true },
    { id: "old-a", accountId: "a", unread: false }
  ]

  assert.equal(Model.unreadCount(items, ""), 2)
  assert.equal(Model.unreadCount(items, "a"), 1)
  assert.equal(Model.unreadCount(items, "b"), 1)
  assert.equal(Model.unreadCount(items, "missing"), 0)
  assert.equal(Model.unreadCount(null, "a"), 0)
})

test("accountFilterOptions sorts accounts without mutating them", () => {
  const accounts = [{ id: "u2", name: "Zulu" }, { id: "u1", name: "alpha" }, { id: "u3" }]
  assert.deepEqual(Model.accountFilterOptions(accounts), [
    { value: "", label: "All accounts" },
    { value: "u1", label: "alpha" },
    { value: "u3", label: "Fastmail" },
    { value: "u2", label: "Zulu" }
  ])
  assert.equal(accounts[0].name, "Zulu")
  assert.deepEqual(Model.accountFilterOptions(null), [{ value: "", label: "All accounts" }])
})

test("computeInitials handles names, punctuation, and empty values", () => {
  assert.equal(Model.computeInitials("Ada Lovelace"), "AL")
  assert.equal(Model.computeInitials("prince"), "P")
  assert.equal(Model.computeInitials("  @Ada  #Lovelace  Third "), "T")
  assert.equal(Model.computeInitials(""), "?")
})

test("themeAvatarPalette supports both schemas, preserves slot order, and deduplicates colors", () => {
  const palette = Model.themeAvatarPalette(`
    bright_blue = "#AABBCC"
    red = '#112233'
    color1 = "#112233"
    color2 = "#445566"
    foreground = "#ffffff"
    color3 = "invalid"
  `)

  assert.deepEqual(palette, ["#112233", "#445566", "#AABBCC"])
  assert.deepEqual(Model.themeAvatarPalette(null), [])
})

test("avatarColorIndex is stable, bounded, and safe without a palette", () => {
  const first = Model.avatarColorIndex("Ada Lovelace", 6)
  assert.equal(first, Model.avatarColorIndex("Ada Lovelace", 6))
  assert.ok(first >= 0 && first < 6)
  assert.equal(Model.avatarColorIndex("Ada", 0), 0)
  assert.equal(Model.avatarColorIndex("Ada", "invalid"), 0)
})

test("notificationBadgeText shows a count or close glyph", () => {
  assert.equal(Model.notificationBadgeText({ unreadCount: 4 }, false), "4")
  assert.equal(Model.notificationBadgeText({ unreadCount: 0 }, false), "1")
  assert.equal(Model.notificationBadgeText(null, false), "1")
  assert.equal(Model.notificationBadgeText({ unreadCount: 4 }, true), "󰅖")
})

test("cleanText removes literal and encoded markup before text reaches the shell", () => {
  assert.equal(Model.cleanText(` A\\n<br> B &nbsp; &lt;x&gt; &amp; &#39;y&#39; &quot;`), "A B & 'y' \"")
  assert.equal(Model.cleanText("&lt;img src='file:///etc/passwd'&gt;Subject"), "Subject")
  assert.equal(Model.cleanText("2 &lt; 3 &gt; 1"), "2 1")
  assert.equal(Model.cleanText("&amp;lt;x&amp;gt;"), "&lt;x&gt;")
  assert.equal(Model.cleanText("x".repeat(1000), 10), "x".repeat(10))
  assert.equal(Model.cleanText({ text: "no" }), "")
  assert.equal(Model.cleanText(null), "")
})

test("notificationTime formats today, earlier dates, other years, and invalid values", () => {
  const now = new Date(2025, 5, 10, 15, 0, 0).getTime()
  assert.equal(Model.notificationTime(new Date(2025, 5, 10, 0, 5, 0).getTime(), now), "12:05am")
  assert.equal(Model.notificationTime(new Date(2025, 5, 10, 15, 7, 0).getTime(), now), "3:07pm")
  assert.equal(Model.notificationTime(new Date(2025, 0, 2, 12, 0, 0).getTime(), now), "Jan 2")
  assert.equal(Model.notificationTime(new Date(2024, 0, 2, 12, 0, 0).getTime(), now), "Jan 2, 2024")
  assert.equal(Model.notificationTime(0, now), "")
})

test("notificationMeta includes available time, sender, and optional account", () => {
  const now = new Date(2025, 5, 10, 15, 0, 0).getTime()
  const item = {
    timestampMs: new Date(2025, 5, 10, 14, 30, 0).getTime(),
    creator: "Ada",
    accountName: "Work"
  }

  assert.equal(Model.notificationMeta(item, now, false), "2:30pm • Ada")
  assert.equal(Model.notificationMeta(item, now, true), "2:30pm • Ada • Work")
  assert.equal(Model.notificationMeta({ creator: "Ada" }, now, true), "Ada")
  assert.equal(Model.notificationMeta(null, now, true), "")
})

test("notificationMeta names the folder of a thread filed outside the Inbox when asked", () => {
  const now = new Date(2025, 5, 10, 15, 0, 0).getTime()
  const filed = { timestampMs: new Date(2025, 5, 10, 14, 30, 0).getTime(), creator: "Ada", accountName: "Work", boxKind: "", boxName: "Finance" }
  const inbox = { timestampMs: filed.timestampMs, creator: "Ada", accountName: "Work", boxKind: "inbox", boxName: "Inbox" }

  assert.equal(Model.notificationMeta(filed, now, false, true), "2:30pm • Ada • Finance")
  assert.equal(Model.notificationMeta(filed, now, true, true), "2:30pm • Ada • Finance • Work")
  assert.equal(Model.notificationMeta(filed, now, false, false), "2:30pm • Ada", "a folder chip already says which folder")
  assert.equal(Model.notificationMeta(filed, now, false), "2:30pm • Ada")
  assert.equal(Model.notificationMeta(inbox, now, false, true), "2:30pm • Ada", "the Inbox goes without saying")
  assert.equal(Model.notificationMeta({ creator: "Ada", boxKind: "", boxName: "<b>Finance</b>" }, now, false, true), "Ada • Finance")
  assert.equal(Model.notificationMeta({ creator: "Ada", boxKind: "" }, now, false, true), "Ada")
})
