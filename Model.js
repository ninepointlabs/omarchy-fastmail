// Adapted from 37signals' HEY plugin for Omarchy under the MIT terms in
// THIRD_PARTY_NOTICES.md.
//
// One place for the setup-state UI contract: CLI installation and version
// readiness precede sign-in. The plan provides the user-facing strings and
// exact shell command the panel launches in a floating terminal. The launch
// command preserves the fix's exit status through the IPC refresh so the terminal
// presentation can honor Ctrl-C (exit 130) from the fix itself.
var setupLockDirectoryName = "setup-lock"
var setupLockShell = "uid=$(id -u) || exit 76; "
  + "runtime=${XDG_RUNTIME_DIR:-/run/user/$uid}; "
  + "[ -d \"$runtime\" ] && [ ! -L \"$runtime\" ] "
  + "&& [ \"$(stat -c %u -- \"$runtime\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& [ \"$(stat -c %a -- \"$runtime\" 2>/dev/null)\" = 700 ] || exit 76; "
  + "ensure_private_dir() { path=$1; "
  + "if mkdir -m 700 -- \"$path\" 2>/dev/null; then return 0; fi; "
  + "[ -d \"$path\" ] && [ ! -L \"$path\" ] "
  + "&& [ \"$(stat -c %u -- \"$path\" 2>/dev/null)\" = \"$uid\" ] "
  + "&& chmod 700 -- \"$path\"; }; "
  + "umask 077; base=\"$runtime/ninepointlabs.fastmail-$uid\"; "
  + "ensure_private_dir \"$base\" || exit 76; "
  + "lock=\"$base/" + setupLockDirectoryName + "\"; "
  + "ensure_private_dir \"$lock\" || exit 76; "

function setupLockCheckCommand() {
  return ["bash", "-c", setupLockShell + "exec 9<\"$lock\"; flock -n 9"]
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function setupLaunchCommand(fix, ipcTarget) {
  var target = shellQuote(ipcTarget)
  var completion = "omarchy-shell -q \"$target\" setupFinished"
  return "target=" + target + "; " + setupLockShell
    + "( flock -n 9 || { printf '%s\\n' 'Fastmail setup is already running.'; exit 75; }; "
    + "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; "
    + "trap 'rc=$?; trap - EXIT; flock -u 9; " + completion + "; exit $rc' EXIT; "
    + String(fix || "") + " ) 9<\"$lock\""
}

// The install pins the CLI release the plugin was built against, so a click
// never fetches whatever "latest" happens to be; the pin moves with the plugin.
var minimumCliVersion = "0.3.0"
var installCommand = "omarchy-mise-install github:ninepointlabs/fm-cli@" + minimumCliVersion + " fm-cli"
var setupCommand = "fm-cli setup --silent-success"

function setupPlan(installed, authenticated, cliOutdated, ipcTarget) {
  var plan = {
    needed: installed !== true || cliOutdated === true || authenticated !== true,
    title: "Please sign in",
    command: setupCommand,
    buttonLabel: "Sign in to Fastmail…",
    fix: setupCommand
  }
  if (installed !== true || cliOutdated === true) {
    plan.title = ""
    plan.command = ""
    plan.buttonLabel = installed === true ? "Update fm-cli…" : "Install fm-cli…"
    plan.fix = installCommand + " && " + setupCommand
  }
  plan.launchCommand = setupLaunchCommand(plan.fix, ipcTarget)
  return plan
}

// Every captured process has an independent producer-side byte ceiling. The
// extra byte lets the consumer distinguish a response exactly at the limit
// from one that was cut off. JSON entry points enforce the same ceiling again
// before parsing.
var cliResponseByteLimit = 1024 * 1024
var cliErrorByteLimit = 64 * 1024
var probeResponseByteLimit = 64 * 1024
var finiteCommandTimeoutSec = 30
var finiteCommandKillGraceSec = 2
var watchOutputByteLimit = 4 * 1024 * 1024
var watchLineByteLimit = 64 * 1024
var maximumAccountCount = 32
var maximumPostingCount = 50
var maximumToastPostings = 50
var maximumFolderCount = 64
var maximumExcludeFolderCount = 32
var excludeFolderCharacterLimit = 160
// The raw setting is bounded before it is split; entries past the cap are
// dropped anyway, so the ceiling only has to be generous.
var excludeFoldersSettingCharacterLimit = 8192

var remoteIdCharacterLimit = 64
var remoteNameCharacterLimit = 160
var remoteTitleCharacterLimit = 256
var remoteExcerptCharacterLimit = 512
var remoteUrlCharacterLimit = 2048
var remoteTimestampCharacterLimit = 64
var remoteTypeCharacterLimit = 64
var remoteCountCharacterLimit = 20
var remoteCountMaximum = 999999
var remoteErrorCharacterLimit = 512
var remoteHintCharacterLimit = 512
var remoteCodeCharacterLimit = 64

var boundedCaptureScript = "stdout_limit=$1; stderr_limit=$2; deadline=$3; grace=$4; shift 4; child_pid=; timer_pid=; killer_pid=; timed_out=0; "
  + "stop_timer() { if [ -n \"$timer_pid\" ]; then kill -TERM -- \"-$timer_pid\" 2>/dev/null || true; kill -TERM \"$timer_pid\" 2>/dev/null || true; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; fi; }; "
  + "start_group_killer() { setpriv --pdeathsig KILL setsid bash -c 'end=$((SECONDS + $1)); while kill -0 -- \"-$2\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; kill -KILL -- \"-$2\" 2>/dev/null || true' fm-output-killer \"$grace\" \"$child_pid\" & killer_pid=$!; }; "
  + "wait_group_killer() { if [ -n \"$killer_pid\" ]; then wait \"$killer_pid\" 2>/dev/null || true; killer_pid=; fi; }; "
  + "cleanup_group() { if [ -n \"$child_pid\" ] && kill -0 -- \"-$child_pid\" 2>/dev/null; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; start_group_killer; wait_group_killer; fi; }; "
  + "terminate_child() { if [ -n \"$child_pid\" ]; then kill -TERM -- \"-$child_pid\" 2>/dev/null || true; kill -TERM \"$child_pid\" 2>/dev/null || true; start_group_killer; wait \"$child_pid\" 2>/dev/null || true; wait_group_killer; child_pid=; fi; }; "
  + "stop_child() { trap - HUP INT TERM USR1; stop_timer; terminate_child; exit 143; }; "
  + "trap 'timed_out=1' USR1; trap stop_child HUP INT TERM; "
  + "setpriv --pdeathsig KILL setsid \"$@\" "
  + "> >(stdbuf -oL head -c \"$((stdout_limit + 1))\") "
  + "2> >(head -c \"$((stderr_limit + 1))\" >&2) & child_pid=$!; "
  + "if [ \"$deadline\" -gt 0 ]; then parent_pid=$BASHPID; "
  + "setpriv --pdeathsig KILL setsid bash -c 'sleep \"$1\" || exit 0; kill -USR1 \"$2\" 2>/dev/null || exit 0; kill -TERM -- \"-$3\" 2>/dev/null || true; kill -TERM \"$3\" 2>/dev/null || true; end=$((SECONDS + $4)); while kill -0 -- \"-$3\" 2>/dev/null && [ \"$SECONDS\" -lt \"$end\" ]; do sleep 0.1; done; if kill -0 -- \"-$3\" 2>/dev/null; then kill -KILL -- \"-$3\" 2>/dev/null || true; fi' "
  + "fm-output-timeout \"$deadline\" \"$parent_pid\" \"$child_pid\" \"$grace\" & timer_pid=$!; fi; "
  + "wait \"$child_pid\"; status=$?; "
  + "if [ \"$timed_out\" -eq 1 ]; then wait \"$child_pid\" 2>/dev/null || true; status=124; wait \"$timer_pid\" 2>/dev/null || true; timer_pid=; "
  + "else stop_timer; cleanup_group; fi; child_pid=; exit \"$status\""

function boundedCaptureCommand(command, stdoutLimit, stderrLimit, timeoutSeconds, killGraceSeconds) {
  var source = Array.isArray(command) ? command : []
  var stdoutBytes = positiveInteger(stdoutLimit, cliResponseByteLimit)
  var stderrBytes = positiveInteger(stderrLimit, cliErrorByteLimit)
  var deadline = timeoutSeconds === 0 ? 0 : positiveInteger(timeoutSeconds, finiteCommandTimeoutSec)
  var grace = positiveInteger(killGraceSeconds, finiteCommandKillGraceSec)
  return ["setpriv", "--pdeathsig", "TERM", "bash", "-o", "pipefail", "-c",
    boundedCaptureScript, "fm-output-guard", String(stdoutBytes), String(stderrBytes),
    String(deadline), String(grace)].concat(source)
}

function capturedCommandPayload(command) {
  var source = Array.isArray(command) ? command : []
  if (source.length < 13 || source[0] !== "setpriv" || source[1] !== "--pdeathsig"
      || source[2] !== "TERM" || source[3] !== "bash" || source[4] !== "-o"
      || source[5] !== "pipefail" || source[6] !== "-c"
      || source[7] !== boundedCaptureScript || source[8] !== "fm-output-guard") return source.slice()
  return source.slice(13)
}

function exceedsUtf8ByteLimit(value, limit) {
  var text = String(value || "")
  var maximum = positiveInteger(limit, cliResponseByteLimit)
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff
        && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00
        && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4
      i += 1
    } else bytes += 3
    if (bytes > maximum) return true
  }
  return false
}

