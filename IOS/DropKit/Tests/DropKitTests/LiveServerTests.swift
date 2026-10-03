import Foundation
import Testing
@testable import DropKit

// Decodage des VRAIES reponses du serveur, en lecture seule (aucune ecriture).
// Lance avec : DROP_API_URL=https://feurdrop3-production.up.railway.app swift test

private let adresse = ProcessInfo.processInfo.environment["DROP_API_URL"].flatMap(URL.init(string:))
private var api: DropAPI { DropAPI(baseURL: adresse!) }

@Suite(.enabled(if: adresse != nil, "DROP_API_URL non defini"))
struct ServeurReel {
    @Test func dashboard() async throws {
        let stats = try await api.stats()
        #expect(stats.pendingCount >= 0)
        #expect(stats.bySender.allSatisfy { !$0.senderName.isEmpty })
        let stock = try await api.stock()
        #expect(stock.normal > -10_000)
    }

    /// le "+N" d'un appareil : les colis arrives depuis son dernier regard
    @Test func nouveauxColis() async throws {
        let stats = try await api.stats()
        let maintenant = try #require(stats.tour.now)
        let depuisMaintenant = try await api.newParcels(since: maintenant)
        #expect(depuisMaintenant.count == 0)
        let depuisLongtemps = try await api.newParcels(since: "2000-01-01 00:00:00")
        #expect(depuisLongtemps.count > 0)
        #expect(depuisLongtemps.senders.reduce(0) { $0 + $1.count } == depuisLongtemps.count)
    }

    @Test func statistiques() async throws {
        _ = try await api.revenue()
        let jours = try await api.dailySeries()
        let semaines = try await api.weeklySeries()
        #expect(!jours.isEmpty)
        #expect(!semaines.isEmpty)
        #expect(ServerDate.day(jours[0].date) != nil)
    }

    @Test func reglages() async throws {
        let expediteurs = try await api.senders()
        #expect(!expediteurs.isEmpty)
        _ = try await api.debts()
        _ = try await api.mergeCandidates()
    }

    @Test func impression() async throws {
        for scope in [PrintScope.new, .printed] {
            let resume = try await api.printSummary(scope: scope)
            #expect(!resume.transporteurs.isEmpty)
            if let categorie = resume.categories.first {
                let colis = try await api.parcels(category: categorie.code, scope: scope)
                #expect(colis.count == categorie.count)
            }
        }
    }

    @Test func lockerEtSuivi() async throws {
        _ = try await api.lockerPairs()
        let suivi = try await api.trackingOverview()
        if suivi.ready, let libelle = suivi.labels?.first {
            let lignes = try await api.trackingRows(label: libelle.label, limit: 5)
            #expect(lignes.rows.count <= 5)
        }
        _ = try await api.liveCheck(since: 0)
    }
}
