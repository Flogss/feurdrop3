import Foundation

// Le controle des depots : ce que les transporteurs disent des colis dropes
// (`GET /api/depots`). Le serveur interroge l'API officielle La Poste (La
// Poste, Colissimo, Chronopost, DPD) a son rythme ; UPS et DHL se constatent
// sur leur page officielle ; Mondial Relay n'est pas controle (seulement
// compte). Ouvrir la page ne fait que lire la base du serveur.

/// Les cinq categories, dans l'ordre des compteurs.
public enum DepotCategorie: String, CaseIterable, Sendable, Identifiable {
    case confirme
    case nonConfirme = "non_confirme"
    case aVerifier = "a_verifier"
    case bloque
    case anomalie

    public var id: String { rawValue }

    /// le libelle complet (compteurs, detail)
    public var libelle: String {
        switch self {
        case .confirme: "Dépôts confirmés"
        case .nonConfirme: "Dépôts non confirmés"
        case .aVerifier: "Vérification nécessaire"
        case .bloque: "Vérification bloquée"
        case .anomalie: "Anomalies de suivi"
        }
    }

    /// le libelle court (badge d'une ligne, filtres)
    public var court: String {
        switch self {
        case .confirme: "Confirmé"
        case .nonConfirme: "Non confirmé"
        case .aVerifier: "Vérif. nécessaire"
        case .bloque: "Vérif. bloquée"
        case .anomalie: "Anomalie"
        }
    }
}

/// `GET /api/depots`
public struct DepotsVue: Codable, Sendable, Equatable {
    public var etat: DepotsEtat
    public var compteurs: DepotsCompteurs
    public var lignes: [DepotLigne]
}

/// `GET /api/depots/resume` : la pastille du dashboard.
public struct DepotsResume: Codable, Sendable, Equatable {
    public var compteurs: DepotsCompteurs
}

public struct DepotsCompteurs: Codable, Sendable, Equatable {
    public var confirme: Int
    public var nonConfirme: Int
    public var aVerifier: Int
    public var bloque: Int
    public var anomalie: Int
    /// non confirmes au-dela du delai normal d'un premier scan
    public var nonConfirmeHorsDelai: Int
    /// UPS, DHL... a regarder sur la page officielle
    public var aConstater: Int
    /// ce qui demande un regard (badge de l'outil)
    public var attention: Int
    public var total: Int
    /// dropes sans numero de suivi lisible
    public var sansNumero: Int
    /// les transporteurs non controles (Mondial Relay) : seulement comptes
    public var horsControle: [DepotHorsControle]?

    public func nombre(_ categorie: DepotCategorie) -> Int {
        switch categorie {
        case .confirme: confirme
        case .nonConfirme: nonConfirme
        case .aVerifier: aVerifier
        case .bloque: bloque
        case .anomalie: anomalie
        }
    }
}

public struct DepotHorsControle: Codable, Sendable, Equatable, Identifiable {
    public var code: String
    public var nom: String
    public var colis: Int
    public var id: String { code }
}

public struct DepotsEtat: Codable, Sendable, Equatable {
    /// un passage de verification tourne en ce moment
    public var enCours: Bool
    /// fin du dernier passage (ISO)
    public var derniereSynchro: String?
    public var dernierBilan: DepotBilan?
    public var derniereErreur: DepotErreurPassage?
    public var file: DepotFile
    /// "laposte" -> l'etat de la verification automatique
    public var methodes: [String: DepotMethode]
    /// les transporteurs presents, avec leur methode et leur nombre de colis
    public var transporteurs: [DepotTransporteurCompte]
    public var affichageJours: Int
    public var delaiScanHeures: Int

    public var laPoste: DepotMethode? { methodes["laposte"] }
}

public struct DepotBilan: Codable, Sendable, Equatable {
    public var verifies: Int
    public var nouveauxEvenements: Int
    public var erreurs: Int
    public var reportes: Int
}

public struct DepotErreurPassage: Codable, Sendable, Equatable {
    public var at: String?
    public var message: String
}

public struct DepotFile: Codable, Sendable, Equatable {
    public var enAttente: Int
}

public struct DepotMethode: Codable, Sendable, Equatable {
    public var nom: String
    /// la cle de l'API est-elle posee sur le serveur ?
    public var configure: Bool
    /// pause demandee par le transporteur (limite, acces refuse)
    public var pause: DepotPause?
    public var derniereReussite: String?
}

public struct DepotPause: Codable, Sendable, Equatable {
    /// heure du serveur (UTC), "2026-10-10 04:47:00"
    public var jusqua: String
    public var motif: String?
}

