import SwiftUI
import DropKit

/// Le controle des depots, comme sur le site : « Tout vérifier » et sa
/// progression, quatre compteurs qui filtrent, l'etat des verifications (et
/// du Mac), la methode de chaque transporteur, puis la liste active -- statut
/// FeurDrop et parole du transporteur cote a cote -- et l'historique (depots
/// prouves, numeros retires). Toucher un colis ouvre sa chronologie.
struct DepotsView: View {
    @Environment(AppModel.self) private var app
    @State private var largeur: CGFloat = 0
    @State private var ouvert: DepotOuvert?

    private var model: DepotsModel { app.depots }
    private var large: Bool { largeur >= 700 }

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let erreur = model.loadError, !model.loaded {
                    EmptyStateView(symbol: "exclamationmark.triangle", title: "Contrôle indisponible", subtitle: erreur)
                        .surfaceCard()
                } else if let vue = model.vue {
                    CampagneCard()
                    compteurs(vue.compteurs)
                    PassageCard(vue: vue) { ouvreSerie() }
                    liste(vue)
                } else {
                    SkeletonRow(height: 120)
                    SkeletonRow(height: 90)
                    SkeletonRow(height: 320)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { largeur = $0 }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle("Contrôle des dépôts")
        .navigationSubtitle(sousTitre)
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .task { await model.surveille() }
        .sheet(item: $ouvert) { o in
            DepotDetailSheet(ouvert: o, suivant: { suivant(apres: o) })
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                #if os(macOS)
                .frame(minWidth: 520, minHeight: 620)
                #endif
        }
        .sensoryFeedback(.success, trigger: model.celebration)
        .onChange(of: model.serieDemandee) { _, serie in
            guard let serie, let premier = serie.ids.first else { return }
            ouvert = DepotOuvert(colisID: premier, serie: serie.ids, position: 0, ouvreLaPage: Platform.isMac)
        }
    }

    private var sousTitre: String {
        guard let c = model.vue?.compteurs, let etat = model.vue?.etat else { return "" }
        guard c.total > 0 else { return "Aucun colis dropé sur \(etat.affichageJours) jours" }
        let actifs = c.actifs ?? c.total
        return "\(Format.count(actifs, "colis en contrôle", "colis en contrôle")) · \(Format.count(c.confirme, "confirmé", "confirmés"))" + (c.attention > 0 ? " · \(c.attention) à regarder" : "")
    }

    // MARK: Compteurs

