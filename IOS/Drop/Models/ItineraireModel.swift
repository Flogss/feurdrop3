import SwiftUI
import CoreLocation
import DropKit

/// « Créer un itinéraire — Boîtes jaunes » : le depart (position de
/// l'appareil ou adresse), le rayon, le nombre de boites ; le serveur choisit
/// les boites et l'ordre le plus rapide en voiture. Garde dans AppModel : on
/// retrouve sa tournee en revenant sur la page.
@Observable
final class ItineraireModel {
    @ObservationIgnored private unowned let app: AppModel

    enum ModeDepart: String { case gps, adresse }

    enum EtatPosition: Equatable {
        case inconnue
        case recherche
        case trouvee
        case erreur(String)
    }

    struct Position: Equatable {
        let lat: Double
        let lon: Double
        let precision: Double
        var label: String?
    }

    // les reglages, retenus d'une fois sur l'autre (pas la position)
    var mode: ModeDepart { didSet { garde() } }
    var rayonKm: Double { didSet { garde() } }
    var nombre: Int { didSet { garde() } }
    var leveeAVenir: Bool { didSet { garde() } }

    private(set) var position: Position?
    private(set) var etatPosition: EtatPosition = .inconnue
    private(set) var suggestions: [ItineraireLieu] = []
    private(set) var adresse: ItineraireLieu?
    private(set) var resultat: Itineraire?
    /// un calcul en cours
    private(set) var enCalcul = false
    private(set) var erreur: String?
    /// l'arret choisi sur la carte ou dans la liste
    var choisi: Int?
    @ObservationIgnored private var exclure: [String] = []
    @ObservationIgnored private var dernierDepart: CLLocation?

    static let rayons: [Double] = [1, 3, 5, 10]
    static let nombres = [3, 5, 8, 10, 15]

    init(app: AppModel) {
        self.app = app
        let d = UserDefaults.standard
        mode = ModeDepart(rawValue: d.string(forKey: "drop.itineraire.mode") ?? "") ?? .gps
        let r = d.double(forKey: "drop.itineraire.rayon")
        rayonKm = Self.rayons.contains(r) ? r : 3
        let n = d.integer(forKey: "drop.itineraire.nombre")
        nombre = (1...25).contains(n) ? n : 8
        leveeAVenir = d.bool(forKey: "drop.itineraire.levee")
    }

    private func garde() {
        let d = UserDefaults.standard
        d.set(mode.rawValue, forKey: "drop.itineraire.mode")
        d.set(rayonKm, forKey: "drop.itineraire.rayon")
        d.set(nombre, forKey: "drop.itineraire.nombre")
        d.set(leveeAVenir, forKey: "drop.itineraire.levee")
    }

    var depart: ItineraireDemande.Depart? {
        switch mode {
        case .gps: position.map { .init(lat: $0.lat, lon: $0.lon, label: $0.label, origine: "gps") }
        case .adresse: adresse.map { .init(lat: $0.lat, lon: $0.lon, label: $0.label, origine: "adresse") }
        }
    }

    // MARK: Position

    /// La position de l'appareil (rend nil si elle n'a pas pu etre lue).
    @discardableResult
    func localise() async -> Position? {
        guard etatPosition != .recherche else { return position }
        withAnimation(Theme.spring) { etatPosition = .recherche }
        do {
            let l = try await Localisation.positionActuelle()
            let p = Position(lat: l.coordinate.latitude, lon: l.coordinate.longitude, precision: l.horizontalAccuracy)
            withAnimation(Theme.spring) {
                position = p
                etatPosition = .trouvee
            }
            // l'adresse la plus proche, pour se reperer (sans bloquer)
            Task {
                if let lieu = try? await app.api.itineraireLieu(lat: p.lat, lon: p.lon), position == p {
                    position?.label = lieu.label
                }
            }
            return p
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Position indisponible : choisis une adresse."
            withAnimation(Theme.spring) { etatPosition = .erreur(message) }
            return nil
        }
    }

