import UIKit
import UserNotifications
import DropKit

/// Les notifications natives. Aujourd'hui : des notifications locales, posees
/// par l'app elle-meme quand le rafraichissement en arriere-plan voit arriver
/// de nouveaux colis. Demain : le push distant (voir `PushRegistrar`).
enum NotificationService {
    static var center: UNUserNotificationCenter { .current() }

    /// "activees", "refusees"... pour l'ecran des reglages
    static func status() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// Demande la permission (une seule fois : iOS ne redemande plus apres un
    /// refus, il faut passer par les Reglages).
    @discardableResult
    static func requestAuthorization() async -> Bool {
        let accorde = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if accorde { await MainActor.run { PushRegistrar.shared.registerIfPossible() } }
        return accorde
    }

    /// "+3 colis à dropper" : un seul message qui se remplace au lieu de
    /// s'empiler, groupe avec les precedents dans le centre de notifications.
    static func announceNewParcels(added: Int, total: Int, value: Double) async {
        let statut = await status()
        guard statut == .authorized || statut == .provisional else { return }
        let contenu = UNMutableNotificationContent()
        contenu.title = added > 1 ? "+\(added) colis" : "+1 colis"
        contenu.body = "\(Format.count(total, "colis", "colis")) à dropper · \(Format.euro(value))"
        contenu.sound = .default
        contenu.threadIdentifier = "nouveaux-colis"
        contenu.interruptionLevel = .active
        contenu.relevanceScore = 0.8
        let requete = UNNotificationRequest(identifier: "nouveaux-colis", content: contenu, trigger: nil)
        try? await center.add(requete)
    }

    /// Envoie une notification d'essai, comme le bouton "Tester" du site.
    static func sendTest() async {
        let contenu = UNMutableNotificationContent()
        contenu.title = "Drop"
        contenu.body = "Les notifications fonctionnent sur cet iPhone."
        contenu.sound = .default
        let requete = UNNotificationRequest(identifier: "essai", content: contenu, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false))
        try? await center.add(requete)
    }
}

/// Le push distant (APNs). L'enregistrement est pret : des que le serveur
/// saura envoyer des notifications Apple, il suffira de lui transmettre le
/// jeton ici (aujourd'hui il ne connait que le push web).
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()
    private(set) var deviceToken: String?

    func registerIfPossible() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(token: Data) {
        deviceToken = token.map { String(format: "%02x", $0) }.joined()
        // A brancher quand le serveur aura sa route APNs, par exemple :
        // try await api.client.send(.post, "/api/push/apns", body: ["token": deviceToken])
    }

    func didFail(_ error: any Error) {
        // sans compte developpeur payant, l'enregistrement echoue : les
        // notifications locales continuent de marcher
        deviceToken = nil
    }
}
