#if os(macOS)
import SwiftUI
import DropKit

/// Le controle des depots sur le Mac : un poste de travail plutot qu'une page
/// de telephone etiree. En haut, fixe : le titre, les cinq compteurs (qui
/// filtrent), l'etat du Mac et des verifications, « Tout vérifier ». Dessous,
/// un vrai tableau -- une ligne compacte par colis, colonnes alignees, en-tete
/// qui reste visible -- et le detail du colis choisi dans un panneau a droite
/// (fleches ↑ ↓ pour passer d'un colis a l'autre, Echap pour fermer).
struct DepotsMacView: View {
    @Environment(AppModel.self) private var app
    @State private var ouvert: DepotOuvert?
    @State private var largeur: CGFloat = 1200
    @FocusState private var tableauActif: Bool

    private var model: DepotsModel { app.depots }

    var body: some View {
        VStack(spacing: 0) {
            enTete
            if let vue = model.vue {
                VStack(spacing: 12) {
                    if model.campagneVisible { CampagneCard() }
                    bandeaux(vue.etat)
                    tableau(vue)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            } else if let erreur = model.loadError {
                EmptyStateView(symbol: "exclamationmark.triangle", title: "Contrôle indisponible", subtitle: erreur)
                    .frame(maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { largeur = $0 }
        .inspector(isPresented: Binding(get: { ouvert != nil }, set: { if !$0 { ouvert = nil } })) {
            Group {
                if let o = ouvert {
                    DepotDetailSheet(ouvert: o, suivant: { suivant(apres: o) })
                        .id(o)
                        .overlay(alignment: .topTrailing) {
                            Button {
                                ouvert = nil
                            } label: {
                                Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 28, height: 28)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.text3)
                            .padding(14)
                            .keyboardShortcut(.cancelAction)
                            .accessibilityLabel("Fermer le détail")
                        }
                }
            }
            .inspectorColumnWidth(min: 380, ideal: 440, max: 600)
        }
        .task { await model.refresh() }
        .task { await model.surveille() }
        .sensoryFeedback(.success, trigger: model.celebration)
        #if DEBUG
        // verification : `-DropDepotOuvert 1` ouvre le premier colis du tableau
        .onChange(of: model.lignes.first?.colisId) { _, premier in
            if ouvert == nil, UserDefaults.standard.bool(forKey: "DropDepotOuvert"), let premier { ouvert = DepotOuvert(colisID: premier) }
        }
        #endif
        .onChange(of: model.serieDemandee) { _, serie in
            guard let serie, let premier = serie.ids.first else { return }
            ouvert = DepotOuvert(colisID: premier, serie: serie.ids, position: 0, ouvreLaPage: true)
        }
    }

    // MARK: En-tete fixe

    private var enTete: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "fr_FR"))).uppercased())
                        .font(.caption.weight(.semibold))
                        .tracking(0.8)
                        .foregroundStyle(Theme.text3)
                    Text("Contrôle des dépôts")
                        .font(.system(size: etroit ? 24 : 30, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .fixedSize()
                        .foregroundStyle(Theme.numberGradient)
                        .shadow(color: Theme.violet.opacity(0.45), radius: 14)
                        .accessibilityAddTraits(.isHeader)
                }
                if let c = model.vue?.compteurs, !etroit {
                    Text(sousTitre(c))
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                        .padding(.top, 14)
                }
                Spacer(minLength: 12)
                if let vue = model.vue { actions(vue) }
            }
            if let vue = model.vue {
                HStack(spacing: 10) {
                    ForEach(DepotCategorie.compteurs) { cat in compteur(cat, vue.compteurs) }
                }
                etatVerifications(vue.etat)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 14)
    }

    private func sousTitre(_ c: DepotsCompteurs) -> String {
        let actifs = c.actifs ?? c.total
        return "\(Format.count(actifs, "colis en contrôle", "colis en contrôle")) · \(Format.count(c.confirme, "confirmé", "confirmés"))" + (c.attention > 0 ? " · \(c.attention) à regarder" : "")
    }

    @ViewBuilder
    private func actions(_ vue: DepotsVue) -> some View {
        let etat = vue.etat
        HStack(spacing: 8) {
            if vue.compteurs.aConstater > 0 {
                Button {
                    let ids = model.aConstater.map(\.colisId)
                    if let premier = ids.first { ouvert = DepotOuvert(colisID: premier, serie: ids, position: 0, ouvreLaPage: true) }
                } label: {
                    Label("Constater \(vue.compteurs.aConstater)", systemImage: "pencil")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize()
                        .padding(.horizontal, 6)
                        .frame(height: 34)
                }
                .boutonVerre()
                .help("Ouvrir un à un les colis à constater sur la page officielle")
            }
            Button {
                Task { await model.relancer() }
            } label: {
                HStack(spacing: 6) {
                    if model.relance || etat.enCours { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                    Text("Relancer les API")
                }
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 6)
                .frame(height: 34)
            }
            .boutonVerre()
            .disabled(etat.apisConfigurees.isEmpty || etat.apisConfigurees.allSatisfy { $0.pause != nil } || etat.enCours || model.relance)
            Button {
                Task { await model.toutVerifier() }
            } label: {
                HStack(spacing: 6) {
                    if model.lancement || model.campagne?.active == true { ProgressView().controlSize(.small).tint(.white) } else { Image(systemName: "checkmark.seal.fill") }
                    Text(model.campagne?.active == true ? "Vérification en cours…" : "Tout vérifier")
                }
                .font(.subheadline.weight(.bold))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 8)
                .frame(height: 34)
            }
            .boutonVerreFort(Theme.violetDeep)
            .disabled(model.lancement || model.campagne?.active == true)
            .keyboardShortcut("r", modifiers: [.command, .shift])
        }
    }

    /// un compteur : son nombre, son libelle ; il filtre le tableau
    private func compteur(_ cat: DepotCategorie, _ c: DepotsCompteurs) -> some View {
        let cible: DepotsModel.Filtre = cat == .confirme ? .confirmes : .categorie(cat)
        let actif = model.filtre == cible
        let couleur = cat.couleur
        return Button {
            withAnimation(Theme.spring) { model.filtre = actif ? .tous : cible }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(Format.integer(c.nombre(cat)))
                    .font(.system(size: 24, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(couleur)
                    .shadow(color: couleur.opacity(0.35), radius: 10)
                    .contentTransition(.numericText(value: Double(c.nombre(cat))))
                VStack(alignment: .leading, spacing: 1) {
                    Text(etroit ? libelleCourt(cat) : cat.libelle)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.text2)
                        .lineLimit(1)
                    if !etroit {
                        Text(sousCompteur(cat, c))
                            .font(.caption2)
                            .foregroundStyle(Theme.text3)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, etroit ? 10 : 14)
            .frame(maxWidth: .infinity, minHeight: etroit ? 46 : 58)
            .background {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Theme.surface.opacity(0.82))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(RadialGradient(colors: [couleur.opacity(actif ? 0.22 : 0.1), .clear], center: .leading, startRadius: 0, endRadius: 180))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(actif ? couleur.opacity(0.6) : .white.opacity(0.07), lineWidth: actif ? 1.4 : 0.7)
                    }
            }
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityAddTraits(actif ? .isSelected : [])
        .help(actif ? "Retirer le filtre" : "Afficher seulement : \(cat.libelle.lowercased())")
    }

    private func libelleCourt(_ cat: DepotCategorie) -> String {
        switch cat {
        case .confirme: "Confirmés"
        case .nonConfirme: "Pas scannés"
        case .aVerifier: "À vérifier"
        case .incorrect: "Incorrects"
        case .bloque: "Bloquées"
        case .enAttente: "En attente"
        }
    }

    private func sousCompteur(_ cat: DepotCategorie, _ c: DepotsCompteurs) -> String {
        switch cat {
        case .confirme: (c.retires ?? 0) > 0 ? "historique · \(Format.count(c.retires ?? 0, "retiré", "retirés"))" : "dans l'historique"
        case .nonConfirme: c.nonConfirmeHorsDelai > 0 ? "dont \(c.nonConfirmeHorsDelai) hors délai" : "étiquette seule"
        case .aVerifier: (c.enAttente ?? 0) > 0 ? "+ \(c.enAttente ?? 0) en attente de lecture" : "illisible ou en échec"
        case .incorrect: (c.incorrect ?? 0) > 0 ? "refusés ou inconnus" : "aucun numéro refusé"
        case .bloque: (c.aConstaterBloques ?? min(c.aConstater, c.bloque)) > 0 ? "dont \(c.aConstaterBloques ?? min(c.aConstater, c.bloque)) à constater" : "site protégé ou à la main"
        case .enAttente: "pas encore lu"
        }
    }

    /// une ligne : le Mac (en ligne ?), le dernier passage, la file -- et les
    /// methodes par transporteur
    private func etatVerifications(_ etat: DepotsEtat) -> some View {
        HStack(spacing: 14) {
            if let mac = etat.mac, etat.lecture?.contains(where: \.active) == true {
                let actif = mac.actif == true
                Label {
                    Text(actif ? "Mac en ligne\((mac.pagesDues ?? 0) > 0 && !etroit ? " · \(Format.count(mac.pagesDues ?? 0, "page à lire", "pages à lire"))" : "")" : "Mac hors ligne")
                        .fixedSize()
                } icon: {
                    Circle().fill(actif ? Theme.teal : Theme.warn).frame(width: 7, height: 7).shadow(color: (actif ? Theme.teal : Theme.warn).opacity(0.7), radius: 4)
                }
                .foregroundStyle(actif ? Theme.text2 : Theme.warn)
            }
            Label {
                Text(passage(etat)).fixedSize()
            } icon: {
                Circle().fill(etat.enCours ? Theme.teal : Theme.violetLight).frame(width: 7, height: 7)
                    .symbolEffect(.pulse, isActive: etat.enCours)
            }
            .foregroundStyle(Theme.text3)
            Spacer(minLength: 8)
            ForEach(etat.transporteurs) { t in methode(t, etat) }
        }
        .font(.caption)
        .lineLimit(1)
    }

    private func passage(_ etat: DepotsEtat) -> String {
        if etat.enCours { return "Vérifications en cours…" }
        let file = etat.file.enAttente > 0 && !etroit ? " · \(Format.count(etat.file.enAttente, "en attente", "en attente"))" : ""
        guard let fin = etat.derniereSynchro else { return "Pas encore de passage\(file)" }
        return "Dernier passage \(ilYa(fin))\(file)"
    }

    private func methode(_ t: DepotTransporteurCompte, _ etat: DepotsEtat) -> some View {
        let api = etat.methodes[t.methode] ?? etat.laPoste
        let (symbole, couleur, aide): (String, Color, String) =
            !t.automatique ? ("pencil", Theme.violetLight, "à la main")
            : t.methode == "navigateur" ? (t.pause != nil ? ("lock.fill", Theme.warn, "bloqué") : ("desktopcomputer", Theme.teal, "lu sur le Mac"))
            : api?.configure != true ? ("info.circle", Theme.warn, "API non configurée")
            : api?.pause != nil ? ("clock", Theme.warn, "API en pause")
            : ("bolt.fill", Theme.teal, "API officielle")
        return HStack(spacing: 5) {
            CarrierDot(color: .carrier(t.code), size: 6)
            if !etroit { Text(t.nom).foregroundStyle(Theme.text2) }
            Image(systemName: symbole).foregroundStyle(couleur).font(.caption2)
            Text(Format.integer(t.colis)).monospacedDigit().foregroundStyle(Theme.text3)
        }
        .fixedSize()
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(.white.opacity(0.04), in: .capsule)
        .help("\(t.nom) : \(aide) · \(Format.count(t.colis, "colis", "colis"))")
    }

    // MARK: Bandeaux (API, lecture coupee)

    /// les alertes (API, pause, lecture coupee) : des pastilles sur une ligne,
    /// pas des bandeaux pleine largeur qui mangeaient le tableau
    @ViewBuilder
    private func bandeaux(_ etat: DepotsEtat) -> some View {
        let lp = etat.laPoste
        let coupees = (etat.lecture ?? []).filter { !$0.active }
        let api: (String, Color, String)? =
            lp.map { !$0.configure } == true ? ("info.circle.fill", Theme.info, "API La Poste non configurée (OKAPI_KEY sur Railway)")
            : lp?.pause.map { ("lock.fill", Theme.warn, "La Poste en pause jusqu'à \(ServerDate.shortDayTime($0.jusqua)) : \($0.motif ?? "pause demandée")") }
            ?? etat.derniereErreur.map { ("exclamationmark.triangle.fill", Theme.danger, "Dernier passage interrompu : \($0.message)") }
        if api != nil || !coupees.isEmpty {
            FlowLayout(spacing: 8, lineSpacing: 8) {
                if let (symbole, couleur, texte) = api { pastille(symbole, couleur, texte) }
                ForEach(coupees) { l in
                    pastille("pause.circle.fill", Theme.info, "Lecture coupée : \(l.nom)") {
                        Button("Rallumer") { Task { await model.lecture(l.code, active: true) } }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.violetLight)
                    }
                    .help("Les colis \(l.nom) ne sont pas lus par l'app du Mac tant que la lecture est coupée")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func pastille(_ symbole: String, _ couleur: Color, _ texte: String, @ViewBuilder action: () -> some View = { EmptyView() }) -> some View {
        HStack(spacing: 8) {
            Image(systemName: symbole).foregroundStyle(couleur)
            Text(texte).foregroundStyle(Theme.text2).lineLimit(1)
            action()
        }
        .font(.caption)
        .padding(.horizontal, 11)
        .frame(height: 28)
        .background(couleur.opacity(0.09), in: .capsule)
        .overlay(Capsule().strokeBorder(couleur.opacity(0.3), lineWidth: 0.8))
        .fixedSize()
    }

    // MARK: Le tableau

    /// assez de place pour toutes les colonnes ? (sinon « Vérifié » rejoint
    /// le dernier statut). `largeur` est deja celle qui reste a cote du
    /// panneau du detail.
    private var colonnesCompletes: Bool { largeur >= 1020 }
    /// moins de place (fenetre etroite, ou detail ouvert) : libelles courts,
    /// colonnes resserrees
    private var etroit: Bool { largeur < 1120 }

    private func tableau(_ vue: DepotsVue) -> some View {
        @Bindable var model = app.depots
        let historique = model.filtre.historique
        let lignes = model.lignes
        let anciens = historique ? model.historique : model.historiqueTrouve
        let ids = (historique ? [] : lignes.map(\.colisId)) + anciens.map(\.colisId)
        return VStack(spacing: 0) {
            outils($model)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            Divider().overlay(Theme.hairline)
            ScrollViewReader { defile in
                ScrollView {
                    LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Section {
                            if !historique {
                                ForEach(lignes) { l in
                                    LigneDepotMac(ligne: l, choisie: ouvert?.colisID == l.colisId, complete: colonnesCompletes, etroit: etroit) { choisis(l.colisId) }
                                        .id(l.colisId)
                                }
                            }
                            if !historique && !anciens.isEmpty {
                                Text("Dans l'historique")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.text3)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 16)
                                    .padding(.top, 14)
                                    .padding(.bottom, 4)
                            }
                            ForEach(anciens) { h in
                                LigneHistoriqueMac(ligne: h, choisie: ouvert?.colisID == h.colisId, complete: colonnesCompletes, etroit: etroit) { choisis(h.colisId) }
                                    .id(h.colisId)
                            }
                            if ids.isEmpty { vide(vue) }
                        } header: {
                            enTeteColonnes(historique: historique)
                        }
                    }
                    .padding(.bottom, 8)
                    .animation(Theme.spring, value: ids)
                }
                .sansIndicateurs()
                .focusable()
                .focused($tableauActif)
                .focusEffectDisabled()
                .onKeyPress(.downArrow) { deplace(1, ids, defile) }
                .onKeyPress(.upArrow) { deplace(-1, ids, defile) }
            }
            if let pied = pied(vue) {
                Divider().overlay(Theme.hairline)
                Text(pied)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
        }
        .background(Theme.surface.opacity(0.82), in: .rect(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.07), lineWidth: 0.7))
        .clipShape(.rect(cornerRadius: 18, style: .continuous))
    }

    private func choisis(_ id: Int) {
        tableauActif = true
        withAnimation(.snappy(duration: 0.22)) {
            ouvert = ouvert?.colisID == id ? nil : DepotOuvert(colisID: id)
        }
    }

    private func deplace(_ pas: Int, _ ids: [Int], _ defile: ScrollViewProxy) -> KeyPress.Result {
        guard !ids.isEmpty else { return .ignored }
        let actuel = ouvert.flatMap { o in ids.firstIndex(of: o.colisID) }
        let suivant = actuel.map { min(max($0 + pas, 0), ids.count - 1) } ?? (pas > 0 ? 0 : ids.count - 1)
        ouvert = DepotOuvert(colisID: ids[suivant])
        withAnimation(.snappy(duration: 0.2)) { defile.scrollTo(ids[suivant]) }
        return .handled
    }

    /// apres un constat dans une serie (ou « Passer ») : le colis suivant
    private func suivant(apres o: DepotOuvert) {
        guard let serie = o.serie, o.position + 1 < serie.count else {
            if o.serie != nil {
                ouvert = nil
                app.toasts.show("Tous les colis à constater sont passés", style: .info)
            }
            return
        }
        ouvert = DepotOuvert(colisID: serie[o.position + 1], serie: serie, position: o.position + 1, ouvreLaPage: o.ouvreLaPage)
    }

    private func enTeteColonnes(historique: Bool) -> some View {
        HStack(spacing: 12) {
            Text("Colis").frame(width: LigneMac.colis(etroit), alignment: .leading)
            Text("Dropé").frame(width: LigneMac.drop(etroit), alignment: .leading)
            Text("Contrôle").frame(width: LigneMac.controle(etroit), alignment: .leading)
            Text(historique ? (model.filtre == .retires ? "Raison du retrait" : "Preuve de dépôt") : "Dernier statut transporteur")
                .frame(maxWidth: .infinity, alignment: .leading)
            if colonnesCompletes {
                Text(historique ? "Quand" : "Vérifié").frame(width: LigneMac.verifie, alignment: .leading)
            }
            Color.clear.frame(width: LigneMac.actions)
        }
        .font(.caption2.weight(.semibold))
        .tracking(0.6)
        .textCase(.uppercase)
        .foregroundStyle(Theme.text3)
        .padding(.leading, 19)
        .padding(.trailing, 14)
        .frame(height: 30)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider().overlay(Theme.hairline) }
    }

    @ViewBuilder
    private func vide(_ vue: DepotsVue) -> some View {
        Group {
            if model.filtreActif {
                EmptyStateView(symbol: "magnifyingglass", title: "Aucun colis ne correspond", subtitle: "Change de filtre ou de recherche.")
            } else if model.filtre == .retires {
                EmptyStateView(symbol: "tray", title: "Aucun numéro retiré", subtitle: "Un numéro inconnu ou hors délai sort de la liste et apparaît ici.")
            } else if model.filtre == .confirmes {
                EmptyStateView(symbol: "checkmark.seal", title: "Aucun dépôt confirmé pour l'instant", subtitle: "Un colis pris en charge quitte la liste et apparaît ici, avec sa preuve.")
            } else {
                EmptyStateView(symbol: "checkmark.seal", title: "Rien à contrôler", subtitle: vue.compteurs.confirme > 0 ? "Tous les dépôts sont confirmés : ils sont dans l'historique." : "Les colis dropés avec un numéro de suivi apparaîtront ici.", positive: true)
            }
        }
        .padding(.vertical, 40)
    }

    private func pied(_ vue: DepotsVue) -> String? {
        var morceaux: [String] = []
        if model.filtreActif {
            let affiches = model.filtre.historique ? model.historique.count : model.lignes.count
            let total = switch model.filtre {
            case .confirmes: vue.historique?.confirmes.count ?? 0
            case .retires: vue.historique?.retires.count ?? 0
            default: vue.lignes.count
            }
            morceaux.append("\(Format.count(affiches, "colis affiché", "colis affichés")) sur \(Format.integer(total))")
        }
        if vue.compteurs.sansNumero > 0 {
            morceaux.append(Format.count(vue.compteurs.sansNumero, "colis dropé sans numéro lisible", "colis dropés sans numéro lisible"))
        }
        return morceaux.isEmpty ? nil : morceaux.joined(separator: " · ")
    }

    // MARK: Filtres, recherche, tri

    private func outils(_ model: Bindable<DepotsModel>) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(DepotsModel.Filtre.tousLesFiltres, id: \.self) { f in
                        let actif = model.wrappedValue.filtre == f
                        Button {
                            withAnimation(Theme.spring) { model.wrappedValue.filtre = f }
                        } label: {
                            Text(f.libelle)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(actif ? Theme.text : Theme.text3)
                                .padding(.horizontal, 11)
                                .frame(height: 28)
                                .background {
                                    Capsule()
                                        .fill(actif ? Theme.violet.opacity(0.26) : .white.opacity(0.04))
                                        .overlay(Capsule().strokeBorder(actif ? Theme.violetLight.opacity(0.4) : Theme.hairline, lineWidth: 0.8))
                                }
                        }
                        .buttonStyle(PressScaleStyle(scale: 0.95))
                        .accessibilityAddTraits(actif ? .isSelected : [])
                    }
                }
            }
            .sansIndicateurs()
            HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.text3)
                TextField("Numéro de suivi…", text: model.recherche)
                    .textFieldStyle(.plain)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                if !model.wrappedValue.recherche.isEmpty {
                    Button {
                        model.wrappedValue.recherche = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.text3)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: 340)
            .frame(height: 30)
            .background(.white.opacity(0.05), in: .capsule)
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
            menu("Transporteur", "shippingbox", selection: model.transporteur, options: model.wrappedValue.transporteursPresents.map { ($0.code, $0.nom) })
            menu("Expéditeur", "person", selection: model.expediteur, options: model.wrappedValue.expediteursPresents.map { ($0, $0) })
            Spacer(minLength: 8)
            Menu {
                Picker("Trier", selection: model.tri) {
                    ForEach(DepotsModel.Tri.allCases) { t in Text(t.libelle).tag(t) }
                }
                .pickerStyle(.inline)
            } label: {
                Label(model.wrappedValue.tri.libelle, systemImage: "arrow.up.arrow.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.text2)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(.white.opacity(0.05), in: .capsule)
                    .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .help("Ordre du tableau")
            }
        }
    }

    private func menu(_ titre: String, _ symbole: String, selection: Binding<String?>, options: [(String, String)]) -> some View {
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
            Label(nom ?? titre, systemImage: symbole)
                .font(.caption.weight(.semibold))
                .foregroundStyle(nom == nil ? Theme.text2 : Theme.text)
                .lineLimit(1)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background((nom == nil ? Color.white.opacity(0.05) : Theme.violet.opacity(0.26)), in: .capsule)
                .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.8))
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .fixedSize()
        .help(titre)
    }
}