function boundedString(value, limit) {
  if (value === undefined || value === null || typeof value === "object") return ""
  var text = String(value)
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  if (text.length <= maximum) return text
  text = text.substring(0, maximum)
  var last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.substring(0, text.length - 1) : text
}

// JMAP ids (RFC 8620 §1.2) are URL-safe base64: letters, digits, "-" and "_",
// and never start with a dash. Anything else is not an id and never reaches a
// command line: a leading dash would read as a flag, and one Omarchy launcher
// on the click path evals its arguments.
var jmapIdPattern = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

function validId(value) {
  if (value === undefined || value === null || typeof value === "object") return ""
  var id = String(value).trim()
  // An over-long id is not truncated into a different id; it is not an id.
  if (id.length > remoteIdCharacterLimit) return ""
  return jmapIdPattern.test(id) ? id : ""
}

function boundedRemoteCount(value, fallback) {
  if (value === undefined || value === null || typeof value === "object") return fallback
  var text = String(value).trim()
  if (text.length === 0 || text.length > remoteCountCharacterLimit || !/^\d+$/.test(text)) return fallback
  var count = parseInt(text, 10)
  return isFinite(count) ? Math.min(remoteCountMaximum, count) : fallback
}

function parseJson(raw, byteLimit) {
  var source = String(raw || "")
  if (exceedsUtf8ByteLimit(source, byteLimit || cliResponseByteLimit)) {
    return { ok: false, error: "The fm-cli response exceeded its size limit", code: "" }
  }
  var text = source.trim()
  if (text === "") return { ok: false, error: "fm-cli returned no data", code: "" }

  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "fm-cli returned invalid data", code: "" }
    if (parsed.ok === false) {
      return {
        ok: false,
        error: cleanText(parsed.error || parsed.message || "The fm-cli request failed", remoteErrorCharacterLimit),
        code: boundedString(parsed.code || "", remoteCodeCharacterLimit),
        hint: cleanText(parsed.hint || "", remoteHintCharacterLimit)
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: "Could not parse the fm-cli response", code: "" }
  }
}

// The CLI writes its error envelope to stderr and nothing to stdout, so a
// failed command is read from whichever stream carried it. `auth` is the
// CLI's code for a signed-out or rejected credential; `auth_required` is
// accepted too, for symmetry with the CLI this plugin descends from.
function parseFailure(stdout, stderr) {
  var hasStderr = String(stderr || "").trim() !== ""
  var text = hasStderr ? stderr : stdout
  var result = parseJson(text, hasStderr ? cliErrorByteLimit : cliResponseByteLimit)
  if (result.ok) return { ok: false, error: "The fm-cli request failed", code: "", hint: "" }
  return result
}

// failureMessage is the line the panel shows for a failed command: the
// envelope's message when the CLI wrote one, the raw stderr (or stdout) when
// it wrote something else, and the caller's fallback when it wrote nothing.
function failureMessage(stdout, stderr, fallback) {
  var raw = String(stderr || "").trim() !== "" ? stderr : stdout
  var text = boundedString(raw, remoteErrorCharacterLimit).trim()
  if (text === "") return String(fallback || "")
  if (text.charAt(0) === "{") return parseFailure(stdout, stderr).error || String(fallback || "")
  return text
}

function isAuthError(code) {
  var value = boundedString(code || "", remoteCodeCharacterLimit)
  return value === "auth" || value === "auth_required"
}

var cliTooOldMessage = "fm-cli " + minimumCliVersion + " or newer is required (" + installCommand + ")"

