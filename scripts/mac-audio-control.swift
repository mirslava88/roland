import Foundation
import CoreAudio

struct OutputDevice: Encodable {
    let id: String
    let name: String
    let isDefault: Bool
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func address(_ selector: AudioObjectPropertySelector,
             _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

func deviceIDs() -> [AudioDeviceID] {
    var property = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size) == noErr,
          size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    let status = ids.withUnsafeMutableBytes { bytes in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, bytes.baseAddress!)
    }
    guard status == noErr else { return [] }
    return ids
}

func defaultOutput() -> AudioDeviceID {
    var property = address(kAudioHardwarePropertyDefaultOutputDevice)
    var result = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &result) == noErr else {
        return AudioDeviceID(kAudioObjectUnknown)
    }
    return result
}

func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var property = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &property, 0, nil, &size, &value) == noErr,
          let string = value?.takeRetainedValue() else { return nil }
    return string as String
}

func hasOutputStreams(_ id: AudioDeviceID) -> Bool {
    var property = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput)
    var size: UInt32 = 0
    return AudioObjectGetPropertyDataSize(id, &property, 0, nil, &size) == noErr && size > 0
}

func outputDevices() -> [(device: AudioDeviceID, value: OutputDevice)] {
    let selected = defaultOutput()
    return deviceIDs().compactMap { id in
        guard hasOutputStreams(id),
              let uid = stringProperty(id, kAudioDevicePropertyDeviceUID), !uid.isEmpty else { return nil }
        let name = stringProperty(id, kAudioDevicePropertyDeviceNameCFString) ?? uid
        return (id, OutputDevice(id: uid, name: name, isDefault: id == selected))
    }
}

func emit<T: Encodable>(_ value: T) {
    do {
        let data = try JSONEncoder().encode(value)
        guard let line = String(data: data, encoding: .utf8) else { fail("Cannot encode audio result") }
        print(line)
    } catch { fail("Cannot encode audio result: \(error)") }
}

guard CommandLine.arguments.count >= 2 else { fail("Usage: mac-audio-control <list|get-default|set> [device UID]") }
let action = CommandLine.arguments[1]
switch action {
case "list":
    emit(outputDevices().map(\.value))
case "get-default":
    guard let selected = outputDevices().first(where: { $0.value.isDefault }) else { fail("No default audio output") }
    emit(selected.value)
case "set":
    guard CommandLine.arguments.count == 3 else { fail("Missing audio device UID") }
    let uid = CommandLine.arguments[2]
    guard let selected = outputDevices().first(where: { $0.value.id == uid }) else { fail("Audio output is unavailable") }
    var property = address(kAudioHardwarePropertyDefaultOutputDevice)
    var device = selected.device
    let size = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, size, &device) == noErr else {
        fail("Cannot change the default audio output")
    }
    guard defaultOutput() == device else { fail("The default audio output did not change") }
    emit(selected.value)
default:
    fail("Unknown audio action")
}
