import AppKit
import CoreGraphics

guard CommandLine.arguments.count > 1,
      let displayID = UInt32(CommandLine.arguments[1]),
      let screen = NSScreen.screens.first(where: {
          ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
      }) else { exit(1) }

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

// Keynote's windowed player keeps animating when PDM is active, but its
// 16:9 window cannot fill an ultrawide display. Cover only the desktop behind
// that player, so the unused area is black without stealing focus or input.
let window = NSWindow(
    contentRect: NSRect(origin: .zero, size: screen.frame.size),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false,
    screen: screen
)
window.backgroundColor = .black
window.isOpaque = true
window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
window.ignoresMouseEvents = true
window.collectionBehavior = [.canJoinAllSpaces, .stationary]
window.orderFrontRegardless()
application.run()