// The probe answers three questions in one process — is the CLI there, is it
// new enough, is it signed in — by printing the version line ahead of the
// auth status. `fm-cli --version` prints the one-liner `fm-cli version X.Y.Z`.
// bash always exists, so the process always exits; a bare `fm-cli` would never
// report an exit when the binary is missing.
var probeCommand = boundedCaptureCommand(
  ["bash", "-c", "command -v fm-cli >/dev/null 2>&1 || { echo missing; exit 0; }; fm-cli --version 2>/dev/null | head -n 1; fm-cli auth status --json"],
  probeResponseByteLimit, cliErrorByteLimit)

// parseProbe splits the probe's output into the version it read and the auth
// status behind it. No version line — a build whose `--version` failed, or a
// test feeding the status alone — leaves the version unknown, not wrong.
function parseProbe(text) {
  var raw = String(text || "")
  if (exceedsUtf8ByteLimit(raw, probeResponseByteLimit)) return { version: "", status: "" }
  var match = raw.match(/^\s*fm-cli version (\S+)[^\n]*\n?/)
  if (!match) return { version: "", status: raw }
  return {
    version: boundedString(match[1], remoteTypeCharacterLimit),
    status: raw.substring(match[0].length)
  }
}

// cliVersionTooOld says whether a version the probe read is older than the
// minimum. The scripting contract this plugin drives — `box view`, `seen`,
// `watch --events new` — is fm-cli 0.3.0's; an older build would fail with
// usage errors mid-refresh, so the version catches that up front. A dev build,
// or a version that does not read as one, is not held against the CLI.
function cliVersionTooOld(version) {
  var parts = parseSemver(version)
  if (!parts) return false
  var minimum = parseSemver(minimumCliVersion)
  for (var i = 0; i < 3; i++) {
    if (parts[i] !== minimum[i]) return parts[i] < minimum[i]
  }
  return false
}

function parseSemver(version) {
  var match = boundedString(version || "", remoteTypeCharacterLimit).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null
}

// The plugin only passes fixed subcommands, flags and event names, so an
// unknown command, flag, or event in a failure means the CLI is too old.
function cliTooOld(stdout, stderr) {
  var errorText = boundedString(stderr || "", remoteErrorCharacterLimit)
  var outputText = boundedString(stdout || "", remoteErrorCharacterLimit)
  return /unknown (command|flag|event)/i.test(errorText + outputText)
}

// The account list: personal accounts with the mail capability.
var accountListCommand = ["fm-cli", "account", "list", "--json"]

// The `folders` setting picks the box the panel reads: `all` is the CLI's
// virtual box — the newest Inbox threads plus every unseen thread from every
// other included folder — and `inbox` is the Inbox alone. Anything else is
// the default.
var foldersModeChoices = ["all", "inbox"]

function foldersMode(value) {
  var mode = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  return foldersModeChoices.indexOf(mode) === -1 ? "all" : mode
}

// The `excludeFolders` setting is a comma-separated list of folder names or
// paths. Each entry becomes one argv element after `--exclude`, never part of
// a shell string, so quoting is not a concern; what is bounded is the count
// and the length of each entry, and control characters are removed. An entry
// that would read as a flag is dropped rather than handed to the CLI. A
// list already parsed passes through unchanged.
function parseExcludeFolders(value) {
  var source = Array.isArray(value) ? value.slice(0, maximumExcludeFolderCount).join(",") : value
  var parts = boundedString(source, excludeFoldersSettingCharacterLimit).split(",")
  var entries = []
  for (var i = 0; i < parts.length && entries.length < maximumExcludeFolderCount; i++) {
    var entry = boundedString(String(parts[i]).replace(/[\u0000-\u001f\u007f]/g, "").trim(), excludeFolderCharacterLimit).trim()
    if (entry === "" || entry.charAt(0) === "-") continue
    entries.push(entry)
  }
  return entries
}

// fm-cli box view is the read: the configured box, the panel's thread limit,
// and --account all once the CLI has shown it knows accounts, so a default
// account selection cannot hide mail from the panel. In `all` mode the
// exclude list follows as `--exclude <entry>` pairs; the Inbox has nothing
// to exclude.
function boxCommand(limit, withAccountFilter, mode, excludeFolders) {
  var box = foldersMode(mode)
  var command = ["fm-cli", "box", "view", box, "--limit", String(Math.min(maximumPostingCount, positiveInteger(limit, maximumPostingCount))), "--json"]
  if (withAccountFilter) command.splice(4, 0, "--account", "all")
  if (box === "all") {
    var excludes = parseExcludeFolders(excludeFolders)
    for (var i = 0; i < excludes.length; i++) command.push("--exclude", excludes[i])
  }
  return boundedCaptureCommand(command, cliResponseByteLimit, cliErrorByteLimit)
}

// fm-cli seen marks every email of the thread seen, in the account it lives in.
function seenCommand(id, accountId) {
  var thread = validId(id)
  if (thread === "") return []
  var command = ["fm-cli", "seen", thread]
  var account = validId(accountId)
  if (account !== "") command.push("--account", account)
  command.push("--json")
  return boundedCaptureCommand(command, cliResponseByteLimit, cliErrorByteLimit)
}

// fm-cli watch is the wake-up: it follows every mailbox over Fastmail's JMAP
// push connection and prints a line per change, plus "ready", "disconnected"
// and "resync" about itself. setpriv --pdeathsig ties it to the shell, so a
// shell that dies takes its watch along instead of leaving one behind per
// restart. It watches every mailbox — a move out of the Inbox is written in
// the mailbox the thread went to — across every account, and it asks for every
// event by name: `new` so each added and updated line says whether the thread
// is new mail, `resync` so a mailbox that skipped ahead is re-read. A CLI that
// does not know `new` refuses the command up front instead of running a watch
// that never says it.
function watchCommand() {
  return boundedCaptureCommand(
    ["setpriv", "--pdeathsig", "TERM", "fm-cli", "--account", "all", "watch", "--events", "added,updated,deleted,new,resync"],
    watchOutputByteLimit, cliErrorByteLimit, 0)
}

// watchLine reads one line from fm-cli watch: its change — added, updated or
// deleted for a thread; ready, disconnected or resync about the watch — and,
// for a thread, whether the CLI called it new mail, the mailbox it is in and
// the posting itself. Blank, malformed and oversized lines are discarded.
function watchLine(line) {
  var source = String(line || "")
  if (exceedsUtf8ByteLimit(source, watchLineByteLimit)) return null
  var text = source.trim()
  if (text === "") return null
  try {
    var value = JSON.parse(text)
    if (!value || typeof value.change !== "string") return null
    var event = { change: "", isNew: false, boxId: "", boxKind: "", boxName: "", posting: null }
    event.change = boundedString(value.change, remoteTypeCharacterLimit)
    event.isNew = value["new"] === true
    if (value.box && typeof value.box === "object") {
      event.boxId = boundedString(value.box.id || "", remoteIdCharacterLimit).trim()
      event.boxKind = boundedString(value.box.kind || "", remoteTypeCharacterLimit).trim().toLowerCase()
      event.boxName = cleanText(value.box.name || "", remoteNameCharacterLimit)
    }
    if (value.posting && typeof value.posting === "object") event.posting = boundedWatchPosting(value.posting)
    return event
  } catch (error) {
    return null
  }
}

