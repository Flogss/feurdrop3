import Foundation
import DropKit

/// Ce que les notifications ont deja annonce, et a partir d'ou. Une seule
/// memoire pour l'ecoute en arriere-plan et le reveil periodique d'iOS : un
/// colis n'est annonce qu'une fois, et le "+N" se cumule depuis la derniere
/// fois qu'on a eu l'app sous les yeux (comme sur le site).
@MainActor
enum ParcelWatch {
    struct State: Codable {
        /// ce qu'on avait sous les yeux en quittant l'app
        var basePending: Int
        var baseValue: Double
        var baseSenders: [String: Int]
        /// le dernier nombre deja annonce
        var announcedPending: Int
        var tourStartedAt: String?
        var tourEndedAt: String?
    }

    private static let cle = "drop.veille"

    // les reglages (Reglages > Notifications)
    static let newParcelsKey = "drop.notif.colis"
    static let tourKey = "drop.notif.tournee"
    static var notifiesNewParcels: Bool { UserDefaults.standard.object(forKey: newParcelsKey) as? Bool ?? true }
    static var notifiesTour: Bool { UserDefaults.standard.object(forKey: tourKey) as? Bool ?? true }

    /// L'app est sous les yeux : tout est vu, le "+N" repart de zero.
    static func seen(_ s: Stats) {
        save(base(s))
    }

    /// Une lecture faite app fermee : annonce ce qui a change depuis.
    static func check(_ s: Stats) async {
        guard var etat = load() else {
            seen(s)
            return
        }

        // des colis ont ete dropes ailleurs (le site) : la base suit
        if s.pendingCount < etat.basePending {
            let suivante = base(s)
            etat.basePending = suivante.basePending
            etat.baseValue = suivante.baseValue
            etat.baseSenders = suivante.baseSenders
        }

        if s.pendingCount > etat.announcedPending, s.pendingCount > etat.basePending, notifiesNewParcels {
            await NotificationService.newParcels(
                added: s.pendingCount - etat.basePending,
                value: max(0, s.pendingValue - etat.baseValue),
                senders: nouveauxExpediteurs(s, depuis: etat.baseSenders),
                pending: s.pendingCount,
                pendingValue: s.pendingValue
            )
        }
        etat.announcedPending = s.pendingCount

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

    private static func base(_ s: Stats) -> State {
        State(
            basePending: s.pendingCount,
            baseValue: s.pendingValue,
            baseSenders: Dictionary(s.bySender.map { ($0.senderName, $0.pendingCount) }, uniquingKeysWith: +),
            announcedPending: s.pendingCount,
            tourStartedAt: s.tour.startedAt,
            tourEndedAt: s.tour.last?.endedAt
        )
    }

    /// qui a envoye les nouveaux : "boxingmaestro ×2", du plus gros au plus petit
    private static func nouveauxExpediteurs(_ s: Stats, depuis base: [String: Int]) -> [(String, Int)] {
        s.bySender
            .map { ($0.senderName, $0.pendingCount - (base[$0.senderName] ?? 0)) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
    }

    private static func load() -> State? {
        UserDefaults.standard.data(forKey: cle).flatMap { try? JSONDecoder().decode(State.self, from: $0) }
    }

    private static func save(_ etat: State) {
        if let data = try? JSONEncoder().encode(etat) { UserDefaults.standard.set(data, forKey: cle) }
    }
}
