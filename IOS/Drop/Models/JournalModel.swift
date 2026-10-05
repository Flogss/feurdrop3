import SwiftUI
import DropKit

/// L'historique du bas du dashboard : la premiere page, relue avec le reste
/// du dashboard (seules les nouvelles lignes arrivent, animees), et la suite
/// a la demande.
@Observable
final class JournalModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var entrees: [EntreeJournal] = []
    private(set) var suite = false
    private(set) var loaded = false
    private(set) var chargeSuite = false
    var filtre: FiltreJournal = .tout {
        didSet {
            guard filtre != oldValue else { return }
            entrees = []
            suite = false
            loaded = false
            Task { await refresh() }
        }
    }

    init(app: AppModel) {
        self.app = app
    }

    func refresh() async {
        let demande = filtre
        guard let page = try? await app.api.journal(filtre: demande) else { return }
        guard demande == filtre else { return }
        // les lignes deja chargees au-dela de la premiere page restent
        let plusAnciennes = entrees.filter { e in !page.entrees.contains { $0.id == e.id } && e.id < (page.entrees.last?.id ?? 0) }
        let nouvelles = page.entrees + plusAnciennes
        guard nouvelles != entrees || !loaded else { return }
        withAnimation(loaded ? Theme.spring : nil) {
            entrees = nouvelles
            if plusAnciennes.isEmpty { suite = page.suite }
            loaded = true
        }
    }

    func chargeLaSuite() async {
        guard let avant = entrees.last?.id, !chargeSuite else { return }
        chargeSuite = true
        defer { chargeSuite = false }
        let demande = filtre
        guard let page = await app.perform({ try await app.api.journal(avant: avant, filtre: demande, limite: 40) }),
              demande == filtre else { return }
        withAnimation(Theme.spring) {
            entrees += page.entrees
            suite = page.suite
        }
    }
}
