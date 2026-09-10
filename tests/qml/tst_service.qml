import QtQuick
import QtTest
import Quickshell
import Quickshell.Io
import "../.."
import "../../Model.js" as Model

TestCase {
  name: "ServiceSetup"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  Component {
    id: barViewComponent
    QtObject {
      property var service: null
      readonly property int unreadCount: service ? service.unreadCount : -1
      readonly property string accountFilter: service ? service.accountFilter : "missing"
    }
  }

  function init() {
    Quickshell.resetDetachedCommands()
    service = serviceComponent.createObject(this)
    verify(service !== null)
    service.watchDebounceMs = 0
    // The refresh timer's start trigger fires on the first turn of the event
    // loop: let it, so every test begins as the shell does, mid-probe.
    tick()
    verify(findProbeProcess().running)
  }

  // Lets zero-length timers — the debounce, the follow-up refresh — fire.
  function tick() { wait(1) }

  // The refresh timer fires once at creation, so a probe is usually already in
  // flight; asking again would only queue a follow-up.
  function beginRefresh() { if (!service.busy) service.refresh() }

  function cleanup() {
    service.destroy()
    service = null
  }

  function processCommand(process) {
    var raw = process.command
    var payload = Model.capturedCommandPayload(raw)
    var setupLock = JSON.stringify(raw) === JSON.stringify(Model.setupLockCheckCommand())
    if (!setupLock && payload.length > 0 && (payload[0] === "fm-cli" || payload[0] === "setpriv"
        || payload[0] === "omarchy-notification-send"
        || (payload[0] === "bash" && String(payload[2] || "").indexOf("fm-cli") !== -1))) {
      verify(raw.length > payload.length, "fm-cli command has a producer-side output guard")
      compare(raw[0], "setpriv")
      compare(raw[1], "--pdeathsig")
      compare(raw[2], "TERM")
      compare(raw[3], "bash")
      compare(raw[4], "-o")
      compare(raw[5], "pipefail")
      compare(raw[6], "-c")
      compare(raw[8], "fm-output-guard")
      verify(Number(raw[9]) > 0)
      verify(Number(raw[10]) > 0)
      verify(Number(raw[11]) >= 0)
      verify(Number(raw[12]) > 0)
      if (payload[0] === "setpriv" && payload.indexOf("watch") !== -1) compare(Number(raw[11]), 0)
      else verify(Number(raw[11]) > 0)
    }
    return payload
  }

  function findProbeProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 2 && command[0] === "bash" && command[1] === "-c"
          && String(command[2]).indexOf("command -v fm-cli") !== -1) return process
    }
    return null
  }

  function findCliProcess(subcommand) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 1 && command[0] === "fm-cli" && command[1] === subcommand) return process
    }
    return null
  }

  readonly property string signedInProbe: 'fm-cli version 0.3.0\n{"ok":true,"data":{"authenticated":true,"auth_type":"oauth","username":"tim@example.com"}}'
  readonly property string signedOutProbe: 'fm-cli version 0.3.0\n{"ok":true,"data":{"authenticated":false,"auth_type":"none","username":""}}'
  readonly property string oneAccount: '{"ok":true,"data":[{"id":"u12345678","name":"tim@example.com","email":"tim@example.com","active":true}],"summary":"1 mail account"}'
  readonly property string emptyInbox: '{"ok":true,"data":{"id":"P-F","kind":"inbox","name":"Inbox","account_id":"u12345678","unread_count":0,"total_count":0,"postings":[]}}'

  // Walks a refresh past the probe and the accounts list so the Inbox read
  // is the next process to run.
  function refreshToBox() {
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    var accounts = findCliProcess("account")
    verify(accounts !== null)
    accounts.complete(0, oneAccount, "")
    var box = findCliProcess("box")
    verify(box !== null)
    return box
  }

  // Walks a refresh all the way through, so the service is idle with the
  // watch running.
  function settle() {
    refreshToBox().complete(0, emptyInbox, "")
    compare(service.busy, false)
  }

  // Completes a refresh that is in flight, probe first.
  function finishRefresh() {
    findProbeProcess().complete(0, signedInProbe, "")
    findCliProcess("account").complete(0, '{"ok":true,"data":[]}', "")
    findCliProcess("box").complete(0, emptyInbox, "")
  }

  function findWatchProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 0 && command[0] === "setpriv") return process
    }
    return null
  }

  function findToastProcess() {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length > 0 && command[0] === "omarchy-notification-send") return process
    }
    return null
  }
  // The toast's text sits between the options and --exec: headline, then the
  // description when there is one. -r, when present, precedes the text.
  function toastPositionals(command) {
    var end = command.indexOf("--exec")
    var start = command.indexOf("-p") + 1
    if (command[start] === "-r") start += 2
    return command.slice(start, end)
  }

  function toastReplaceId(command) {
    var index = command.indexOf("-r")
    return index === -1 ? "" : command[index + 1]
  }


  function findSetupLockProcess() {
    var expected = JSON.stringify(Model.setupLockCheckCommand())
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      if (JSON.stringify(process.command) === expected) return process
    }
    return null
  }

  function test_account_filter_defaults_to_all_accounts() {
    compare(service.accountFilter, "")
  }

  function test_two_bar_views_share_the_account_filter() {
    service.notifications = [
      { id: "a", accountId: "u42", unread: true },
      { id: "b", accountId: "u7", unread: true }
    ]
    var viewA = barViewComponent.createObject(this, { service: service })
    var viewB = barViewComponent.createObject(this, { service: service })
    compare(viewA.unreadCount, 2)
    compare(viewB.unreadCount, 2)

    service.setAccountFilter("u42")
    compare(viewA.accountFilter, "u42")
    compare(viewB.accountFilter, "u42")
    compare(viewA.unreadCount, 1)
    compare(viewB.unreadCount, 1)

    viewA.destroy()
    viewB.destroy()
  }

  function test_stale_account_filter_clears_when_accounts_change() {
    service.setAccountFilter("gone")
    service.accounts = [{ id: "u1", name: "Personal" }]
    compare(service.accountFilter, "")
  }

  function test_matching_account_filter_is_kept_when_accounts_change() {
    service.setAccountFilter("u1")
    service.accounts = [{ id: "u1", name: "Personal" }]
    compare(service.accountFilter, "u1")
  }

  function test_unread_count_follows_the_account_filter() {
    service.notifications = [
      { id: "a", accountId: "u1", unread: true },
      { id: "b", accountId: "u2", unread: true }
    ]

    compare(service.unreadCount, 2)
    service.setAccountFilter("u1")
    compare(service.unreadCount, 1)
    service.setAccountFilter("missing")
    compare(service.unreadCount, 0)
  }

  function test_setup_stays_running_until_completion() {
    verify(service.tryStartSetup())
    compare(service.setupRunning, true)

    wait(50)
    verify(!service.tryStartSetup())
    compare(service.setupRunning, true)

    service.finishSetup()
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
    compare(service.setupRunning, true)
  }

  function test_setup_lock_check_recovers_stale_running_state() {
    service.setupRunning = true
    service.checkSetupRunning()

    var process = findSetupLockProcess()
    verify(process !== null)
    compare(process.command, Model.setupLockCheckCommand())
    verify(!service.tryStartSetup())

    process.complete(0, "", "")
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
  }

  function test_setup_lock_check_detects_a_running_process() {
    service.checkSetupRunning()

    var process = findSetupLockProcess()
    verify(process !== null)
    process.complete(1, "", "")
    compare(service.setupRunning, true)
  }

  // The all box as fm-cli prints it: the Inbox's newest threads plus every
  // unseen thread from the folders the rules file into, with the folders.
  readonly property string allBoxRead: '{"ok":true,"data":{"id":"all","kind":"all","name":"All folders","account_id":"u12345678","unread_count":3,"total_count":162,"folders":[' +
    '{"id":"P-F","kind":"inbox","name":"Inbox","account_id":"u12345678","unread_count":1,"total_count":162},' +
    '{"id":"Pibo","kind":"","name":"FInance","account_id":"u12345678","unread_count":2,"total_count":241}],"postings":[' +
    '{"id":"AB5kIMdwqots","thread_id":"AB5kIMdwqots","box_id":"P-F","box_kind":"inbox","box_name":"Inbox","name":"Lunch on Thursday?","seen":false,"unseen_count":1,"visible_entry_count":1,"account_id":"u12345678","creator":{"name":"Maria Delgado","email_address":"maria@example.com","initials":"MD"}},' +
    '{"id":"AT17sXU1HFoF","thread_id":"AT17sXU1HFoF","box_id":"Pibo","box_kind":"","box_name":"FInance","name":"You spent $4.08","seen":false,"unseen_count":1,"visible_entry_count":1,"account_id":"u12345678","creator":{"name":"Cash App","email_address":"cash@square.com","initials":"CA"}},' +
    '{"id":"Qx7yZmNpLkJh","thread_id":"Qx7yZmNpLkJh","box_id":"P-F","box_kind":"inbox","box_name":"Inbox","name":"Invoice #4021","seen":true,"unseen_count":0,"visible_entry_count":1,"account_id":"u12345678","creator":{"name":"Northwind Invoicing","email_address":"billing@northwind.example","initials":"NI"}}]}}'

  function test_box_reads_all_folders_for_every_account_by_default() {
    var box = refreshToBox()
    compare(processCommand(box), ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json"])

    box.complete(0, allBoxRead, "")
    compare(service.refreshing, false)
    compare(service.notifications.length, 3)
    // The bar counts every included folder.
    compare(service.unreadCount, 2)
    compare(service.notifications[0].id, "AB5kIMdwqots")
    compare(service.notifications[0].accountName, "tim@example.com")
    compare(service.notifications[0].boxKind, "inbox")
    compare(service.notifications[1].boxId, "Pibo")
    compare(service.notifications[1].boxName, "FInance")
    compare(service.folders.length, 2)
    compare(service.folders[1].name, "FInance")
    compare(service.folders[1].unreadCount, 2)
    compare(Model.folderChips(service.folders, "").length, 2)
  }

  function test_box_reads_the_inbox_alone_in_inbox_mode() {
    service.settings = { folders: "inbox" }
    var box = refreshToBox()
    compare(processCommand(box), ["fm-cli", "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"])

    box.complete(0, '{"ok":true,"data":{"id":"P-F","kind":"inbox","name":"Inbox","account_id":"u12345678","unread_count":1,"total_count":2,"folders":[{"id":"P-F","kind":"inbox","name":"Inbox","unread_count":1,"total_count":2}],"postings":[' +
      '{"id":"AB5kIMdwqots","thread_id":"AB5kIMdwqots","name":"Lunch on Thursday?","seen":false,"unseen_count":1,"visible_entry_count":1,"account_id":"u12345678","creator":{"name":"Maria Delgado","email_address":"maria@example.com","initials":"MD"}}]}}', "")
    compare(service.notifications.length, 1)
    compare(service.notifications[0].boxKind, "inbox")
    compare(service.notifications[0].boxName, "Inbox")
    compare(service.folders.length, 1)
  }

  function test_box_excludes_the_configured_folders_as_argv_pairs() {
    service.settings = { folders: "all", excludeFolders: " Newsletters ,Other Services/Gmail,, -x " }
    var box = refreshToBox()
    compare(processCommand(box), ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json",
      "--exclude", "Newsletters", "--exclude", "Other Services/Gmail"])
    compare(service.excludeFolders, ["Newsletters", "Other Services/Gmail"])
  }

  function test_a_read_without_folders_clears_the_last_ones() {
    refreshToBox().complete(0, allBoxRead, "")
    compare(service.folders.length, 2)
    refreshToBox().complete(0, emptyInbox, "")
    compare(service.folders.length, 0)
  }

  function test_signing_out_clears_the_folders() {
    refreshToBox().complete(0, allBoxRead, "")
    beginRefresh()
    findProbeProcess().complete(0, signedOutProbe, "")
    compare(service.folders.length, 0)
    compare(service.notifications.length, 0)
  }

  function test_changing_the_read_shape_re_reads() {
    settle()
    compare(service.refreshing, false)

    service.settings = { folders: "inbox" }
    compare(service.refreshing, true)
    findProbeProcess().complete(0, signedInProbe, "")
    findCliProcess("account").complete(0, oneAccount, "")
    compare(processCommand(findCliProcess("box")), ["fm-cli", "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"])
    findCliProcess("box").complete(0, emptyInbox, "")
    compare(service.refreshing, false)

    service.settings = { folders: "inbox", excludeFolders: "Finance" }
    compare(service.refreshing, false, "the exclude list has no say over an Inbox read")

    service.settings = { folders: "all", excludeFolders: "Finance" }
    compare(service.refreshing, true)
    finishRefresh()

    // An unrelated setting leaves the read alone.
    service.settings = { folders: "all", excludeFolders: "Finance", notify: true }
    compare(service.refreshing, false)
    service.settings = { folders: "all", excludeFolders: " Finance, " }
    compare(service.refreshing, false, "the same list, spaced differently, is the same read")
  }

  function test_a_shape_change_before_the_first_probe_does_not_read() {
    service.settings = { folders: "inbox" }
    // The probe in flight from creation is the only process.
    compare(service.refreshPending, false)
  }

  function test_folder_filter_toggles_and_is_shared() {
    refreshToBox().complete(0, allBoxRead, "")
    compare(service.folderFilter, "")
    service.toggleFolderFilter("Pibo")
    compare(service.folderFilter, "Pibo")
    service.toggleFolderFilter("Pibo")
    compare(service.folderFilter, "")
    service.setFolderFilter("P-F")
    compare(service.folderFilter, "P-F")
    service.toggleFolderFilter("Pibo")
    compare(service.folderFilter, "Pibo")
    service.setFolderFilter("x".repeat(500))
    compare(service.folderFilter.length, Model.remoteIdCharacterLimit)
  }

  function test_folder_filter_clears_when_its_folder_leaves_the_read() {
    refreshToBox().complete(0, allBoxRead, "")
    service.setFolderFilter("Pibo")
    refreshToBox().complete(0, allBoxRead, "")
    compare(service.folderFilter, "Pibo", "a re-read that still lists the folder keeps the filter")
    refreshToBox().complete(0, emptyInbox, "")
    compare(service.folderFilter, "")
  }

  function test_folder_filter_clears_with_an_inbox_read() {
    refreshToBox().complete(0, allBoxRead, "")
    service.setFolderFilter("Pibo")
    service.settings = { folders: "inbox" }
    compare(service.folderFilter, "")
  }

  function test_folder_filter_clears_when_another_account_is_selected() {
    refreshToBox().complete(0, allBoxRead, "")
    service.setFolderFilter("Pibo")
    service.setAccountFilter("u12345678")
    compare(service.folderFilter, "Pibo", "the folder belongs to the selected account")
    service.setAccountFilter("u99")
    compare(service.folderFilter, "")
  }

  function test_box_keeps_a_bounded_thread_limit() {
    service.settings = { maxNotifications: 20 }
    var box = refreshToBox()
    compare(processCommand(box), ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json"])
  }

  function test_watch_starts_once_signed_in() {
    verify(findWatchProcess() === null || !findWatchProcess().running)
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")

    var watch = findWatchProcess()
    verify(watch !== null)
    verify(watch.running)
    compare(processCommand(watch), ["setpriv", "--pdeathsig", "TERM", "fm-cli", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
    compare(service.watching, true)
    // Alive is not the same as live: the watch has not said ready.
    compare(service.connected, false)
  }

  function test_probe_rejects_a_cli_older_than_the_minimum() {
    beginRefresh()
    findProbeProcess().complete(0, 'fm-cli version 0.2.9\n{"ok":true,"data":{"authenticated":true}}', "")
    compare(service.cliOutdated, true)
    compare(service.lastError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    verify(findWatchProcess() === null || !findWatchProcess().running)
    // The panel still reads on the timer, degraded.
    verify(findCliProcess("account").running)
  }

  function test_probe_accepts_a_cli_at_the_minimum() {
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    compare(service.cliOutdated, false)
    compare(service.lastError, "")
    verify(findWatchProcess().running)
  }

  function test_probe_without_a_version_line_is_not_held_against_the_cli() {
    beginRefresh()
    findProbeProcess().complete(0, '{"ok":true,"data":{"authenticated":true}}', "")
    compare(service.cliOutdated, false)
    verify(findWatchProcess().running)
  }

  function test_an_intentional_stop_is_not_a_watch_failure() {
    settle()
    var watch = findWatchProcess()
    verify(watch.running)

    // Signed out since the last probe: the watch is stopped on purpose.
    beginRefresh()
    findProbeProcess().complete(0, signedOutProbe, "")
    verify(!watch.running)
    compare(service.authenticated, false)
    compare(service.watchError, "")
    compare(service.watchRestartScheduled, false)
    compare(service.lastError, "")
  }

  function test_auth_lost_during_a_fetch_stops_the_watch() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"ready"}')
    compare(service.connected, true)

    var box = refreshToBox()
    box.complete(1, "", '{"ok":false,"error":"not signed in","code":"auth"}')
    compare(service.authenticated, false)
    verify(!watch.running)
    compare(service.connected, false)
    compare(service.watchError, "")
  }

  function test_a_failed_mark_seen_re_reads_even_while_live() {
    settle()
    service.connected = true
    service.notifications = [{ id: "AB5kIMdwqots", accountId: "u12345678", unread: true }]
    service.markRead(service.notifications[0])
    var seen = findCliProcess("seen")
    verify(seen !== null)
    compare(processCommand(seen), ["fm-cli", "seen", "AB5kIMdwqots", "--account", "u12345678", "--json"])

    seen.complete(1, "", '{"ok":false,"error":"could not mark as seen","code":"remote"}')
    // The panel marked it seen optimistically and the push connection has
    // nothing to say about a request that failed: the delayed re-read puts
    // it back.
    compare(service.refreshAfterReadScheduled, true)
    compare(service.actionStatus, "could not mark as seen")
    compare(service.actionStatusScheduled, true)
  }

  function test_marks_queue_one_after_another() {
    settle()
    service.notifications = [{ id: "AB5kIMdwqots", unread: true }, { id: "Qx7yZmNpLkJh", unread: true }]
    service.markRead(service.notifications[0])
    service.markRead(service.notifications[1])
    var seen = findCliProcess("seen")
    // No account on the item: the CLI picks its primary account.
    compare(processCommand(seen), ["fm-cli", "seen", "AB5kIMdwqots", "--json"])
    seen.complete(0, '{"ok":true,"data":{"ids":["AB5kIMdwqots"],"seen":true}}', "")
    // The second mark runs once the first has answered.
    compare(processCommand(seen), ["fm-cli", "seen", "Qx7yZmNpLkJh", "--json"])
    verify(seen.running)
    compare(service.actionStatus, "Marking email as seen…")
    seen.complete(0, '{"ok":true,"data":{"ids":["Qx7yZmNpLkJh"],"seen":true}}', "")
    compare(service.actionStatus, "Marked as seen")
    compare(service.actionStatusScheduled, true)
  }

  function test_a_mark_seen_while_live_leaves_the_re_read_to_the_watch() {
    settle()
    service.connected = true
    service.notifications = [{ id: "AB5kIMdwqots", unread: true }]
    service.markRead(service.notifications[0])
    findCliProcess("seen").complete(0, '{"ok":true,"data":{"ids":["AB5kIMdwqots"],"seen":true}}', "")
    compare(service.refreshAfterReadScheduled, false)
  }

  function test_a_mark_seen_without_a_live_watch_schedules_a_re_read() {
    settle()
    service.connected = false
    service.notifications = [{ id: "AB5kIMdwqots", unread: true }]
    service.markRead(service.notifications[0])
    findCliProcess("seen").complete(0, '{"ok":true,"data":{"ids":["AB5kIMdwqots"],"seen":true}}', "")
    compare(service.refreshAfterReadScheduled, true)
  }

  function test_watch_does_not_start_while_signed_out() {
    beginRefresh()
    findProbeProcess().complete(0, signedOutProbe, "")
    verify(findWatchProcess() === null || !findWatchProcess().running)
    compare(service.watching, false)
  }

  function test_ready_makes_the_watch_live_and_reads_the_inbox() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"ready"}')
    compare(service.connected, true)
    tick()
    // The read on ready is the one that closes the startup gap.
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_resync_is_a_read() {
    settle()
    findWatchProcess().emitLine('{"change":"resync"}')
    tick()
    compare(service.refreshing, true)
  }

  function test_disconnected_turns_live_off_without_a_read() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"ready"}')
    tick()
    finishRefresh()
    compare(service.connected, true)

    watch.emitLine('{"change":"disconnected"}')
    tick()
    compare(service.connected, false)
    compare(service.watching, true)
    compare(service.refreshing, false)

    // The catch-up after the reconnect says ready again: live, and a read.
    watch.emitLine('{"change":"ready"}')
    tick()
    compare(service.connected, true)
    compare(service.refreshing, true)
  }

  // The lines fm-cli watch writes for new mail: the Inbox's, and the Archive's.
  readonly property string newLunchLine: '{"change":"added","new":true,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots","thread_id":"AB5kIMdwqots","email_id":"StmlKEsTVdXB","account_id":"u12345678","name":"Lunch on Thursday?","summary":"Are you free around noon?","seen":false,"app_url":"https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots","creator":{"name":"Maria Delgado","email_address":"maria@example.com","initials":"MD"}}}'
  readonly property string newInvoiceLine: '{"change":"added","new":true,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"Qx7yZmNpLkJh","thread_id":"Qx7yZmNpLkJh","email_id":"Hd3kLmNpQrSt","account_id":"u12345678","name":"Invoice #4021","seen":false,"app_url":"https://app.fastmail.com/mail/Inbox/TQx7yZmNpLkJh","creator":{"name":"Northwind Invoicing","email_address":"billing@northwind.example","initials":"NI"}}}'
  readonly property string newArchiveLine: '{"change":"added","new":true,"box":{"id":"P-A","kind":"archive","name":"Archive"},"posting":{"id":"Zr2tWvXyAbCd","thread_id":"Zr2tWvXyAbCd","account_id":"u12345678","name":"48 hours only","creator":{"name":"Weekend Deals","email_address":"deals@example.com"}}}'
  readonly property string readLunchLine: '{"change":"updated","new":false,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots","thread_id":"AB5kIMdwqots","account_id":"u12345678","name":"Lunch on Thursday?","seen":true,"creator":{"name":"Maria Delgado"}}}'
  readonly property string newFinanceLine: '{"change":"added","new":true,"box":{"id":"Pibo","kind":"","name":"FInance"},"posting":{"id":"AT17sXU1HFoF","thread_id":"AT17sXU1HFoF","email_id":"Stml-agfWKg-","account_id":"u12345678","name":"You spent $4.08","summary":"Wildcat Mart $4.08","seen":false,"creator":{"name":"Cash App","email_address":"cash@square.com"}}}'
  readonly property string newJunkLine: '{"change":"added","new":true,"box":{"id":"P-J","kind":"junk","name":"Spam"},"posting":{"id":"Zj9","thread_id":"Zj9","account_id":"u12345678","name":"You won","creator":{"name":"Nobody"}}}'

  // Settles with toasts on and the toast debounce, like the read's, at zero.
  function settleNotifying() {
    service.settings = { notify: true }
    service.toastDebounceMs = 0
    settle()
  }

  function test_a_new_inbox_line_is_a_toast_from_the_plugin() {
    settleNotifying()
    var watch = findWatchProcess()
    compare(processCommand(watch), ["setpriv", "--pdeathsig", "TERM", "fm-cli", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    verify(toast.running)
    compare(processCommand(toast), [
      "omarchy-notification-send",
      "--app-name", "Fastmail",
      "-u", "low",
      "-i", "mail-unread",
      "-p",
      "Fastmail\nLunch on Thursday?",
      "Are you free around noon?",
      "--exec", "bash", "-c", Model.tuiOpenShell("AB5kIMdwqots", "StmlKEsTVdXB")
    ])
    // The line is a wake-up too, as every line is.
    compare(service.refreshing, true)
  }

  function test_two_new_lines_in_the_window_are_one_toast() {
    settleNotifying()
    var watch = findWatchProcess()

    watch.emitLine(newLunchLine)
    watch.emitLine(newInvoiceLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    compare(toastPositionals(processCommand(toast)), ["Fastmail\n2 new in Inbox", "Maria Delgado, Northwind Invoicing"])
    compare(processCommand(toast).slice(5, 8), ["-i", "mail-unread", "-p"])
    toast.complete(0, "42\n", "")
    compare(service._toastId, 42)
  }

  function test_the_next_burst_replaces_the_toast() {
    settleNotifying()
    var watch = findWatchProcess()

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    compare(processCommand(toast).indexOf("-r"), -1)
    toast.complete(0, "42\n", "")

    watch.emitLine(newInvoiceLine)
    tick()
    compare(toastPositionals(processCommand(toast)), ["Fastmail\nInvoice #4021"])
    compare(toastReplaceId(processCommand(toast)), "42")

    // A send that printed no id leaves the last one in place.
    toast.complete(1, "", "notify-send: no notification daemon")
    compare(service._toastId, 42)
  }

  function test_a_toast_in_flight_keeps_the_next_burst_for_the_following_turn() {
    settleNotifying()
    var watch = findWatchProcess()

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    verify(toast.running)

    // The send has not answered yet: the new line waits rather than dropping.
    watch.emitLine(newInvoiceLine)
    tick()
    compare(service._toastQueue.length, 1)
    toast.complete(0, "7\n", "")
    tick()
    tick()
    compare(service._toastQueue.length, 0)
    compare(toastPositionals(processCommand(toast)), ["Fastmail\nInvoice #4021"])
    compare(toastReplaceId(processCommand(toast)), "7")
  }

  function test_new_mail_in_another_mailbox_does_not_toast() {
    settleNotifying()
    findWatchProcess().emitLine(newArchiveLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
    // It still wakes the read, like any change.
    compare(service.refreshing, true)
  }

  function test_new_mail_in_a_filed_folder_toasts_in_all_mode() {
    settleNotifying()
    findWatchProcess().emitLine(newFinanceLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    verify(toast.running)
    compare(toastPositionals(processCommand(toast)), ["Fastmail\nYou spent $4.08", "Wildcat Mart $4.08"])
  }

  function test_new_mail_in_a_quiet_mailbox_never_toasts() {
    settleNotifying()
    findWatchProcess().emitLine(newJunkLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_new_mail_in_an_excluded_folder_does_not_toast() {
    service.settings = { notify: true, excludeFolders: "finance" }
    service.toastDebounceMs = 0
    settle()
    var watch = findWatchProcess()
    watch.emitLine(newFinanceLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)

    // The Inbox is never on the exclude list's side of the line.
    watch.emitLine(newLunchLine)
    tick()
    verify(findToastProcess() !== null && findToastProcess().running)
  }

  function test_inbox_mode_toasts_the_inbox_alone() {
    service.settings = { notify: true, folders: "inbox" }
    service.toastDebounceMs = 0
    settle()
    var watch = findWatchProcess()
    watch.emitLine(newFinanceLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)

    watch.emitLine(newLunchLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    compare(toastPositionals(processCommand(toast)), ["Fastmail\nLunch on Thursday?", "Are you free around noon?"])
  }

  function test_a_burst_across_folders_counts_the_folders() {
    settleNotifying()
    var watch = findWatchProcess()
    watch.emitLine(newLunchLine)
    watch.emitLine(newFinanceLine)
    tick()
    var toast = findToastProcess()
    verify(toast !== null)
    compare(toastPositionals(processCommand(toast)), ["Fastmail\n2 new in 2 folders", "Maria Delgado, Cash App"])
  }

  function test_a_line_that_is_not_new_does_not_toast() {
    settleNotifying()
    findWatchProcess().emitLine(readLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_notify_off_does_not_toast() {
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine(newLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_a_non_boolean_notify_setting_is_off() {
    service.settings = { notify: "true" }
    service.toastDebounceMs = 0
    settle()
    compare(service.notify, false)
    findWatchProcess().emitLine(newLunchLine)
    tick()
    verify(findToastProcess() === null || !findToastProcess().running)
  }

  function test_refresh_interval_stays_at_ten_minutes() {
    service.settings = { refreshIntervalSec: 60 }
    compare(service.refreshIntervalSec, 600)
  }

  function test_open_action_accepts_known_settings_only() {
    compare(service.openAction, "tui")

    service.settings = { openAction: "browser" }
    compare(service.openAction, "browser")

    service.settings = { openAction: "app" }
    compare(service.openAction, "app")

    service.settings = { openAction: "unexpected" }
    compare(service.openAction, "tui")
  }

  function test_open_action_preserves_a_shared_existing_destination() {
    service.settings = { toastClickAction: "browser", emailClickAction: "browser" }
    compare(service.openAction, "browser")

    service.settings = { toastClickAction: "browser", emailClickAction: "tui" }
    compare(service.openAction, "tui")
  }

  function test_email_click_opens_the_thread_in_the_tui() {
    service.settings = { openAction: "tui" }
    service.openNotification({ id: "AB5kIMdwqots", emailId: "StmlKEsTVdXB", accountId: "u12345678", title: "Lunch on Thursday?", url: "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots", unread: false })

    // A running TUI is handed the thread first; then it is raised, or a new
    // TUI starts on that thread.
    compare(Quickshell.detachedCommands.length, 2)
    compare(Quickshell.detachedCommands[0],
      ["fm-cli", "tui", "--thread", "AB5kIMdwqots", "--email", "StmlKEsTVdXB", "--remote"])
    compare(Quickshell.detachedCommands[1],
      ["omarchy-launch-or-focus", "com.ninepointlabs.fm-cli",
        "'omarchy-launch-tui' '--app-id=com.ninepointlabs.fm-cli' 'fm-cli' 'tui' '--thread' 'AB5kIMdwqots' '--email' 'StmlKEsTVdXB'"])
  }

  function test_email_click_without_ids_just_focuses_the_tui() {
    service.settings = { openAction: "tui" }
    service.openNotification({ id: "", url: "https://app.fastmail.com/mail/Inbox", unread: false })

    compare(Quickshell.detachedCommands.length, 1)
    compare(Quickshell.detachedCommands[0],
      ["omarchy-launch-or-focus", "com.ninepointlabs.fm-cli", "'omarchy-launch-tui' '--app-id=com.ninepointlabs.fm-cli' 'fm-cli' 'tui'"])
  }

  function test_email_click_can_open_its_thread_in_the_fastmail_app() {
    service.settings = { openAction: "app" }
    service.openNotification({ id: "AB5kIMdwqots", accountId: "u12345678", title: "Lunch on Thursday?", url: "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots", unread: false })

    compare(Quickshell.detachedCommands.length, 1)
    compare(Quickshell.detachedCommands[0],
      ["omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots"])
  }

  function test_email_click_in_the_app_falls_back_to_the_inbox_for_a_foreign_url() {
    service.settings = { openAction: "app" }
    service.openNotification({ id: "AB5kIMdwqots", url: "https://example.com/phish", unread: false })

    compare(Quickshell.detachedCommands[0],
      ["omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox"])
  }

  function test_email_click_marks_an_unseen_thread_seen() {
    settle()
    service.settings = { openAction: "tui" }
    service.notifications = [{ id: "AB5kIMdwqots", accountId: "u12345678", unread: true }]
    service.openNotification(service.notifications[0])

    compare(Quickshell.detachedCommands.length, 2)
    compare(processCommand(findCliProcess("seen")), ["fm-cli", "seen", "AB5kIMdwqots", "--account", "u12345678", "--json"])
    compare(service.unreadCount, 0)
    service.openNotification(null)
    compare(Quickshell.detachedCommands.length, 2)
  }

  function test_tui_notification_click_opens_the_thread_in_the_tui() {
    service.settings = { notify: true, openAction: "tui" }
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine(newLunchLine)
    tick()

    var toast = findToastProcess()
    verify(toast !== null)
    var command = processCommand(toast)
    compare(command.slice(-3), ["bash", "-c", Model.tuiOpenShell("AB5kIMdwqots", "StmlKEsTVdXB")])
  }

  function test_browser_notification_click_opens_the_message_url() {
    service.settings = { notify: true, openAction: "browser" }
    service.toastDebounceMs = 0
    settle()
    findWatchProcess().emitLine(newLunchLine)
    tick()

    var toast = findToastProcess()
    verify(toast !== null)
    compare(processCommand(toast).slice(-3), ["--exec", "xdg-open", "https://app.fastmail.com/mail/Inbox/TAB5kIMdwqots"])
  }

  function test_app_notification_click_for_a_burst_opens_the_inbox() {
    service.settings = { notify: true, openAction: "app" }
    service.toastDebounceMs = 0
    settle()
    var watch = findWatchProcess()
    watch.emitLine(newLunchLine)
    watch.emitLine(newInvoiceLine)
    tick()

    var toast = findToastProcess()
    verify(toast !== null)
    compare(processCommand(toast).slice(-3), ["--exec", "omarchy-launch-webapp", "https://app.fastmail.com/mail/Inbox"])
  }

  function test_flipping_notify_leaves_the_watch_alone() {
    settle()
    var before = findWatchProcess()

    service.settings = { notify: true }
    verify(before.running)
    compare(processCommand(before), ["setpriv", "--pdeathsig", "TERM", "fm-cli", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"])
    compare(service.watchRestartScheduled, false)

    // Off drops a toast that was about to go out.
    service.toastDebounceMs = 1000
    before.emitLine(newLunchLine)
    compare(service._toastQueue.length, 1)
    service.settings = { notify: false }
    compare(service._toastQueue.length, 0)
    verify(before.running)
  }

  function test_a_burst_of_watch_events_is_one_debounced_read() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"added","new":false,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots"}}')
    watch.emitLine('{"change":"updated","new":false,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"AB5kIMdwqots"}}')
    watch.emitLine('{"change":"deleted","new":false,"box":{"id":"P-F","kind":"inbox","name":"Inbox"},"posting":{"id":"Qx7yZmNpLkJh","email_id":"Hd3kLmNpQrSt","thread_id":"Qx7yZmNpLkJh"}}')
    compare(service.refreshing, false)
    tick()
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
    compare(service.refreshPending, false)
  }

  function test_events_during_a_read_cost_one_follow_up() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine('{"change":"added","new":false,"posting":{"id":"AB5kIMdwqots"}}')
    tick()
    compare(service.refreshing, true)

    // The read in flight may predate these: one follow-up, not three.
    watch.emitLine('{"change":"updated","new":false,"posting":{"id":"AB5kIMdwqots"}}')
    watch.emitLine('{"change":"updated","new":false,"posting":{"id":"Zr2tWvXyAbCd"}}')
    watch.emitLine('{"change":"deleted","new":false,"posting":{"id":"Qx7yZmNpLkJh"}}')
    tick()
    compare(service.refreshPending, true)

    finishRefresh()
    compare(service.refreshing, false)
    tick()
    compare(service.refreshPending, false)
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_watch_blank_or_malformed_lines_are_not_events() {
    settle()
    var watch = findWatchProcess()
    watch.emitLine("")
    watch.emitLine("not json")
    tick()
    compare(service.refreshing, false)
  }

  function test_watch_event_budget_stops_a_flood_and_reconciles_once() {
    settle()
    var watch = findWatchProcess()
    service.watchDebounceMs = 10000
    service.watchEventLimit = 8
    service.watchEventWindowMs = 60000

    for (var i = 0; i <= service.watchEventLimit; i++) watch.emitLine("not json " + i)

    compare(service._watchRateLimited, true)
    compare(service.watching, false)
    compare(service.connected, false)
    compare(service.watchRestartScheduled, true)
    compare(service.watchRestartMs, service.watchAbuseRestartMs)
    compare(service.watchError, "Fastmail live updates paused after too many events")
    compare(service.refreshing, true)
    verify(findProbeProcess().running)

    finishRefresh()
    compare(service.refreshing, false)
    compare(service.watching, false)
    compare(service._watchRateLimited, true)
    compare(service.watchRestartScheduled, true)

    service.startWatch(true)
    compare(service.watching, true)
    compare(service._watchRateLimited, false)
    compare(service.watchRestartScheduled, false)
  }

  function test_signed_out_reconciliation_clears_the_watch_cooldown() {
    settle()
    var watch = findWatchProcess()
    service.watchEventLimit = 4
    service.watchEventWindowMs = 60000

    for (var i = 0; i <= service.watchEventLimit; i++) watch.emitLine("not json " + i)
    compare(service._watchRateLimited, true)
    compare(service.watchRestartScheduled, true)
    verify(findProbeProcess().running)

    findProbeProcess().complete(0, signedOutProbe, "")
    compare(service.authenticated, false)
    compare(service._watchRateLimited, false)
    compare(service.watchRestartScheduled, false)

    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    compare(service.authenticated, true)
    compare(service.watching, true)
  }

  function test_watch_auth_exit_asks_to_sign_in_and_waits_for_the_probe() {
    settle()
    var watch = findWatchProcess()

    watch.emitLine('{"change":"ready"}')
    watch.complete(1, "", '{"ok":false,"error":"the access token was rejected — run `fm-cli auth login` again","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.connected, false)
    compare(service.watching, false)
    compare(service.watchRestartScheduled, false)
    compare(service.lastError, "")

    // Signed in again: the next probe restarts it.
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    verify(watch.running)
  }

  function test_watch_other_exit_restarts_on_a_doubling_backoff() {
    settle()
    var watch = findWatchProcess()

    watch.complete(1, "", '{"ok":false,"error":"the push connection closed for good — nothing is watching for changes any more","code":"network"}')
    compare(service.watching, false)
    compare(service.watchRestartScheduled, true)
    compare(service.watchRestartMs, 2000)
    verify(service.watchError.indexOf("closed for good") !== -1)
    // The panel keeps working off the timer; the watch's trouble is not an error.
    compare(service.lastError, "")

    service.startWatch()
    verify(watch.running)
    compare(service.watchError, "")
    watch.complete(1, "", '{"ok":false,"error":"could not connect","code":"network"}')
    compare(service.watchRestartMs, 4000)
  }

  function test_watch_exit_without_an_envelope_reports_a_generic_stop() {
    settle()
    var watch = findWatchProcess()
    watch.complete(137, "", "")
    compare(service.watchError, "Fastmail live updates stopped")
    compare(service.watchRestartScheduled, true)
  }

  function test_watch_missing_from_the_cli_reports_an_old_cli() {
    settle()
    var watch = findWatchProcess()

    watch.complete(1, "", '{"ok":false,"error":"unknown command \\"watch\\"","code":"usage"}')
    compare(service.lastError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    compare(service.watchRestartScheduled, false)
  }

  function test_watch_without_the_new_event_reports_an_old_cli() {
    settle()
    var watch = findWatchProcess()

    // A CLI with watch but no `new` event refuses the command up front,
    // rather than running a watch that never says which threads are new.
    watch.complete(1, "", '{"ok":false,"error":"unknown event \\"new\\"","code":"usage"}')
    compare(service.lastError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    compare(service.watchError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    compare(service.watchRestartScheduled, false)
  }

  function test_inactive_service_neither_refreshes_nor_watches() {
    settle()
    var watch = findWatchProcess()

    service.active = false
    verify(!watch.running)
    service.refresh()
    compare(service.refreshing, false)
    verify(!findProbeProcess().running)
  }

  function test_box_auth_error_on_stderr_asks_to_sign_in() {
    var box = refreshToBox()
    box.complete(1, "", '{"ok":false,"error":"not signed in — run `fm-cli auth login` first","code":"auth","hint":"Run: fm-cli auth login"}')
    compare(service.authenticated, false)
    compare(service.refreshing, false)
    compare(service.lastError, "")
  }

  function test_accounts_auth_error_on_stderr_asks_to_sign_in() {
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    findCliProcess("account").complete(1, "", '{"ok":false,"error":"not signed in","code":"auth"}')
    compare(service.authenticated, false)
    compare(service.refreshing, false)
  }

  function test_accounts_unknown_command_reports_an_old_cli() {
    beginRefresh()
    findProbeProcess().complete(0, signedInProbe, "")
    findCliProcess("account").complete(1, "", '{"ok":false,"error":"unknown command \\"account\\"","code":"usage"}')
    compare(service.lastError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    compare(service.refreshing, false)
    compare(findCliProcess("box"), null)
  }

  function test_box_reports_an_old_cli() {
    var box = refreshToBox()
    box.complete(1, "", '{"ok":false,"error":"unknown flag \\"--account\\"","code":"usage"}')
    compare(service.lastError, "fm-cli 0.3.0 or newer is required (omarchy-mise-install github:ninepointlabs/fm-cli@0.3.0 fm-cli)")
    compare(service.refreshing, false)
  }

  function test_box_surfaces_the_cli_error_message() {
    var box = refreshToBox()
    box.complete(1, "", '{"ok":false,"error":"network error: dial tcp: connection refused","code":"network"}')
    compare(service.lastError, "network error: dial tcp: connection refused")
  }

  function test_box_failure_without_an_envelope_gets_a_generic_message() {
    var box = refreshToBox()
    box.complete(124, "", "")
    compare(service.lastError, "Could not read Fastmail folders")
    compare(service.refreshing, false)
  }

  function test_inbox_read_failure_without_an_envelope_names_the_inbox() {
    service.settings = { folders: "inbox" }
    var box = refreshToBox()
    box.complete(124, "", "")
    compare(service.lastError, "Could not read the Fastmail Inbox")
    compare(service.refreshing, false)
  }

  function test_refresh_during_a_fetch_is_coalesced_not_dropped() {
    var box = refreshToBox()
    service.refresh()
    service.refresh()
    compare(service.refreshPending, true)

    box.complete(0, emptyInbox, "")
    // Everything settled: the pending refresh starts a new probe, once, on
    // the next turn of the event loop.
    compare(service.refreshing, false)
    compare(service.refreshPending, false)
    tick()
    compare(service.refreshing, true)
    verify(findProbeProcess().running)
  }

  function test_refresh_if_stale_reads_only_after_the_interval() {
    settle()
    compare(service.busy, false)
    service.refreshIfStale()
    compare(service.refreshing, false, "a fresh read is not repeated")

    service.lastUpdated = new Date(Date.now() - (service.refreshIntervalSec + 1) * 1000)
    service.refreshIfStale()
    compare(service.refreshing, true)
  }
}
