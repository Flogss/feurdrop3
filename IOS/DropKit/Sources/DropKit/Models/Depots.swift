import Foundation

// Le controle des depots : une question -- le transporteur a-t-il pris en
// charge ce colis ? (`GET /api/depots`). Le serveur interroge les API
// officielles (La Poste pour La Poste, Colissimo, Chronopost, DPD ; UPS et
// DHL quand leurs cles sont posees) ; l'app du Mac lit seule les pages
// officielles de Mondial Relay, GLS (et DHL sans cle) ; UPS sans API se
// constate a la main (ses conditions interdisent la lecture automatisee).
// La liste ne garde que ce qui reste a trancher : un depot prouve passe dans
// l'historique, un numero inconnu du transporteur en est retire.

/// Les statuts d'un colis de la liste active (le dernier : rien n'a encore
/// ete lu, ce n'est pas un verdict).
public enum DepotCategorie: String, CaseIterable, Sendable, Identifiable {
    case confirme
    case nonConfirme = "non_confirme"
    case aVerifier = "a_verifier"
    case bloque
    case enAttente = "en_attente"
    /// le transporteur dit lui-meme que le numero est faux (refuse, ou
    /// inconnu a plusieurs lectures bien apres le drop) -- jamais un delai,
    /// une panne ou une protection anti-robot
    case incorrect

    public var id: String { rawValue }

    /// les cinq compteurs de la page
    public static let compteurs: [DepotCategorie] = [.confirme, .nonConfirme, .aVerifier, .incorrect, .bloque]

    /// le libelle complet (compteurs, detail)
    public var libelle: String {
        switch self {
        case .confirme: "Postés confirmés"
        case .nonConfirme: "Pas encore scannés"
        case .aVerifier: "À vérifier"
        case .bloque: "Vérification bloquée"
        case .enAttente: "En attente de lecture"
        case .incorrect: "Numéros incorrects"
        }
    }

    /// le libelle court (badge d'une ligne, filtres)
    public var court: String {
        switch self {
        case .confirme: "Posté confirmé"
        case .nonConfirme: "Pas encore scanné"
        case .aVerifier: "À vérifier"
        case .bloque: "Vérif. bloquée"
        case .enAttente: "En attente"
        case .incorrect: "Numéro incorrect"
        }
    }

    /// « Pas encore scannés d'abord » : ce qui attend son premier scan, puis
    /// ce qui demande un regard, puis ce qui n'est pas tranche
    public var rang: Int {
        switch self {
        case .nonConfirme: 0
        case .incorrect: 1
        case .aVerifier: 2
        case .bloque: 3
        case .enAttente: 4
        case .confirme: 5
        }
    }
}

/// Un colis oublie (dropé, jamais parti) remis « à poster » : en attente
/// (l'identifiant du nouveau colis, 0 €), ou cette ligne suit deja le redrop
/// (l'identifiant du colis d'origine).
public struct DepotRedrop: Codable, Sendable, Equatable {
    public var enAttente: Int?
    public var de: Int?
}

/// `GET /api/depots`
public struct DepotsVue: Codable, Sendable, Equatable {
    public var etat: DepotsEtat
    public var compteurs: DepotsCompteurs
    /// la liste active : ce qui reste a trancher
    public var lignes: [DepotLigne]
    /// les depots prouves (sortis de la liste) et les numeros retires
    public var historique: DepotsHistorique?
}

public struct DepotsHistorique: Codable, Sendable, Equatable {
    public var confirmes: [DepotHistorique]
    public var retires: [DepotHistorique]
}

/// Une ligne de l'historique : un depot prouve (quand, par quoi), ou un
/// numero retire de la file (pourquoi). Le colis lui-meme n'est jamais touche.
public struct DepotHistorique: Codable, Sendable, Equatable, Identifiable {
    public var colisId: Int
    public var numero: String
    public var expediteur: String
    public var transporteur: DepotTransporteur
    public var dropeLe: String?
    /// quand le depot a ete prouve (heure du serveur, UTC)
    public var confirmeLe: String?
    public var preuve: DepotPreuve?
    public var suite: DepotSuite?
    public var livre: Bool?
    public var retire: DepotRetrait?
    public var lien: String?
    /// ce que la liste savait au moment de la sortie (absent d'un serveur plus ancien)
    public var categorie: String?
    public var dernierEvenement: DepotEvenementResume?
    public var verifieLe: String?
    public var redrop: DepotRedrop?
    public var id: Int { colisId }
    /// retire parce que le numero est incorrect (inconnu ou refuse)
    public var incorrect: Bool { retire?.incorrect == true }
}

public struct DepotPreuve: Codable, Sendable, Equatable {
    public var le: String?
    public var statut: String?
    public var source: String?
}