    @ViewBuilder
    private func compteurs(_ c: DepotsCompteurs) -> some View {
        let toutes = DepotCategorie.compteurs
        if large {
            HStack(spacing: 10) {
                ForEach(toutes) { cat in compteur(cat, c) }
            }
        } else {
            // deux par ligne ; le dernier (impair) sur toute la largeur
            let paires = Array(toutes.prefix(toutes.count - toutes.count % 2))
            VStack(spacing: 10) {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(paires) { cat in compteur(cat, c) }
                }
                if toutes.count % 2 == 1, let dernier = toutes.last { compteur(dernier, c) }
            }
        }
    }

    private func compteur(_ cat: DepotCategorie, _ c: DepotsCompteurs) -> some View {
        // les confirmes ont quitte la liste : leur compteur ouvre l'historique
        let cible: DepotsModel.Filtre = cat == .confirme ? .confirmes : .categorie(cat)
        let actif = model.filtre == cible
        let couleur = cat.couleur
        return Button {
            Haptics.selection()
            withAnimation(Theme.spring) { model.filtre = actif ? .tous : cible }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(cat.libelle.uppercased())
                    .font(.caption2.weight(.semibold).monospaced())
                    .tracking(0.6)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(Format.integer(c.nombre(cat)))
                    .font(.system(size: 30, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(couleur)
                    .shadow(color: couleur.opacity(0.4), radius: 12)
                    .contentTransition(.numericText(value: Double(c.nombre(cat))))
                // deux lignes reservees : « inconnu, illisible ou en échec »
                // etait coupe sur iPhone, et les quatre cartes gardent la meme
                // hauteur
                Text(sousCompteur(cat, c))
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(2, reservesSpace: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Theme.surface.opacity(0.82))
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(RadialGradient(colors: [couleur.opacity(actif ? 0.22 : 0.12), .clear], center: .topLeading, startRadius: 0, endRadius: 160))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(actif ? couleur.opacity(0.6) : .white.opacity(0.07), lineWidth: actif ? 1.4 : 0.7)
                    }
            }
            .contentShape(.rect(cornerRadius: 20))
        }
        .buttonStyle(PressScaleStyle(scale: 0.97))
        .accessibilityAddTraits(actif ? .isSelected : [])
    }

    private func sousCompteur(_ cat: DepotCategorie, _ c: DepotsCompteurs) -> String {
        switch cat {
        case .confirme: (c.retires ?? 0) > 0 ? "historique · \(Format.count(c.retires ?? 0, "retiré", "retirés"))" : "sortis de la liste (historique)"
        case .nonConfirme: c.nonConfirmeHorsDelai > 0 ? "dont \(c.nonConfirmeHorsDelai) hors délai" : "étiquette seule"
        case .aVerifier: (c.enAttente ?? 0) > 0 ? "+ \(c.enAttente ?? 0) en attente de lecture" : "illisible ou en échec répété"
        case .incorrect: (c.incorrect ?? 0) > 0 ? "refusés ou inconnus du transporteur" : "aucun numéro refusé"
        // le « dont » ne compte que les bloques (B02 : sinon il depassait le total)
        case .bloque: (c.aConstaterBloques ?? min(c.aConstater, c.bloque)) > 0 ? "dont \(c.aConstaterBloques ?? min(c.aConstater, c.bloque)) à constater" : "site protégé ou à la main"
        case .enAttente: "pas encore lu"
        }
    }

    // MARK: Liste

    private func liste(_ vue: DepotsVue) -> some View {
        @Bindable var model = app.depots
        let lignes = model.lignes
        return VStack(alignment: .leading, spacing: 12) {
            filtres($model.filtre)
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.text3)
                    TextField("Numéro de suivi…", text: $model.recherche)
                        .font(.subheadline.monospaced())
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                }
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(.white.opacity(0.05), in: .capsule)
                .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
                choix("Transporteur", selection: $model.transporteur, options: model.transporteursPresents.map { ($0.code, $0.nom) })
                choix("Expéditeur", selection: $model.expediteur, options: model.expediteursPresents.map { ($0, $0) })
                choixTri($model.tri)
            }

            if model.filtre.historique {
                let historique = model.historique
                if historique.isEmpty {
                    if model.filtreActif {
                        EmptyStateView(symbol: "magnifyingglass", title: "Aucun colis ne correspond", subtitle: "Change de filtre ou de recherche.")
                    } else if model.filtre == .retires {
                        EmptyStateView(symbol: "tray", title: "Aucun numéro retiré", subtitle: "Un numéro que le transporteur dit inconnu à plusieurs reprises sort de la liste et apparaît ici.")
                    } else {
                        EmptyStateView(symbol: "checkmark.seal", title: "Aucun dépôt confirmé pour l'instant", subtitle: "Un colis pris en charge par le transporteur quitte la liste et apparaît ici, avec sa preuve.")
                    }
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(historique) { h in
                            HistoriqueRow(ligne: h) { ouvert = DepotOuvert(colisID: h.colisId) }
                            if h.id != historique.last?.id {
                                Divider().overlay(Theme.hairline)
                            }
                        }
                    }
                    .animation(Theme.spring, value: historique.map(\.id))
                }
            } else if lignes.isEmpty {
                if model.filtreActif {
                    EmptyStateView(symbol: "magnifyingglass", title: "Aucun colis ne correspond", subtitle: "Change de filtre ou de recherche.")
                } else {
                    EmptyStateView(symbol: "checkmark.seal", title: "Rien à contrôler", subtitle: vue.compteurs.confirme > 0 ? "Tous les dépôts sont confirmés : ils sont dans l'historique." : "Les colis dropés avec un numéro de suivi apparaîtront ici.")
                }
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(lignes) { l in
                        DepotRow(ligne: l) { ouvert = DepotOuvert(colisID: l.colisId) }
                        if l.id != lignes.last?.id {
                            Divider().overlay(Theme.hairline)
                        }
                    }
                }
                .animation(Theme.spring, value: lignes.map(\.id))
            }

            // une recherche sur « Tous » : ce qui est deja sorti de la liste
            let anciens = model.historiqueTrouve
            if !anciens.isEmpty {
                Text("Dans l'historique")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .padding(.top, 4)
                LazyVStack(spacing: 0) {
                    ForEach(anciens) { h in
                        HistoriqueRow(ligne: h) { ouvert = DepotOuvert(colisID: h.colisId) }
                        if h.id != anciens.last?.id {
                            Divider().overlay(Theme.hairline)
                        }
                    }
                }
            }

            if let pied = pied(vue, affichees: model.filtre.historique ? model.historique.count : lignes.count) {
                Text(pied)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .surfaceCard()
    }

    private func filtres(_ filtre: Binding<DepotsModel.Filtre>) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(DepotsModel.Filtre.tousLesFiltres, id: \.self) { f in
                    let actif = filtre.wrappedValue == f
                    Button {
                        Haptics.selection()
                        withAnimation(Theme.spring) { filtre.wrappedValue = f }
                    } label: {
                        Text(f.libelle)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(actif ? Theme.text : Theme.text3)
                            .padding(.horizontal, 12)
                            .frame(height: 30)
                            .background {
                                Capsule()
                                    .fill(actif ? Theme.violet.opacity(0.26) : .white.opacity(0.04))
                                    .overlay(Capsule().strokeBorder(actif ? Theme.violetLight.opacity(0.4) : Theme.hairline, lineWidth: 0.8))
                                    .shadow(color: actif ? Theme.violet.opacity(0.55) : .clear, radius: 8)
                            }
                    }
                    .buttonStyle(PressScaleStyle(scale: 0.94))
                    .accessibilityAddTraits(actif ? .isSelected : [])
                }
            }
            .padding(.vertical, 8)
        }
        .sansIndicateurs()
        .mask {
            HStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 26)
            }
        }
        .padding(.vertical, -8)
    }

    /// un menu "Tous / un seul" (transporteur, expediteur)
    private func choix(_ titre: String, selection: Binding<String?>, options: [(String, String)]) -> some View {
        Menu {
            Button("Tous") { selection.wrappedValue = nil }
            Divider()
            ForEach(options, id: \.0) { valeur, libelle in
                Button {
                    selection.wrappedValue = valeur
                } label: {
                    if selection.wrappedValue == valeur { Label(libelle, systemImage: "checkmark") } else { Text(libelle) }
                }
            }
        } label: {
            let nom = options.first { $0.0 == selection.wrappedValue }?.1
            HStack(spacing: 4) {
                Image(systemName: titre == "Transporteur" ? "shippingbox" : "person")
                if let nom { Text(nom).lineLimit(1) }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(nom == nil ? Theme.text2 : Theme.text)
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background((nom == nil ? Color.white.opacity(0.05) : Theme.violet.opacity(0.26)), in: .capsule)
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel(titre)
    }

    /// l'ordre de la liste (« Pas encore scannés d'abord » par defaut)
    private func choixTri(_ tri: Binding<DepotsModel.Tri>) -> some View {
        Menu {
            Picker("Trier", selection: tri) {
                ForEach(DepotsModel.Tri.allCases) { t in Text(t.libelle).tag(t) }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(tri.wrappedValue == .pasEncore ? Theme.text2 : Theme.text)
                .frame(width: 38, height: 38)
                .background((tri.wrappedValue == .pasEncore ? Color.white.opacity(0.05) : Theme.violet.opacity(0.26)), in: .circle)
                .overlay(Circle().strokeBorder(Theme.hairline, lineWidth: 0.8))
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Trier : \(tri.wrappedValue.libelle)")
    }

    private func pied(_ vue: DepotsVue, affichees: Int) -> String? {
        var morceaux: [String] = []
        if model.filtreActif {
            let total = switch model.filtre {
            case .confirmes: vue.historique?.confirmes.count ?? 0
            case .retires: vue.historique?.retires.count ?? 0
            default: vue.lignes.count
            }
            morceaux.append("\(Format.count(affichees, "colis affiché", "colis affichés")) sur \(Format.integer(total))")
        }
        for h in vue.compteurs.horsControle ?? [] {
            morceaux.append(Format.count(h.colis, "colis \(h.nom) non contrôlé", "colis \(h.nom) non contrôlés"))
        }
        if vue.compteurs.sansNumero > 0 {
            morceaux.append("\(Format.count(vue.compteurs.sansNumero, "colis dropé sans numéro lisible", "colis dropés sans numéro lisible"))")
        }
        return morceaux.isEmpty ? nil : morceaux.joined(separator: " · ")
    }

    // MARK: Constats a la suite

    private func ouvreSerie() {
        let ids = model.aConstater.map(\.colisId)
        guard let premier = ids.first else { return }
        ouvert = DepotOuvert(colisID: premier, serie: ids, position: 0)
    }

    /// apres un constat (ou « Passer ») : le colis suivant de la serie
    private func suivant(apres o: DepotOuvert) {
        guard let serie = o.serie, o.position + 1 < serie.count else {
            ouvert = nil
            if o.serie != nil { app.toasts.show("Tous les colis à constater sont passés", style: .info) }
            return
        }
        ouvert = DepotOuvert(colisID: serie[o.position + 1], serie: serie, position: o.position + 1, ouvreLaPage: o.ouvreLaPage)
    }
}

/// Le colis ouvert dans la feuille (et sa place dans une serie de constats).
struct DepotOuvert: Identifiable, Hashable {
    let colisID: Int
    var serie: [Int]? = nil
    var position = 0
    /// sur le Mac, pendant « Tout vérifier » : la page officielle de chaque
    /// colis s'ouvre d'elle-meme dans le navigateur
    var ouvreLaPage = false
    var id: Int { colisID }
}

// MARK: - Etat des verifications

/// Le dernier passage, la file, la pause eventuelle de La Poste, et les deux
/// boutons : relancer, constater a la main.
private struct PassageCard: View {
    let vue: DepotsVue
    let constater: () -> Void
    @Environment(AppModel.self) private var app

    private func rallumer(_ l: DepotLecture) -> some View {
        Button {
            Task { await app.depots.lecture(l.code, active: true) }
        } label: {
            Text("Rallumer")
                .font(.subheadline.weight(.semibold))
                .fixedSize()
                .frame(height: 36)
                .padding(.horizontal, 10)
        }
        .boutonVerre()
        .accessibilityLabel("Rallumer la lecture automatique de \(l.nom)")
    }

    var body: some View {
        let etat = vue.etat
        let lp = etat.laPoste
        VStack(alignment: .leading, spacing: 12) {
            if let lp, !lp.configure {
                bandeau("info.circle.fill", Theme.info, "L'API La Poste n'est pas configurée : ajoute OKAPI_KEY sur le serveur (Railway).")
            } else if let pause = lp?.pause {
                bandeau("lock.fill", Theme.warn, "Vérifications La Poste en pause jusqu'à \(ServerDate.shortDayTime(pause.jusqua)) : \(pause.motif ?? "pause demandée"). Rien n'est forcé : la file reprendra seule.")
            } else if let erreur = etat.derniereErreur {
                bandeau("exclamationmark.triangle.fill", Theme.danger, "Dernier passage interrompu : \(erreur.message)")
            }
            // une lecture automatique coupee (depuis le site) : on la rallume d'ici
            ForEach((etat.lecture ?? []).filter { !$0.active }) { l in
                // a cote du bandeau quand la place le permet (Mac) ; dessous sur
                // iPhone, ou le texte s'ecrasait sur 5 lignes (B12)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        bandeau("info.circle.fill", Theme.info, "Lecture automatique coupée pour \(l.nom) : ses colis ne sont pas lus par l'app du Mac.")
                        rallumer(l)
                    }
                    VStack(alignment: .trailing, spacing: 8) {
                        bandeau("info.circle.fill", Theme.info, "Lecture automatique coupée pour \(l.nom) : ses colis ne sont pas lus par l'app du Mac.")
                        rallumer(l)
                    }
                }
            }

            HStack(spacing: 8) {
                Circle()
                    .fill(etat.enCours ? Theme.teal : Theme.violetLight)
                    .frame(width: 8, height: 8)
                    .shadow(color: (etat.enCours ? Theme.teal : Theme.violet).opacity(0.8), radius: 5)
                    .symbolEffect(.pulse, isActive: etat.enCours)
                Text(titre(etat))
                    .font(.subheadline.weight(.semibold))
            }
            Text(detail(etat))
                .font(.caption)
                .foregroundStyle(Theme.text3)
            if let mac = etat.mac, etat.lecture?.contains(where: \.active) == true {
                etatMac(mac, etat)
            }

            // cote a cote s'il y a la place, l'un sous l'autre sur un telephone
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { boutons(etat, lp, pleineLargeur: false) }
                VStack(spacing: 8) { boutons(etat, lp, pleineLargeur: true) }
            }

            if !etat.transporteurs.isEmpty {
                Divider().overlay(Theme.hairline)
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(etat.transporteurs) { t in methode(t, lp) }
                }
            }
        }
        .surfaceCard()
    }

    @ViewBuilder
    private func boutons(_ etat: DepotsEtat, _ lp: DepotMethode?, pleineLargeur: Bool) -> some View {
        if vue.compteurs.aConstater > 0 {
            Button(action: constater) {
                Label("Constater \(vue.compteurs.aConstater) à la main", systemImage: "pencil")
                    .font(.subheadline.weight(.semibold))
                    .fixedSize()
                    .frame(maxWidth: pleineLargeur ? .infinity : nil)
                    .frame(height: 40)
                    .padding(.horizontal, 6)
            }
            .boutonVerre()
        }
        Button {
            Task { await app.depots.relancer() }
        } label: {
            HStack(spacing: 6) {
                if app.depots.relance || etat.enCours { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                Text("Relancer les API")
            }
            .font(.subheadline.weight(.semibold))
            .fixedSize()
            .frame(maxWidth: pleineLargeur ? .infinity : nil)
            .frame(height: 40)
            .padding(.horizontal, 6)
        }
        .boutonVerre()
        .disabled(etat.apisConfigurees.isEmpty || etat.apisConfigurees.allSatisfy { $0.pause != nil } || etat.enCours || app.depots.relance)
    }

    /// l'app du Mac : en ligne (elle lit seule les pages officielles), ou
    /// hors ligne (les pages l'attendent)
    private func etatMac(_ mac: DepotMac, _ etat: DepotsEtat) -> some View {
        let actif = mac.actif == true
        let lisibles = (etat.lecture ?? []).filter(\.active).map(\.nom).joined(separator: ", ")
        let pages = mac.pagesDues ?? 0
        let texte = actif
            ? "Mac en ligne · \(mac.nom ?? "app Drop") lit \(lisibles)" + (pages > 0 ? " · \(Format.count(pages, "page à lire", "pages à lire"))" : "")
            : "Mac hors ligne" + (mac.le.map { " depuis \(ilYa($0).replacingOccurrences(of: "il y a ", with: ""))" } ?? "") + " (app fermée, ou à reconnecter)"
                + (pages > 0 ? " · \(Format.count(pages, "page attend", "pages attendent")) l'app Drop du Mac" : " · \(lisibles) se lisent quand l'app Drop du Mac est ouverte")
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(actif ? Theme.teal : Theme.warn)
                .frame(width: 7, height: 7)
                .shadow(color: (actif ? Theme.teal : Theme.warn).opacity(0.7), radius: 4)
            Text(texte)
                .font(.caption)
                .foregroundStyle(actif ? Theme.text2 : Theme.text3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func titre(_ etat: DepotsEtat) -> String {
        if etat.enCours { return "Vérifications en cours…" }
        guard let fin = etat.derniereSynchro else { return "Pas encore de passage" }
        return "Dernier passage : \(ServerDate.shortDayTime(fin)) (\(ilYa(fin)))"
    }

    private func detail(_ etat: DepotsEtat) -> String {
        var morceaux: [String] = []
        if let b = etat.dernierBilan, !etat.enCours {
            if b.verifies > 0 { morceaux.append(Format.count(b.verifies, "colis vérifié", "colis vérifiés")) }
            if b.nouveauxEvenements > 0 { morceaux.append(Format.count(b.nouveauxEvenements, "nouvel événement", "nouveaux événements")) }
            if b.erreurs > 0 { morceaux.append(Format.count(b.erreurs, "erreur", "erreurs")) }
        }
        morceaux.append(etat.file.enAttente > 0 ? Format.count(etat.file.enAttente, "vérification en attente", "vérifications en attente") : "rien en attente")
        return morceaux.joined(separator: " · ")
    }

    private func bandeau(_ symbole: String, _ couleur: Color, _ texte: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbole).foregroundStyle(couleur)
            Text(texte).font(.footnote).foregroundStyle(Theme.text2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(couleur.opacity(0.09), in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(couleur.opacity(0.3), lineWidth: 0.8))
    }

    /// une puce par transporteur : automatique, en pause, ou a la main
    private func methode(_ t: DepotTransporteurCompte, _ lp: DepotMethode?) -> some View {
        let api = vue.etat.methodes[t.methode] ?? lp
        let (texte, symbole, couleur): (String, String, Color) =
            !t.automatique ? ("à la main", "pencil", Theme.violetLight)
            : t.methode == "navigateur" ? (t.pause != nil ? ("bloqué", "lock.fill", Theme.warn) : ("lu sur le Mac", "desktopcomputer", Theme.teal))
            : api?.configure != true ? ("non configuré", "info.circle", Theme.warn)
            : api?.pause != nil ? ("en pause", "clock", Theme.warn)
            : ("API officielle", "bolt.fill", Theme.teal)
        return HStack(spacing: 7) {
            CarrierDot(color: .carrier(t.code), size: 7)
            Text(t.nom).font(.caption).foregroundStyle(Theme.text2)
            Label(texte, systemImage: symbole)
                .font(.caption.weight(.semibold))
                .foregroundStyle(couleur)
            Text(Format.integer(t.colis))
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(couleur)
                .padding(.horizontal, 6)
                .frame(minWidth: 22, minHeight: 20)
                .background(couleur.opacity(0.14), in: .capsule)
        }
        .fixedSize()
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .frame(height: 30)
        .background(.white.opacity(0.03), in: .capsule)
        .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
    }
}

// MARK: - Une ligne

/// Un colis : numero, transporteur et expediteur ; le verdict et ce que dit
/// le transporteur ; quand c'est verifie ; « Vérifier » et le suivi officiel.
private struct DepotRow: View {
    let ligne: DepotLigne
    let ouvre: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let c = ligne.controle
        HStack(alignment: .top, spacing: 12) {
            Capsule()
                .fill(c.cat == .confirme ? .clear : c.cat.couleur.opacity(ligne.attention ? 1 : 0.5))
                .frame(width: 3)
                .shadow(color: ligne.attention ? c.cat.couleur.opacity(0.7) : .clear, radius: 5)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(ligne.numero)
                        .font(.subheadline.weight(.semibold).monospaced())
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    DepotBadge(controle: c)
                }
                if let redrop = ligne.redrop, redrop.enAttente != nil || redrop.de != nil {
                    RedropPuce(enAttente: redrop.enAttente != nil)
                }
                HStack(spacing: 5) {
                    CarrierDot(color: .carrier(ligne.transporteur.code), size: 6)
                    Text("\(ligne.transporteur.nom) · \(ligne.expediteur)")
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if c.cat == .nonConfirme && c.enRetard {
                        Text("hors délai ·").foregroundStyle(Theme.warn)
                    }
                    Text(statutTransporteur + (c.suite?.retour == true ? " · retour" : c.livre ? " · livré" : ""))
                        .lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(Theme.text3)

                VStack(alignment: .leading, spacing: 2) {
                    Text(c.dernierEvenement?.statut ?? (ligne.manuel && c.constat == nil ? "À constater sur la page officielle" : "—"))
                        .font(.footnote)
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                    Text(c.dernierEvenement.map { ServerDate.shortDayTime($0.le) } ?? c.raison)
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                }

                HStack(spacing: 6) {
                    Text("Dropé \(ServerDate.shortDayTime(ligne.statutInterne.dropeLe))")
                    Spacer(minLength: 8)
                    if ligne.erreur != nil {
                        Label("erreur", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger)
                    }
                    Text(quand)
                    if !ligne.manuel {
                        Button {
                            Task { await app.depots.verifie(ligne.colisId) }
                        } label: {
                            Group {
                                if app.depots.enVerification.contains(ligne.colisId) { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
                            }
                            .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.text2)
                        .accessibilityLabel("Vérifier \(ligne.numero) maintenant")
                    }
                    if let lien = ligne.lien, let url = URL(string: lien) {
                        Link(destination: url) {
                            Image(systemName: "arrow.up.right.square").frame(width: 30, height: 30)
                        }
                        .foregroundStyle(Theme.text2)
                        .accessibilityLabel("Suivi officiel de \(ligne.numero)")
                    }
                }
                .font(.caption)
                .foregroundStyle(Theme.text3)
            }
        }
        .padding(.vertical, 10)
        .background(ligne.attention ? c.cat.couleur.opacity(0.06) : .clear)
        .contentShape(.rect)
        .onTapGesture(perform: ouvre)
        .ligneSurvol()
        .accessibilityAction(named: "Détail", ouvre)
    }

    private var statutTransporteur: String { ligne.controle.statutTransporteur(manuel: ligne.manuel, verifie: ligne.verifieLe != nil, navigateur: ligne.transporteur.methode == "navigateur") }

    private var quand: String {
        if ligne.manuel {
            return ligne.controle.constat.map { "constaté \(ilYa($0.le))" } ?? "à constater"
        }
        return ilYa(ligne.verifieLe ?? ligne.essaiLe)
    }
}

/// Une ligne de l'historique : un depot prouve (sa date de confirmation et sa
/// preuve), ou un numero retire de la file (sa raison, discretement).
private struct HistoriqueRow: View {
    let ligne: DepotHistorique
    let ouvre: () -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let retire = ligne.retire != nil
        let couleur = ligne.incorrect ? DepotCategorie.incorrect.couleur : retire ? Theme.text3 : DepotCategorie.confirme.couleur
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(ligne.numero)
                    .font(.subheadline.weight(.semibold).monospaced())
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Label(ligne.incorrect ? "Numéro incorrect" : retire ? "Retiré" : "Posté confirmé", systemImage: ligne.incorrect ? DepotCategorie.incorrect.symbole : retire ? "tray" : "checkmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(couleur)
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(couleur.opacity(0.13), in: .capsule)
                    .lineLimit(1)
            }
            HStack(spacing: 5) {
                CarrierDot(color: .carrier(ligne.transporteur.code), size: 6)
                Text("\(ligne.transporteur.nom) · \(ligne.expediteur)").lineLimit(1)
                Spacer(minLength: 8)
                Text(retire ? "retiré \(ilYa(ligne.retire?.le))" : "confirmé \(ilYa(ligne.confirmeLe))")
            }
            .font(.caption)
            .foregroundStyle(Theme.text3)
            Text(retire ? (ligne.retire?.motif ?? "retiré de la file") : (ligne.preuve?.statut ?? "—"))
                .font(.footnote)
                .foregroundStyle(retire ? Theme.text3 : Theme.text)
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(retire ? "Dropé \(ServerDate.shortDayTime(ligne.dropeLe)) · colis et étiquette gardés" : "\(ServerDate.shortDayTime(ligne.preuve?.le))\(suite)")
                    .lineLimit(1)
                Spacer(minLength: 8)
                if retire {
                    Button {
                        Task { await app.depots.verifie(ligne.colisId) }
                    } label: {
                        Group {
                            if app.depots.enVerification.contains(ligne.colisId) { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
                        }
                        .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.text2)
                    .accessibilityLabel("Remettre \(ligne.numero) en contrôle")
                }
                if let lien = ligne.lien, let url = URL(string: lien) {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right.square").frame(width: 30, height: 30)
                    }
                    .foregroundStyle(Theme.text2)
                    .accessibilityLabel("Suivi officiel de \(ligne.numero)")
                }
            }
            .font(.caption)
            .foregroundStyle(Theme.text3)
        }
        .padding(.vertical, 10)
        .padding(.leading, 15)
        .contentShape(.rect)
        .onTapGesture(perform: ouvre)
        .ligneSurvol()
        .accessibilityAction(named: "Détail", ouvre)
    }

    private var suite: String {
        if ligne.suite?.retour == true { return " · puis retour à l'expéditeur" }
        if ligne.suite?.etape == "delivered" || ligne.livre == true { return " · puis livré" }
        return ""
    }
}

