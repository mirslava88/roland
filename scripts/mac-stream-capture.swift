import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import CoreGraphics

func captureError(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardError.write(data); FileHandle.standardError.write(Data([10])); exit(1)
}

@available(macOS 12.3, *)
final class ProgramCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let width: Int, height: Int, fps: Int
    private let lock = NSLock()
    private var latest: Data?
    private var stream: SCStream?
    private var timer: DispatchSourceTimer?
    private let black = CGColor(gray: 0, alpha: 1)
    init(width: Int, height: Int, fps: Int) { self.width = width; self.height = height; self.fps = fps }
    func start(displayID: UInt32) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard error == nil, let display = content?.displays.first(where: { $0.displayID == displayID }) else {
                captureError("Не удалось захватить эфирный экран. Разрешите запись экрана для PDM Stream в настройках macOS.")
            }
            let config = SCStreamConfiguration()
            config.width = self.width; config.height = self.height
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(self.fps))
            config.queueDepth = 3; config.showsCursor = false
            if #available(macOS 13.0, *) { config.capturesAudio = false }
            config.scalesToFit = true
            if #available(macOS 14.0, *) { config.preservesAspectRatio = true }
            config.backgroundColor = self.black
            let factor = min(Double(self.width) / Double(display.width), Double(self.height) / Double(display.height))
            let w = Double(display.width) * factor, h = Double(display.height) * factor
            config.destinationRect = CGRect(x: (Double(self.width) - w) / 2, y: (Double(self.height) - h) / 2, width: w, height: h)
            let capture = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
            self.stream = capture
            do { try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "pdm.capture.frames", qos: .userInteractive)) }
            catch { captureError("Не удалось подготовить захват эфирного экрана.") }
            capture.startCapture { error in
                if error != nil { captureError("macOS отказала в захвате эфирного экрана. Проверьте разрешение записи экрана.") }
                self.writeFrames()
            }
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        captureError("Захват эфирного экрана остановился. Проверьте подключение монитора и разрешение macOS.")
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let image = CMSampleBufferGetImageBuffer(sample),
            CVPixelBufferGetWidth(image) == width, CVPixelBufferGetHeight(image) == height else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        if let status = attachments?.first?[.status] as? Int, status != SCFrameStatus.complete.rawValue { return }
        CVPixelBufferLockBaseAddress(image, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(image) else { return }
        let stride = CVPixelBufferGetBytesPerRow(image)
        var frame = Data(count: width * height * 4)
        frame.withUnsafeMutableBytes { bytes in
            for row in 0..<height { memcpy(bytes.baseAddress!.advanced(by: row * width * 4), base.advanced(by: row * stride), width * 4) }
        }
        lock.lock(); latest = frame; lock.unlock()
    }
    private func writeFrames() {
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "pdm.capture.pipe", qos: .userInteractive))
        source.schedule(deadline: .now(), repeating: 1.0 / Double(fps))
        source.setEventHandler {
            self.lock.lock(); let frame = self.latest; self.lock.unlock()
            guard let frame else { return }
            // Keep static slides at the selected frame rate. ScreenCaptureKit
            // can omit unchanged frames; retain only its newest full image.
            do { try FileHandle.standardOutput.write(contentsOf: frame) }
            catch { exit(0) }
        }
        timer = source; source.resume()
    }
}

let args = CommandLine.arguments
guard args.count == 5, let displayID = UInt32(args[1]), let width = Int(args[2]), let height = Int(args[3]),
    let fps = Int(args[4]), [1280, 1920].contains(width), [720, 1080].contains(height), [25, 30, 50, 60].contains(fps) else {
    captureError("Некорректные параметры захвата PDM.")
}
if #available(macOS 12.3, *) {
    let capture = ProgramCapture(width: width, height: height, fps: fps)
    capture.start(displayID: displayID)
    withExtendedLifetime(capture) { dispatchMain() }
} else { captureError("Для стриминга нужна macOS 12.3 или новее.") }
