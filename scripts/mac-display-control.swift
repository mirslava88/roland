import Foundation
import CoreGraphics

struct Mode: Encodable {
    let width: Int
    let height: Int
    let frequency: Int
}

struct DisplayInfo: Encodable {
    let deviceName: String
    let friendlyName: String
    let isPrimary: Bool
    let current: Mode
    let modes: [Mode]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func emit<T: Encodable>(_ value: T) {
    do {
        let data = try JSONEncoder().encode(value)
        print(String(decoding: data, as: UTF8.self))
    } catch { fail("Cannot encode display result: \(error)") }
}

func onlineDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    let status = CGGetOnlineDisplayList(0, nil, &count)
    guard status == .success else { fail("Cannot list displays: \(status.rawValue)") }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { fail("Cannot list displays") }
    return Array(ids.prefix(Int(count))).filter {
        !(CGDisplayVendorNumber($0) == 0x5044 && CGDisplayModelNumber($0) == 0x4d52)
    }
}

func modeInfo(_ mode: CGDisplayMode) -> Mode {
    let rate = mode.refreshRate
    return Mode(width: mode.width, height: mode.height,
                frequency: rate > 0 ? Int(rate.rounded()) : 60)
}

guard CommandLine.arguments.count >= 2 else { fail("Usage: mac-display-control <list|set|clone|extend> [args]") }
let action = CommandLine.arguments[1]
let ids = onlineDisplays()
let main = CGMainDisplayID()

switch action {
case "list":
    emit(ids.compactMap { id -> DisplayInfo? in
        guard let current = CGDisplayCopyDisplayMode(id) else { return nil }
        let modes = (CGDisplayCopyAllDisplayModes(id, nil) as? [CGDisplayMode] ?? [])
            .filter { $0.width >= 640 && $0.height >= 480 }
            .map(modeInfo)
        var seen = Set<String>()
        let unique = ([modeInfo(current)] + modes).filter { mode in
            seen.insert("\(mode.width)x\(mode.height)x\(mode.frequency)").inserted
        }.sorted { ($0.width * $0.height, $0.frequency) > ($1.width * $1.height, $1.frequency) }
        return DisplayInfo(deviceName: String(id), friendlyName: CGDisplayIsBuiltin(id) != 0
                           ? "Встроенный экран" : "Внешний экран \(id)",
                           isPrimary: id == main, current: modeInfo(current), modes: unique)
    })
case "set":
    guard CommandLine.arguments.count == 6,
          let id = UInt32(CommandLine.arguments[2]), ids.contains(id),
          let width = Int(CommandLine.arguments[3]), let height = Int(CommandLine.arguments[4]),
          let frequency = Int(CommandLine.arguments[5]) else { fail("Invalid display or mode") }
    let options = CGDisplayCopyAllDisplayModes(id, nil) as? [CGDisplayMode] ?? []
    guard let mode = options.first(where: {
        let value = modeInfo($0)
        return value.width == width && value.height == height && value.frequency == frequency
    }) else { fail("Display mode is no longer available") }
    let status = CGDisplaySetDisplayMode(id, mode, nil)
    guard status == .success else { fail("Cannot set display mode: \(status.rawValue)") }
    emit(["success": true])
case "clone", "extend":
    guard ids.count > 1 else { fail("No additional display is connected") }
    var config: CGDisplayConfigRef?
    var status = CGBeginDisplayConfiguration(&config)
    guard status == .success, let config else { fail("Cannot start display configuration: \(status.rawValue)") }
    var x = Int32(CGDisplayBounds(main).maxX)
    for id in ids where id != main {
        status = CGConfigureDisplayMirrorOfDisplay(config, id, action == "clone" ? main : kCGNullDirectDisplay)
        if status == .success && action == "extend" {
            status = CGConfigureDisplayOrigin(config, id, x, 0)
            x += Int32(CGDisplayBounds(id).width)
        }
        if status != .success {
            CGCancelDisplayConfiguration(config)
            fail("Cannot configure display: \(status.rawValue)")
        }
    }
    status = CGCompleteDisplayConfiguration(config, .permanently)
    guard status == .success else { fail("Cannot apply display configuration: \(status.rawValue)") }
    emit(["success": true])
default:
    fail("Unknown display action")
}
