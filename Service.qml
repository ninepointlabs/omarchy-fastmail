// Adapted from 37signals' HEY plugin for Omarchy under the MIT terms in
// THIRD_PARTY_NOTICES.md.
import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The plugin's engine, instantiated once per shell as its `service` entry
// point; every bar widget — one per monitor — reads this one instance, so one
// `fm-cli watch` runs however many bars there are. Panels push their settings
// in, since the shell injects settings into widgets only.
Item {
  id: root

  property var shell: null
  property var settings: ({})
  // A widget-local instance, built only under a shell without service
  // support, must stay inert once a shared one exists: two watches and two
  // refresh cycles per bar otherwise.
  property bool active: true
  property bool refreshing: false
  // A refresh asked for mid-fetch — a watch event landing during one, say — is
  // not dropped: it runs once the current one settles.
  property bool refreshPending: false
  property bool installed: true
  // The probe read a version older than the minimum: the panel still reads
  // the Inbox on the timer, but no watch runs — an old watch may say neither
  // ready nor which threads are new — and the header says to upgrade.
  property bool cliOutdated: false
  property bool authenticated: true
  property bool probed: false
  property bool setupRunning: false
  readonly property bool setupChecking: setupLockProcess.running
  // True when the probe itself failed (unreadable auth status) — distinct
  // from setup states, so the panel can keep retrying: a transient failure
  // mid-install/mid-login must not strand a stuck error.
  property bool probeError: false
  property var accounts: []
  property var notifications: []
  // The read's folders: the Inbox plus every other included folder with
  // unseen mail, what the panel's folder chips render.
  property var folders: []
  // The bar icon counts every unread thread in the selected account, whatever
  // folder it sits in; the folder filter below narrows the list only.
  readonly property int unreadCount: Model.unreadCount(notifications, accountFilter)
  property date lastUpdated: new Date(0)
  property string lastError: ""
  property string actionStatus: ""

  readonly property int refreshIntervalSec: 600
  readonly property int notificationLimit: 50
  // New-mail toasts: the watch says on every line whether the thread is new
  // mail, and the plugin toasts the Inbox's — one per burst at most, replacing
  // the previous one, identified as Fastmail so Omarchy's notification
  // silencing applies. Off unless the bar entry says true.
  readonly property bool notify: setting("notify", false) === true
  readonly property string openAction: openActionSetting()
  // Which box the read is of: `all` — the Inbox plus every unseen thread the
  // server-side rules filed elsewhere — or `inbox` alone; and, for `all`, the
  // folders to leave out. A change in either re-reads, but the shape is keyed
  // on a string so an unrelated settings change does not.
  readonly property string foldersMode: Model.foldersMode(setting("folders", "all"))
  readonly property var excludeFolders: Model.parseExcludeFolders(setting("excludeFolders", ""))
  readonly property string readShape: foldersMode + (foldersMode === "all" ? "\n" + excludeFolders.join("\n") : "")
  readonly property int accountCount: accounts.length
  property string accountFilter: ""
  // The folder chip selected in the panel, shared across bars like the
  // account filter: a chip id, or "" for every folder.
  property string folderFilter: ""
  // Every process a refresh drives; a pending refresh waits for all of them.
  readonly property bool busy: refreshing || probeProcess.running || accountsProcess.running || notificationProcess.running

  // The watch: `fm-cli watch` follows every mailbox over Fastmail's JMAP push
  // connection and prints a line per change. A line is a wake-up — the Inbox
  // is re-read, debounced — not a delta. It watches every mailbox because a
  // move out of the Inbox is written in the mailbox the thread went to, never
  // in the Inbox's own feed. The watch says "ready" once its cursors are set
  // and its subscription is live (again after each reconnect's catch-up), and
  // the read on that line is what makes the picture gap-free: anything before
  // the cursor is in the read, anything after it is an event. It says
  // "disconnected" when the push connection drops, which is what `connected`
  // follows — `watching` only says the process is alive.
  readonly property bool watching: watchProcess.running
  property bool connected: false
  readonly property bool watchRestartScheduled: watchRestartTimer.running
  property int watchDebounceMs: 300
  property string watchError: ""
  property int watchRestartMs: 0
  property double watchStartedAtMs: 0
  // The event budget keeps a malfunctioning producer from monopolizing the
  // shell. A normal push burst is debounced far below this ceiling.
  property int watchEventLimit: 256
  property int watchEventWindowMs: 1000
  property int watchAbuseRestartMs: 60000
  property double _watchEventWindowStartedAtMs: 0
  property int _watchEventCount: 0
  property bool _watchRateLimited: false
  // A stop the service asked for still reports an exit; it is not a failure.
  property bool _watchStopping: false
  property string _watchLastStderr: ""
  readonly property bool refreshAfterReadScheduled: refreshAfterRead.running
  readonly property bool actionStatusScheduled: actionStatusTimer.running

  // The toast: new Inbox lines collect for toastDebounceMs — one read's burst
  // is one toast — and the daemon's printed id is kept so the next burst
  // replaces the toast on screen instead of stacking.
  property int toastDebounceMs: 1500
  property var _toastQueue: []
  property int _toastId: 0
  property double _toastAtMs: 0
  property string _toastOutput: ""

  property string _probeOutput: ""
  property string _probeErrorOutput: ""
  property string _accountsOutput: ""
  property string _accountsError: ""
  property string _notificationsOutput: ""
  property string _notificationsError: ""
  property var _readQueue: []
  property var _readingNotification: null
  property string _readOutput: ""
  property string _readError: ""

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function choiceSetting(name, fallback, choices) {
    var value = String(setting(name, fallback))
    return choices.indexOf(value) === -1 ? fallback : value
  }

  function openActionSetting() {
    var choices = ["app", "tui", "browser"]
    var configured = String(setting("openAction", ""))
    if (choices.indexOf(configured) !== -1) return configured
    var toast = String(setting("toastClickAction", ""))
    var email = String(setting("emailClickAction", ""))
    return toast === email && choices.indexOf(toast) !== -1 ? toast : "tui"
  }

  function setAccountFilter(value) {
    accountFilter = String(value || "")
    ensureFolderFilter()
  }

  function ensureAccountFilter() {
    if (accountFilter === "") return
    for (var i = 0; i < accounts.length; i++) {
      if (String(accounts[i].id) === accountFilter) return
    }
    setAccountFilter("")
  }

  onAccountsChanged: ensureAccountFilter()

  function setFolderFilter(value) {
    folderFilter = Model.boundedString(value || "", Model.remoteIdCharacterLimit)
  }

  // A click on the active chip clears the filter.
  function toggleFolderFilter(value) {
    var next = Model.boundedString(value || "", Model.remoteIdCharacterLimit)
    setFolderFilter(next === folderFilter ? "" : next)
  }

  // The filter stays while its chip exists in scope: a folder read to zero
  // leaves the strip, and the filter goes with it, as it does when the Inbox
  // alone is read or another account is selected.
  function ensureFolderFilter() {
    if (folderFilter === "") return
    if (foldersMode !== "all") {
      setFolderFilter("")
      return
    }
    var chips = Model.folderChips(folders, accountFilter)
    for (var i = 0; i < chips.length; i++) {
      if (String(chips[i].id) === folderFilter) return
    }
    setFolderFilter("")
  }

  onFoldersChanged: ensureFolderFilter()

  // The box the read is of changed under a signed-in CLI: the picture on
  // screen is of the old one, so read again. Before the first probe the
  // refresh timer's start trigger does this anyway.
  onReadShapeChanged: {
    ensureFolderFilter()
    if (probed && installed && authenticated && !cliOutdated) refresh()
  }

  function conciseError(value, fallback) {
    var source = Model.boundedString(value || fallback || "Fastmail request failed", Model.remoteErrorCharacterLimit)
    var text = source.replace(/\s+/g, " ").trim()
    return text.length > 180 ? text.substring(0, 177) + "…" : text
  }

  function refreshIfStale() {
    var updatedAt = lastUpdated instanceof Date ? lastUpdated.getTime() : 0
    if (updatedAt <= 0 || Date.now() - updatedAt >= refreshIntervalSec * 1000) refresh()
  }

  function tryStartSetup() {
    if (setupRunning || setupChecking) return false
    setupRunning = true
    return true
  }

  function finishSetup() {
    setupRunning = false
  }

  function checkSetupRunning() {
    if (!setupLockProcess.running) setupLockProcess.running = true
  }

  function refresh() {
    if (!active) return
    if (busy) {
      refreshPending = true
      return
    }
    refreshing = true
    lastError = ""
    // Probe on every refresh: a bare `fm-cli` process would never emit
    // `exited` if the binary vanished since the last check, sticking
    // `refreshing` forever. The probe's bash wrapper always exits.
    _probeOutput = ""
    _probeErrorOutput = ""
    probeProcess.running = true
  }

  function finishProbe(exitCode, stdout, stderr) {
    probed = true
    probeError = false
    var text = String(stdout || "")
    var errorText = String(stderr || "")
    if (text.trim() === "missing") {
      installed = false
      authenticated = true
      notifications = []
      folders = []
      refreshing = false
      stopWatch()
      return
    }
    installed = true

    var probe = Model.parseProbe(text)
    cliOutdated = Model.cliVersionTooOld(probe.version)
    if (cliOutdated) {
      lastError = Model.cliTooOldMessage
      stopWatch()
    }

    // Only a well-formed `auth status` success is authoritative for the
    // authenticated flag. Errors and garbage get the error line instead —
    // telling the user to log in can't fix those.
    var result = Model.parseJson(probe.status)
    if (!result.ok || !result.value.data) {
      authenticated = true
      probeError = true
      lastError = conciseError(errorText || ("Could not check fm-cli: " + (result.error || "unexpected response")))
      refreshing = false
      return
    }
    authenticated = result.value.data.authenticated === true
    if (!authenticated) {
      signedOut()
      return
    }

    // Watch first, read second: anything that changed before the watch's
    // cursor is in the read, anything after it wakes the watch.
    startWatch()
    _accountsOutput = ""
    _accountsError = ""
    accountsProcess.running = true
  }

  function fetchNotifications(withAccountFilter) {
    _notificationsOutput = ""
    _notificationsError = ""
    notificationProcess.command = Model.boxCommand(notificationLimit, withAccountFilter, foldersMode, excludeFolders)
    notificationProcess.running = true
  }

  // A signed-out CLI, wherever a request found that out: nothing to read,
  // and nothing to watch with — the watch would only exit the same way.
  function signedOut() {
    authenticated = false
    notifications = []
    folders = []
    refreshing = false
    stopWatch()
  }

  function startWatch(resumeRateLimited) {
    if (_watchRateLimited && resumeRateLimited !== true) return
    if (!active || !probed || !installed || cliOutdated || !authenticated || watchProcess.running) return
    watchRestartTimer.stop()
    _watchLastStderr = ""
    watchError = ""
    _watchEventWindowStartedAtMs = 0
    _watchEventCount = 0
    _watchRateLimited = false
    watchStartedAtMs = Date.now()
    watchProcess.command = Model.watchCommand()
    watchProcess.running = true
  }

  function stopWatch() {
    watchRestartTimer.stop()
    _watchRateLimited = false
    _watchEventWindowStartedAtMs = 0
    _watchEventCount = 0
    watchDebounce.stop()
    toastDebounce.stop()
    _toastQueue = []
    connected = false
    if (watchProcess.running) {
      _watchStopping = true
      watchProcess.running = false
    }
  }

  // A line from the watch. "ready" and "resync" are wake-ups like any change —
  // the read on "ready" is the one that closes the startup gap — while
  // "disconnected" only turns the live state off: there is nothing new to read
  // until the watch catches up and says "ready" again. Wake-ups are debounced,
  // so a burst of changes costs one read, plus one follow-up when changes land
  // while a read is in flight, since that read may predate them. A line the
  // CLI calls new mail in the Inbox is also a toast, when toasts are on.
  function watchEvent(line) {
    if (_watchRateLimited) return
    var source = String(line || "")
    if (source.length === 0) return

    var now = Date.now()
    if (_watchEventWindowStartedAtMs <= 0
        || now - _watchEventWindowStartedAtMs >= watchEventWindowMs) {
      _watchEventWindowStartedAtMs = now
      _watchEventCount = 0
    }
    _watchEventCount++
    if (_watchEventCount > watchEventLimit) {
      _watchRateLimited = true
      connected = false
      watchDebounce.stop()
      watchError = "Fastmail live updates paused after too many events"
      if (watchProcess.running) watchProcess.running = false
      refresh()
      return
    }

    var event = Model.watchLine(source)
    if (event === null) return
    watchError = ""
    if (event.change === "disconnected") {
      connected = false
      return
    }
    if (event.change === "ready") connected = true
    if (notify && Model.newMailForToast(event, foldersMode, excludeFolders)) collectToast(event)
    watchDebounce.interval = watchDebounceMs
    watchDebounce.restart()
  }

  function collectToast(event) {
    var queue = _toastQueue.slice(0, Model.maximumToastPostings)
    if (queue.length < Model.maximumToastPostings) {
      queue.push({
        boxName: Model.cleanText(event.boxName, Model.remoteNameCharacterLimit),
        posting: event.posting
      })
    }
    _toastQueue = queue
    toastDebounce.interval = toastDebounceMs
    toastDebounce.restart()
  }

  // One toast for whatever collected: Sender — Subject for one thread, a count
  // with the first senders for more, replacing the last toast while its id is
  // recent enough to trust. A send still in flight keeps the queue for the
  // next turn of the debounce rather than dropping it.
  function sendToast() {
    if (_toastQueue.length === 0) return
    if (toastProcess.running) {
      toastDebounce.restart()
      return
    }
    var postings = []
    for (var i = 0; i < _toastQueue.length && i < Model.maximumToastPostings; i++) postings.push(_toastQueue[i].posting)
    var toast = Model.composeMailToast(Model.toastBoxName(_toastQueue), postings)
    _toastQueue = []
    _toastOutput = ""
    toastProcess.command = Model.boundedCaptureCommand(
      Model.toastCommand(toast.headline, toast.description,
        Model.replaceableToastId(_toastId, _toastAtMs, Date.now()), openAction,
        toast.targetUrl, toast.threadId, toast.emailId),
      Model.cliErrorByteLimit, Model.cliErrorByteLimit)
    toastProcess.running = true
  }

  // -p printed the daemon's id for the toast, which is what -r replaces next
  // time. A send that failed is not the panel's error: the next burst toasts
  // again.
  function toastSent(exitCode, stdout) {
    var id = parseInt(String(stdout || "").trim(), 10)
    if (exitCode === 0 && isFinite(id) && id > 0) {
      _toastId = id
      _toastAtMs = Date.now()
    }
  }

  function watchExited(exitCode) {
    connected = false
    watchDebounce.stop()
    if (_watchStopping) {
      // The service stopped it — signed out, the CLI gone, a local instance
      // going inert. Not an error, and nothing to restart.
      _watchStopping = false
      return
    }
    if (_watchRateLimited) {
      watchRestartMs = watchAbuseRestartMs
      watchRestartTimer.interval = watchRestartMs
      watchRestartTimer.restart()
      return
    }
    var stderr = _watchLastStderr
    var failure = Model.parseFailure("", stderr)
    if (Model.isAuthError(failure.code)) {
      // Signed out: the next probe that says otherwise starts the watch again.
      authenticated = false
      return
    }
    if (Model.cliTooOld("", stderr)) {
      // Nothing to retry until the CLI is upgraded; the next refresh's probe
      // tries again, by which time it may have been.
      lastError = Model.cliTooOldMessage
      watchError = Model.cliTooOldMessage
      return
    }
    watchError = conciseError(Model.failureMessage("", stderr, "Fastmail live updates stopped"))
    // A run that lasted a while resets the backoff; a quick exit doubles it.
    var ranForMs = Date.now() - watchStartedAtMs
    watchRestartMs = ranForMs > 60000 ? 2000 : Math.min(60000, Math.max(2000, watchRestartMs * 2))
    watchRestartTimer.interval = watchRestartMs
    watchRestartTimer.restart()
  }

  function finishRefresh(items, readFolders) {
    notifications = Model.sortNotifications(items)
    folders = Array.isArray(readFolders) ? readFolders.slice(0, Model.maximumFolderCount) : []
    refreshing = false
    lastUpdated = new Date()
  }

  // Opening an email: the terminal destination focuses or launches the TUI on
  // the Inbox — there is no deep link into a thread in this version — while
  // the web destinations open the thread's own URL on the Fastmail origin.
  function openNotification(item) {
    if (!item) return
    if (openAction === "tui") {
      // Hand the thread to a running TUI first, then raise it or start one.
      var remote = Model.tuiRemoteCommand(item.id, item.emailId)
      if (remote.length > 0) Quickshell.execDetached(remote)
      Quickshell.execDetached(Model.tuiFocusCommand(item.id, item.emailId))
    } else {
      var url = Model.fastmailBrowserUrl(item.url)
      if (openAction === "app") Quickshell.execDetached(["omarchy-launch-webapp", url])
      else Qt.openUrlExternally(url)
    }
    if (item.unread) markRead(item)
  }

  function markRead(item) {
    if (!item || !item.unread) return
    var current = null
    for (var i = 0; i < notifications.length; i++) {
      if (String(notifications[i].id) === String(item.id) && notifications[i].unread) {
        current = notifications[i]
        break
      }
    }
    if (!current) return

    setReadOptimistically(current)
    var queue = _readQueue.slice()
    queue.push(current)
    _readQueue = queue
    runNextRead()
  }

  function setReadOptimistically(item) {
    var changed = []
    for (var i = 0; i < notifications.length; i++) {
      var existing = notifications[i]
      if (String(existing.id) === String(item.id) && existing.unread) {
        var replacement = {}
        for (var key in existing) replacement[key] = existing[key]
        replacement.unread = false
        changed.push(replacement)
      } else {
        changed.push(existing)
      }
    }
    notifications = changed
  }

  function runNextRead() {
    if (readProcess.running || _readQueue.length === 0) return
    var queue = _readQueue.slice()
    _readingNotification = queue.shift()
    _readQueue = queue
    _readOutput = ""
    _readError = ""
    actionStatusTimer.stop()
    actionStatus = "Marking email as seen…"
    // The account travels with the id once the CLI has listed accounts; a
    // read without one lets the CLI pick its primary account.
    var accountId = accountCount > 0 ? String(_readingNotification.accountId || "") : ""
    var command = Model.seenCommand(String(_readingNotification.id), accountId)
    if (command.length === 0) {
      // Not a JMAP id: nothing to mark, and nothing to run.
      _readingNotification = null
      actionStatus = ""
      runNextRead()
      return
    }
    readProcess.command = command
    readProcess.running = true
  }

  // Flipping the toasts only gates what the watch's lines do; the watch itself
  // runs on. Off drops whatever was about to toast.
  onNotifyChanged: {
    if (notify) return
    toastDebounce.stop()
    _toastQueue = []
  }

  onActiveChanged: if (!active) stopWatch()

  // The follow-up refresh starts on the next turn of the event loop rather than
  // inside busy's own change handler: refresh() flips the processes busy is
  // made of, and doing that while busy is still being notified is a binding loop.
  onBusyChanged: {
    if (busy || !refreshPending) return
    refreshPending = false
    refreshSoon.restart()
  }

  // The timer periodically rechecks the full panel data alongside the live watch.
  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: root.active
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: watchRestartTimer
    repeat: false
    onTriggered: root.startWatch(true)
  }

  Timer {
    id: watchDebounce
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    id: toastDebounce
    repeat: false
    onTriggered: root.sendToast()
  }

  Process {
    id: toastProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: toastStdout
      waitForEnd: true
      onStreamFinished: root._toastOutput = text
    }
    onExited: function(exitCode) {
      root.toastSent(exitCode, String(toastStdout.text || root._toastOutput || ""))
    }
  }

  Timer {
    id: refreshSoon
    interval: 0
    repeat: false
    onTriggered: root.refresh()
  }

  Process {
    id: watchProcess
    running: false
    command: []
    stdout: SplitParser {
      onRead: function(data) { root.watchEvent(data) }
    }
    // Only the last line matters: the CLI's error envelope when the watch
    // exits. A collector would hold a long run's warnings in memory for days.
    stderr: SplitParser {
      onRead: function(data) {
        root._watchLastStderr = Model.boundedString(data, Model.remoteErrorCharacterLimit)
      }
    }
    onExited: function(exitCode, exitStatus) { root.watchExited(exitCode) }
  }

  Timer {
    id: refreshAfterRead
    interval: 1200
    repeat: false
    onTriggered: root.refresh()
  }

  Timer {
    id: actionStatusTimer
    interval: 2200
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: probeProcess
    running: false
    command: Model.probeCommand
    stdout: StdioCollector {
      id: probeStdout
      waitForEnd: true
      onStreamFinished: root._probeOutput = text
    }
    stderr: StdioCollector {
      id: probeStderr
      waitForEnd: true
      onStreamFinished: root._probeErrorOutput = text
    }
    onExited: function(exitCode) {
      root.finishProbe(
        exitCode,
        String(probeStdout.text || root._probeOutput || ""),
        String(probeStderr.text || root._probeErrorOutput || ""))
    }
  }

  Process {
    id: accountsProcess
    running: false
    command: Model.boundedCaptureCommand(
      Model.accountListCommand, Model.cliResponseByteLimit, Model.cliErrorByteLimit)
    stdout: StdioCollector {
      id: accountsStdout
      waitForEnd: true
      onStreamFinished: root._accountsOutput = text
    }
    stderr: StdioCollector {
      id: accountsStderr
      waitForEnd: true
      onStreamFinished: root._accountsError = text
    }
    onExited: function(exitCode) {
      var stdout = String(accountsStdout.text || root._accountsOutput || "")
      var stderr = String(accountsStderr.text || root._accountsError || "")
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) {
          root.signedOut()
          return
        }
        // The account list is part of the minimum CLI: a build without it is
        // too old, not a CLI to work around.
        if (Model.cliTooOld(stdout, stderr)) root.lastError = Model.cliTooOldMessage
        else root.lastError = root.conciseError(Model.failureMessage(stdout, stderr, "Could not list Fastmail accounts"))
        root.refreshing = false
        return
      }

      var parsed = Model.parseAccounts(stdout)
      if (!parsed.ok) {
        root.lastError = root.conciseError(parsed.error, "Could not list Fastmail accounts")
        root.refreshing = false
        return
      }
      root.accounts = parsed.accounts
      root.fetchNotifications(true)
    }
  }

  Process {
    id: notificationProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: notificationsStdout
      waitForEnd: true
      onStreamFinished: root._notificationsOutput = text
    }
    stderr: StdioCollector {
      id: notificationsStderr
      waitForEnd: true
      onStreamFinished: root._notificationsError = text
    }
    onExited: function(exitCode) {
      var stdout = String(notificationsStdout.text || root._notificationsOutput || "")
      var stderr = String(notificationsStderr.text || root._notificationsError || "")
      if (exitCode !== 0) {
        var failure = Model.parseFailure(stdout, stderr)
        if (Model.isAuthError(failure.code)) {
          root.signedOut()
          return
        }
        if (Model.cliTooOld(stdout, stderr)) root.lastError = Model.cliTooOldMessage
        else root.lastError = root.conciseError(Model.failureMessage(stdout, stderr,
          root.foldersMode === "inbox" ? "Could not read the Fastmail Inbox" : "Could not read Fastmail folders"))
        root.refreshing = false
        return
      }

      var parsed = Model.parseNotifications(stdout, root.notificationLimit, root.accounts)
      if (!parsed.ok) {
        root.lastError = parsed.error
        root.refreshing = false
        return
      }
      root.finishRefresh(parsed.items, parsed.folders)
    }
  }

  Process {
    id: setupLockProcess
    running: false
    command: Model.setupLockCheckCommand()
    onExited: function(exitCode) {
      // Exit 0 acquired the lock, so no setup process holds it; exit 1 means
      // a setup holds it. Anything else is the runtime directory being
      // unusable (exit 76): say so instead of leaving a dead button.
      root.setupRunning = exitCode === 1
      if (exitCode !== 0 && exitCode !== 1) {
        root.lastError = "Setup needs a private runtime directory ($XDG_RUNTIME_DIR, mode 700) to run"
      }
    }
  }

  Process {
    id: readProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: readStdout
      waitForEnd: true
      onStreamFinished: root._readOutput = text
    }
    stderr: StdioCollector {
      id: readStderr
      waitForEnd: true
      onStreamFinished: root._readError = text
    }
    onExited: function(exitCode) {
      var stdout = String(readStdout.text || root._readOutput || "")
      var stderr = String(readStderr.text || root._readError || "")
      if (exitCode !== 0) {
        root.lastError = root.conciseError(Model.failureMessage(stdout, stderr, "Could not mark the email as seen"))
        root.actionStatus = root.lastError
      } else {
        root.actionStatus = "Marked as seen"
      }
      actionStatusTimer.restart()
      root._readingNotification = null
      // The push connection reports our own mark-as-seen back within a
      // second; the delayed re-read is for when nothing is listening — and
      // for a request that failed, which the watch has nothing to report and
      // the panel has already marked seen.
      if (root._readQueue.length > 0) root.runNextRead()
      else if (!root.connected || exitCode !== 0) refreshAfterRead.restart()
    }
  }
}
