import Foundation
import UserNotifications
import DropKit

/// Ce que CE telephone a vu, et ce que ses notifications ont deja dit.
///
/// Le "+N" se compte depuis la derniere fois que ce telephone a eu l'app sous
/// les yeux -- pas depuis la derniere notification, ni depuis qu'un autre
/// appareil a regarde : chaque installation a sa propre memoire, rangee
/// localement. Le serveur donne le compte exact des colis arrives depuis
/// cette heure-la (les drops faits entre-temps ne le faussent pas).
///
/// Une seule notification "nouveaux colis" par telephone : elle porte
/// toujours le meme identifiant, donc "+5" remplace "+3" au lieu de s'empiler.
@MainActor
enum ParcelWatch {
    struct State: Codable {
        /// heure du serveur du dernier regard sur ce telephone
        var seenAt: String
        /// le "+N" deja affiche (rien de nouveau : pas de nouvelle notification)
        var announced: Int
        var tourStartedAt: String?
        var tourEndedAt: String?
    }

    private static let cle = "drop.veille.appareil"

    // les reglages (Reglages > Notifications)
    static let newParcelsKey = "drop.notif.colis"
    static let tourKey = "drop.notif.tournee"
    static var notifiesNewParcels: Bool { UserDefaults.standard.object(forKey: newParcelsKey) as? Bool ?? true }
    static var notifiesTour: Bool { UserDefaults.standard.object(forKey: tourKey) as? Bool ?? true }

    /// L'app est sous les yeux : tout est vu, le "+N" de ce telephone repart
    /// de zero, et sa notification "nouveaux colis" n'a plus lieu d'etre.
    static func seen(_ s: Stats) {
        let avant = load()
        save(State(
            seenAt: s.tour.now ?? heureServeur(),
            announced: 0,
            tourStartedAt: s.tour.startedAt,
            tourEndedAt: s.tour.last?.endedAt ?? avant?.tourEndedAt
        ))
        if (avant?.announced ?? 0) > 0 {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [NotificationService.newParcelsID])
        }
    }

    /// Une lecture faite app fermee : annonce ce qui est nouveau pour ce
    /// telephone.
    static func check(api: DropAPI) async {
        guard let s = try? await api.stats() else { return }
        guard var etat = load() else {
            seen(s)
            return
        }

        if notifiesNewParcels, let recap = try? await api.newParcels(since: etat.seenAt) {
            if recap.count > etat.announced {
                await NotificationService.newParcels(recap, pending: s.pendingCount, pendingValue: s.pendingValue)
            }
            // des colis retires entre-temps : le compte suit, sans notifier
            etat.announced = recap.count
        }

        if notifiesTour {
            if let debut = s.tour.startedAt, debut != etat.tourStartedAt {
                await NotificationService.tourStarted(count: s.pendingCount, value: s.pendingValue)
            }
            if let fin = s.tour.last, fin.endedAt != etat.tourEndedAt {
                await NotificationService.tourEnded(fin)
            }
        }
        etat.tourStartedAt = s.tour.startedAt
        etat.tourEndedAt = s.tour.last?.endedAt ?? etat.tourEndedAt
        save(etat)
    }

    // MARK: Outils

    /// l'heure au format du serveur (UTC), si le serveur ne l'a pas donnee
    private static func heureServeur() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.string(from: .now)
    }

    private static func load() -> State? {
        UserDefaults.standard.data(forKey: cle).flatMap { try? JSONDecoder().decode(State.self, from: $0) }
    }

    private static func save(_ etat: State) {
        if let data = try? JSONEncoder().encode(etat) { UserDefaults.standard.set(data, forKey: cle) }
    }
}
