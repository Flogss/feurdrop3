#if os(macOS)
import Foundation
import Observation
import PDFKit
import ImageIO
import DropKit

/// Une etiquette ouverte dans la visionneuse : le fichier d'origine tel quel
/// (jamais modifie), en PDF ou en image.
enum DocumentEtiquette {
    case pdf(PDFDocument)
    case image(CGImage)

    init?(_ data: Data) {
        if let pdf = PDFDocument(data: data), pdf.pageCount > 0 {
            self = .pdf(pdf)
            return
        }
        // les pixels tels qu'ils sont dans le fichier (sans rotation EXIF) :
        // les zones des codes sont lues sur ces pixels-la
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
            self = .image(image)
            return
        }
        return nil
    }

    var nombrePages: Int {
        switch self {
        case .pdf(let doc): doc.pageCount
        case .image: 1
        }
    }
}

/// Ce que la page demande a la visionneuse (zoom, ajustement, aller a un code).
enum ActionVisionneuse: Equatable {
    case zoomPlus, zoomMoins, taille100, largeur, pageEntiere
    case montre(codeId: Int)
}

/// La fenetre « Bordereaux » : la liste des etiquettes (ou les resultats
/// d'une recherche), l'etiquette ouverte et ses codes. Tout est lu sur le
/// serveur (/api/bordereaux) ; le fichier d'origine n'est jamais modifie.
@MainActor
@Observable
final class BordereauxModel {
    enum Onglet: String, CaseIterable { case etude, recherche }
    enum Ajustement { case largeur, page, libre }

    struct Commande: Equatable {
        let numero: Int
        let action: ActionVisionneuse
    }

    struct Bulle: Equatable {
        let code: BordereauCode
        /// la zone, dans la visionneuse (origine en haut a gauche)
        let cadre: CGRect
    }

    @ObservationIgnored private unowned let app: AppModel
    init(app: AppModel) { self.app = app }

    /// les messages de cette fenetre (pas ceux de la fenetre Drop)
    let toasts = ToastCenter()

    // MARK: Etat de la page

    var onglet: Onglet = .etude
    private(set) var etat: BordereauxEtat?

    // la liste (onglet Etude)
    var filtre = "tous"
    var texteFiltre = ""
    /// transporteur ("" : tous, "aucun" : sans), a partir d'un jour, tri, categorie ("" : toutes, "aucune", ou l'id)
    var transporteur = "" { didSet { if transporteur != oldValue { filtresChanges() } } }
    var depuis: Date? { didSet { if depuis != oldValue { filtresChanges() } } }
    var tri = "recent" { didSet { if tri != oldValue { filtresChanges() } } }
    var categorie = "" { didSet { if categorie != oldValue { filtresChanges() } } }
    private(set) var transporteurs: [BordereauTransporteurCompte] = []
    private(set) var categories: [BordereauCategorie] = []
    private(set) var total = 0
    private(set) var liste: [BordereauResume] = []
    private(set) var suite: Int?
    private(set) var chargementListe = false
    private(set) var erreurListe: String?

    // la recherche
    var requete = ""
    private(set) var resultats: [BordereauResultat] = []
    private(set) var totalResultats = 0
    private(set) var rechercheFaite = false
    private(set) var rechercheEnCours = false

    // l'etiquette ouverte
    private(set) var ouverteId: Int?
    private(set) var resume: BordereauResume?
    private(set) var detail: BordereauDetail?
    private(set) var document: DocumentEtiquette?
    /// les octets d'origine (pour « Fichier d'origine » : une copie, jamais une modification)
    @ObservationIgnored private(set) var octets: Data?
    private(set) var erreurFichier: String?
    private(set) var chargement = false
    private(set) var lectureEnCours = false
    /// augmente quand des codes viennent d'etre lus (ils s'allument un a un)
    private(set) var revelation = 0
    var page = 1
    var selection: Int?
    /// le code trouve par la recherche (il pulse un moment)
    private(set) var trouve: Int?
    var zonesToutes = false
    var ajustement: Ajustement = .largeur
    /// le zoom affiche (1 = taille reelle)
    var zoom: Double = 1
    var bulle: Bulle?
    private(set) var commande: Commande?

    @ObservationIgnored private var jeton = 0
    @ObservationIgnored private var cible: (codeId: Int?, recherche: String?)?
    @ObservationIgnored private var tacheRecherche: Task<Void, Never>?
    @ObservationIgnored private var tacheFiltre: Task<Void, Never>?

    private var api: DropAPI { app.api }

    var codes: [BordereauCode] { detail?.analyse.codes ?? [] }
    var codesDeLaPage: [BordereauCode] { codes.filter { $0.page == page } }

    func code(_ id: Int?) -> BordereauCode? {
        guard let id else { return nil }
        return codes.first { $0.id == id }
    }

    @ObservationIgnored private var numeroCommande = 0

    func envoie(_ action: ActionVisionneuse) {
        numeroCommande += 1
        commande = Commande(numero: numeroCommande, action: action)
    }