function boundedWatchPosting(value) {
  var posting = value && typeof value === "object" ? value : {}
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  return {
    id: validId(posting.id),
    email_id: validId(posting.email_id),
    name: cleanText(posting.name || "", remoteTitleCharacterLimit),
    summary: cleanText(posting.summary || "", remoteExcerptCharacterLimit),
    app_url: boundedString(posting.app_url || "", remoteUrlCharacterLimit),
    account_id: validId(posting.account_id),
    alternative_sender_name: cleanText(posting.alternative_sender_name || "", remoteNameCharacterLimit),
    creator: {
      name: cleanText(creator.name || "", remoteNameCharacterLimit),
      email_address: cleanText(creator.email_address || "", remoteNameCharacterLimit)
    }
  }
}

// The toast. What counts as new is the CLI's call, made on every line; what
// to do about it is the plugin's: the Inbox only, one toast per burst,
// replaced rather than stacked, under the app-name Fastmail so Omarchy's
// notification silencing applies (its own `omarchy-action` pops through DND on
// purpose), with a generic unread-mail icon and a click that opens the
// configured destination. The exec runs on the shell's side, so it survives
// shell restarts.
var toastAppName = "Fastmail"
var toastIcon = "mail-unread"
var toastPreviewLimit = 96
var tuiAppId = "com.ninepointlabs.fm-cli"
var fastmailWebUrl = "https://app.fastmail.com"
var fastmailInboxUrl = fastmailWebUrl + "/mail/Inbox"

// There is no deep link into the TUI in this version: opening an email in the
// terminal focuses the TUI if it is running, and launches it on the Inbox
// otherwise.
// The TUI opens on a thread through two steps, like the HEY plugin's: a
// `--remote` hand-off to a TUI that is already running, then a focus-or-launch
// that either raises that TUI or starts a new one on the same thread. Without
// a thread id the TUI just opens or comes forward.
function tuiTargetArgs(threadId, emailId) {
  var args = []
  var thread = validId(threadId)
  var email = validId(emailId)
  if (thread !== "") args.push("--thread", thread)
  if (email !== "") args.push("--email", email)
  return args
}

function tuiRemoteCommand(threadId, emailId) {
  var target = tuiTargetArgs(threadId, emailId)
  if (target.length === 0) return []
  return ["fm-cli", "tui"].concat(target, ["--remote"])
}

// omarchy-launch-or-focus evals its launch command, and its -tui sibling
// flattens argv into that string unquoted. So the launch command is quoted
// here, word by word, and handed over as one argument.
function tuiLaunchCommand(threadId, emailId) {
  return ["omarchy-launch-tui", "--app-id=" + tuiAppId, "fm-cli", "tui"].concat(tuiTargetArgs(threadId, emailId))
}

function tuiFocusCommand(threadId, emailId) {
  return ["omarchy-launch-or-focus", tuiAppId, shellCommand(tuiLaunchCommand(threadId, emailId))]
}

function tuiOpenShell(threadId, emailId) {
  var remote = tuiRemoteCommand(threadId, emailId)
  var focus = shellCommand(tuiFocusCommand(threadId, emailId))
  if (remote.length === 0) return focus
  return shellCommand(remote) + " >/dev/null 2>&1 || true; " + focus
}

function shellCommand(command) {
  var parts = []
  for (var i = 0; i < command.length; i++) parts.push(shellQuote(command[i]))
  return parts.join(" ")
}

var toastFocusCommand = tuiFocusCommand()