// MARK: - Les lignes du tableau

/// les largeurs des colonnes (le dernier statut prend le reste) ; resserrees
/// quand la place manque
enum LigneMac {
    static func colis(_ etroit: Bool) -> CGFloat { etroit ? 196 : 230 }
    static func drop(_ etroit: Bool) -> CGFloat { etroit ? 88 : 104 }
    static func controle(_ etroit: Bool) -> CGFloat { etroit ? 170 : 190 }
    static let verifie: CGFloat = 104
    static let actions: CGFloat = 64
}

/// Un colis de la liste active, sur une ligne : numero et transporteur ·
/// expediteur ; date du drop (et « hors délai ») ; le verdict ; ce que dit le
/// transporteur ; quand c'est verifie ; « Vérifier » et le suivi officiel.
private struct LigneDepotMac: View {
    let ligne: DepotLigne
    let choisie: Bool
    let complete: Bool
    let etroit: Bool
    let choisis: () -> Void
    @Environment(AppModel.self) private var app
    @State private var survol = false

    var body: some View {
        let c = ligne.controle
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(ligne.numero)
                    .font(.system(.callout, design: .monospaced).weight(.semibold))
                    .lineLimit(1)
                    .textSelection(.enabled)
                HStack(spacing: 5) {
                    CarrierDot(color: .carrier(ligne.transporteur.code), size: 6)
                    Text("\(ligne.transporteur.nom) · \(ligne.expediteur)").lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(Theme.text3)
            }
            .frame(width: LigneMac.colis(etroit), alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(ServerDate.shortDayTime(ligne.statutInterne.dropeLe))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                if c.cat == .nonConfirme && c.enRetard {
                    Text("hors délai").font(.caption2.weight(.semibold)).foregroundStyle(Theme.warn)
                }
            }
            .frame(width: LigneMac.drop(etroit), alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                DepotBadge(controle: c)
                if let redrop = ligne.redrop, redrop.enAttente != nil || redrop.de != nil {
                    RedropPuce(enAttente: redrop.enAttente != nil)
                }
            }
            .frame(width: LigneMac.controle(etroit), alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(c.dernierEvenement?.statut ?? (ligne.manuel && c.constat == nil ? "À constater sur la page officielle" : statutTransporteur))
                    .font(.callout)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Text(sousStatut)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(c.raison)

            if complete {
                HStack(spacing: 4) {
                    if ligne.erreur != nil {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger).help(ligne.erreur?.message ?? "erreur")
                    }
                    Text(quand)
                }
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .frame(width: LigneMac.verifie, alignment: .leading)
            }

            HStack(spacing: 2) {
                if !ligne.manuel {
                    Button {
                        Task { await app.depots.verifie(ligne.colisId) }
                    } label: {
                        Group {
                            if app.depots.enVerification.contains(ligne.colisId) { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
                        }
                        .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Vérifier maintenant")
                }
                if let lien = ligne.lien, let url = URL(string: lien) {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right.square").frame(width: 28, height: 28)
                    }
                    .help("Suivi officiel")
                }
            }
            .foregroundStyle(Theme.text2)
            .opacity(survol || choisie ? 1 : 0.55)
            .frame(width: LigneMac.actions, alignment: .trailing)
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 9)
        .background(fond(c))
        .overlay(alignment: .leading) {
            // la barre de couleur d'un colis qui demande un regard
            Capsule()
                .fill(c.cat == .confirme ? .clear : c.cat.couleur.opacity(ligne.attention ? 1 : 0.4))
                .frame(width: 3)
                .padding(.vertical, 8)
                .padding(.leading, 5)
                .shadow(color: ligne.attention ? c.cat.couleur.opacity(0.6) : .clear, radius: 4)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 0.5).padding(.leading, 16) }
        .contentShape(.rect)
        .onTapGesture(perform: choisis)
        .onHover { survol = $0 }
        .animation(.easeOut(duration: 0.15), value: survol)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(choisie ? [.isSelected, .isButton] : .isButton)
        .accessibilityAction(named: "Détail", choisis)
    }

    private func fond(_ c: DepotControle) -> Color {
        if choisie { return Theme.violet.opacity(0.18) }
        if survol { return .white.opacity(0.045) }
        return ligne.attention ? c.cat.couleur.opacity(0.05) : .clear
    }

    private var statutTransporteur: String {
        ligne.controle.statutTransporteur(manuel: ligne.manuel, verifie: ligne.verifieLe != nil, navigateur: ligne.transporteur.methode == "navigateur")
    }

    private var sousStatut: String {
        let c = ligne.controle
        var morceaux: [String] = []
        if let e = c.dernierEvenement {
            morceaux.append(ServerDate.shortDayTime(e.le, jourSeul: e.jourSeul))
            if let lieu = e.lieu { morceaux.append(lieu) }
            morceaux.append(statutTransporteur)
        } else {
            morceaux.append(c.raison)
        }
        if c.suite?.retour == true { morceaux.append("retour") } else if c.livre { morceaux.append("livré") }
        if !complete { morceaux.append(quand) }
        return morceaux.joined(separator: " · ")
    }

    private var quand: String {
        if ligne.manuel { return ligne.controle.constat.map { "constaté \(ilYa($0.le))" } ?? "à constater" }
        return ilYa(ligne.verifieLe ?? ligne.essaiLe)
    }
}