public struct DepotTransporteurCompte: Codable, Sendable, Equatable, Identifiable {
    public var code: String
    public var nom: String
    /// "laposte" (automatique) ou "manuel" (page officielle)
    public var methode: String
    public var colis: Int
    public var id: String { code }
    public var automatique: Bool { methode != "manuel" }
}

/// Un colis drope et ce que son transporteur en dit.
public struct DepotLigne: Codable, Sendable, Equatable, Identifiable {
    public var colisId: Int
    public var numero: String
    public var expediteur: String
    public var transporteur: DepotTransporteur
    public var statutInterne: DepotStatutInterne
    public var controle: DepotControle
    public var attention: Bool
    /// UPS, DHL... jamais constate (ou "pas encore" perime) : a regarder
    public var aConstater: Bool?
    /// derniere lecture reussie (heure du serveur, UTC)
    public var verifieLe: String?
    public var essaiLe: String?
    public var prochaineLe: String?
    public var erreur: DepotErreurNumero?
    /// le suivi officiel, numero deja saisi
    public var lien: String?

    public var id: Int { colisId }
    public var manuel: Bool { transporteur.methode == "manuel" }
}

public struct DepotTransporteur: Codable, Sendable, Equatable {
    public var code: String
    public var nom: String
    public var methode: String
}

public struct DepotStatutInterne: Codable, Sendable, Equatable {
    public var status: String
    public var libelle: String
    /// heure du drop (serveur, UTC)
    public var dropeLe: String?
    public var imprimeLe: String?
    public var paye: Bool
}

public struct DepotErreurNumero: Codable, Sendable, Equatable {
    public var code: String
    public var message: String?
}

/// Le verdict du controle et sa raison, dite en clair par le serveur.
public struct DepotControle: Codable, Sendable, Equatable {
    /// "confirme", "non_confirme", "a_verifier", "bloque", "anomalie"
    public var categorie: String
    public var libelle: String
    public var raison: String
    /// au-dela du delai normal d'un premier scan
    public var enRetard: Bool
    /// le scan qui prouve le depot
    public var preuve: DepotEvenementResume?
    public var dernierEvenement: DepotEvenementResume?
    public var dernierStatut: DepotStatut?
    public var constat: DepotConstat?
    public var livre: Bool
    public var manuel: Bool?

    public var cat: DepotCategorie { DepotCategorie(rawValue: categorie) ?? .aVerifier }
}

public struct DepotEvenementResume: Codable, Sendable, Equatable {
    /// heure du transporteur, avec son fuseau ("2026-10-09T18:45:00+02:00")
    public var le: String?
    public var statut: String
    public var lieu: String?
    public var etape: String?
    public var code: String?
    public var source: String?
}

public struct DepotStatut: Codable, Sendable, Equatable {
    public var etape: String?
    public var libelle: String
}

public struct DepotConstat: Codable, Sendable, Equatable {
    /// MANUEL_PRIS, MANUEL_PAS_ENCORE, MANUEL_PROBLEME
    public var resultat: String
    public var le: String?
    public var par: String?
}

/// `GET /api/depots/:colisId` (et la reponse de "Vérifier" et des constats).
public struct DepotDetail: Codable, Sendable, Equatable, Identifiable {
    public var colisId: Int
    public var numero: String
    public var expediteur: String
    public var transporteur: DepotTransporteur
    public var statutInterne: DepotStatutInterne
    public var controle: DepotControle
    public var attention: Bool
    public var verifieLe: String?
    public var essaiLe: String?
    public var prochaineLe: String?
    public var erreur: DepotErreurNumero?
    public var lien: String?
    /// la chronologie, du plus recent au plus ancien
    public var evenements: [DepotEvenement]
    /// pourquoi ce transporteur se verifie a la main
    public var raisonManuel: String?
    public var liens: DepotLiens?

    public var id: Int { colisId }
    public var manuel: Bool { transporteur.methode == "manuel" }
}

public struct DepotEvenement: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    public var survenuLe: String?
    public var code: String?
    public var libelle: String?
    public var lieu: String?
    public var etape: String?
    public var physique: Bool
    public var incident: String?
    /// "laposte" ou "manuel" (constat sur la page officielle)
    public var source: String?
}

public struct DepotLiens: Codable, Sendable, Equatable {
    public var transporteur: String?
    public var page: String?
}

/// Ce qu'on a vu sur la page officielle d'un transporteur sans verification
/// automatique.
public enum DepotConstatChoix: String, Sendable, CaseIterable, Identifiable {
    case pris
    case pasEncore = "pas_encore"
    case probleme
    /// efface les constats
    case annule

    public var id: String { rawValue }
}