/// Le badge d'une categorie : sa couleur, son icone, son libelle court.
struct DepotBadge: View {
    let controle: DepotControle
    var long = false

    var body: some View {
        let cat = controle.cat
        // (« hors délai » est dit sous le badge : il reste court)
        let texte = long ? controle.libelle : cat.court
        Label(texte, systemImage: cat.symbole)
            .font(.caption.weight(.bold))
            .foregroundStyle(cat.couleur)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(cat.couleur.opacity(0.13), in: .capsule)
            .overlay(Capsule().strokeBorder(cat.couleur.opacity(0.32), lineWidth: 0.8))
            .lineLimit(1)
    }
}

extension DepotCategorie {
    /// poste confirme (sarcelle), non confirme (ambre), a verifier (bleu),
    /// bloquee (lavande : rien n'a pu etre lu, pas une alerte) -- comme sur le site
    var couleur: Color {
        switch self {
        case .confirme: Theme.teal
        case .nonConfirme: Theme.warn
        case .aVerifier: Theme.info
        case .bloque: Theme.violetLight
        // rien n'est encore lu : gris lavande, sans alerte
        case .enAttente: Color(red: 0.66, green: 0.65, blue: 0.77)
        // le transporteur dit que le numero est faux
        case .incorrect: Theme.danger
        }
    }