    // MARK: Liste et etat

    func arrivee() async {
        async let e: Void = chargeEtat()
        if liste.isEmpty { await chargeListe() }
        await e
    }

    func chargeEtat() async {
        if let e = try? await api.bordereauxEtat() { etat = e }
    }

    private static let jourISO: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Europe/Paris")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var filtresActifs: Bool { !transporteur.isEmpty || depuis != nil || tri != "recent" || !categorie.isEmpty }

    func effaceFiltres() {
        transporteur = ""
        depuis = nil
        tri = "recent"
        categorie = ""
    }

    private func filtresChanges() {
        liste = []
        Task { await chargeListe() }
    }

    func chargeListe(suite plus: Bool = false) async {
        chargementListe = true
        defer { chargementListe = false }
        do {
            let r = try await api.bordereaux(
                filtre: filtre, texte: texteFiltre.trimmingCharacters(in: .whitespaces), transporteur: transporteur,
                depuis: depuis.map { Self.jourISO.string(from: $0) }, categorie: categorie, tri: tri,
                decalage: plus ? suite : nil
            )
            liste = plus ? liste + r.bordereaux : r.bordereaux
            suite = r.decalageSuivant
            total = r.total ?? liste.count
            transporteurs = r.transporteurs ?? []
            if let c = r.categories { categories = c }
            erreurListe = nil
        } catch {
            erreurListe = error.localizedDescription
        }
    }

    func changeFiltre(_ nouveau: String) {
        guard nouveau != filtre else { return }
        filtre = nouveau
        liste = []
        Task { await chargeListe() }
    }

    func filtreModifie() {
        tacheFiltre?.cancel()
        tacheFiltre = Task {
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            await chargeListe()
        }
    }

    // MARK: Recherche

    func requeteModifiee() {
        tacheRecherche?.cancel()
        let texte = requete
        tacheRecherche = Task {
            try? await Task.sleep(for: .milliseconds(180))
            if Task.isCancelled { return }
            await cherche(texte)
        }
    }

    func cherche(_ texte: String) async {
        let propre = texte.uppercased().filter { $0.isLetter || $0.isNumber }
        guard propre.count >= 3 else {
            resultats = []
            totalResultats = 0
            rechercheFaite = false
            return
        }
        rechercheEnCours = true
        defer { rechercheEnCours = false }
        do {
            let r = try await api.rechercheBordereaux(texte)
            guard texte == requete else { return }
            resultats = r.resultats
            totalResultats = r.total
            rechercheFaite = true
        } catch {
            toasts.show(error.localizedDescription, style: .error)
        }
    }

    func ouvreResultat(_ r: BordereauResultat) {
        let m = r.correspondances.first { $0.source == "code" } ?? r.correspondances.first
        Task { await ouvre(r.id, page: m?.page, codeId: m?.source == "code" ? m?.codeId : nil, recherche: requete) }
    }

    // MARK: Ouvrir une etiquette

    func ouvre(_ id: Int, page aller: Int? = nil, codeId: Int? = nil, recherche: String? = nil) async {
        jeton += 1
        let j = jeton
        ouverteId = id
        resume = liste.first { $0.id == id }
        detail = nil
        document = nil
        octets = nil
        erreurFichier = nil
        bulle = nil
        selection = codeId
        trouve = codeId
        page = aller ?? 1
        cible = (codeId, recherche)
        if ajustement == .libre { ajustement = .largeur }
        // les commandes de l'etiquette precedente (zoom...) ne la suivent pas
        commande = nil
        chargement = true

        async let fichier = api.fichierBordereau(id)
        do {
            let d = try await api.bordereau(id)
            guard j == jeton else { return }
            detail = d
            resume = d.colis
            if d.analyse.etat == "attente" || d.analyse.etat == "echec" {
                Task { await lis(j) }
            }
        } catch {
            guard j == jeton else { return }
            erreurFichier = error.localizedDescription
            chargement = false
            return
        }
        do {
            let data = try await fichier
            guard j == jeton else { return }
            guard let doc = DocumentEtiquette(data) else {
                erreurFichier = "Ce fichier n'est ni un PDF ni une image : il ne s'affiche pas ici."
                chargement = false
                return
            }
            octets = data
            document = doc
            page = min(max(page, 1), doc.nombrePages)
        } catch {
            guard j == jeton else { return }
            erreurFichier = error.localizedDescription
        }
        chargement = false
        appliqueCible()
    }

    /// Lire les codes maintenant (`force` : relire une etiquette deja lue).
    func lis(_ j: Int? = nil, force: Bool = false) async {
        guard let id = ouverteId, !lectureEnCours else { return }
        let jetonLecture = j ?? jeton
        lectureEnCours = true
        bulle = nil
        do {
            let d = try await api.analyseBordereau(id, force: force)
            guard jetonLecture == jeton else { return }
            detail = d
            if force {
                selection = nil
                trouve = nil
            }
            majIndex(id, d.analyse)
            revelation += 1
        } catch {
            guard jetonLecture == jeton else { return }
            toasts.show(error.localizedDescription, style: .error)
            if let d = try? await api.bordereau(id) { detail = d }
        }
        lectureEnCours = false
        appliqueCible()
        await chargeEtat()
    }

