import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

guard CommandLine.arguments.count >= 3 else {
    fail("Usage: mac-pdf-pages <metadata|render> <pdf> [output directory width height]")
}
let action = CommandLine.arguments[1]
let source = URL(fileURLWithPath: CommandLine.arguments[2])
guard let document = CGPDFDocument(source as CFURL), document.numberOfPages > 0,
      let firstPage = document.page(at: 1) else { fail("Cannot open presentation PDF") }
let firstBounds = firstPage.getBoxRect(.mediaBox)
guard firstBounds.width > 0, firstBounds.height > 0 else { fail("Invalid PDF page size") }
emit(["slideCount": document.numberOfPages,
      "slideWidth": firstBounds.width, "slideHeight": firstBounds.height])
if action == "metadata" { exit(0) }
guard action == "render", CommandLine.arguments.count == 6,
      let width = Int(CommandLine.arguments[4]), let height = Int(CommandLine.arguments[5]),
      width > 0, height > 0, width <= 16384, height <= 16384 else { fail("Invalid render arguments") }
let output = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
do { try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true) }
catch { fail("Cannot create slide directory: \(error)") }

for index in 1...document.numberOfPages {
    guard let page = document.page(at: index) else { fail("Missing PDF page \(index)") }
    let bounds = page.getBoxRect(.mediaBox)
    let scale = min(CGFloat(width) / bounds.width, CGFloat(height) / bounds.height)
    let pixelWidth = max(1, Int((bounds.width * scale).rounded()))
    let pixelHeight = max(1, Int((bounds.height * scale).rounded()))
    guard let context = CGContext(data: nil, width: pixelWidth, height: pixelHeight,
                                  bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fail("Cannot create bitmap for page \(index)")
    }
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
    context.interpolationQuality = .high
    context.scaleBy(x: CGFloat(pixelWidth) / bounds.width, y: CGFloat(pixelHeight) / bounds.height)
    context.translateBy(x: -bounds.minX, y: -bounds.minY)
    context.drawPDFPage(page)
    guard let image = context.makeImage() else { fail("Cannot render page \(index)") }
    let target = output.appendingPathComponent("slide_\(index).png")
    guard let destination = CGImageDestinationCreateWithURL(target as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("Cannot save page \(index)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("PNG export failed for page \(index)") }
    emit(["slide": index, "slideCount": document.numberOfPages,
          "slideWidth": firstBounds.width, "slideHeight": firstBounds.height,
          "path": target.path])
}