    var symbole: String {
        switch self {
        case .confirme: "checkmark"
        case .nonConfirme: "clock"
        case .aVerifier: "magnifyingglass"
        case .bloque: "lock.fill"
        case .enAttente: "arrow.clockwise"
        case .incorrect: "xmark.octagon"
        }
    }
}

/// Un redrop : le colis oublie est de retour « à poster » (il pulse
/// doucement tant qu'il attend), ou la ligne suit deja le redrop.
struct RedropPuce: View {
    let enAttente: Bool
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduit

    var body: some View {
        Label(enAttente ? "Redrop à poster" : "Redrop", systemImage: "shippingbox.and.arrow.backward")
            .font(.caption2.weight(.bold))
            .foregroundStyle(Theme.violetLight)
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(Theme.violet.opacity(0.18), in: .capsule)
            .overlay(Capsule().strokeBorder(Theme.violetLight.opacity(pulse ? 0.6 : 0.3), lineWidth: 0.8))
            .shadow(color: Theme.violet.opacity(pulse ? 0.5 : 0), radius: 8)
            .onAppear {
                guard enAttente, !reduit else { return }
                withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { pulse = true }
            }
            .accessibilityLabel(enAttente ? "Redrop : de retour dans À poster" : "Colis redropé")
    }
}

extension DepotControle {
    /// ce que dit le transporteur, en quelques mots
    func statutTransporteur(manuel: Bool, verifie: Bool, navigateur: Bool = false) -> String {
        if let s = dernierStatut { return s.libelle }
        if manuel { return constat != nil ? "Constaté à la main" : "Pas de lecture automatique" }
        if erreurTechnique == true { return "Lecture en échec, nouvel essai" }
        return verifie ? "Inconnu du transporteur" : navigateur ? "En attente du Mac" : "Pas encore vérifié"
    }
}

/// "à l'instant", "il y a 12 min", "il y a 3 h", "il y a 2 j"
func ilYa(_ texte: String?) -> String {
    guard let date = ServerDate.parse(texte) else { return "jamais" }
    let minutes = Int(Date.now.timeIntervalSince(date) / 60)
    if minutes < 1 { return "à l'instant" }
    if minutes < 60 { return "il y a \(minutes) min" }
    let heures = Int((Double(minutes) / 60).rounded())
    if heures < 48 { return "il y a \(heures) h" }
    return "il y a \(Int((Double(heures) / 24).rounded())) j"
}