/// Une ligne de l'historique : un depot prouve, ou un numero retire.
private struct LigneHistoriqueMac: View {
    let ligne: DepotHistorique
    let choisie: Bool
    let complete: Bool
    let etroit: Bool
    let choisis: () -> Void
    @Environment(AppModel.self) private var app
    @State private var survol = false

    var body: some View {
        let retire = ligne.retire != nil
        let couleur = ligne.incorrect ? DepotCategorie.incorrect.couleur : retire ? Theme.text3 : DepotCategorie.confirme.couleur
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(ligne.numero)
                    .font(.system(.callout, design: .monospaced).weight(.semibold))
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
                    .textSelection(.enabled)
                HStack(spacing: 5) {
                    CarrierDot(color: .carrier(ligne.transporteur.code), size: 6)
                    Text("\(ligne.transporteur.nom) · \(ligne.expediteur)").lineLimit(1)
                }
                .font(.caption)
                .foregroundStyle(Theme.text3)
            }
            .frame(width: LigneMac.colis(etroit), alignment: .leading)

            Text(ServerDate.shortDayTime(ligne.dropeLe))
                .font(.caption.monospacedDigit())
                .foregroundStyle(Theme.text3)
                .frame(width: LigneMac.drop(etroit), alignment: .leading)

            Label(ligne.incorrect ? "Numéro incorrect" : retire ? "Retiré" : "Posté confirmé", systemImage: ligne.incorrect ? DepotCategorie.incorrect.symbole : retire ? "tray" : "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(couleur)
                .padding(.horizontal, 9)
                .frame(height: 24)
                .background(couleur.opacity(0.13), in: .capsule)
                .lineLimit(1)
                .frame(width: LigneMac.controle(etroit), alignment: .leading)

            VStack(alignment: .leading, spacing: 3) {
                Text(retire ? (ligne.retire?.motif ?? "retiré de la file") : (ligne.preuve?.statut ?? "—"))
                    .font(.callout)
                    .foregroundStyle(retire ? Theme.text2 : Theme.text)
                    .lineLimit(1)
                Text(retire ? "le colis et son étiquette sont gardés" : "\(ServerDate.shortDayTime(ligne.preuve?.le))\(suite)")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(retire ? (ligne.retire?.motif ?? "") : (ligne.preuve?.statut ?? ""))

            if complete {
                Text(retire ? "retiré \(ilYa(ligne.retire?.le))" : "confirmé \(ilYa(ligne.confirmeLe))")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .frame(width: LigneMac.verifie, alignment: .leading)
            }

            HStack(spacing: 2) {
                if retire {
                    Button {
                        Task { await app.depots.verifie(ligne.colisId) }
                    } label: {
                        Group {
                            if app.depots.enVerification.contains(ligne.colisId) { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
                        }
                        .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help("Remettre en contrôle (relire maintenant)")
                }
                if let lien = ligne.lien, let url = URL(string: lien) {
                    Link(destination: url) {
                        Image(systemName: "arrow.up.right.square").frame(width: 28, height: 28)
                    }
                    .help("Suivi officiel")
                }
            }
            .foregroundStyle(Theme.text2)
            .opacity(survol || choisie ? 1 : 0.55)
            .frame(width: LigneMac.actions, alignment: .trailing)
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 9)
        .background(choisie ? Theme.violet.opacity(0.18) : survol ? .white.opacity(0.045) : .clear)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.hairline).frame(height: 0.5).padding(.leading, 16) }
        .contentShape(.rect)
        .onTapGesture(perform: choisis)
        .onHover { survol = $0 }
        .animation(.easeOut(duration: 0.15), value: survol)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(choisie ? [.isSelected, .isButton] : .isButton)
        .accessibilityAction(named: "Détail", choisis)
    }

    private var suite: String {
        if ligne.suite?.retour == true { return " · puis retour à l'expéditeur" }
        if ligne.suite?.etape == "delivered" || ligne.livre == true { return " · puis livré" }
        return ""
    }
}
#endif
