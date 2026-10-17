// Facts and text for the panel's About page (AboutPage.qml), kept out of QML
// so node can check them against the repo (tests/about.test.js).
//
// The version comes from manifest.json and the license from LICENSE at run
// time, so neither is copied here and neither can drift from the real file.

var NAME = "Fastmail"
var TAGLINE = "Your Fastmail mail in the Omarchy bar: unread mail from every folder, live, through fm-cli."
var ORGANIZATION = "Nine Point Labs"
var CREATED = "September 2026" // first commit: 2026-09-10
var SUPPORT_EMAIL = "help@ninepointlabs.com"

// Must stay true to what the plugin does (see README's Security section).
// Network: the plugin itself opens no connection; fm-cli (run through
// bin/fm-cli-run) talks JMAP to api.fastmail.com, where it also signs in.
// Clicks open only https://app.fastmail.com (Model.fastmailBrowserUrl). The
// install step runs `mise install github:ninepointlabs/fm-cli@<pinned>`, and
// fm-cli-run checks the binary's SHA-256 before running it. Credentials: fm-cli
// 0.3.x keeps them in the keyring (99designs/keyring, Secret Service or
// KWallet only, service "fm-cli"), or reads FM_API_TOKEN. The headless
// commands the panel runs open no database; only the fm-cli TUI caches mail
// in ~/.config/fm-cli/emails.db (mode 0600). The plugin writes its shell.json
// entry and the setup lock under $XDG_RUNTIME_DIR.
var PRIVACY = "No Nine Point Labs account, no telemetry, no analytics. The plugin itself opens no network "
  + "connection: it runs fm-cli, which talks only to Fastmail at api.fastmail.com, to sign you in and for "
  + "the JMAP API and push connection that read your accounts, folders and unread mail and mark a thread "
  + "seen when you open it or click its count. Opening an email in a web-app window or your browser goes "
  + "to app.fastmail.com, and Sign in opens Fastmail's consent page in your browser. Install fm-cli "
  + "downloads the pinned fm-cli release from github.com through mise and checks its SHA-256 before it "
  + "runs. Your Fastmail sign-in (an OAuth grant or API token) is kept by fm-cli in your system keyring "
  + "(Secret Service or KWallet, service fm-cli), never in a file; the plugin never reads it, and only "
  + "passes FM_API_TOKEN through to fm-cli if you set one. The panel holds email in memory only and caches "
  + "nothing on disk; "
  + "if you open mail in the fm-cli terminal app, that app caches what it lists in "
  + "~/.config/fm-cli/emails.db, readable only by you. The plugin saves its settings in "
  + "~/.config/omarchy/shell.json and a setup lock under $XDG_RUNTIME_DIR. New-mail notifications are "
  + "shown on this computer only, and are off by default."

var VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/

// "0.1.0" from manifest.json's text, or "" when it can't be read.
function manifestVersion(text) {
  var parsed
  try { parsed = JSON.parse(String(text || "")) } catch (e) { return "" }
  var version = parsed && typeof parsed.version === "string" ? parsed.version : ""
  return VERSION_PATTERN.test(version) ? version : ""
}

// "MIT License, © 2026 Nine Point Labs" from LICENSE's text: its first line
// plus its copyright line, as written there.
function licenseSummary(text) {
  var lines = String(text || "").split("\n")
  var name = ""
  var holder = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    if (name === "") name = line
    var m = /^Copyright\s+(?:\(c\)|©)\s*(.+)$/i.exec(line)
    if (m) { holder = "© " + m[1]; break }
  }
  return holder ? name + ", " + holder : name
}

// One line per paragraph, so LICENSE / THIRD_PARTY_NOTICES.md wrap to the
// panel's width.
function reflow(text) {
  var paras = String(text || "").replace(/\r/g, "").split(/\n\s*\n/)
  var out = []
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i].replace(/\s+/g, " ").trim()
    if (p !== "") out.push(p)
  }
  return out.join("\n\n")
}

// Highest minor version `has(major, minor)` accepts, as "major.minor"
// (Quickshell.hasVersion / hasQtVersion only answer yes or no), or "".
function probedVersion(has, major) {
  if (typeof has !== "function" || !has(major, 0)) return ""
  var minor = 0
  while (minor < 99 && has(major, minor + 1)) minor++
  return major + "." + minor
}

// fm-cli's version is the one the service's probe already read from
// `fm-cli --version`; anything that does not look like a version is dropped.
function builtWith(quickshell, qt, cli) {
  var out = []
  if (quickshell) out.push("Quickshell " + quickshell)
  if (qt) out.push("Qt " + qt)
  var base = out.length ? out.join(", ") : "Quickshell and Qt"
  var fmCli = String(cli || "")
  return VERSION_PATTERN.test(fmCli) ? base + ", fm-cli " + fmCli : base
}

// Version details to paste into a support email.
function details(version, quickshell, qt, cli, desktop) {
  return NAME + " for Omarchy " + (version || "unknown version") + "\n"
    + builtWith(quickshell, qt, cli) + "\n"
    + (desktop || "unknown desktop")
}

function mailto(version, detailText) {
  return "mailto:" + SUPPORT_EMAIL
    + "?subject=" + encodeURIComponent(NAME + " for Omarchy " + (version || ""))
    + "&body=" + encodeURIComponent("\n\n--\n" + detailText)
}

if (typeof module !== "undefined") {
  module.exports = {
    NAME: NAME, TAGLINE: TAGLINE, ORGANIZATION: ORGANIZATION, CREATED: CREATED,
    SUPPORT_EMAIL: SUPPORT_EMAIL, PRIVACY: PRIVACY,
    manifestVersion: manifestVersion, licenseSummary: licenseSummary, reflow: reflow,
    probedVersion: probedVersion, builtWith: builtWith, details: details, mailto: mailto
  }
}