    #if DEBUG
    /// verification : `-DropItineraireDepart 48.792,2.3634` pose ce depart
    /// (comme une position) et calcule la tournee
    func departDeTest() async {
        guard let brut = UserDefaults.standard.string(forKey: "DropItineraireDepart") else { return }
        let c = brut.split(separator: ",").compactMap { Double($0) }
        guard c.count == 2 else { return }
        mode = .gps
        position = Position(lat: c[0], lon: c[1], precision: 5, label: "Départ de test")
        etatPosition = .trouvee
        await calcule()
    }
    #endif

    // MARK: Adresse

    func cherche(_ texte: String) async {
        let q = texte.trimmingCharacters(in: .whitespaces)
        if let adresse, q == adresse.label { return }
        adresse = nil
        guard q.count >= 3 else {
            suggestions = []
            return
        }
        // une frappe rapide ne lance pas une recherche par lettre
        try? await Task.sleep(for: .milliseconds(280))
        if Task.isCancelled { return }
        let pres = position.map { (lat: $0.lat, lon: $0.lon) }
        if let lieux = try? await app.api.itineraireAdresses(q, pres: pres), !Task.isCancelled {
            withAnimation(Theme.spring) { suggestions = lieux }
        }
    }

    func choisit(_ lieu: ItineraireLieu) {
        Haptics.selection()
        withAnimation(Theme.spring) {
            adresse = lieu
            suggestions = []
        }
    }

    // MARK: Calcul

    /// La meilleure tournee (variante 0), ou une autre selection de boites.
    func calcule(variante: Int = 0, depuis: ItineraireDemande.Depart? = nil) async {
        guard let depart = depuis ?? depart, !enCalcul else { return }
        withAnimation(Theme.spring) {
            enCalcul = true
            erreur = nil
        }
        let demande = ItineraireDemande(depart: depart, rayonKm: rayonKm, nombre: nombre, variante: variante, exclure: exclure, leveeAVenir: leveeAVenir)
        do {
            let r = try await app.api.calculeItineraire(demande)
            app.reachedServer()
            Haptics.success()
            // (la fin du calcul dans la meme transaction que le resultat : posee
            // a part, juste apres, SwiftUI la manquait et le bouton restait
            // sur « Calcul… »)
            withAnimation(.smooth(duration: 0.5)) {
                resultat = r
                choisi = nil
                enCalcul = false
            }
            dernierDepart = CLLocation(latitude: r.depart.lat, longitude: r.depart.lon)
        } catch {
            if let api = error as? APIError, api.exigeConnexion || api.isNetwork {
                app.report(error)
            }
            Haptics.error()
            withAnimation(Theme.spring) {
                erreur = app.messageEchec(error)
                enCalcul = false
            }
        }
    }

    /// Nouvelle tournee : on repart de zero (sans boites evitees).
    func nouvelle() async {
        exclure = []
        await calcule()
    }

    /// « Recalculer » : depuis la position du moment si l'on a bouge de plus
    /// de 100 m, sinon une autre selection de boites depuis le meme depart.
    func recalcule() async {
        var depart = depart
        if mode == .gps {
            guard let p = await localise() else { return }
            depart = .init(lat: p.lat, lon: p.lon, label: p.label, origine: "gps")
        }
        guard let depart else { return }
        let ici = CLLocation(latitude: depart.lat, longitude: depart.lon)
        if let avant = dernierDepart, ici.distance(from: avant) > 100 {
            app.toasts.show("Tu as bougé : nouvelle tournée depuis ici", style: .info)
            await calcule(variante: 0, depuis: depart)
        } else {
            await calcule(variante: (resultat?.variante ?? 0) + 1, depuis: depart)
        }
    }

    /// « Éviter cette boîte » : elle sort du choix, et l'on recalcule.
    func evite(_ arret: Itineraire.Arret) async {
        exclure.append(contentsOf: arret.ids)
        app.toasts.show("\(arret.adresse ?? "Boîte") évitée : nouveau calcul", style: .info)
        let d = resultat.map { ItineraireDemande.Depart(lat: $0.depart.lat, lon: $0.depart.lon, label: $0.depart.label, origine: $0.depart.origine ?? "gps") }
        await calcule(variante: 0, depuis: d)
    }
}
