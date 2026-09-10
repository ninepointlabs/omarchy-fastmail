import QtQuick
import QtTest
import Quickshell.Io
import "../.."
import "../../Model.js" as Model

TestCase {
  name: "Service"

  property var service: null

  Component {
    id: serviceComponent
    Service {}
  }

  function init() {
    service = serviceComponent.createObject(this)
    verify(service !== null)
    wait(1)
  }

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

  function findProcess(prefix) {
    for (var i = 0; i < ProcessRegistry.processes.length; i++) {
      var process = ProcessRegistry.processes[i]
      var command = processCommand(process)
      if (command.length < prefix.length) continue
      var matches = true
      for (var j = 0; j < prefix.length; j++) {
        if (String(command[j]) !== String(prefix[j])) {
          matches = false
          break
        }
      }
      if (matches) return process
    }
    return null
  }

  function probeProcess() { return findProcess(Model.capturedCommandPayload(Model.probeCommand)) }
  function setupLockProcess() { return findProcess(Model.setupLockCheckCommand()) }
  function accountsProcess() { return findProcess(["fm-cli", "account", "list"]) }
  function notificationProcess() { return findProcess(["fm-cli", "box", "view"]) }
  function readProcess() { return findProcess(["fm-cli", "seen"]) }

  function completeAuthenticatedProbe() {
    var process = probeProcess()
    verify(process !== null)
    process.complete(0, 'fm-cli version 0.3.0\n{"ok":true,"data":{"authenticated":true}}', "")
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
  }

  function test_setup_lock_check_recovers_stale_running_state() {
    service.setupRunning = true
    service.checkSetupRunning()

    var process = setupLockProcess()
    verify(process !== null)
    compare(processCommand(process), Model.setupLockCheckCommand())
    verify(!service.tryStartSetup())

    process.complete(0, "", "")
    compare(service.setupRunning, false)
    verify(service.tryStartSetup())
  }

  function test_setup_lock_check_detects_a_running_process() {
    service.checkSetupRunning()

    var process = setupLockProcess()
    verify(process !== null)
    process.complete(1, "", "")
    compare(service.setupRunning, true)
  }

  function test_probe_reports_stderr_from_failed_auth_check() {
    var process = probeProcess()
    verify(process !== null)
    process.complete(17, "", "keyring unavailable; run fm-cli auth status")

    compare(service.probeError, true)
    compare(service.lastError, "keyring unavailable; run fm-cli auth status")
    compare(service.refreshing, false)
  }

  function test_probe_reports_an_unreadable_auth_status() {
    var process = probeProcess()
    verify(process !== null)
    process.complete(0, "fm-cli version 0.3.0\nnot json", "")

    compare(service.probeError, true)
    compare(service.lastError, "Could not check fm-cli: Could not parse the fm-cli response")
    compare(service.refreshing, false)
  }

  function test_missing_cli_clears_stale_mail_state() {
    service.notifications = [{ id: "old", unread: true }]

    probeProcess().complete(0, "missing\n", "")

    compare(service.probed, true)
    compare(service.installed, false)
    compare(service.notifications.length, 0)
    compare(service.unreadCount, 0)
    compare(service.refreshing, false)
  }

  function test_signed_out_probe_clears_stale_mail_state() {
    service.notifications = [{ id: "old", unread: true }]

    probeProcess().complete(0, 'fm-cli version 0.3.0\n{"ok":true,"data":{"authenticated":false,"auth_type":"none","username":""}}', "")

    compare(service.installed, true)
    compare(service.authenticated, false)
    compare(service.notifications.length, 0)
    compare(service.unreadCount, 0)
    compare(service.refreshing, false)
  }

  function test_authenticated_probe_starts_the_account_list() {
    completeAuthenticatedProbe()

    compare(service.authenticated, true)
    verify(accountsProcess().running)
    compare(processCommand(accountsProcess()), ["fm-cli", "account", "list", "--json"])
  }

  function test_accounts_success_fetches_every_account() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, '{"ok":true,"data":[{"id":"u12345678","name":"tim@example.com","email":"tim@example.com","active":true}],"summary":"1 mail account"}', "")

    compare(service.accounts, [{ id: "u12345678", name: "tim@example.com", order: 0 }])
    compare(processCommand(notificationProcess()),
      ["fm-cli", "box", "view", "all", "--account", "all", "--limit", "50", "--json"])
    verify(notificationProcess().running)
  }

  function test_inbox_mode_reads_the_inbox_alone() {
    service.settings = { folders: "inbox", excludeFolders: "Finance" }
    completeAuthenticatedProbe()
    accountsProcess().complete(0, '{"ok":true,"data":[]}', "")

    compare(processCommand(notificationProcess()),
      ["fm-cli", "box", "view", "inbox", "--account", "all", "--limit", "50", "--json"])
  }

  function test_cli_without_the_account_command_is_too_old() {
    completeAuthenticatedProbe()
    accountsProcess().complete(1, "", '{"ok":false,"error":"unknown command \\"account\\"","code":"usage"}')

    compare(service.lastError, Model.cliTooOldMessage)
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_account_list_failure_stays_visible_and_retryable() {
    completeAuthenticatedProbe()
    accountsProcess().complete(2, "", "keyring unavailable")

    compare(service.lastError, "keyring unavailable")
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_malformed_account_response_stays_visible_and_retryable() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, "not json", "")

    compare(service.lastError, "Could not parse the fm-cli response")
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_accounts_auth_error_returns_to_setup() {
    completeAuthenticatedProbe()
    accountsProcess().complete(1, "", '{"ok":false,"code":"auth","error":"sign in"}')

    compare(service.authenticated, false)
    compare(service.refreshing, false)
    compare(notificationProcess(), null)
  }

  function test_notification_success_updates_items_and_unread_count() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, '{"ok":true,"data":[]}', "")
    notificationProcess().complete(0,
      '{"ok":true,"data":{"id":"P-F","kind":"inbox","name":"Inbox","postings":['
      + '{"id":"seen","name":"Seen","active_at":"2025-02-02T00:00:00Z","seen":true,"unseen_count":0},'
      + '{"id":"new","name":"New","active_at":"2025-02-01T00:00:00Z","seen":false,"unseen_count":1}'
      + ']}}', "")

    compare(service.notifications.length, 2)
    compare(service.notifications[0].id, "new")
    compare(service.unreadCount, 1)
    compare(service.refreshing, false)
    verify(service.lastUpdated.getTime() > 0)
  }

  function test_malformed_inbox_response_stays_visible_and_retryable() {
    completeAuthenticatedProbe()
    accountsProcess().complete(0, '{"ok":true,"data":[]}', "")
    notificationProcess().complete(0, "not json", "")

    compare(service.lastError, "Could not parse the fm-cli response")
    compare(service.refreshing, false)
  }

  function test_mark_read_uses_the_notification_account_with_a_current_cli() {
    service.accounts = [{ id: "u12345678", name: "Personal", order: 0 }]
    var item = { id: "AB5kIMdwqots", accountId: "u12345678", unread: true }
    service.notifications = [item]

    service.markRead(item)

    compare(processCommand(readProcess()),
      ["fm-cli", "seen", "AB5kIMdwqots", "--account", "u12345678", "--json"])
  }

  function test_mark_read_is_optimistic_serial_and_idempotent() {
    var first = { id: "AB5kIMdwqots", unread: true }
    var second = { id: "Qx7yZ", unread: true }
    service.notifications = [first, second]

    service.markRead(first)
    compare(service.unreadCount, 1)
    compare(service.notifications[0].unread, false)
    compare(processCommand(readProcess()), ["fm-cli", "seen", "AB5kIMdwqots", "--json"])

    service.markRead(first)
    compare(service.unreadCount, 1)
    compare(service._readQueue.length, 0)

    service.markRead(second)
    compare(service.unreadCount, 0)
    compare(service._readQueue.length, 1)

    readProcess().complete(0, '{"ok":true,"data":{"ids":["AB5kIMdwqots"],"seen":true}}', "")
    compare(processCommand(readProcess()), ["fm-cli", "seen", "Qx7yZ", "--json"])
    verify(readProcess().running)
    compare(service.actionStatus, "Marking email as seen…")

    readProcess().complete(4, "", '{"ok":false,"error":"server unavailable","code":"remote"}')
    compare(service.lastError, "server unavailable")
    compare(service.actionStatus, "server unavailable")
  }

  function test_mark_read_ignores_items_that_are_not_unread_or_unknown() {
    service.notifications = [{ id: "AB5kIMdwqots", unread: false }]
    service.markRead(null)
    service.markRead({ id: "AB5kIMdwqots", unread: false })
    service.markRead({ id: "missing", unread: true })
    compare(readProcess(), null)
  }
}