    private func majIndex(_ id: Int, _ a: BordereauAnalyse) {
        let index = a.etat == "analyse"
            ? BordereauIndex(etat: "analyse", pages: a.nombrePages, lisibles: a.lisibles, illisibles: a.illisibles)
            : BordereauIndex(etat: a.etat, erreur: a.erreur)
        if let i = liste.firstIndex(where: { $0.id == id }) { liste[i].index = index }
    }

    /// Le code vise (par la recherche) : sa page, lui au centre, en evidence.
    private func appliqueCible() {
        guard document != nil, let c = cible, !codes.isEmpty else { return }
        let q = (c.recherche ?? "").uppercased().filter { $0.isLetter || $0.isNumber }
        let lisibles = codes.filter(\.lisible)
        let norme = { (v: String?) in (v ?? "").uppercased().filter { $0.isLetter || $0.isNumber } }
        let code = c.codeId.flatMap { id in codes.first { $0.id == id } }
            ?? (q.count >= 3 ? (lisibles.first { norme($0.valeur) == q } ?? lisibles.first { norme($0.valeur).contains(q) }) : nil)
        cible = nil
        guard let code else { return }
        page = code.page
        selection = code.id
        trouve = code.id
        envoie(.montre(codeId: code.id))
        Task {
            try? await Task.sleep(for: .seconds(4.2))
            if trouve == code.id { trouve = nil }
        }
    }

    func choisit(_ id: Int?, montre: Bool = false) {
        selection = id
        guard let id, let code = code(id) else { return }
        if code.page != page { page = code.page }
        if montre { envoie(.montre(codeId: id)) }
    }

    func allerPage(_ n: Int) {
        guard let doc = document else { return }
        let p = min(max(n, 1), doc.nombrePages)
        guard p != page else { return }
        bulle = nil
        page = p
    }

    // MARK: Categories (un classement a part)

    /// Classe l'etiquette ouverte (nil : sans categorie) ; `nouvelle` : la cree d'abord.
    func classe(_ categorieId: Int?, nouvelle: String? = nil) async {
        guard let id = ouverteId else { return }
        do {
            var cible = categorieId
            if let nom = nouvelle?.trimmingCharacters(in: .whitespacesAndNewlines), !nom.isEmpty {
                cible = try await api.creeCategorieBordereaux(nom)?.id
            }
            let c = try await api.classeBordereau(id, categorie: cible)
            detail?.categorie = c
            if let i = liste.firstIndex(where: { $0.id == id }) { liste[i].categorie = c }
            if let toutes = try? await api.categoriesBordereaux() { categories = toutes }
            toasts.show(c.map { "Classée dans « \($0.nom) »" } ?? "Retirée de sa catégorie", style: .info)
        } catch {
            toasts.show(error.localizedDescription, style: .error)
        }
    }

    func rechargeCategories() async {
        if let c = try? await api.categoriesBordereaux() { categories = c }
    }

    func creeCategorie(_ nom: String) async {
        let propre = nom.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !propre.isEmpty else { return }
        do {
            _ = try await api.creeCategorieBordereaux(propre)
            await rechargeCategories()
        } catch {
            toasts.show(error.localizedDescription, style: .error)
        }
    }

    func modifieCategorie(_ id: Int, nom: String? = nil, couleur: String? = nil) async {
        do {
            _ = try await api.modifieCategorieBordereaux(id, nom: nom, couleur: couleur)
            await rechargeCategories()
            await chargeListe()
            if let ouverte = ouverteId, let d = try? await api.bordereau(ouverte) { detail = d }
        } catch {
            toasts.show(error.localizedDescription, style: .error)
            await rechargeCategories()
        }
    }

    /// Supprime une categorie : ses etiquettes restent, simplement sans categorie.
    func supprimeCategorie(_ id: Int) async {
        do {
            try await api.supprimeCategorieBordereaux(id)
            if categorie == String(id) { categorie = "" }
            await rechargeCategories()
            await chargeListe()
            if detail?.categorie?.id == id { detail?.categorie = nil }
        } catch {
            toasts.show(error.localizedDescription, style: .error)
        }
    }

    // MARK: Note d'etude (a part du fichier)

    func annote(_ texte: String) async -> Bool {
        guard let id = ouverteId else { return false }
        do {
            let a = try await api.annoteBordereau(id, texte: texte)
            detail?.annotation = a
            toasts.show(a == nil ? "Note d'étude effacée" : "Note d'étude enregistrée", style: .success)
            return true
        } catch {
            toasts.show(error.localizedDescription, style: .error)
            return false
        }
    }
}
#endif