// Fastmail posting URLs can be absolute or app-relative. Web actions stay on
// the canonical Fastmail origin, with the Inbox as the safe destination.
function fastmailBrowserUrl(value) {
  var url = boundedString(value, remoteUrlCharacterLimit).trim()
  if (/^https:\/\/app\.fastmail\.com(?:[/?#]|$)/i.test(url)) return url
  if (url.charAt(0) === "/") return fastmailWebUrl + url
  return fastmailInboxUrl
}

// The toast action follows the configured destination. Web destinations open
// the message URL, and grouped mail opens the Inbox.
// The click command is argv, never a shell string: omarchy-notification-send
// carries it word by word and the daemon runs it without a shell. The TUI
// action needs two steps (hand off, then focus or launch), so that one runs
// through bash -c with every word quoted and every id already validated.
function toastExecCommand(clickAction, targetUrl, threadId, emailId) {
  var action = String(clickAction || "")
  var url = fastmailBrowserUrl(targetUrl)
  if (action === "app") return ["omarchy-launch-webapp", url]
  if (action === "browser") return ["xdg-open", url]
  if (tuiRemoteCommand(threadId, emailId).length === 0) return tuiFocusCommand()
  return ["bash", "-c", tuiOpenShell(threadId, emailId)]
}

// Notification ids are daemon-local, not stable identities: after a shell
// restart the same number may belong to another application's notification,
// and -r would overwrite that instead of replacing ours. Replacement only
// matters for back-to-back bursts, so a short window loses nothing.
var toastReplaceWindowMs = 10 * 60 * 1000

// Mailboxes the `all` box never includes, by role. New mail there is not the
// user's attention.
var quietBoxKinds = ["junk", "trash", "drafts", "sent", "snoozed", "scheduled", "archive"]

// folderExcluded says whether a box the watch named is on the exclude list:
// by name, id or role, case-insensitively, the way the CLI reads the list.
// The CLI also excludes by path and takes a parent's children along; a watch
// line carries only the name, so a path entry excludes the folder it ends in
// and a parent's children are not recognized — a toast too many, never a
// folder read that disagrees with the panel.
function folderExcluded(box, excludeFolders) {
  var source = box && typeof box === "object" ? box : {}
  var excludes = parseExcludeFolders(excludeFolders)
  var name = cleanText(source.boxName || "", remoteNameCharacterLimit).toLowerCase()
  var id = boundedString(source.boxId || "", remoteIdCharacterLimit).trim().toLowerCase()
  var kind = boundedString(source.boxKind || "", remoteTypeCharacterLimit).trim().toLowerCase()
  for (var i = 0; i < excludes.length; i++) {
    var wanted = excludes[i].toLowerCase()
    if (wanted === name || (id !== "" && wanted === id) || (kind !== "" && wanted === kind)) return true
    var slash = wanted.lastIndexOf("/")
    if (slash !== -1 && name !== "" && wanted.substring(slash + 1).trim() === name) return true
  }
  return false
}

// newMailForToast decides whether a watch line is a toast. What counts as new
// is the CLI's call, made on every line; which boxes count is the plugin's:
// in `inbox` mode the Inbox alone, in `all` mode every box the `all` read
// includes — not the quiet roles, not the excluded folders.
function newMailForToast(event, mode, excludeFolders) {
  if (!event || event.isNew !== true || event.posting === null) return false
  var kind = boundedString(event.boxKind || "", remoteTypeCharacterLimit).trim().toLowerCase()
  if (foldersMode(mode) === "inbox") return kind === "inbox"
  if (quietBoxKinds.indexOf(kind) !== -1) return false
  return !folderExcluded(event, excludeFolders)
}

// toastBoxName is the box a burst is headlined with: the one box every
// queued posting arrived in, or a count of the boxes when they differ.
function toastBoxName(queue) {
  var source = Array.isArray(queue) ? queue.slice(0, maximumToastPostings) : []
  var names = []
  for (var i = 0; i < source.length; i++) {
    var name = cleanText(source[i] && source[i].boxName || "", remoteNameCharacterLimit)
    if (names.indexOf(name) === -1) names.push(name)
  }
  if (names.length === 0) return ""
  if (names.length === 1) return names[0]
  return names.length + " folders"
}

function postingSender(posting) {
  var creator = posting && posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  return cleanText(posting.alternative_sender_name || creator.name || creator.email_address || "", remoteNameCharacterLimit)
}

function postingSubject(posting) {
  return cleanText(posting.name || posting.summary || "", remoteTitleCharacterLimit)
}

// notificationPreview provides one concise body line. HTML breaks and escaped
// newlines establish the first line, and long previews end with an ellipsis.
function notificationPreview(value, limit) {
  var lines = boundedString(value, remoteExcerptCharacterLimit)
    .replace(/\\[nr]/g, "\n")
    .replace(/<br\s*\/?\s*>|<\/p\s*>/gi, "\n")
    .split(/\r?\n/)
  var preview = ""
  for (var i = 0; i < lines.length; i++) {
    preview = cleanText(lines[i])
    if (preview !== "") break
  }
  var maximum = positiveInteger(limit, toastPreviewLimit)
  if (preview.length <= maximum) return preview
  return preview.substring(0, maximum - 1).trim() + "…"
}

// composeMailToast gives each popup three content lines: Fastmail, the
// subject, and the first concise line of the message. A burst uses its count
// as the subject and the first senders as its description.
function composeMailToast(boxName, postings) {
  var fresh = Array.isArray(postings) ? postings.slice(0, maximumToastPostings) : []
  if (fresh.length === 1) {
    var posting = fresh[0]
    var subject = postingSubject(posting)
    var description = notificationPreview(posting.summary || "")
    if (description === subject) description = ""  // the summary already stood in for a missing subject
    return {
      headline: toastAppName + "\n" + subject,
      description: description,
      targetUrl: fastmailBrowserUrl(posting.app_url),
      threadId: boundedString(posting.id || "", remoteIdCharacterLimit),
      emailId: boundedString(posting.email_id || "", remoteIdCharacterLimit)
    }
  }

  var senders = []
  for (var i = 0; i < fresh.length; i++) {
    if (senders.length === 3) {
      senders.push("…")
      break
    }
    senders.push(postingSender(fresh[i]))
  }
  return {
    headline: toastAppName + "\n" + fresh.length + " new in " + (cleanText(boxName, remoteNameCharacterLimit) || "Inbox"),
    description: notificationPreview(senders.join(", ")),
    targetUrl: fastmailInboxUrl,
    threadId: "",
    emailId: ""
  }
}

// notificationText keeps mail-derived text from being read as an option:
// notify-send parses a leading dash wherever it appears, and a subject or
// summary can start with one. A word joiner is invisible on screen but makes
// the argument a plain positional.
function notificationText(text) {
  var value = boundedString(text, remoteExcerptCharacterLimit)
  return value.charAt(0) === "-" ? "\u2060" + value : value
}

// replaceableToastId is the last toast's id while it is recent enough to
// trust, and 0 otherwise.
function replaceableToastId(id, atMs, nowMs) {
  var value = Number(id || 0)
  if (!isFinite(value) || value <= 0) return 0
  return Number(nowMs) - Number(atMs || 0) > toastReplaceWindowMs ? 0 : value
}

// toastCommand is the argv: omarchy-notification-send takes its own options
// first, then the headline and the description, then anything for
// notify-send — -p to print the daemon's id, -r to replace the last one.
function toastCommand(headline, description, replaceId, clickAction, targetUrl, threadId, emailId) {
  var command = [
    "omarchy-notification-send",
    "--app-name", toastAppName,
    "-u", "low",
    "-i", toastIcon,
    "-p"
  ]
  var id = Number(replaceId || 0)
  if (isFinite(id) && id > 0) command.push("-r", String(id))
  command.push(notificationText(headline))
  if (String(description || "") !== "") command.push(notificationText(description))
  // --exec comes last and takes the rest of the line as the click argv.
  return command.concat(["--exec"], toastExecCommand(clickAction, targetUrl, threadId, emailId))
}

function parseAccounts(raw) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, accounts: [] }

  var data = Array.isArray(result.value.data) ? result.value.data : []
  var accounts = []
  var inputCount = Math.min(data.length, maximumAccountCount + 1)
  for (var i = 0; i < inputCount && accounts.length < maximumAccountCount; i++) {
    var account = data[i] || {}
    var id = boundedString(account.id || "", remoteIdCharacterLimit).trim()
    // "all" is the CLI's filter keyword, never an account of its own.
    if (id === "" || id === "all" || validId(id) === "") continue
    accounts.push({
      id: id,
      name: cleanText(account.name || account.email || ("Account " + id), remoteNameCharacterLimit),
      order: accounts.length
    })
  }

  return { ok: true, error: "", accounts: accounts }
}

function parseNotifications(raw, limit, accounts) {
  var result = parseJson(raw)
  if (!result.ok) return { ok: false, error: result.error, items: [] }

  var accountsById = Object.create(null)
  var source = Array.isArray(accounts) ? accounts : []
  var accountCount = Math.min(source.length, maximumAccountCount)
  for (var a = 0; a < accountCount; a++) {
    var sourceId = boundedString(source[a].id || "", remoteIdCharacterLimit)
    accountsById[sourceId] = source[a]
  }

  var data = result.value.data && typeof result.value.data === "object" ? result.value.data : {}
  var postings = Array.isArray(data.postings) ? data.postings : []
  var items = []
  var count = Math.min(maximumPostingCount, positiveInteger(limit, maximumPostingCount))
  var postingCount = Math.min(postings.length, maximumPostingCount)
  for (var i = 0; i < postingCount; i++) {
    var item = normalizeNotification(postings[i], accountsById)
    if (item) items.push(item)
  }

  items.sort(compareNotifications)
  if (items.length > count) items = items.slice(0, count)
  return { ok: true, error: "", items: items, folders: parseFolders(data) }
}

// The read's `folders`: the Inbox and every other included folder with
// unseen mail, in mailbox order, one entry per account when several are
// read. Bounded like every remote list.
function parseFolders(data) {
  var source = data && typeof data === "object" && Array.isArray(data.folders) ? data.folders : []
  var folders = []
  var count = Math.min(source.length, maximumFolderCount)
  for (var i = 0; i < count; i++) {
    var folder = normalizeFolder(source[i])
    if (folder) folders.push(folder)
  }
  return folders
}

function normalizeFolder(value) {
  var folder = value && typeof value === "object" ? value : {}
  var id = boundedString(folder.id || "", remoteIdCharacterLimit).trim()
  if (id === "") return null
  var kind = boundedString(folder.kind || "", remoteTypeCharacterLimit).trim().toLowerCase()
  return {
    id: id,
    kind: kind,
    name: cleanText(folder.name || "", remoteNameCharacterLimit) || (kind === "inbox" ? "Inbox" : "Folder"),
    accountId: boundedString(folder.account_id || "", remoteIdCharacterLimit).trim(),
    unreadCount: boundedRemoteCount(folder.unread_count, 0),
    totalCount: boundedRemoteCount(folder.total_count, 0),
    url: boundedString(folder.app_url || "", remoteUrlCharacterLimit)
  }
}

function present(value) {
  return value !== undefined && value !== null
}

// A posting is one thread as seen from a box. Its id is the thread id — an
// opaque, bounded string, the identity the plugin uses for seen and open. Its
// box is the folder the newest email sits in; a posting that names no box is
// the Inbox's, the way a plain Inbox read leaves it.
function normalizeNotification(value, accountsById) {
  var posting = value && typeof value === "object" ? value : {}
  var id = validId(posting.id)
  if (id === "") return null

  var hasBox = present(posting.box_id) || present(posting.box_kind) || present(posting.box_name)
  var boxKind = hasBox ? boundedString(posting.box_kind || "", remoteTypeCharacterLimit).trim().toLowerCase() : "inbox"
  var boxName = hasBox
    ? (cleanText(posting.box_name || "", remoteNameCharacterLimit) || (boxKind === "inbox" ? "Inbox" : "Folder"))
    : "Inbox"

  var timestamp = boundedString(posting.active_at || posting.updated_at || posting.created_at || "", remoteTimestampCharacterLimit)
  var parsedTime = Date.parse(timestamp)
  if (!isFinite(parsedTime)) parsedTime = 0
  var creator = posting.creator && typeof posting.creator === "object" ? posting.creator : {}
  var creatorName = cleanText(creator.name || creator.email_address || posting.alternative_sender_name || "", remoteNameCharacterLimit)
  var accountId = validId(posting.account_id)
  var account = (accountsById && accountsById[accountId]) || {}

  return {
    id: id,
    accountId: accountId,
    accountName: cleanText(account.name || "", remoteNameCharacterLimit),
    accountOrder: Number(account.order || 0),
    title: cleanText(posting.name || "Fastmail email", remoteTitleCharacterLimit),
    excerpt: cleanText(posting.summary || "", remoteExcerptCharacterLimit),
    project: "",
    creator: creatorName,
    initials: cleanText(creator.initials || "", remoteTypeCharacterLimit) || computeInitials(creatorName),
    type: "email",
    timestamp: timestamp,
    timestampMs: parsedTime,
    url: boundedString(posting.app_url || "", remoteUrlCharacterLimit),
    emailId: validId(posting.email_id),
    boxId: hasBox ? boundedString(posting.box_id || "", remoteIdCharacterLimit).trim() : "",
    boxKind: boxKind,
    boxName: boxName,
    unread: posting.seen !== true,
    // The badge counts unseen emails in the thread when the CLI says how many,
    // and falls back to the thread's visible emails.
    unreadCount: boundedRemoteCount(posting.unseen_count, boundedRemoteCount(posting.visible_entry_count, 1))
  }
}

function computeInitials(name) {
  var words = cleanText(name, remoteNameCharacterLimit).split(" ")
  var initials = ""
  for (var i = 0; i < words.length && initials.length < 2; i++) {
    var letter = words[i].charAt(0)
    if (/[0-9A-Za-z]/.test(letter)) initials += letter.toUpperCase()
  }
  return initials === "" ? "?" : initials
}

function compareNotifications(a, b) {
  if (a.unread !== b.unread) return a.unread ? -1 : 1
  var timeDifference = Number(b.timestampMs || 0) - Number(a.timestampMs || 0)
  if (timeDifference !== 0) return timeDifference
  var accountDifference = Number(a.accountOrder || 0) - Number(b.accountOrder || 0)
  if (accountDifference !== 0) return accountDifference
  return boundedString(a.id || "", remoteIdCharacterLimit).localeCompare(
    boundedString(b.id || "", remoteIdCharacterLimit))
}

function sortNotifications(items) {
  var sorted = Array.isArray(items) ? items.slice(0, maximumPostingCount) : []
  sorted.sort(compareNotifications)
  return sorted
}

// folderChips is what the folder strip renders: the Inbox first — one chip
// however many accounts have one, since the filter it sets is "the Inbox",
// not one account's — then every other folder with unseen mail, in the
// read's order. With an account selected, only that account's folders count.
// No folders, no chips: an Inbox read, or a CLI that lists none.
function folderChips(folders, accountId) {
  var source = Array.isArray(folders) ? folders.slice(0, maximumFolderCount) : []
  var selectedAccount = boundedString(accountId || "", remoteIdCharacterLimit)
  var inbox = null
  var others = []
  for (var i = 0; i < source.length; i++) {
    var folder = source[i] && typeof source[i] === "object" ? source[i] : {}
    var id = boundedString(folder.id || "", remoteIdCharacterLimit).trim()
    if (id === "") continue
    var folderAccount = boundedString(folder.accountId || "", remoteIdCharacterLimit)
    if (selectedAccount !== "" && folderAccount !== "" && folderAccount !== selectedAccount) continue
    var unread = boundedRemoteCount(folder.unreadCount, 0)
    var kind = boundedString(folder.kind || "", remoteTypeCharacterLimit).trim().toLowerCase()
    if (kind === "inbox") {
      if (inbox === null) inbox = { id: id, kind: "inbox", name: cleanText(folder.name || "", remoteNameCharacterLimit) || "Inbox", unreadCount: 0 }
      inbox.unreadCount = Math.min(remoteCountMaximum, inbox.unreadCount + unread)
    } else if (unread > 0) {
      others.push({ id: id, kind: kind, name: cleanText(folder.name || "", remoteNameCharacterLimit) || "Folder", unreadCount: unread })
    }
  }
  if (source.length === 0) return []
  // The contract lists the Inbox on every read; a response without one still
  // gets its chip, under a token no real folder shares in practice.
  if (inbox === null) inbox = { id: "inbox", kind: "inbox", name: "Inbox", unreadCount: 0 }
  return [inbox].concat(others)
}

// folderFilterMatches applies the folder filter to one thread: the Inbox chip
// matches by role, since every account's Inbox shares it; any other chip
// matches its folder's id, an opaque string.
function folderFilterMatches(item, folderId, chips) {
  var selected = boundedString(folderId || "", remoteIdCharacterLimit)
  if (selected === "") return true
  var source = Array.isArray(chips) ? chips : []
  var subject = item && typeof item === "object" ? item : {}
  for (var i = 0; i < source.length; i++) {
    var chip = source[i] || {}
    if (String(chip.id || "") !== selected) continue
    if (chip.kind === "inbox") return boundedString(subject.boxKind || "", remoteTypeCharacterLimit) === "inbox"
    break
  }
  return boundedString(subject.boxId || "", remoteIdCharacterLimit) === selected
}

function filterNotifications(items, accountId, state, folderId, chips) {
  var source = Array.isArray(items) ? items.slice(0, maximumPostingCount) : []
  var selectedAccount = boundedString(accountId || "", remoteIdCharacterLimit)
  var selectedState = boundedString(state || "all", remoteTypeCharacterLimit)
  return source.filter(function(item) {
    if (selectedAccount !== ""
        && boundedString(item.accountId || "", remoteIdCharacterLimit) !== selectedAccount) return false
    if (!folderFilterMatches(item, folderId, chips)) return false
    if (selectedState === "unread") return item.unread === true
    if (selectedState === "previous") return item.unread !== true
    return true
  })
}

// The count behind the bar icon: unread threads in the selected account, or
// all of them, whatever folder they sit in. The folder filter narrows the
// list, not the count.
function unreadCount(items, accountId) {
  var source = Array.isArray(items) ? items : []
  var selectedAccount = boundedString(accountId || "", remoteIdCharacterLimit)
  var count = 0
  for (var i = 0; i < source.length; i++) {
    var item = source[i] || {}
    if (selectedAccount !== ""
        && boundedString(item.accountId || "", remoteIdCharacterLimit) !== selectedAccount) continue
    if (item.unread === true) count++
  }
  return count
}

function accountFilterOptions(accounts) {
  var options = [{ value: "", label: "All accounts" }]
  var source = Array.isArray(accounts) ? accounts.slice(0, maximumAccountCount) : []
  source.sort(function(a, b) {
    return cleanText(a.name || "Fastmail", remoteNameCharacterLimit).toLowerCase().localeCompare(
      cleanText(b.name || "Fastmail", remoteNameCharacterLimit).toLowerCase())
  })
  for (var i = 0; i < source.length; i++) {
    options.push({
      value: boundedString(source[i].id || "", remoteIdCharacterLimit),
      label: cleanText(source[i].name || "Fastmail", remoteNameCharacterLimit)
    })
  }
  return options
}

// Chromatic ANSI slots only: black/white and the greys make unreadable
// avatar fills, so they never join the palette. Omarchy themes write
// colors.toml in one of two schemas — numbered terminal slots (color1..14)
// or named colors (red, bright_blue, ...) — so both key styles are listed.
var AVATAR_COLOR_KEYS = [
  "color1", "color2", "color3", "color4", "color5", "color6",
  "color9", "color10", "color11", "color12", "color13", "color14",
  "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown",
  "bright_red", "bright_yellow", "bright_green",
  "bright_cyan", "bright_blue", "bright_magenta"
]

function themeAvatarPalette(raw) {
  var byKey = {}
  var lines = boundedString(raw, cliErrorByteLimit).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) byKey[match[1]] = match[2]
  }

  var palette = []
  var seen = {}
  for (var k = 0; k < AVATAR_COLOR_KEYS.length; k++) {
    var hex = byKey[AVATAR_COLOR_KEYS[k]]
    if (!hex) continue
    var lower = hex.toLowerCase()
    if (seen[lower]) continue
    seen[lower] = true
    palette.push(hex)
  }
  return palette
}

