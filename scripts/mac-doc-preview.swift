import Foundation
import AppKit
import CoreGraphics
import CoreText
import QuickLookThumbnailing

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else { fail("Usage: mac-doc-preview <source> <destination.pdf>") }
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let destination = URL(fileURLWithPath: CommandLine.arguments[2])
guard FileManager.default.fileExists(atPath: source.path) else { fail("Document does not exist") }

func previewImage(_ file: URL) -> CGImage? {
    let request = QLThumbnailGenerator.Request(fileAt: file,
                                                size: CGSize(width: 1200, height: 1600),
                                                scale: 2,
                                                representationTypes: .all)
    let semaphore = DispatchSemaphore(value: 0)
    var captured: CGImage?
    QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, _ in
        if let representation, representation.type != .icon {
            captured = representation.cgImage
        }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 12) == .success else { return nil }
    return captured
}

var image = previewImage(source)
var convertedText: NSAttributedString?
if image == nil && ["doc", "docx", "odt"].contains(source.pathExtension.lowercased()) {
    let intermediate = FileManager.default.temporaryDirectory
        .appendingPathComponent("pdm-doc-preview-\(UUID().uuidString).rtf")
    defer { try? FileManager.default.removeItem(at: intermediate) }
    let converter = Process()
    converter.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
    converter.arguments = ["-convert", "rtf", "-output", intermediate.path, source.path]
    do {
        try converter.run()
        converter.waitUntilExit()
        if converter.terminationStatus == 0 {
            convertedText = try? NSAttributedString(url: intermediate,
                                                    options: [.documentType: NSAttributedString.DocumentType.rtf],
                                                    documentAttributes: nil)
        }
    } catch { /* the caller receives a clear preview failure */ }
}
guard image != nil || convertedText != nil else { fail("Quick Look did not provide a document preview") }

var bounds = image.map { CGRect(x: 0, y: 0, width: $0.width, height: $0.height) }
    ?? CGRect(x: 0, y: 0, width: 595, height: 842)
guard let context = CGContext(destination as CFURL, mediaBox: &bounds, nil) else { fail("Cannot create preview PDF") }
context.beginPDFPage(nil)
context.setFillColor(CGColor(gray: 1, alpha: 1))
context.fill(bounds)
if let image {
    context.draw(image, in: bounds)
} else if let convertedText {
    let area = CGPath(rect: CGRect(x: 42, y: 42, width: 511, height: 758), transform: nil)
    let setter = CTFramesetterCreateWithAttributedString(convertedText)
    let frame = CTFramesetterCreateFrame(setter, CFRangeMake(0, 0), area, nil)
    CTFrameDraw(frame, context)
}
context.endPDFPage()
context.closePDF()
print(destination.path)
