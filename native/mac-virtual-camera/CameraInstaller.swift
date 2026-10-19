import AppKit
import SystemExtensions

let extensionID = "com.roland.pdm.camera.extension"
final class Installer: NSObject, OSSystemExtensionRequestDelegate {
    func request(_ request: OSSystemExtensionRequest, actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension replacement: OSSystemExtensionProperties) -> OSSystemExtensionRequest.ReplacementAction { .replace }
    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        report(["phase": "approval", "message": "Разрешите PDM Virtual Camera в Настройках системы → Основные → Объекты входа и расширения → Расширения камеры."])
    }
    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        report(["phase": result == .completed ? "installed" : "reboot", "message": result == .completed ? "Камера установлена." : "Для завершения установки перезагрузите Mac."])
        exit(0)
    }
    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        let ns = error as NSError
        report(["phase": "error", "code": ns.code, "message": error.localizedDescription]); exit(1)
    }
    func report(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        }
    }
}
@main struct CameraInstaller {
    static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let installer = Installer()
        let request = CommandLine.arguments.contains("--deactivate")
            ? OSSystemExtensionRequest.deactivationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
            : OSSystemExtensionRequest.activationRequest(forExtensionWithIdentifier: extensionID, queue: .main)
        request.delegate = installer
        OSSystemExtensionManager.shared.submitRequest(request)
        withExtendedLifetime(installer) { NSApp.run() }
    }
}
