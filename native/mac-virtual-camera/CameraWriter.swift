import Foundation
import CoreMediaIO
import CoreMedia
import CoreVideo

let cameraUID = "com.roland.pdm.virtualcamera"
let frameBytes = 1920 * 1080 * 4
func json(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
func objects(_ object: CMIOObjectID, selector: Int, scope: Int = kCMIOObjectPropertyScopeGlobal) -> [CMIOObjectID] {
    var address = CMIOObjectPropertyAddress(mSelector: UInt32(selector), mScope: UInt32(scope), mElement: UInt32(kCMIOObjectPropertyElementMain))
    var size: UInt32 = 0
    guard CMIOObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var result = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
    var used: UInt32 = 0
    guard CMIOObjectGetPropertyData(object, &address, 0, nil, size, &used, &result) == noErr else { return [] }
    return Array(result.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size))
}
func property(_ object: CMIOObjectID, selector: Int) -> String {
    var address = CMIOObjectPropertyAddress(mSelector: UInt32(selector), mScope: UInt32(kCMIOObjectPropertyScopeGlobal), mElement: UInt32(kCMIOObjectPropertyElementMain))
    var value: Unmanaged<CFString>?
    var used: UInt32 = 0
    if CMIOObjectGetPropertyData(object, &address, 0, nil, UInt32(MemoryLayout.size(ofValue: value)), &used, &value) == noErr {
        return value?.takeRetainedValue() as String? ?? ""
    }
    return ""
}
func findCamera() -> CMIOObjectID? {
    objects(CMIOObjectID(kCMIOObjectSystemObject), selector: kCMIOHardwarePropertyDevices).first {
        let uid = property($0, selector: kCMIODevicePropertyDeviceUID)
        return uid == cameraUID || uid == "73FA8DC0-533B-4D57-986C-D5E6042FEE01"
    }
}

@main struct CameraWriter {
    static func main() {
        if CommandLine.arguments.contains("--devices") {
            let devices = objects(CMIOObjectID(kCMIOObjectSystemObject), selector: kCMIOHardwarePropertyDevices).map { device in
                ["id": device, "uid": property(device, selector: kCMIODevicePropertyDeviceUID),
                 "name": property(device, selector: kCMIOObjectPropertyName),
                 "inputs": objects(device, selector: kCMIODevicePropertyStreams, scope: kCMIODevicePropertyScopeInput),
                 "outputs": objects(device, selector: kCMIODevicePropertyStreams, scope: kCMIODevicePropertyScopeOutput)] as [String: Any]
            }
            json(["devices": devices]); return
        }
        let device = findCamera()
        if CommandLine.arguments.contains("--status") { json(["installed": device != nil]); return }
        guard let device else { json(["phase": "error", "message": "Сначала установите и разрешите PDM Virtual Camera в macOS."]); exit(2) }
        guard let stream = objects(device, selector: kCMIODevicePropertyStreams, scope: kCMIODevicePropertyScopeOutput).first else {
            json(["phase": "error", "message": "Камера PDM не предоставила входной поток."]); exit(3)
        }
        var queueReference: Unmanaged<CMSimpleQueue>?
        guard CMIOStreamCopyBufferQueue(stream, nil, nil, &queueReference) == noErr, let queue = queueReference?.takeRetainedValue() else {
            json(["phase": "error", "message": "Не удалось подключить очередь камеры PDM."]); exit(4)
        }
        guard CMIODeviceStartStream(device, stream) == noErr else {
            json(["phase": "error", "message": "Камера занята другой копией PDM или недоступна."]); exit(5)
        }
        defer { CMIODeviceStopStream(device, stream) }
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, [kCVPixelBufferWidthKey: 1920,
            kCVPixelBufferHeightKey: 1080, kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pool)
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
            width: 1920, height: 1080, extensions: nil, formatDescriptionOut: &format)
        guard let pool, let format else { exit(6) }
        json(["phase": "running"])
        var bytes = Data(); bytes.reserveCapacity(frameBytes)
        while true {
            guard let chunk = try? FileHandle.standardInput.read(upToCount: frameBytes - bytes.count), !chunk.isEmpty else { break }
            bytes.append(chunk)
            if bytes.count < frameBytes { continue }
            autoreleasepool {
                defer { bytes.removeAll(keepingCapacity: true) }
                // Drop a full queue instead of accumulating delayed video.
                guard CMSimpleQueueGetCount(queue) < CMSimpleQueueGetCapacity(queue) else { return }
                var image: CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool,
                    [kCVPixelBufferPoolAllocationThresholdKey: 6] as CFDictionary, &image) == noErr, let image else { return }
                CVPixelBufferLockBaseAddress(image, [])
                if let base = CVPixelBufferGetBaseAddress(image) {
                    let stride = CVPixelBufferGetBytesPerRow(image)
                    bytes.withUnsafeBytes { raw in
                        for row in 0..<1080 { memcpy(base.advanced(by: row * stride), raw.baseAddress!.advanced(by: row * 1920 * 4), 1920 * 4) }
                    }
                }
                CVPixelBufferUnlockBaseAddress(image, [])
                var sample: CMSampleBuffer?
                var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30),
                    presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()), decodeTimeStamp: .invalid)
                guard CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
                    dataReady: true, makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
                    sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample else { return }
                let retained = Unmanaged.passRetained(sample)
                if CMSimpleQueueEnqueue(queue, element: retained.toOpaque()) != noErr { retained.release() }
            }
        }
    }
}
