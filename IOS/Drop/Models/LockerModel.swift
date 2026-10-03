import SwiftUI
import UIKit
import DropKit

/// Le mode locker : les codes-barres des speciaux, dans l'ordre des numeros
/// imprimes sur les etiquettes.
@Observable
final class LockerModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var pairs: [LockerPair] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private(set) var images: [Int: UIImage] = [:]
    @ObservationIgnored private var enCours: Set<Int> = []

    init(app: AppModel) {
        self.app = app
    }

    var withCode: Int { pairs.filter(\.code).count }

    var summary: String {
        pairs.isEmpty
            ? "Aucun code en attente"
            : "\(Format.count(pairs.count, "paire", "paires")) · \(Format.count(withCode, "code arrivé", "codes arrivés"))"
    }

    func refresh() async {
        do {
            let liste = try await app.api.lockerPairs()
            app.reachedServer()
            if liste != pairs || !loaded {
                withAnimation(Theme.spring) {
                    pairs = liste
                    loaded = true
                    loadError = nil
                }
            }
        } catch {
            if !loaded { loadError = (error as? LocalizedError)?.errorDescription }
            app.report(error)
        }
    }

    /// le compteur de la ligne "Mode locker" du dashboard : un confort, une
    /// erreur ici ne doit rien casser
    func refreshCount() async {
        guard let liste = try? await app.api.lockerPairs() else { return }
        if liste != pairs {
            withAnimation(Theme.spring) { pairs = liste }
        }
        if !loaded { loaded = true }
    }

    /// L'image du code, chargee une fois puis gardee.
    func image(for pair: LockerPair) async {
        guard pair.code, images[pair.id] == nil, !enCours.contains(pair.id) else { return }
        enCours.insert(pair.id)
        defer { enCours.remove(pair.id) }
        guard let data = try? await app.api.lockerCodeImage(pairID: pair.id), let brute = UIImage(data: data) else { return }
        // decodee hors du fil principal : le balayage du locker ne saccade pas
        // a l'arrivee d'un code
        images[pair.id] = await brute.byPreparingForDisplay() ?? brute
    }

    /// "Deposé" (ou "Fait" pour un code seul) : la paire quitte la liste.
    func complete(_ pair: LockerPair) async -> Bool {
        let ok = await app.perform {
            if let colis = pair.colis {
                try await app.api.dropParcel(colis.id)
            } else {
                try await app.api.completeAlonePair(pair.id)
            }
        } != nil
        if ok {
            withAnimation(Theme.spring) { pairs.removeAll { $0.id == pair.id } }
        }
        return ok
    }
}
