#if os(macOS)
import AppKit
import DropKit

/// La veille du Mac. Une app Mac reste ouverte quand on ferme sa fenetre ou
/// qu'on passe a une autre app : pas besoin de l'astuce de l'iPhone. Toutes
/// les 10 secondes, quand Drop n'est pas au premier plan, elle relit le
/// serveur : notification (avec le cha-ching) s'il y a du nouveau pour CE
/// Mac, et compteur de la barre des menus a jour.
@MainActor
final class MacWatcher {
    static let shared = MacWatcher()
    private var boucle: Task<Void, Never>?

    func start() {
        guard boucle == nil else { return }
        boucle = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !NSApp.isActive else { continue }
                let app = AppModel.shared
                await ParcelWatch.check(api: app.api)
                await app.dashboard.refresh()
            }
        }
    }
}
#endif
