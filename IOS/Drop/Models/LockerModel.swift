import SwiftUI
import DropKit

/// Le mode locker : les codes-barres des speciaux, dans l'ordre des numeros
/// imprimes sur les etiquettes.
@Observable
final class LockerModel {
    @ObservationIgnored private unowned let app: AppModel

    private(set) var pairs: [LockerPair] = []
    private(set) var loaded = false
    private(set) var loadError: String?
    private(set) var images: [Int: PlatformImage] = [:]
    /// le code d'une paire n'a pas pu etre charge (apres les reessais) : la
    /// page le dit et propose « Réessayer » -- jamais une roue sans fin
    private(set) var imageErreurs: [Int: String] = [:]
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
            loadError = nil
            if liste != pairs || !loaded {
                withAnimation(Theme.spring) {
                    pairs = liste
                    loaded = true
                    loadError = nil
                }
            }
        } catch {
            if !loaded { loadError = app.messageEchec(error) }
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

    /// L'image du code, chargee une fois puis gardee. Une erreur passagere
    /// (reseau, Telegram derriere le serveur) est retentee deux fois ; ensuite
    /// l'erreur s'affiche, avec « Réessayer ». (Avant : l'erreur etait avalee
    /// et la roue tournait indefiniment -- a chaque ouverture, pour la meme paire.)
    func image(for pair: LockerPair) async {
        guard pair.code, images[pair.id] == nil, imageErreurs[pair.id] == nil, !enCours.contains(pair.id) else { return }
        enCours.insert(pair.id)
        defer { enCours.remove(pair.id) }
        let api = app.api
        do {
            let data = try await avecReessais { try await api.lockerCodeImage(pairID: pair.id) }
            guard let brute = PlatformImage(data: data) else { throw APIError.decoding("image illisible") }
            // decodee hors du fil principal : le balayage du locker ne saccade pas
            // a l'arrivee d'un code
            images[pair.id] = await Platform.prepared(brute)
        } catch is CancellationError {
            // la page a disparu : le prochain affichage relance le chargement
        } catch {
            withAnimation(Theme.spring) { imageErreurs[pair.id] = app.messageEchec(error) ?? "Code indisponible" }
        }
    }

    /// « Réessayer » sur un code qui n'a pas pu etre charge.
    func reessaieImage(_ pair: LockerPair) async {
        withAnimation(Theme.spring) { _ = imageErreurs.removeValue(forKey: pair.id) }
        await image(for: pair)
    }

    /// "Deposé" (ou "Fait" pour un code seul) : la paire quitte la liste.
    ///
    /// L'envoi est une operation identifiee : renvoye apres une coupure, le
    /// serveur ne l'applique qu'une fois (et un colis deja drope repond « deja
    /// fait »). Si la reponse s'est perdue malgre tout, la liste relue dit la
    /// verite : une paire qui n'y est plus a bien ete deposee -- pas besoin de
    /// recommencer, et pas d'erreur affichee pour rien.
    func complete(_ pair: LockerPair) async -> Bool {
        do {
            if let colis = pair.colis {
                try await app.api.dropParcel(colis.id)
            } else {
                try await app.api.completeAlonePair(pair.id)
            }
            app.reachedServer()
        } catch is CancellationError {
            return false
        } catch {
            // la reponse perdue (reseau) ou « introuvable » : la liste tranche
            if let liste = try? await app.api.lockerPairs(), !liste.contains(where: { $0.id == pair.id }) {
                withAnimation(Theme.spring) { pairs = liste }
                return true
            }
            app.report(error)
            return false
        }
        withAnimation(Theme.spring) { pairs.removeAll { $0.id == pair.id } }
        return true
    }
}
