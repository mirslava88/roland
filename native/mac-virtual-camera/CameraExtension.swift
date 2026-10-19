import Foundation
import CoreMediaIO
import CoreVideo
import IOKit.audio

let cameraDeviceID = UUID(uuidString: "73FA8DC0-533B-4D57-986C-D5E6042FEE01")!
let cameraFrameDuration = CMTime(value: 1, timescale: 30)

final class CameraDevice: NSObject, CMIOExtensionDeviceSource {
    var device: CMIOExtensionDevice!
    var output: CameraStream!
    var input: CameraStream!
    var format: CMVideoFormatDescription!
    private var pool: CVPixelBufferPool!
    private var latest: CVPixelBuffer?
    private var receivedAt: Double = 0
    private var consumers = 0
    private var timer: DispatchSourceTimer?

    override init() {
        super.init()
        device = CMIOExtensionDevice(localizedName: "PDM Virtual Camera", deviceID: cameraDeviceID,
            legacyDeviceID: "com.roland.pdm.virtualcamera", source: self)
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
            width: 1920, height: 1080, extensions: nil, formatDescriptionOut: &format)
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, [
            kCVPixelBufferWidthKey: 1920, kCVPixelBufferHeightKey: 1080,
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ] as CFDictionary, &pool)
        let streamFormat = CMIOExtensionStreamFormat(formatDescription: format,
            maxFrameDuration: cameraFrameDuration, minFrameDuration: cameraFrameDuration, validFrameDurations: nil)
        output = CameraStream(owner: self, direction: .source, format: streamFormat,
            id: UUID(uuidString: "73FA8DC0-533B-4D57-986C-D5E6042FEE02")!)
        input = CameraStream(owner: self, direction: .sink, format: streamFormat,
            id: UUID(uuidString: "73FA8DC0-533B-4D57-986C-D5E6042FEE03")!)
        try! device.addStream(output.stream)
        try! device.addStream(input.stream)
    }

    var availableProperties: Set<CMIOExtensionProperty> { [.deviceTransportType, .deviceModel] }
    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let result = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) { result.transportType = kIOAudioDeviceTransportTypeVirtual }
        if properties.contains(.deviceModel) { result.model = "PDM Camera v1" }
        return result
    }
    func setDeviceProperties(_ properties: CMIOExtensionDeviceProperties) throws {}

    func receive(_ sample: CMSampleBuffer) {
        guard let image = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetWidth(image) == 1920,
            CVPixelBufferGetHeight(image) == 1080, CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else { return }
        latest = image
        receivedAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    }
    func clearInput() { latest = nil; receivedAt = 0 }
    func startOutput() {
        consumers += 1
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now(), repeating: 1.0 / 30.0)
        source.setEventHandler { [weak self] in self?.sendFrame() }
        timer = source
        source.resume()
    }
    func stopOutput() {
        consumers = max(0, consumers - 1)
        if consumers == 0 { timer?.cancel(); timer = nil }
    }
    private func sendFrame() {
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        var image = latest
        // Stop publishing stale event content after PDM stops or crashes.
        if image == nil || now.seconds - receivedAt > 2 {
            CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool,
                [kCVPixelBufferPoolAllocationThresholdKey: 6] as CFDictionary, &image)
            if let image {
                CVPixelBufferLockBaseAddress(image, [])
                if let base = CVPixelBufferGetBaseAddress(image) {
                    memset(base, 0, CVPixelBufferGetBytesPerRow(image) * 1080)
                }
                CVPixelBufferUnlockBaseAddress(image, [])
            }
        }
        guard let image else { return }
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: cameraFrameDuration, presentationTimeStamp: now, decodeTimeStamp: .invalid)
        if CMSampleBufferCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
            sampleTiming: &timing, sampleBufferOut: &sample) == noErr, let sample {
            output.stream.send(sample, discontinuity: [], hostTimeInNanoseconds: UInt64(now.seconds * 1_000_000_000))
        }
    }
}

