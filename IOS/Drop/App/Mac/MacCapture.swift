#if os(macOS) && DEBUG
import AppKit
import ScreenCaptureKit
import DropKit

/// Verification en developpement : `-DropCapture /chemin.png -DropPageMac stats`
/// photographie la fenetre de l'app (ses propres fenetres seulement, sans
/// autorisation d'enregistrement d'ecran) apres quelques secondes.
@MainActor
enum MacCapture {
    static func planifie() {
        let reglages = UserDefaults.standard
        guard let chemin = reglages.string(forKey: "DropCapture") else { return }
        if let nom = reglages.string(forKey: "DropPageMac"), let page = MacPage(rawValue: nom) {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2.5))
                NotificationCenter.default.post(name: .dropAllerA, object: page)
            }
        }
        // `-DropDeplier printed:LP` deplie une categorie d'Imprime avant la photo
        if let cle = reglages.string(forKey: "DropDeplier") {
            let morceaux = cle.split(separator: ":").map(String.init)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(4))
                if morceaux.count == 2, let scope = PrintScope(rawValue: morceaux[0]) {
                    AppModel.shared.printing.toggle(morceaux[1], scope)
                }
            }
        }
        let delai = reglages.double(forKey: "DropCaptureDelai")
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delai > 0 ? delai : 6))
            do {
                let contenu = try await SCShareableContent.currentProcess
                let liste = contenu.windows.map { "\($0.windowID) \($0.title ?? "-") \($0.frame) layer=\($0.windowLayer) visible=\($0.isOnScreen)" }.joined(separator: "\n")
                try? liste.write(toFile: chemin + ".fenetres.txt", atomically: true, encoding: .utf8)
                let principale = NSApp.windows.first { $0.isVisible && $0.frame.width > 600 }
                guard let fenetre = contenu.windows.first(where: { $0.windowID == CGWindowID(principale?.windowNumber ?? -1) })
                        ?? contenu.windows.filter({ $0.windowLayer == 0 && $0.isOnScreen }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return }
                let filtre = SCContentFilter(desktopIndependentWindow: fenetre)
                let config = SCStreamConfiguration()
                config.width = Int(fenetre.frame.width * 2)
                config.height = Int(fenetre.frame.height * 2)
                config.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filtre, configuration: config)
                let rep = NSBitmapImageRep(cgImage: image)
                try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: chemin))
            } catch {
                try? "erreur: \(error)".write(toFile: chemin + ".txt", atomically: true, encoding: .utf8)
            }
        }
    }
}
#endif