function nameHash(text) {
  var value = boundedString(text, remoteNameCharacterLimit)
  var hash = 5381
  for (var i = 0; i < value.length; i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0
  return hash
}

// A stable hash of the sender picks the color, so one sender always gets the
// same fill.
function avatarColorIndex(name, count) {
  var total = Number(count || 0)
  if (!isFinite(total) || total <= 0) return 0
  return nameHash(cleanText(name, remoteNameCharacterLimit)) % total
}

function notificationBadgeText(item, hovered) {
  if (hovered) return "󰅖"  // md-close
  return String(Math.max(1, (item && item.unreadCount) || 0))
}

function decodeTextEntity(entity) {
  switch (String(entity || "").toLowerCase()) {
    case "&nbsp;": return " "
    case "&amp;": return "&"
    case "&lt;": return "<"
    case "&gt;": return ">"
    case "&#39;":
    case "&apos;": return "'"
    case "&quot;": return "\""
    default: return ""
  }
}

// Controls, C1, bidi overrides and zero-width characters never reach the
// panel or a toast: a subject "Invoice\u202Efdp.exe" would otherwise read
// as "Invoiceexe.pdf".
var invisibleCharacters = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

function cleanText(value, limit) {
  var maximum = positiveInteger(limit, remoteExcerptCharacterLimit)
  var text = boundedString(value, maximum)
    .replace(invisibleCharacters, " ")
    .replace(/\\[nrt]/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|#39|apos|quot);/gi, decodeTextEntity)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return boundedString(text, maximum)
}

function positiveInteger(value, fallback) {
  var parsed = parseInt(String(value || ""), 10)
  return isFinite(parsed) && parsed > 0 ? parsed : fallback
}

var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function notificationTime(timestampMs, nowMs) {
  var value = Number(timestampMs || 0)
  if (!isFinite(value) || value <= 0) return ""
  var now = nowMs === undefined ? Date.now() : Number(nowMs)
  var date = new Date(value)
  var ref = new Date(now)
  if (date.getFullYear() === ref.getFullYear() && date.getMonth() === ref.getMonth() && date.getDate() === ref.getDate()) {
    var hours = date.getHours()
    var hour12 = hours % 12 === 0 ? 12 : hours % 12
    var minutes = date.getMinutes()
    return hour12 + ":" + (minutes < 10 ? "0" + minutes : minutes) + (hours >= 12 ? "pm" : "am")
  }
  var label = MONTH_NAMES[date.getMonth()] + " " + date.getDate()
  if (date.getFullYear() !== ref.getFullYear()) label += ", " + date.getFullYear()
  return label
}

// The row's meta line: the time, the sender, then — when asked — the folder
// a thread was filed in (the Inbox goes without saying) and the account.
function notificationMeta(item, nowMs, showAccount, showFolder) {
  if (!item) return ""
  var parts = []
  var age = notificationTime(item.timestampMs, nowMs)
  var creator = cleanText(item.creator || "", remoteNameCharacterLimit)
  var account = cleanText(item.accountName || "", remoteNameCharacterLimit)
  var folder = cleanText(item.boxName || "", remoteNameCharacterLimit)
  var kind = boundedString(item.boxKind || "", remoteTypeCharacterLimit)
  if (age !== "") parts.push(age)
  if (creator !== "") parts.push(creator)
  if (showFolder === true && kind !== "inbox" && folder !== "") parts.push(folder)
  if (showAccount === true && account !== "") parts.push(account)
  return parts.join(" • ")
}

if (typeof module !== "undefined") {
  module.exports = {
    setupLockCheckCommand: setupLockCheckCommand,
    setupLaunchCommand: setupLaunchCommand,
    setupPlan: setupPlan,
    installCommand: installCommand,
    setupCommand: setupCommand,
    boundedCaptureCommand: boundedCaptureCommand,
    capturedCommandPayload: capturedCommandPayload,
    exceedsUtf8ByteLimit: exceedsUtf8ByteLimit,
    boundedString: boundedString,
    boundedRemoteCount: boundedRemoteCount,
    cliResponseByteLimit: cliResponseByteLimit,
    cliErrorByteLimit: cliErrorByteLimit,
    probeResponseByteLimit: probeResponseByteLimit,
    finiteCommandTimeoutSec: finiteCommandTimeoutSec,
    finiteCommandKillGraceSec: finiteCommandKillGraceSec,
    watchOutputByteLimit: watchOutputByteLimit,
    watchLineByteLimit: watchLineByteLimit,
    maximumAccountCount: maximumAccountCount,
    maximumPostingCount: maximumPostingCount,
    maximumToastPostings: maximumToastPostings,
    maximumFolderCount: maximumFolderCount,
    maximumExcludeFolderCount: maximumExcludeFolderCount,
    excludeFolderCharacterLimit: excludeFolderCharacterLimit,
    excludeFoldersSettingCharacterLimit: excludeFoldersSettingCharacterLimit,
    foldersModeChoices: foldersModeChoices,
    foldersMode: foldersMode,
    parseExcludeFolders: parseExcludeFolders,
    quietBoxKinds: quietBoxKinds,
    folderExcluded: folderExcluded,
    newMailForToast: newMailForToast,
    toastBoxName: toastBoxName,
    parseFolders: parseFolders,
    folderChips: folderChips,
    folderFilterMatches: folderFilterMatches,
    remoteIdCharacterLimit: remoteIdCharacterLimit,
    remoteNameCharacterLimit: remoteNameCharacterLimit,
    remoteTitleCharacterLimit: remoteTitleCharacterLimit,
    remoteExcerptCharacterLimit: remoteExcerptCharacterLimit,
    remoteUrlCharacterLimit: remoteUrlCharacterLimit,
    remoteTimestampCharacterLimit: remoteTimestampCharacterLimit,
    remoteTypeCharacterLimit: remoteTypeCharacterLimit,
    remoteCountCharacterLimit: remoteCountCharacterLimit,
    remoteCountMaximum: remoteCountMaximum,
    remoteErrorCharacterLimit: remoteErrorCharacterLimit,
    remoteHintCharacterLimit: remoteHintCharacterLimit,
    remoteCodeCharacterLimit: remoteCodeCharacterLimit,
    parseJson: parseJson,
    parseFailure: parseFailure,
    failureMessage: failureMessage,
    isAuthError: isAuthError,
    cliTooOld: cliTooOld,
    cliTooOldMessage: cliTooOldMessage,
    minimumCliVersion: minimumCliVersion,
    probeCommand: probeCommand,
    parseProbe: parseProbe,
    cliVersionTooOld: cliVersionTooOld,
    accountListCommand: accountListCommand,
    boxCommand: boxCommand,
    seenCommand: seenCommand,
    watchCommand: watchCommand,
    watchLine: watchLine,
    composeMailToast: composeMailToast,
    notificationPreview: notificationPreview,
    notificationText: notificationText,
    replaceableToastId: replaceableToastId,
    toastCommand: toastCommand,
    toastExecCommand: toastExecCommand,
    tuiFocusCommand: tuiFocusCommand,
    tuiLaunchCommand: tuiLaunchCommand,
    shellCommand: shellCommand,
    validId: validId,
    tuiRemoteCommand: tuiRemoteCommand,
    tuiTargetArgs: tuiTargetArgs,
    tuiOpenShell: tuiOpenShell,
    tuiAppId: tuiAppId,
    fastmailBrowserUrl: fastmailBrowserUrl,
    toastAppName: toastAppName,
    toastIcon: toastIcon,
    toastPreviewLimit: toastPreviewLimit,
    toastFocusCommand: toastFocusCommand,
    fastmailWebUrl: fastmailWebUrl,
    fastmailInboxUrl: fastmailInboxUrl,
    toastReplaceWindowMs: toastReplaceWindowMs,
    parseAccounts: parseAccounts,
    parseNotifications: parseNotifications,
    sortNotifications: sortNotifications,
    filterNotifications: filterNotifications,
    unreadCount: unreadCount,
    accountFilterOptions: accountFilterOptions,
    notificationBadgeText: notificationBadgeText,
    computeInitials: computeInitials,
    themeAvatarPalette: themeAvatarPalette,
    avatarColorIndex: avatarColorIndex,
    cleanText: cleanText,
    notificationTime: notificationTime,
    notificationMeta: notificationMeta
  }
}
