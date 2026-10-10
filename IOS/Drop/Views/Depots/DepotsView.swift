import SwiftUI
import DropKit

/// Le controle des depots, comme sur le site : cinq compteurs qui filtrent,
/// l'etat des verifications (et « Relancer »), la methode de chaque
/// transporteur, puis la liste -- statut FeurDrop et parole du transporteur
/// cote a cote. Toucher un colis ouvre sa chronologie.
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
    }

    private var sousTitre: String {
        guard let c = model.vue?.compteurs, let etat = model.vue?.etat else { return "" }
        guard c.total > 0 else { return "Aucun colis dropé sur \(etat.affichageJours) jours" }
        return "\(Format.count(c.total, "colis dropé", "colis dropés")) sur \(etat.affichageJours) jours" + (c.attention > 0 ? " · \(c.attention) à regarder" : "")
    }

    // MARK: Compteurs

    @ViewBuilder
    private func compteurs(_ c: DepotsCompteurs) -> some View {
        let toutes = DepotCategorie.allCases
        if large {
            HStack(spacing: 10) {
                ForEach(toutes) { cat in compteur(cat, c) }
            }
        } else {
            VStack(spacing: 10) {
                compteur(.confirme, c)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    ForEach(toutes.dropFirst()) { cat in compteur(cat, c) }
                }
            }
        }
    }

    private func compteur(_ cat: DepotCategorie, _ c: DepotsCompteurs) -> some View {
        let actif = model.filtre == .categorie(cat)
        let couleur = cat.couleur
        return Button {
            Haptics.selection()
            withAnimation(Theme.spring) { model.filtre = actif ? .tous : .categorie(cat) }
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
                Text(sousCompteur(cat, c))
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
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
        case .confirme: "pris en charge par le transporteur"
        case .nonConfirme: c.nonConfirmeHorsDelai > 0 ? "dont \(c.nonConfirmeHorsDelai) hors délai" : "étiquette seule, pas de scan"
        case .aVerifier: "inconnu, refusé ou ambigu"
        case .bloque: c.aConstater > 0 ? "dont \(c.aConstater) à constater" : "site protégé ou en pause"
        case .anomalie: "incident ou incohérence"
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
            }

            if lignes.isEmpty {
                if model.filtreActif {
                    EmptyStateView(symbol: "magnifyingglass", title: "Aucun colis ne correspond", subtitle: "Change de filtre ou de recherche.")
                } else {
                    EmptyStateView(symbol: "tray", title: "Aucun colis dropé à contrôler", subtitle: "Les colis dropés avec un numéro de suivi apparaîtront ici.")
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

            if let pied = pied(vue, affichees: lignes.count) {
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

    private func pied(_ vue: DepotsVue, affichees: Int) -> String? {
        var morceaux: [String] = []
        if model.filtreActif { morceaux.append("\(Format.count(affichees, "colis affiché", "colis affichés")) sur \(Format.integer(vue.lignes.count))") }
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
        ouvert = DepotOuvert(colisID: serie[o.position + 1], serie: serie, position: o.position + 1)
    }
}

/// Le colis ouvert dans la feuille (et sa place dans une serie de constats).
struct DepotOuvert: Identifiable, Hashable {
    let colisID: Int
    var serie: [Int]? = nil
    var position = 0
    var id: Int { colisID }
}

// MARK: - Etat des verifications

/// Le dernier passage, la file, la pause eventuelle de La Poste, et les deux
/// boutons : relancer, constater a la main.
private struct PassageCard: View {
    let vue: DepotsVue
    let constater: () -> Void
    @Environment(AppModel.self) private var app

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
                Text("Relancer les vérifications en attente")
            }
            .font(.subheadline.weight(.semibold))
            .fixedSize()
            .frame(maxWidth: pleineLargeur ? .infinity : nil)
            .frame(height: 40)
            .padding(.horizontal, 6)
        }
        .boutonVerre()
        .disabled(lp?.configure != true || lp?.pause != nil || etat.enCours || app.depots.relance)
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
        let (texte, symbole, couleur): (String, String, Color) =
            !t.automatique ? ("à la main", "pencil", Theme.violetLight)
            : lp?.configure != true ? ("non configuré", "info.circle", Theme.warn)
            : lp?.pause != nil ? ("en pause", "clock", Theme.warn)
            : ("automatique", "bolt.fill", Theme.teal)
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
                HStack(spacing: 5) {
                    CarrierDot(color: .carrier(ligne.transporteur.code), size: 6)
                    Text("\(ligne.transporteur.nom) · \(ligne.expediteur)")
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(statutTransporteur + (c.livre && c.cat != .anomalie ? " · livré" : ""))
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

    private var statutTransporteur: String { ligne.controle.statutTransporteur(manuel: ligne.manuel, verifie: ligne.verifieLe != nil) }

    private var quand: String {
        if ligne.manuel {
            return ligne.controle.constat.map { "constaté \(ilYa($0.le))" } ?? "à constater"
        }
        return ilYa(ligne.verifieLe ?? ligne.essaiLe)
    }
}

/// Le badge d'une categorie : sa couleur, son icone, son libelle court.
struct DepotBadge: View {
    let controle: DepotControle
    var long = false

    var body: some View {
        let cat = controle.cat
        let texte = long ? controle.libelle : cat == .nonConfirme && controle.enRetard ? "Non confirmé · hors délai" : cat.court
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
    /// confirme (sarcelle), non confirme (ambre), verification necessaire
    /// (bleu), bloquee (lavande : rien n'a pu etre lu, pas une alerte),
    /// anomalie (rouge) -- comme sur le site
    var couleur: Color {
        switch self {
        case .confirme: Theme.teal
        case .nonConfirme: Theme.warn
        case .aVerifier: Theme.info
        case .bloque: Theme.violetLight
        case .anomalie: Theme.danger
        }
    }

    var symbole: String {
        switch self {
        case .confirme: "checkmark"
        case .nonConfirme: "clock"
        case .aVerifier: "magnifyingglass"
        case .bloque: "lock.fill"
        case .anomalie: "exclamationmark.triangle.fill"
        }
    }
}

extension DepotControle {
    /// ce que dit le transporteur, en quelques mots
    func statutTransporteur(manuel: Bool, verifie: Bool) -> String {
        if let s = dernierStatut { return s.libelle }
        if manuel { return constat != nil ? "Constaté à la main" : "Pas de lecture automatique" }
        return verifie ? "Inconnu du transporteur" : "Pas encore vérifié"
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
