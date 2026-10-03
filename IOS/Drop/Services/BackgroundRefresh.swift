import Foundation
import BackgroundTasks
import DropKit

/// Le rafraichissement en arriere-plan : iOS reveille l'app de temps en temps
/// (au mieux toutes les 15 minutes, selon l'usage et la batterie). On relit le
/// nombre de colis ; s'il a monte depuis le dernier passage, une notification
/// locale previent.
enum BackgroundRefresh {
    static let identifier = "com.flogas.drop.refresh"
    private static let cleDernierCompte = "drop.fond.pending"

    static func schedule() {
        let demande = BGAppRefreshTaskRequest(identifier: identifier)
        demande.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(demande)
    }

    /// Appele par la scene (`.backgroundTask(.appRefresh)`).
    static func run() async {
        // le prochain reveil est demande d'abord : meme si celui-ci echoue
        schedule()
        let adresse = UserDefaults.standard.string(forKey: "drop.serveur").flatMap(URL.init(string:)) ?? AppModel.defaultServer
        guard let stats = try? await DropAPI(baseURL: adresse).stats() else { return }
        await noteForeground(pending: stats.pendingCount, value: stats.pendingValue, notify: true)
    }

    /// Retient le compte vu ; au passage suivant, la difference devient "+N".
    /// L'app au premier plan l'appelle aussi (sans notifier) pour ne pas
    /// annoncer en arriere-plan ce qu'on vient de voir a l'ecran.
    static func noteForeground(pending: Int, value: Double, notify: Bool = false) async {
        let defaults = UserDefaults.standard
        let avant = defaults.object(forKey: cleDernierCompte) as? Int
        defaults.set(pending, forKey: cleDernierCompte)
        guard notify, let avant, pending > avant else { return }
        await NotificationService.announceNewParcels(added: pending - avant, total: pending, value: value)
    }
}
