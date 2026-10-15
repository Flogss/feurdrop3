import Foundation

/// L'impression automatique vue du telephone : ce que le serveur garde
/// (interrupteur, filtres) et ce que l'agent du Mac a reellement fait. Une
/// tache n'est « imprimee » qu'apres la confirmation de l'agent.
public struct ImpressionAuto: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var filtres: Filtres
    public var pending: Int
    public var agent: Agent
    public var enCours: Int
    public var taches: [Tache]
    public var options: Options

    public struct Filtres: Codable, Sendable, Equatable {
        public var categories: [String]
        public var transporteurs: [String]
        public var expediteurs: [String]
        public init(categories: [String] = [], transporteurs: [String] = [], expediteurs: [String] = []) {
            self.categories = categories
            self.transporteurs = transporteurs
            self.expediteurs = expediteurs
        }
    }

    public struct Agent: Codable, Sendable, Equatable {
        public var enLigne: Bool
        public var vu: String?
        public var imprimante: String?
    }

    public struct Tache: Codable, Sendable, Equatable, Identifiable {
        public var id: String
        /// envoyee (en attente de confirmation) · imprimee · echec · expiree
        public var etat: String
        public var etiquettes: Int
        public var pages: Int
        public var creee: String
        public var finie: String?
        public var erreur: String?
    }

    public struct Choix: Codable, Sendable, Equatable, Identifiable {
        public var code: String
        public var nom: String
        public var id: String { code }
    }

    public struct Options: Codable, Sendable, Equatable {
        public var categories: [Choix]
        public var transporteurs: [Choix]
        public var expediteurs: [String]
    }
}