final class CameraStream: NSObject, CMIOExtensionStreamSource {
    var stream: CMIOExtensionStream!
    private weak var owner: CameraDevice?
    private let direction: CMIOExtensionStream.Direction
    let formats: [CMIOExtensionStreamFormat]
    var activeFormatIndex: Int = 0
    private var producer: CMIOExtensionClient?
    private var consuming = false
    private var generation = 0

    init(owner: CameraDevice, direction: CMIOExtensionStream.Direction, format: CMIOExtensionStreamFormat, id: UUID) {
        self.owner = owner; self.direction = direction; self.formats = [format]
        super.init()
        stream = CMIOExtensionStream(localizedName: direction == .source ? "PDM Video" : "PDM Input",
            streamID: id, direction: direction, clockType: .hostTime, source: self)
    }
    var availableProperties: Set<CMIOExtensionProperty> {
        var properties: Set<CMIOExtensionProperty> = [.streamActiveFormatIndex, .streamFrameDuration]
        if direction == .sink { properties.formUnion([.streamSinkBufferQueueSize, .streamSinkBuffersRequiredForStartup, .streamSinkEndOfData]) }
        return properties
    }
    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let result = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { result.activeFormatIndex = 0 }
        if properties.contains(.streamFrameDuration) { result.frameDuration = cameraFrameDuration }
        if properties.contains(.streamSinkBufferQueueSize) { result.sinkBufferQueueSize = 3 }
        if properties.contains(.streamSinkBuffersRequiredForStartup) { result.sinkBuffersRequiredForStartup = 1 }
        if properties.contains(.streamSinkEndOfData) { result.sinkEndOfData = 0 }
        return result
    }
    func setStreamProperties(_ properties: CMIOExtensionStreamProperties) throws {
        if let index = properties.activeFormatIndex, index != 0 { throw NSError(domain: "PDM Camera", code: 1) }
    }
    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        if direction == .sink {
            if consuming && producer?.clientID != client.clientID { return false }
            producer = client
        }
        return true
    }
    func startStream() throws {
        if direction == .source { owner?.startOutput(); return }
        guard let client = producer, !consuming else { return }
        consuming = true; generation += 1
        consume(client, token: generation)
    }
    func stopStream() throws {
        if direction == .source { owner?.stopOutput(); return }
        consuming = false; generation += 1; producer = nil; owner?.clearInput()
    }
    private func consume(_ client: CMIOExtensionClient, token: Int) {
        guard consuming, generation == token else { return }
        stream.consumeSampleBuffer(from: client) { [weak self] sample, sequence, _, _, error in
            DispatchQueue.main.async {
                guard let self, self.consuming, self.generation == token else { return }
                if let sample {
                    self.owner?.receive(sample)
                    self.stream.notifyScheduledOutputChanged(CMIOExtensionScheduledOutput(sequenceNumber: sequence,
                        hostTimeInNanoseconds: UInt64(CMClockGetTime(CMClockGetHostTimeClock()).seconds * 1_000_000_000)))
                }
                // Poll an empty sink at a bounded rate; never recurse synchronously.
                DispatchQueue.main.asyncAfter(deadline: .now() + (sample == nil || error != nil ? 1.0 / 60 : 0)) {
                    self.consume(client, token: token)
                }
            }
        }
    }
}

final class CameraProvider: NSObject, CMIOExtensionProviderSource {
    var provider: CMIOExtensionProvider!
    let camera = CameraDevice()
    override init() {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: .main)
        try! provider.addDevice(camera.device)
    }
    func connect(to client: CMIOExtensionClient) throws {}
    func disconnect(from client: CMIOExtensionClient) {}
    var availableProperties: Set<CMIOExtensionProperty> { [.providerManufacturer] }
    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let result = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) { result.manufacturer = "Presentation Display Manager" }
        return result
    }
    func setProviderProperties(_ properties: CMIOExtensionProviderProperties) throws {}
}

@main struct CameraService {
    static func main() {
        let source = CameraProvider()
        CMIOExtensionProvider.startService(provider: source.provider)
        withExtendedLifetime(source) { dispatchMain() }
    }
}
