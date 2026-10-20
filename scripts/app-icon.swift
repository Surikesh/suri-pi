import AppKit

let root = CommandLine.arguments[1]
let source = CommandLine.arguments[2]
guard let icon = NSImage(contentsOfFile: source) else {
    fatalError("Could not load the Suri Pi icon at \(source)")
}

try FileManager.default.createDirectory(
    atPath: root,
    withIntermediateDirectories: true
)

for logical in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = logical * scale
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: pixels,
            pixelsHigh: pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )!
        let context = NSGraphicsContext(bitmapImageRep: rep)!
        let size = CGFloat(pixels)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.clear(CGRect(x: 0, y: 0, width: size, height: size))
        context.imageInterpolation = .high
        icon.draw(
            in: NSRect(x: 0, y: 0, width: size, height: size),
            from: .zero,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: false,
            hints: [.interpolation: NSImageInterpolation.high]
        )
        NSGraphicsContext.restoreGraphicsState()

        let suffix = scale == 2 ? "@2x" : ""
        let output = URL(
            fileURLWithPath: root + "/icon_\(logical)x\(logical)\(suffix).png"
        )
        try rep.representation(using: .png, properties: [:])!.write(to: output)
    }
}
