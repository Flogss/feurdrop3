import Foundation

// « Créer un itinéraire — Boîtes jaunes » : POST /api/itineraire/calcul.
// Le serveur choisit les boites (donnees ouvertes La Poste) et l'ordre de
// passage le plus rapide en voiture (OSRM) ; temps et distances viennent du
// routeur, l'app ne les recalcule jamais.

/// Ce qu'on demande : le depart, le rayon, le nombre de boites.
public struct ItineraireDemande: Encodable, Sendable, Equatable {
    public struct Depart: Encodable, Sendable, Equatable {
        public var lat: Double
        public var lon: Double
        public var label: String?
        /// "gps" ou "adresse"
        public var origine: String

        public init(lat: Double, lon: Double, label: String?, origine: String) {
            self.lat = lat
            self.lon = lon
            self.label = label
            self.origine = origine
        }
    }

    public var depart: Depart
    public var rayonKm: Double
    public var nombre: Int
    /// 0 : la meilleure tournee ; 1, 2... : une autre selection de boites
    public var variante: Int
    /// les boites a eviter (« Éviter cette boîte »)
    public var exclure: [String]
    /// seulement les boites dont la levee du jour n'est pas encore passee
    public var leveeAVenir: Bool

    public init(depart: Depart, rayonKm: Double, nombre: Int, variante: Int = 0, exclure: [String] = [], leveeAVenir: Bool = false) {
        self.depart = depart
        self.rayonKm = rayonKm
        self.nombre = nombre
        self.variante = variante
        self.exclure = exclure
        self.leveeAVenir = leveeAVenir
    }
}

public struct Itineraire: Decodable, Sendable, Equatable {
    public struct Depart: Decodable, Sendable, Equatable {
        public var lat: Double
        public var lon: Double
        public var label: String?
        public var origine: String?
    }

    public struct Troncon: Decodable, Sendable, Equatable {
        /// secondes
        public var duree: Double
        /// metres
        public var distance: Double
    }

    public struct Arret: Decodable, Sendable, Equatable, Identifiable {
        public var ordre: Int
        public var id: String
        /// les boites de cet arret (deux boites a quelques metres : un arret)
        public var ids: [String]
        public var boites: Int
        public var lat: Double
        public var lon: Double
        public var adresse: String?
        public var commune: String?
        public var cp: String?
        /// heure limite de depot, « 09:00 »
        public var limiteSemaine: String?
        public var limiteSamedi: String?
        /// celle du jour d'arrivee (nil le dimanche)
        public var limiteDuJour: String?
        /// deposee a l'arrivee prevue, la lettre part-elle demain ? (nil : inconnu)
        public var apresLimite: Bool?
        public var depuisPrecedent: Troncon
        /// secondes depuis le depart
        public var arriveeDans: Double
    }

    public struct Total: Decodable, Sendable, Equatable {
        public var duree: Double
        public var distance: Double
    }

    public struct Zone: Decodable, Sendable, Equatable {
        public var arrets: Int
        public var boites: Int
        public var imprecises: Int
        public var comparees: Int
    }

    public struct Liens: Decodable, Sendable, Equatable {
        public var applePlans: [String]
        public var googleMaps: [String]
    }

    public struct Sources: Decodable, Sendable, Equatable {
        public struct Boites: Decodable, Sendable, Equatable {
            public var nom: String
            public var miseAJour: String?
        }
        public struct Routage: Decodable, Sendable, Equatable {
            public var nom: String
            public var trafic: Bool
            public var attribution: String?
        }
        public var boites: Boites
        public var routage: Routage
        public var matriceGardee: Bool?
    }

    public var depart: Depart
    public var rayonKm: Double
    public var demande: Int
    public var arrets: [Arret]
    public var total: Total
    /// le trace routier, [lon, lat]
    public var geometrie: [[Double]]
    /// les autres boites de la zone, [lat, lon]
    public var autres: [[Double]]
    public var zone: Zone
    public var variante: Int
    public var variantes: Int
    public var liens: Liens
    public var avertissements: [String]
    public var sources: Sources
    /// quand le serveur l'a calculee (ISO 8601)
    public var calculeLe: String?
}

/// Une adresse proposee pour le depart.
public struct ItineraireLieu: Decodable, Sendable, Equatable, Identifiable, Hashable {
    public var label: String
    public var ville: String?
    public var lat: Double
    public var lon: Double
    public var id: String { "\(label)|\(lat)|\(lon)" }
}

struct ItineraireLieux: Decodable, Sendable {
    var lieux: [ItineraireLieu]
}

struct ItineraireLieuReponse: Decodable, Sendable {
    var lieu: ItineraireLieu?
}
