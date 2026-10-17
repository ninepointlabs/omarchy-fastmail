// The About page's facts come from the repo's own files (manifest.json,
// LICENSE, git history), so these check About.js against the real files, and
// check that the privacy statement names every network host the code can
// reach.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const About = require("../About.js")

const root = path.join(__dirname, "..")
const read = (name) => fs.readFileSync(path.join(root, name), "utf8")
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })

test("version comes from manifest.json", () => {
  const manifest = JSON.parse(read("manifest.json"))
  assert.equal(About.manifestVersion(read("manifest.json")), manifest.version)
  assert.equal(About.manifestVersion("not json"), "")
  assert.equal(About.manifestVersion(""), "")
  assert.equal(About.manifestVersion("null"), "")
  assert.equal(About.manifestVersion('{"version":"1.0 <b>"}'), "")
  assert.equal(About.NAME, manifest.name)
  assert.equal(manifest.author, "Nine Point Labs")
})

test("license summary and text come from LICENSE", () => {
  const text = read("LICENSE")
  assert.equal(About.licenseSummary(text), "MIT License, © 2026 Nine Point Labs")
  assert.equal(About.licenseSummary("Some License\n\nno holder"), "Some License")
  assert.equal(About.licenseSummary(""), "")
  const body = About.reflow(text)
  assert.ok(body.startsWith("MIT License\n\nCopyright (c) 2026 Nine Point Labs\n\nPermission is hereby granted"))
  assert.ok(body.includes("THE SOFTWARE IS PROVIDED \"AS IS\""))
  assert.ok(!body.includes("a copy\nof"), "one line per paragraph")
  assert.ok(About.reflow(read("THIRD_PARTY_NOTICES.md")).startsWith("# Third-party notices\n\n"))
})

test("facts: Nine Point Labs, created date, support address", (t) => {
  assert.equal(About.ORGANIZATION, "Nine Point Labs")
  assert.equal(About.SUPPORT_EMAIL, "help@ninepointlabs.com")
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    t.skip("shallow clone: the first commit is not in the history")
    return
  }
  const first = git("log", "--reverse", "--format=%ad", "--date=format:%B %Y").split("\n")[0]
  assert.equal(About.CREATED, first)
})

test("no file still spells the company Ninepoint", () => {
  const files = git("ls-files").split("\n").filter(f => f && !/\.(png|svg)$/.test(f))
  for (const f of files) assert.doesNotMatch(read(f), /Ninepoint\s+Labs|NINEPOINT\s+LABS/, f)
})

test("privacy statement names every network host in the code", () => {
  const privacy = About.PRIVACY
  assert.match(privacy, /no telemetry/)
  // fm-cli's own JMAP and sign-in host: the plugin reaches Fastmail only
  // through it, so the name is not in this repo's code.
  assert.ok(privacy.includes("api.fastmail.com"))
  assert.ok(privacy.includes("keyring") && privacy.includes("service fm-cli"), "names where the sign-in lives")
  assert.ok(privacy.includes("~/.config/omarchy/shell.json"))
  assert.ok(privacy.includes("~/.config/fm-cli/emails.db"))

  const sources = fs.readdirSync(root).filter(f => /\.(qml|js)$/.test(f))
    .concat(fs.readdirSync(path.join(root, "bin")).map(f => path.join("bin", f)))
  const hosts = new Set()
  for (const f of sources) {
    const text = read(f)
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      if (/\.[A-Za-z]{2,}$/.test(m[1])) hosts.add(m[1])
    }
    // A mise package spec downloads from GitHub.
    if (/["']github:/.test(text)) hosts.add("github.com")
  }
  assert.ok(hosts.has("app.fastmail.com"), "the scan sees the web origin")
  assert.ok(hosts.has("github.com"), "the scan sees the pinned install")
  for (const host of hosts) assert.ok(privacy.includes(host), host + " is not named in the privacy text")
})

test("toolkit and fm-cli versions are shown, and the support mail prefills them", () => {
  assert.equal(About.probedVersion((major, minor) => major === 6 && minor <= 11, 6), "6.11")
  assert.equal(About.probedVersion((major, minor) => major === 0 && minor <= 3, 0), "0.3")
  assert.equal(About.probedVersion(() => false, 6), "")
  assert.equal(About.probedVersion(null, 6), "")
  assert.equal(About.builtWith("", "", ""), "Quickshell and Qt")
  assert.equal(About.builtWith("0.3", "6.11", "0.3.3"), "Quickshell 0.3, Qt 6.11, fm-cli 0.3.3")
  assert.equal(About.builtWith("0.3", "6.11", "0.3.3\nspoof"), "Quickshell 0.3, Qt 6.11")
  const details = About.details("0.1.0", "0.3", "6.11", "0.3.3", "Hyprland, wayland")
  assert.equal(details, "Fastmail for Omarchy 0.1.0\nQuickshell 0.3, Qt 6.11, fm-cli 0.3.3\nHyprland, wayland")
  assert.equal(About.details("", "", "", "", ""), "Fastmail for Omarchy unknown version\nQuickshell and Qt\nunknown desktop")
  const url = About.mailto("0.1.0", details)
  assert.ok(url.startsWith("mailto:help@ninepointlabs.com?subject=Fastmail%20for%20Omarchy%200.1.0&body="))
  assert.equal(decodeURIComponent(url.split("&body=")[1]), "\n\n--\n" + details)
})

test("the panel reaches About from its header, I, Esc and IPC, and resets on close", () => {
  const panel = read("Panel.qml")
  const page = read("AboutPage.qml")
  assert.match(panel, /id:\s*aboutButton[\s\S]*?iconText:\s*"󰋽"[\s\S]*?onClicked:\s*root\.setAbout\(true\)/)
  assert.match(panel, /if \(text === "i" \|\| text === "I"\) root\.setAbout\(!root\.aboutOpen\)\s*else if \(root\.aboutOpen\) return/)
  assert.match(panel, /else if \(root\.aboutOpen\) root\.setAbout\(false\)/)
  assert.match(panel, /function about\(\): void \{ root\.showAboutPage\(\) \}/)
  assert.match(panel, /if \(!opened\) \{[^}]*aboutOpen = false/)
  assert.match(panel, /id:\s*content\s*anchors\.fill:\s*parent\s*visible:\s*!root\.settingsOpen && !root\.aboutOpen/)
  // The Email button runs the probed xdg-open, never a desktop-wide opener.
  assert.match(panel, /mailLauncher:\s*Model\.toolPath\(service\.tools,\s*"xdg-open"\)/)
  assert.match(page, /command:\s*\[root\.mailLauncher,\s*About\.mailto\(/)
  assert.match(page, /Quickshell\.clipboardText = text/)
  for (const name of ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) assert.ok(page.includes('"/' + name + '"'), name)
  assert.match(read("Service.qml"), /cliVersion = probe\.version/)
})
