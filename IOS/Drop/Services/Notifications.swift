import UIKit
import UserNotifications
import DropKit

/// Les notifications natives : nouveaux colis et tournee, toutes avec le
/// cha-ching. Elles sont posees par l'app elle-meme (ecoute en arriere-plan,
/// reveil periodique d'iOS) ; le push distant est pret a prendre le relais
/// (voir `PushRegistrar`).
enum NotificationService {
    static var center: UNUserNotificationCenter { .current() }

    /// "activees", "refusees"... pour l'ecran des reglages
    static func status() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    static func isAuthorized() async -> Bool {
        let statut = await status()
        return statut == .authorized || statut == .provisional
    }

    /// Demande la permission (une seule fois : iOS ne redemande plus apres un
    /// refus, il faut passer par les Reglages).
    @discardableResult
    static func requestAuthorization() async -> Bool {
        let accorde = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if accorde { PushRegistrar.shared.registerIfPossible() }
        return accorde
    }

    /// l'identifiant fixe de la notification "nouveaux colis" : chaque
    /// nouvelle version remplace la precedente
    static let newParcelsID = "nouveaux-colis"

    /// Une seule notification qui se met a jour ("+3" puis "+5" puis "+9")
    /// au lieu de s'empiler.
    ///
    ///     +5 nouveaux colis
    ///     17,50 € · boxingmaestro ×3 · SRBOXING ×2
    ///     45 à dropper · 185,50 €
    static func newParcels(_ recap: NewParcels, pending: Int, pendingValue: Double) async {
        let expediteurs = recap.senders.map { ($0.name, $0.count) }
        let premiere = ([Format.euro(recap.value)] + (expediteurs.isEmpty ? [] : [ligneExpediteurs(expediteurs)])).joined(separator: " · ")
        await poste(
            id: newParcelsID,
            titre: titreNouveauxColis(recap.count),
            corps: "\(premiere)\n\(Format.integer(pending)) à dropper · \(Format.euro(pendingValue))",
            fil: "colis"
        )
    }

    static func titreNouveauxColis(_ n: Int) -> String {
        n > 1 ? "+\(Format.integer(n)) nouveaux colis" : "+1 nouveau colis"
    }

    static func tourStarted(count: Int, value: Double) async {
        await poste(id: "tournee", titre: "🚚 En tournée · \(Format.euro(value))", corps: "\(Format.count(count, "colis", "colis")) dans le sac", fil: "tournee")
    }

    static func tourEnded(_ t: TourSummary) async {
        let secondes = t.durationSeconds
        var detail = [Format.count(t.count, "colis dropé", "colis dropés") + (secondes > 0 ? " en \(Format.duration(secondes))" : "")]
        if secondes > 0 {
            let taux = t.value * 3600 / Double(secondes)
            detail.append("\(Format.euro(taux))/h")
            if let smic = t.smicHourly, smic > 0 { detail.append("\(Format.multiple(taux / smic)) le SMIC") }
        }
        await poste(id: "tournee", titre: "✅ Tournée terminée · \(Format.euro(t.value))", corps: detail.joined(separator: " · "), fil: "tournee")
    }

    /// Une notification d'essai, deux secondes apres l'appui.
    static func sendTest() async {
        await poste(
            id: "essai",
            titre: titreNouveauxColis(3),
            corps: "\(Format.euro(10.5)) · boxingmaestro ×2 · SRBOXING (exemple)\nLe cha-ching sonnera comme ça.",
            fil: "colis",
            apres: 2
        )
    }

    // MARK: Outils

    /// "boxingmaestro ×2 · SRBOXING · +2 autres"
    private static func ligneExpediteurs(_ senders: [(String, Int)]) -> String {
        var tete = senders.prefix(3).map { $0.1 > 1 ? "\($0.0) ×\($0.1)" : $0.0 }
        let reste = senders.count - 3
        if reste > 0 { tete.append("+\(reste) autre\(reste > 1 ? "s" : "")") }
        return tete.joined(separator: " · ")
    }

    private static func poste(id: String, titre: String, corps: String, fil: String, apres: TimeInterval? = nil) async {
        guard await isAuthorized() else { return }
        let contenu = UNMutableNotificationContent()
        contenu.title = titre
        contenu.body = corps
        contenu.sound = Sounds.newParcelsNotification
        contenu.threadIdentifier = fil
        contenu.interruptionLevel = .active
        contenu.relevanceScore = fil == "colis" ? 0.9 : 0.6
        let declencheur = apres.map { UNTimeIntervalNotificationTrigger(timeInterval: $0, repeats: false) }
        try? await center.add(UNNotificationRequest(identifier: id, content: contenu, trigger: declencheur))
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
        // Le serveur mettra alors "sound": "cha-ching.caf" dans la charge "aps" :
        // le meme son que les notifications locales, et l'ecoute en
        // arriere-plan deviendra inutile.
    }

    func didFail(_ error: any Error) {
        // sans compte developpeur payant, l'enregistrement echoue : les
        // notifications locales continuent de marcher
        deviceToken = nil
    }
}