public struct DepotRetrait: Codable, Sendable, Equatable {
    public var le: String?
    public var motif: String?
    /// "inconnu", "hors_delai" (anciennes lignes : "invalide")
    public var regle: String?
    /// le numero est incorrect (inconnu ou refuse par le transporteur)
    public var incorrect: Bool?
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
    /// « Numéro incorrect » (absent d'un serveur plus ancien)
    public var incorrect: Int?
    /// « Pas encore scanné » (= non confirmes)
    public var pasEncoreScanne: Int?
    /// des colis oublies remis « à poster » (Redrop)
    public var redropsEnAttente: Int?
    /// (anciennes versions du serveur)
    public var anomalie: Int?
    /// non confirmes au-dela du delai normal d'un premier scan
    public var nonConfirmeHorsDelai: Int
    /// UPS, DHL... a regarder sur la page officielle
    public var aConstater: Int
    /// parmi eux, ceux de la categorie « bloque » (absent d'un serveur plus ancien)
    public var aConstaterBloques: Int?
    /// ce qui demande un regard (badge de l'outil)
    public var attention: Int
    /// rien n'a encore ete lu (le Mac ou la file du serveur s'en charge)
    public var enAttente: Int?
    /// la liste active (sans les confirmes ni les retires)
    public var actifs: Int?
    /// les numeros retires de la file (inconnus du transporteur)
    public var retires: Int?
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
        case .enAttente: enAttente ?? 0
        case .incorrect: incorrect ?? 0
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
    /// les transporteurs que le Mac sait lire, et l'interrupteur de chacun
    public var lecture: [DepotLecture]?
    /// « Tout vérifier » : la campagne en cours (ou la derniere)
    public var campagne: DepotCampagneEtat?
    /// l'app du Mac : en ligne ? combien de pages l'attendent ?
    public var mac: DepotMac?

    public var laPoste: DepotMethode? { methodes["laposte"] }
    /// les API officielles posees sur le serveur (La Poste, UPS, DHL)
    public var apisConfigurees: [DepotMethode] { ["laposte", "ups", "dhl"].compactMap { methodes[$0] }.filter(\.configure) }
}

public struct DepotMac: Codable, Sendable, Equatable {
    /// s'est signale il y a moins de 45 s
    public var actif: Bool?
    public var nom: String?
    /// le dernier signal (ISO)
    public var le: String?
    public var pagesDues: Int?
}

/// `GET /api/depots/agent` : l'app du Mac se signale.
public struct DepotAgentSignal: Codable, Sendable, Equatable {
    /// des pages officielles a lire (campagne en cours ou file)
    public var aLire: Int
}

public struct DepotLecture: Codable, Sendable, Equatable, Identifiable {
    public var code: String
    public var nom: String
    /// la lecture automatique sur le Mac est allumee
    public var active: Bool
    /// le site a affiche une protection : pause jusqu'a...
    public var pause: DepotPause?
    public var id: String { code }
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
    /// "laposte" (API, serveur), "navigateur" (page lue sur le Mac) ou "manuel"
    public var methode: String
    public var colis: Int
    public var pause: DepotPause?
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
    /// la memoire de la derniere lecture
    public var lecture: DepotLectureMemoire?
    public var confirmeLe: String?
    public var retire: DepotRetrait?
    public var redrop: DepotRedrop?

    public var id: Int { colisId }
    public var manuel: Bool { transporteur.methode == "manuel" }
}

/// Ce qu'on retient de la derniere lecture d'un numero.
public struct DepotLectureMemoire: Codable, Sendable, Equatable {
    /// "laposte", "navigateur", "manuel"
    public var methode: String?
    /// le statut tel que le transporteur l'ecrit
    public var statutBrut: String?
    /// l'adresse lue (page officielle)
    public var page: String?
    /// qui l'a lue ("Mac de …")
    public var par: String?

    public var methodeLibelle: String {
        switch methode {
        case "laposte": "API La Poste (officielle)"
        case "ups": "API UPS (officielle)"
        case "dhl": "API DHL (officielle)"
        case "navigateur": "Page officielle lue sur le Mac"
        case "manuel": "Constat à la main"
        default: "—"
        }
    }
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
    /// apres la prise en charge (retour, « mis a disposition du vendeur »,
    /// livraison) : pour le detail, sans alerte
    public var suite: DepotSuite?
    /// la derniere lecture a echoue (reseau, page incomplete) : rien de conclu
    public var erreurTechnique: Bool?
    /// inconnu du transporteur au-dela du delai : sortira de la liste s'il le reste
    public var inconnu: Bool?
    /// seul un ancien parcours de ce numero (avant l'etiquette) est visible
    public var ancienParcours: Bool?

    public var cat: DepotCategorie { DepotCategorie(rawValue: categorie) ?? .aVerifier }
}

public struct DepotSuite: Codable, Sendable, Equatable {
    public var libelle: String?
    public var le: String?
    public var etape: String?
    public var retour: Bool?
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
    public var lecture: DepotLectureMemoire?
    /// le Mac va lire (ou lit) sa page officielle
    public var enAttenteDuMac: Bool?
    public var confirmeLe: String?
    public var retire: DepotRetrait?
    public var redrop: DepotRedrop?

    public var id: Int { colisId }
    public var manuel: Bool { transporteur.methode == "manuel" }
}

