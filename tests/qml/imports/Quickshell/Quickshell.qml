pragma Singleton
import QtQml

QtObject {
  property var detachedCommands: []
  property var detachedContexts: []

  // Quickshell accepts an argv list or a ProcessContext-shaped object.
  function execDetached(command) {
    var context = command && typeof command === "object" && !Array.isArray(command)
      ? command : { command: command, environment: null, clearEnvironment: false }
    var commands = detachedCommands.slice()
    commands.push(context.command)
    detachedCommands = commands
    var contexts = detachedContexts.slice()
    contexts.push(context)
    detachedContexts = contexts
  }

  function resetDetachedCommands() {
    detachedCommands = []
    detachedContexts = []
  }

  // A hostile session: none of these may reach a process except the values a
  // closed environment keeps.
  function env(name) {
    if (name === "XDG_RUNTIME_DIR") return "/tmp"
    if (name === "HOME") return "/home/tester"
    if (name === "WAYLAND_DISPLAY") return "wayland-1"
    if (name === "PATH") return "/home/tester/.local/bin:/usr/bin"
    if (name === "BASH_ENV") return "/home/tester/.evil"
    if (name === "LD_PRELOAD") return "/home/tester/evil.so"
    return ""
  }
}
