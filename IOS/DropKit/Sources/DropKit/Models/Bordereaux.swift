import Foundation

// « Bordereaux » : les etiquettes deja dans FeurDrop et les codes lus dessus
// par le serveur (/api/bordereaux). Les zones des codes sont en 0..1 de la
// page AFFICHEE (rotation comprise), origine en haut a gauche : elles se
// posent sur la page a n'importe quel zoom.

/// Un numero de suivi et ses liens (meme logique que le portail).
public struct BordereauSuivi: Decodable, Sendable, Hashable {
    public let numero: String
    public let transporteur: String
    public let nom: String
    /// le lien direct (nil : le transporteur n'en a pas ; voir `page`)
    public let lien: String?
    public let page: String

    /// ce qu'ouvre « Ouvrir le suivi du colis »
    public var url: URL? { URL(string: lien ?? page) }
}

public struct BordereauTransporteur: Decodable, Sendable, Hashable {
    public let code: String
    public let nom: String
}

/// Ou en est la lecture d'une etiquette.
public struct BordereauIndex: Decodable, Sendable, Hashable {
    /// "analyse" | "attente" | "erreur" | "echec"
    public let etat: String
    public let pages: Int?
    public let lisibles: Int?
    public let illisibles: Int?
    public let erreur: String?

    public init(etat: String, pages: Int? = nil, lisibles: Int? = nil, illisibles: Int? = nil, erreur: String? = nil) {
        self.etat = etat
        self.pages = pages
        self.lisibles = lisibles
        self.illisibles = illisibles
        self.erreur = erreur
    }
}

/// Une etiquette, telle que la liste la montre.
public struct BordereauResume: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let expediteur: String?
    public let transporteur: BordereauTransporteur?
    public let fichier: String?
    /// "pdf" | "image"
    public let genre: String?
    public let recuLe: String?
    public let imprimeLe: String?
    public let deposeLe: String?
    /// "a_imprimer" | "imprime" | "depose"
    public let etape: String?
    public let redrop: Bool?
    public let suivi: BordereauSuivi?
    public var index: BordereauIndex?
}

public struct BordereauxListe: Decodable, Sendable {
    public let bordereaux: [BordereauResume]
    public let suite: Int?
}

public struct BordereauZone: Decodable, Sendable, Hashable {
    public let x0: Double
    public let y0: Double
    public let x1: Double
    public let y1: Double
}

/// Un code-barre ou QR code lu sur une page.
public struct BordereauCode: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let page: Int
    public let format: String
    public let nomFormat: String
    /// "1D" | "2D"
    public let famille: String
    public let lisible: Bool
    /// nil : illisible (jamais une valeur devinee)
    public let valeur: String?
    public let erreur: String?
    public let zone: BordereauZone
    /// "suivi" | "suivi-probable" | "contient-suivi" | "lien" | "donnees" | "autre" | "illisible"
    public let role: String
    public let suivi: BordereauSuivi?
    public let lien: String?
}

public struct BordereauPage: Decodable, Sendable, Hashable {
    public let page: Int
    public let largeur: Double?
    public let hauteur: Double?
    public let codes: [BordereauCode]
}

public struct BordereauAnalyse: Decodable, Sendable, Hashable {
    /// "analyse" | "attente" | "erreur" | "echec"
    public let etat: String
    public let erreur: String?
    public let empreinte: String?
    public let type: String?
    public let nombrePages: Int?
    public let partiel: Bool?
    public let analyseLe: String?
    public let lisibles: Int?
    public let illisibles: Int?
    public let pages: [BordereauPage]?

    public var codes: [BordereauCode] { (pages ?? []).flatMap(\.codes) }
}

public struct BordereauAnnotation: Decodable, Sendable, Hashable {
    public let texte: String
    public let modifieLe: String?
}

/// Tout ce que la page montre d'une etiquette.
public struct BordereauDetail: Decodable, Sendable, Hashable {
    public let colis: BordereauResume
    /// la note du colis (dashboard), en lecture
    public let note: String?
    /// la note d'etude, gardee a part du fichier
    public var annotation: BordereauAnnotation?
    public let analyse: BordereauAnalyse
}

/// Ce qui correspond a une recherche sur une etiquette.
public struct BordereauCorrespondance: Decodable, Sendable, Hashable {
    /// "code" (lu sur l'etiquette) | "suivi" (nom du fichier)
    public let source: String
    public let codeId: Int?
    public let page: Int?
    public let nomFormat: String?
    public let valeur: String
    /// la valeur en lettres et chiffres seuls ; `debut`..`fin` : la partie trouvee
    public let norme: String
    public let score: Int
    /// "exact" | "debut" | "fin" | "contient" | "proche"
    public let type: String
    public let debut: Int?
    public let fin: Int?
}

public struct BordereauResultat: Decodable, Sendable, Hashable, Identifiable {
    public let id: Int
    public let expediteur: String?
    public let transporteur: BordereauTransporteur?
    public let fichier: String?
    public let genre: String?
    public let recuLe: String?
    public let etape: String?
    public let suivi: BordereauSuivi?
    public let index: BordereauIndex?
    public let score: Int
    public let correspondances: [BordereauCorrespondance]
}

public struct BordereauxRecherche: Decodable, Sendable {
    public let requete: String
    public let total: Int
    public let resultats: [BordereauResultat]
}

public struct BordereauxEtat: Decodable, Sendable, Hashable {
    public struct Indexation: Decodable, Sendable, Hashable {
        public let active: Bool
        public let restants: Int
        public let jours: Int
    }

    public let etiquettes: Int
    public let analysees: Int
    public let echecs: Int
    public let codes: Int
    public let indexation: Indexation
}