/// `POST /api/depots/:colisId/redrop` : le detail de la ligne (qui montre le
/// redrop en attente), et le nouveau colis « à poster » (0 €). `deja` : un
/// redrop attendait deja -- le meme est rendu, jamais deux.
public struct DepotRedropReponse: Decodable, Sendable, Equatable {
    public struct Nouveau: Codable, Sendable, Equatable {
        public var id: Int
        public var status: String?
        public var price: Double?
    }
    public var deja: Bool
    public var nouveau: Nouveau
    public var detail: DepotDetail

    private enum Cles: String, CodingKey { case deja, nouveau }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Cles.self)
        deja = try c.decodeIfPresent(Bool.self, forKey: .deja) ?? false
        nouveau = try c.decode(Nouveau.self, forKey: .nouveau)
        detail = try DepotDetail(from: decoder)
    }
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
    /// "laposte", "ups", "dhl", "navigateur" (page lue sur le Mac) ou "manuel" (constat)
    public var source: String?
}

public struct DepotLiens: Codable, Sendable, Equatable {
    public var transporteur: String?
    public var page: String?
}

/// Ce qu'on a vu sur la page officielle d'un transporteur sans verification
/// automatique.
public enum DepotConstatChoix: String, Sendable, CaseIterable, Identifiable {
    /// ce que la page officielle montre ; seuls pris, transit et livre
    /// prouvent le depot
    case etiquette
    case pasEncore = "pas_encore"
    case pris
    case transit
    case livre
    case inconnu
    case bloque
    case probleme
    /// efface les constats
    case annule

    public var id: String { rawValue }
}

// MARK: - « Tout vérifier »

/// `GET /api/depots/campagne` : la campagne en cours (ou la derniere).
public struct DepotCampagneEtat: Codable, Sendable, Equatable {
    public var campagne: DepotCampagne?
    public var compteurs: DepotCampagneCompteurs?
    public var parTransporteur: [DepotCampagneTransporteur]?
    /// des pages attendent l'app du Mac
    public var attendMac: Bool?
    /// a constater sur la page officielle (UPS sans API)
    public var numerosAConstater: [String]?
    /// le dernier Mac qui a demande du travail
    public var agent: DepotAgent?

    public var active: Bool { campagne?.statut == "active" }
}

public struct DepotCampagne: Codable, Sendable, Equatable, Identifiable {
    public var id: Int
    /// "active", "terminee", "annulee"
    public var statut: String
    public var creeLe: String?
    public var finLe: String?
    public var par: String?
}

public struct DepotCampagneCompteurs: Codable, Sendable, Equatable {
    public var total: Int
    public var verifies: Int
    public var restants: Int
    public var confirmes: Int
    public var nonConfirmes: Int
    public var aVerifier: Int
    public var bloques: Int
    public var erreurs: Int
    public var aConstater: Int
    /// numeros retires de la file a la lecture (inconnus)
    public var retires: Int?
    /// numeros incorrects (refuses ou inconnus du transporteur)
    public var incorrects: Int?

    /// la part faite (0...1)
    public var avancee: Double { total > 0 ? Double(total - restants) / Double(total) : 1 }
}

public struct DepotCampagneTransporteur: Codable, Sendable, Equatable, Identifiable {
    public var code: String
    public var nom: String
    public var methode: String
    public var total: Int
    public var faits: Int
    public var restants: Int
    public var bloques: Int
    public var erreurs: Int
    public var aConstater: Int
    public var message: String?
    public var id: String { code }
}

public struct DepotAgent: Codable, Sendable, Equatable {
    public var le: String?
    public var nom: String?
    public var actif: Bool?
}

/// `GET /api/depots/campagne/travail` : un lot de pages a lire (un seul transporteur).
public struct DepotTravail: Codable, Sendable, Equatable {
    public var campagne: Int?
    /// une pause entre deux pages (le rythme d'une personne)
    public var pauseMs: Int?
    public var items: [DepotPageALire]
}

public struct DepotPageALire: Codable, Sendable, Equatable, Identifiable, Hashable {
    public var numero: String
    public var transporteur: String
    public var nom: String
    public var url: String
    public var id: String { numero }
}

/// Ce que le Mac a vu sur une page officielle (le serveur le lit lui-meme).
public struct DepotPageLue: Codable, Sendable, Equatable {
    public var numero: String
    public var transporteur: String
    public var url: String?
    public var titre: String?
    public var texte: String?
    /// la page n'a pas pu etre lue (reseau, delai)
    public var erreur: String?

    public init(numero: String, transporteur: String, url: String?, titre: String?, texte: String?, erreur: String?) {
        self.numero = numero
        self.transporteur = transporteur
        self.url = url
        self.titre = titre
        self.texte = texte
        self.erreur = erreur
    }
}

/// `POST /api/depots/campagne/resultats` : chaque page, et l'etat qui suit.
public struct DepotResultatsReponse: Codable, Sendable, Equatable {
    public var resultats: [DepotResultatPage]
    public var campagne: DepotCampagne?
    public var compteurs: DepotCampagneCompteurs?
}

public struct DepotResultatPage: Codable, Sendable, Equatable {
    public var numero: String
    /// "trouve", "introuvable", "ambigu", "illisible", "bloque", "erreur",
    /// "incomplet", "autre_numero", "ignore"
    public var etat: String
    public var resultat: String?
}
