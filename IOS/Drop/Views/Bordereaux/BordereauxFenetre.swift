#if os(macOS)
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import DropKit

/// La fenetre « Bordereaux », a part de la fenetre Drop : l'etude des
/// etiquettes (liste, visionneuse, codes) et la recherche d'un numero.
struct BordereauxFenetre: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            FondBordereaux()
            if app.connecte {
                BordereauxContenu(model: app.bordereaux)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "lock")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(Theme.violetLight)
                    Text("Connecte-toi dans la fenêtre Drop")
                        .font(.title3.weight(.semibold))
                }
            }
        }
        .overlay(alignment: .top) {
            ToastOverlay(center: app.bordereaux.toasts)
                .padding(.top, 58)
        }
        .ignoresSafeArea(.container, edges: .top)
        .controlSize(.large)
    }
}

/// Le fond de la fenetre : calme (graphite et lueurs violettes), sans
/// animation -- toute la place est pour l'etiquette.
private struct FondBordereaux: View {
    var body: some View {
        ZStack {
            Theme.background
            RadialGradient(colors: [Theme.violet.opacity(0.20), .clear], center: UnitPoint(x: 0.12, y: -0.1), startRadius: 0, endRadius: 900)
            RadialGradient(colors: [Theme.violetDeep.opacity(0.16), .clear], center: UnitPoint(x: 1, y: 0), startRadius: 0, endRadius: 700)
            RadialGradient(colors: [Theme.violetDark.opacity(0.35), .clear], center: UnitPoint(x: 0.5, y: 1.2), startRadius: 0, endRadius: 900)
        }
        .ignoresSafeArea()
    }
}

private struct BordereauxContenu: View {
    @Bindable var model: BordereauxModel

    var body: some View {
        VStack(spacing: 12) {
            EnTeteBordereaux(model: model)
            if model.onglet == .recherche {
                BarreRecherche(model: model)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            HStack(alignment: .top, spacing: 14) {
                ColonneGauche(model: model)
                    .frame(width: 300)
                VisionneuseCadre(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if model.ouverteId != nil {
                    PanneauEtiquette(model: model)
                        .frame(width: 340)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 18)
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: model.onglet)
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: model.ouverteId != nil)
        .task {
            await model.arrivee()
            #if DEBUG
            // verification : `-DropBordereau 12` ouvre une etiquette,
            // `-DropBordereauxRecherche 6A123` cherche un numero
            let reglages = UserDefaults.standard
            if reglages.bool(forKey: "DropBordereauZones") { model.zonesToutes = true }
            if let t = reglages.string(forKey: "DropBordereauxTri") { model.tri = t }
            if let q = reglages.string(forKey: "DropBordereauxRecherche") {
                model.onglet = .recherche
                model.requete = q
                await model.cherche(q)
                if let premier = model.resultats.first { model.ouvreResultat(premier) }
            } else if reglages.integer(forKey: "DropBordereau") > 0 {
                await model.ouvre(reglages.integer(forKey: "DropBordereau"))
            }
            #endif
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                await model.chargeEtat()
            }
        }
    }
}

// MARK: - En-tete

private struct EnTeteBordereaux: View {
    @Bindable var model: BordereauxModel

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(Theme.accentGradient)
                    .shadow(color: Theme.violet.opacity(0.7), radius: 10, y: 4)
                Image(systemName: "barcode.viewfinder")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text("Bordereaux")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.numberGradient)
                Text(etatTexte)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 20)
            Picker("", selection: $model.onglet) {
                Label("Étude des bordereaux", systemImage: "doc.text.magnifyingglass").tag(BordereauxModel.Onglet.etude)
                Label("Recherche / modifications", systemImage: "magnifyingglass").tag(BordereauxModel.Onglet.recherche)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 440)
        }
        .padding(.leading, 78) // les trois boutons de la fenetre
        .padding(.top, 12)
        .frame(height: 64)
        .background {
            // on deplace la fenetre en la tirant par son en-tete
            Color.clear.contentShape(.rect).gesture(WindowDragGesture())
        }
    }

    private var etatTexte: String {
        guard let e = model.etat else { return "Étude des étiquettes et de leurs codes" }
        var morceaux = [Format.count(e.etiquettes, "étiquette", "étiquettes"), "\(Format.integer(e.analysees)) lue\(e.analysees > 1 ? "s" : "")", Format.count(e.codes, "code indexé", "codes indexés")]
        if e.indexation.active && e.indexation.restants > 0 { morceaux.append("lecture en fond : \(e.indexation.restants)") }
        return morceaux.joined(separator: " · ")
    }
}

// MARK: - Recherche

private struct BarreRecherche: View {
    @Bindable var model: BordereauxModel
    @FocusState private var focus: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(Theme.violetLight)
            TextField("Rechercher un numéro de suivi…", text: $model.requete)
                .textFieldStyle(.plain)
                .font(.system(size: 19, weight: .semibold))
                .focused($focus)
                .onChange(of: model.requete) { model.requeteModifiee() }
                .onSubmit {
                    if let premier = model.resultats.first { model.ouvreResultat(premier) }
                }
            if model.rechercheEnCours { ProgressView().controlSize(.small) }
            if !model.requete.isEmpty {
                Button {
                    model.requete = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.text3)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 56)
        .glassEffect(.regular.tint(Theme.violet.opacity(0.12)), in: .rect(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Theme.violetLight.opacity(focus ? 0.55 : 0.22), lineWidth: 1)
        }
        .shadow(color: Theme.violet.opacity(focus ? 0.45 : 0.2), radius: 20, y: 8)
        .onAppear { focus = true }
    }
}

// MARK: - Colonne de gauche : etiquettes ou resultats

private struct ColonneGauche: View {
    @Bindable var model: BordereauxModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.onglet == .etude { etude } else { resultats }
        }
        .padding(12)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Surface())
    }

    @ViewBuilder
    private var etude: some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal.decrease").foregroundStyle(Theme.text3)
            TextField("Expéditeur ou fichier", text: $model.texteFiltre)
                .textFieldStyle(.plain)
                .onChange(of: model.texteFiltre) { model.filtreModifie() }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(.black.opacity(0.25), in: .rect(cornerRadius: 11))
        .overlay { RoundedRectangle(cornerRadius: 11).strokeBorder(.white.opacity(0.08)) }

        FlowFiltres(model: model)
        TrisEtFiltres(model: model)

        ScrollView {
            LazyVStack(spacing: 4, pinnedViews: [.sectionHeaders]) {
                if model.liste.isEmpty {
                    Text(model.erreurListe ?? (model.chargementListe ? "Chargement…" : "Aucune étiquette ici."))
                        .font(.callout)
                        .foregroundStyle(model.erreurListe == nil ? Theme.text3 : Theme.warn)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                }
                if model.tri == "transporteur" {
                    // par transporteur : un intertitre (et son nombre) avant chacun
                    ForEach(groupes, id: \.code) { g in
                        Section {
                            ForEach(g.etiquettes) { b in ligne(b) }
                        } header: {
                            IntertitreTransporteur(code: g.code, nom: g.nom, n: model.transporteurs.first { $0.code == g.code }?.n ?? g.etiquettes.count)
                        }
                    }
                } else {
                    ForEach(model.liste) { b in ligne(b) }
                }
                if model.suite != nil {
                    Button("Plus d'étiquettes") { Task { await model.chargeListe(suite: true) } }
                        .boutonVerre()
                        .padding(.top, 6)
                }
            }
        }
        .scrollIndicators(.never)
    }

    private func ligne(_ b: BordereauResume) -> some View {
        LigneEtiquette(b: b, choisie: model.ouverteId == b.id) {
            Task { await model.ouvre(b.id) }
        }
    }

    /// la liste par transporteur, dans l'ordre du serveur
    private var groupes: [(code: String, nom: String, etiquettes: [BordereauResume])] {
        var resultat: [(code: String, nom: String, etiquettes: [BordereauResume])] = []
        for b in model.liste {
            let code = b.transporteur?.code ?? "aucun"
            if resultat.last?.code == code { resultat[resultat.count - 1].etiquettes.append(b) }
            else { resultat.append((code, b.transporteur?.nom ?? "Sans transporteur", [b])) }
        }
        return resultat
    }

    @ViewBuilder
    private var resultats: some View {
        Text(infoRecherche)
            .font(.callout)
            .foregroundStyle(Theme.text3)
            .padding(.horizontal, 4)
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(model.resultats) { r in
                    CarteResultat(r: r, choisie: model.ouverteId == r.id) { model.ouvreResultat(r) }
                }
            }
        }
        .scrollIndicators(.never)
    }

    private var infoRecherche: String {
        let q = model.requete.filter { $0.isLetter || $0.isNumber }
        if q.count < 3 { return "" }
        if !model.rechercheFaite { return "Recherche…" }
        if model.resultats.isEmpty { return "Aucune étiquette ne porte ce numéro, même à une faute près." }
        if model.totalResultats > model.resultats.count { return "\(Format.integer(model.totalResultats)) étiquettes — les \(model.resultats.count) plus proches" }
        return Format.count(model.totalResultats, "étiquette trouvée", "étiquettes trouvées")
    }
}

private struct FlowFiltres: View {
    @Bindable var model: BordereauxModel
    private let filtres = [("tous", "Toutes"), ("a_imprimer", "À imprimer"), ("imprimes", "Imprimées"), ("deposes", "Déposées")]

    var body: some View {
        // deux par ligne : les quatre tiennent sans etre coupes
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
            ForEach(filtres, id: \.0) { cle, titre in
                let on = model.filtre == cle
                Button(titre) { model.changeFiltre(cle) }
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(on ? Theme.text : Theme.text2)
                    .padding(.horizontal, 9)
                    .frame(maxWidth: .infinity)
                    .frame(height: 28)
                    .contentShape(.capsule)
                    .background {
                        Capsule().fill(on ? AnyShapeStyle(LinearGradient(colors: [Theme.violet.opacity(0.32), Theme.violet.opacity(0.14)], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(0.04)))
                    }
                    .overlay { Capsule().strokeBorder(on ? Theme.violetBright.opacity(0.5) : .white.opacity(0.1)) }
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: model.filtre)
    }
}

/// Transporteur, a partir du, tri, categorie.
private struct TrisEtFiltres: View {
    @Bindable var model: BordereauxModel
    @State private var gereCategories = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Grid(horizontalSpacing: 8, verticalSpacing: 6) {
                GridRow {
                    choix("Transporteur") {
                        Picker("", selection: $model.transporteur) {
                            Text("Tous").tag("")
                            ForEach(model.transporteurs) { t in Text("\(t.nom) (\(t.n))").tag(t.code) }
                        }
                    }
                    choix("À partir du") {
                        HStack(spacing: 4) {
                            DatePicker("", selection: Binding(get: { model.depuis ?? .now }, set: { model.depuis = $0 }), displayedComponents: .date)
                                .labelsHidden()
                                .datePickerStyle(.field)
                                .opacity(model.depuis == nil ? 0.45 : 1)
                            if model.depuis != nil {
                                Button { model.depuis = nil } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.plain).foregroundStyle(Theme.text3).help("Toutes les dates")
                            }
                        }
                    }
                }
                GridRow {
                    choix("Tri") {
                        Picker("", selection: $model.tri) {
                            Text("Plus récentes").tag("recent")
                            Text("Plus anciennes").tag("ancien")
                            Text("Par transporteur").tag("transporteur")
                        }
                    }
                    choix("Catégorie") {
                        Picker("", selection: $model.categorie) {
                            Text("Toutes").tag("")
                            Text("Sans catégorie").tag("aucune")
                            ForEach(model.categories) { c in Text("\(c.nom) (\(c.etiquettes ?? 0))").tag(String(c.id)) }
                        }
                    }
                }
            }
            HStack(spacing: 10) {
                Text(Format.count(model.total, "étiquette", "étiquettes")).font(.caption.monospacedDigit()).foregroundStyle(Theme.text3)
                Spacer()
                if model.filtresActifs {
                    Button("Effacer les filtres") { model.effaceFiltres() }
                        .buttonStyle(.plain).font(.caption.weight(.semibold)).foregroundStyle(Theme.violetLight)
                }
                Button("Catégories…") { gereCategories = true }
                    .buttonStyle(.plain).font(.caption.weight(.semibold)).foregroundStyle(Theme.violetLight)
                    .help("Créer, renommer, recolorer ou supprimer les catégories")
            }
        }
        .sheet(isPresented: $gereCategories) {
            GestionCategories(model: model)
        }
    }

    private func choix<Contenu: View>(_ titre: String, @ViewBuilder contenu: () -> Contenu) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(titre.uppercased()).font(.system(size: 9.5, weight: .semibold)).tracking(0.8).foregroundStyle(Theme.text3)
            contenu().labelsHidden().pickerStyle(.menu).controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Les categories : creer, renommer, recolorer, supprimer (les etiquettes restent).
private struct GestionCategories: View {
    @Bindable var model: BordereauxModel
    @Environment(\.dismiss) private var ferme
    @State private var nouvelle = ""
    @State private var noms: [Int: String] = [:]
    @State private var aSupprimer: BordereauCategorie?
    private static let couleurs = ["violet", "bleu", "turquoise", "vert", "jaune", "orange", "rose", "rouge", "gris"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Catégories").font(.title2.weight(.bold))
                Spacer()
                Button("Fermer") { ferme() }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(spacing: 8) {
                    if model.categories.isEmpty {
                        Text("Aucune catégorie pour l'instant.").foregroundStyle(Theme.text3).frame(maxWidth: .infinity).padding(.vertical, 20)
                    }
                    ForEach(model.categories) { c in
                        HStack(spacing: 10) {
                            Circle().fill(PuceCategorie.couleur(c.couleur)).frame(width: 12, height: 12).shadow(color: PuceCategorie.couleur(c.couleur), radius: 5)
                            TextField("Nom", text: Binding(get: { noms[c.id] ?? c.nom }, set: { noms[c.id] = $0 }))
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { Task { await model.modifieCategorie(c.id, nom: noms[c.id]) } }
                            Text(Format.count(c.etiquettes ?? 0, "étiquette", "étiquettes")).font(.caption).foregroundStyle(Theme.text3).fixedSize()
                            HStack(spacing: 4) {
                                ForEach(Self.couleurs, id: \.self) { k in
                                    Button { Task { await model.modifieCategorie(c.id, couleur: k) } } label: {
                                        Circle().fill(PuceCategorie.couleur(k)).frame(width: 15, height: 15)
                                            .overlay { if k == c.couleur { Circle().strokeBorder(.white, lineWidth: 2) } }
                                    }
                                    .buttonStyle(.plain)
                                    .help(k)
                                }
                            }
                            Button(role: .destructive) { aSupprimer = c } label: { Image(systemName: "trash") }
                                .buttonStyle(.plain).foregroundStyle(Theme.danger).help("Supprimer la catégorie")
                        }
                        .padding(10)
                        .background(.white.opacity(0.03), in: .rect(cornerRadius: 12))
                    }
                }
            }
            .frame(minHeight: 160, maxHeight: 360)
            HStack {
                TextField("Nouvelle catégorie (ex. Retours)", text: $nouvelle)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(cree)
                Button("Créer", action: cree).boutonVerreFort().disabled(nouvelle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 640)
        .task { await model.rechargeCategories() }
        .confirmationDialog("Supprimer la catégorie « \(aSupprimer?.nom ?? "") » ?", isPresented: Binding(get: { aSupprimer != nil }, set: { if !$0 { aSupprimer = nil } }), titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                if let c = aSupprimer { Task { await model.supprimeCategorie(c.id) } }
                aSupprimer = nil
            }
        } message: {
            Text("Ses \(aSupprimer?.etiquettes ?? 0) étiquette(s) restent, simplement sans catégorie.")
        }
    }

    private func cree() {
        let nom = nouvelle
        nouvelle = ""
        Task { await model.creeCategorie(nom) }
    }
}

private struct IntertitreTransporteur: View {
    let code: String
    let nom: String
    let n: Int

    var body: some View {
        let couleur = Theme.carrier(code == "aucun" ? "" : code)
        HStack(spacing: 7) {
            Circle().fill(couleur).frame(width: 7, height: 7).shadow(color: couleur, radius: 4)
            Text(nom).font(.system(size: 12, weight: .semibold)).foregroundStyle(couleur)
            Spacer()
            Text("\(n)").font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Color(red: 0.07, green: 0.06, blue: 0.10).opacity(0.95), in: .rect(cornerRadius: 10))
    }
}

/// La pastille d'une categorie, a ses couleurs.
struct PuceCategorie: View {
    let categorie: BordereauCategorie

    static func couleur(_ nom: String) -> Color {
        switch nom {
        case "violet": Theme.violet
        case "bleu": Theme.info
        case "turquoise": Theme.teal
        case "vert": Theme.carrier("CHRONO")
        case "jaune": Theme.carrier("LP")
        case "orange": Theme.special
        case "rose": Theme.carrier("MR")
        case "rouge": Theme.danger
        default: Theme.text3
        }
    }

    var body: some View {
        let c = Self.couleur(categorie.couleur)
        HStack(spacing: 4) {
            Circle().fill(c).frame(width: 5, height: 5)
            Text(categorie.nom).lineLimit(1)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(c)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(c.opacity(0.15), in: .capsule)
    }
}

private struct LigneEtiquette: View {
    let b: BordereauResume
    let choisie: Bool
    let action: () -> Void
    @State private var survol = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                CarrierDot(color: Theme.carrier(b.transporteur?.code ?? ""), size: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(b.expediteur ?? "—").font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                    Text(b.suivi?.numero ?? b.fichier ?? "Colis #\(b.id)")
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let c = b.categorie { PuceCategorie(categorie: c) }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 3) {
                    BadgeIndex(index: b.index)
                    Text(DateBordereau.courte(b.recuLe)).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(Theme.text3)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(choisie ? AnyShapeStyle(LinearGradient(colors: [Theme.violet.opacity(0.24), Theme.violet.opacity(0.08)], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(survol ? 0.045 : 0)))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(choisie ? Theme.violetLight.opacity(0.4) : .white.opacity(survol ? 0.07 : 0))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { survol = $0 }
        .animation(.easeOut(duration: 0.15), value: survol)
    }
}

private struct BadgeIndex: View {
    let index: BordereauIndex?

    var body: some View {
        let (texte, couleur): (String, Color) = {
            switch index?.etat {
            case "analyse":
                let n = index?.lisibles ?? 0
                let i = index?.illisibles ?? 0
                if n + i == 0 { return ("Aucun code", Theme.text3) }
                return ("\(n) code\(n > 1 ? "s" : "")\(i > 0 ? " · \(i) illisible\(i > 1 ? "s" : "")" : "")", i > 0 ? Theme.warn : Theme.violetPale)
            case "erreur": return ("Fichier illisible", Theme.warn)
            case "echec": return ("Inaccessible", Theme.warn)
            default: return ("À lire", Theme.text3)
            }
        }()
        Text(texte)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(couleur)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(couleur.opacity(0.13), in: .capsule)
    }
}

private struct CarteResultat: View {
    let r: BordereauResultat
    let choisie: Bool
    let action: () -> Void
    private static let types = ["exact": "Numéro exact", "debut": "Commence par", "fin": "Se termine par", "contient": "Contient", "proche": "Numéro proche"]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button(action: action) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        CarrierDot(color: Theme.carrier(r.transporteur?.code ?? ""), size: 8)
                        Text(r.expediteur ?? "—").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        Spacer(minLength: 4)
                        if let t = r.correspondances.first?.type {
                            Text(Self.types[t] ?? t)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(t == "proche" ? Theme.warn : Theme.violetPale)
                                .padding(.horizontal, 7).padding(.vertical, 2.5)
                                .background((t == "proche" ? Theme.warn : Theme.violet).opacity(0.16), in: .rect(cornerRadius: 6))
                        }
                    }
                    Text([r.transporteur?.nom, DateBordereau.courte(r.recuLe), DateBordereau.etape(r.etape)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                    ForEach(Array(r.correspondances.enumerated()), id: \.offset) { _, m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.source == "code" ? "\(m.nomFormat ?? "Code")\(m.page.map { " · p. \($0)" } ?? "")" : "Nom du fichier")
                                .font(.system(size: 10.5))
                                .foregroundStyle(Theme.text3)
                            Text(DateBordereau.surligne(m.norme, debut: m.debut, fin: m.fin))
                                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.black.opacity(0.22), in: .rect(cornerRadius: 9))
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if let url = r.suivi?.url {
                Link(destination: url) {
                    Label("Ouvrir le suivi du colis", systemImage: "arrow.up.right.square")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(maxWidth: .infinity)
                }
                .boutonVerre()
            }
        }
        .padding(10)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(choisie ? AnyShapeStyle(LinearGradient(colors: [Theme.violet.opacity(0.2), Theme.violet.opacity(0.06)], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Color.white.opacity(0.025)))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(choisie ? Theme.violetLight.opacity(0.45) : .white.opacity(0.07))
        }
    }
}

// MARK: - La visionneuse et sa barre

private struct VisionneuseCadre: View {
    @Bindable var model: BordereauxModel

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                if let doc = model.document {
                    VisionneuseEtiquette(
                        document: doc,
                        page: model.page,
                        codes: model.codesDeLaPage,
                        selection: model.selection,
                        trouve: model.trouve,
                        zonesToutes: model.zonesToutes,
                        ajustement: model.ajustement,
                        commande: model.commande,
                        revelation: model.revelation,
                        surZoom: { z, libre in
                            model.zoom = z
                            if libre { model.ajustement = .libre }
                        },
                        surSurvol: { model.bulle = $0 },
                        surChoix: { model.choisit($0) },
                        surCopie: { code in
                            Presse.copie(code.valeur ?? "")
                            model.toasts.show("Valeur copiée")
                        }
                    )
                    if model.lectureEnCours { Balayage() }
                    if let bulle = model.bulle { BulleCode(bulle: bulle) }
                } else {
                    etatVide
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(.rect(cornerRadius: 20))
            if model.document != nil {
                BarreOutils(model: model)
                    .padding(.vertical, 10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(red: 0.043, green: 0.039, blue: 0.063))
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(RadialGradient(colors: [Theme.violet.opacity(0.10), .clear], center: .top, startRadius: 0, endRadius: 600))
                }
                .overlay { RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(0.07)) }
                .shadow(color: .black.opacity(0.4), radius: 20, y: 10)
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: model.document != nil)
    }

    @ViewBuilder
    private var etatVide: some View {
        VStack(spacing: 10) {
            if model.chargement {
                ProgressView()
                Text("Ouverture de l'étiquette…").foregroundStyle(Theme.text2)
            } else if let erreur = model.erreurFichier {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 26)).foregroundStyle(Theme.warn)
                Text(erreur).foregroundStyle(Theme.warn).multilineTextAlignment(.center).frame(maxWidth: 420)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(LinearGradient(colors: [Theme.violet.opacity(0.24), Theme.violet.opacity(0.06)], startPoint: .top, endPoint: .bottom))
                        .overlay { RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.violetLight.opacity(0.25)) }
                        .shadow(color: Theme.violet.opacity(0.6), radius: 24, y: 10)
                    Image(systemName: "barcode.viewfinder").font(.system(size: 32, weight: .semibold)).foregroundStyle(Theme.violetPale)
                }
                .frame(width: 76, height: 76)
                .phaseAnimator([0.0, 1.0]) { vue, phase in vue.offset(y: phase * -6) } animation: { _ in .easeInOut(duration: 2) }
                Text("Choisis une étiquette").font(.title3.weight(.bold))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// La lecture des codes : une ligne de balayage violette.
private struct Balayage: View {
    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation) { contexte in
                let t = contexte.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                LinearGradient(colors: [.clear, Theme.violet.opacity(0.16), Theme.violetLight.opacity(0.7), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: geo.size.height * 0.22)
                    .offset(y: (geo.size.height * 1.22) * t - geo.size.height * 0.22)
            }
        }
        .allowsHitTesting(false)
        .overlay(alignment: .bottom) {
            Label("Lecture des codes-barres et QR codes…", systemImage: "barcode.viewfinder")
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 8)
                .glassEffect(.regular, in: .capsule)
                .padding(.bottom, 16)
        }
    }
}

/// L'infobulle d'un code : son format, son role, sa valeur.
private struct BulleCode: View {
    let bulle: BordereauxModel.Bulle

    var body: some View {
        GeometryReader { geo in
            let largeur: CGFloat = min(360, geo.size.width - 16)
            let hauteurEstimee: CGFloat = 70
            let dessus = bulle.cadre.minY - hauteurEstimee - 10 > 8
            let x = min(max(bulle.cadre.midX - largeur / 2, 8), geo.size.width - largeur - 8)
            let y = dessus ? bulle.cadre.minY - hauteurEstimee - 10 : min(bulle.cadre.maxY + 10, geo.size.height - hauteurEstimee - 8)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    PuceFormat(code: bulle.code)
                    PuceRole(role: bulle.code.role)
                }
                if bulle.code.lisible {
                    Text(Visible.valeur(bulle.code.valeur ?? "", limite: 220))
                        .font(.system(size: 13.5, weight: .semibold, design: .monospaced))
                        .lineLimit(4)
                } else {
                    Text(bulle.code.erreur ?? "illisible").font(.callout.weight(.semibold)).foregroundStyle(Theme.warn)
                }
            }
            .padding(10)
            .frame(width: largeur, height: hauteurEstimee, alignment: .topLeading)
            // du verre, assez sombre pour rester lisible sur l'etiquette blanche
            .background(Color(red: 0.07, green: 0.06, blue: 0.10).opacity(0.86), in: .rect(cornerRadius: 14))
            .glassEffect(.regular.tint(Theme.violet.opacity(0.08)), in: .rect(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.12)) }
            .shadow(color: .black.opacity(0.5), radius: 16, y: 8)
            .offset(x: x, y: y)
            .transition(.opacity)
        }
        .allowsHitTesting(false)
    }
}

private struct BarreOutils: View {
    @Bindable var model: BordereauxModel

    var body: some View {
        HStack(spacing: 4) {
            if let n = model.document?.nombrePages, n > 1 {
                outil("chevron.left", aide: "Page précédente", desactive: model.page <= 1) { model.allerPage(model.page - 1) }
                Text("\(model.page) / \(n)").font(.system(size: 13, weight: .semibold).monospacedDigit()).frame(minWidth: 56)
                outil("chevron.right", aide: "Page suivante", desactive: model.page >= n) { model.allerPage(model.page + 1) }
                separateur
            }
            outil("minus", aide: "Dézoomer (⌘-)", desactive: false) { model.envoie(.zoomMoins) }
                .keyboardShortcut("-", modifiers: .command)
            Button { model.envoie(.taille100) } label: {
                Text("\(Int((model.zoom * 100).rounded())) %").font(.system(size: 13, weight: .semibold).monospacedDigit()).frame(minWidth: 58, minHeight: 32)
            }
            .buttonStyle(.plain)
            .help("Taille réelle")
            outil("plus", aide: "Zoomer (⌘+)", desactive: false) { model.envoie(.zoomPlus) }
                .keyboardShortcut("=", modifiers: .command)
            separateur
            bascule("Largeur", actif: model.ajustement == .largeur, aide: "Ajuster à la largeur (⌘0)") {
                model.ajustement = .largeur
                model.envoie(.largeur)
            }
            .keyboardShortcut("0", modifiers: [.command, .option])
            bascule("Page", actif: model.ajustement == .page, aide: "Page entière") {
                model.ajustement = .page
                model.envoie(.pageEntiere)
            }
            separateur
            bascule("Zones", actif: model.zonesToutes, aide: "Montrer toutes les zones", symbole: "barcode") { model.zonesToutes.toggle() }
        }
        .padding(5)
        .glassEffect(.regular.tint(.black.opacity(0.3)), in: .capsule)
    }

    private var separateur: some View {
        Rectangle().fill(.white.opacity(0.1)).frame(width: 1, height: 20).padding(.horizontal, 4)
    }

    private func outil(_ symbole: String, aide: String, desactive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbole).font(.system(size: 13, weight: .semibold)).frame(width: 32, height: 32).contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(desactive ? Theme.text3 : Theme.text)
        .disabled(desactive)
        .help(aide)
    }

    private func bascule(_ titre: String, actif: Bool, aide: String, symbole: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let symbole { Image(systemName: symbole) }
                Text(titre)
            }
            .font(.system(size: 12.5, weight: .semibold))
            .padding(.horizontal, 11)
            .frame(height: 30)
            .background { Capsule().fill(actif ? Theme.violet.opacity(0.32) : .clear) }
            .overlay { Capsule().strokeBorder(actif ? Theme.violetBright.opacity(0.45) : .clear) }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(actif ? Theme.text : Theme.text2)
        .help(aide)
    }
}

// MARK: - Le panneau de droite

private struct PanneauEtiquette: View {
    @Bindable var model: BordereauxModel
    @State private var note = ""
    @State private var noteDe: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let r = model.resume {
                    tete(r)
                    infos(r)
                    suivi(r)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
                codes
                categorie
                if let n = model.detail?.note, !n.isEmpty {
                    bloc("Note du colis") { Text(n).font(.callout).foregroundStyle(Theme.text2) }
                }
                annotation
                actions
            }
            .padding(16)
        }
        .scrollIndicators(.never)
        .background(Surface())
        .onChange(of: model.detail?.annotation?.texte, initial: true) { synchroniseNote() }
        .onChange(of: model.ouverteId) { synchroniseNote() }
    }

    private func synchroniseNote() {
        if noteDe != model.ouverteId || note == (model.detail?.annotation?.texte ?? "") {
            note = model.detail?.annotation?.texte ?? ""
            noteDe = model.ouverteId
        }
    }

    private func tete(_ r: BordereauResume) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let couleur = Theme.carrier(r.transporteur?.code ?? "")
            HStack(spacing: 6) {
                Circle().fill(couleur).frame(width: 7, height: 7).shadow(color: couleur, radius: 4)
                Text(r.transporteur?.nom ?? "Transporteur inconnu")
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(couleur)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(couleur.opacity(0.13), in: .capsule)
            Text(r.expediteur ?? "—").font(.system(size: 22, weight: .bold, design: .rounded))
            Label(r.fichier ?? "Colis #\(r.id)", systemImage: "doc")
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private func infos(_ r: BordereauResume) -> some View {
        let lignes: [(String, String)] = [
            ("Reçue", DateBordereau.courte(r.recuLe)),
            ("Étape", DateBordereau.etape(r.etape) ?? "—"),
            r.imprimeLe.map { ("Imprimée", DateBordereau.courte($0)) },
            r.deposeLe.map { ("Déposée", DateBordereau.courte($0)) },
            model.detail?.analyse.nombrePages.map { ("Pages", "\($0)") },
        ].compactMap { $0 }
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], alignment: .leading, spacing: 8) {
            ForEach(lignes, id: \.0) { k, v in
                VStack(alignment: .leading, spacing: 4) {
                    Text(k.uppercased()).font(.system(size: 9.5, weight: .semibold)).tracking(0.8).foregroundStyle(Theme.text3)
                    Text(v).font(.system(size: 12.5).monospacedDigit()).lineLimit(1)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.03), in: .rect(cornerRadius: 11))
                .overlay { RoundedRectangle(cornerRadius: 11).strokeBorder(.white.opacity(0.06)) }
            }
        }
    }

    @ViewBuilder
    private func suivi(_ r: BordereauResume) -> some View {
        let probable = r.suivi == nil ? model.codes.first { $0.role == "suivi-probable" }?.suivi : nil
        if let s = r.suivi ?? probable {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.suivi == nil ? "Numéro probable · lu sur l'étiquette" : "Numéro de suivi · \(s.nom)")
                            .font(.caption).foregroundStyle(Theme.text3)
                        Text(s.numero).font(.system(size: 17, weight: .bold, design: .monospaced)).textSelection(.enabled)
                    }
                    Spacer()
                    Button {
                        Presse.copie(s.numero)
                        model.toasts.show("Numéro copié")
                    } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.text2)
                        .help("Copier le numéro")
                }
                .padding(12)
                .background(LinearGradient(colors: [Theme.violet.opacity(0.16), Theme.violet.opacity(0.04)], startPoint: .top, endPoint: .bottom), in: .rect(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.violetLight.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: r.suivi == nil ? [4, 3] : [])) }
                if let url = s.url {
                    Link(destination: url) {
                        Label("Ouvrir le suivi du colis", systemImage: "arrow.up.right.square").frame(maxWidth: .infinity)
                    }
                    .boutonVerreFort()
                }
            }
        } else {
            Text("Pas de numéro de suivi").font(.callout).foregroundStyle(Theme.text2)
        }
    }

    @ViewBuilder
    private var codes: some View {
        let a = model.detail?.analyse
        let total = a?.etat == "analyse" ? (a?.lisibles ?? 0) + (a?.illisibles ?? 0) : nil
        bloc("Codes détectés", compte: total) {
            if model.lectureEnCours {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Lecture des codes-barres et QR codes…")
                }
                .font(.callout).foregroundStyle(Theme.text2)
            } else if a == nil || a?.etat == "attente" {
                Text("Pas encore lue.").font(.callout).foregroundStyle(Theme.text3)
            } else if a?.etat == "erreur" || a?.etat == "echec" {
                Label(a?.erreur ?? "Lecture impossible", systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Theme.warn)
            } else if model.codes.isEmpty {
                Text("Aucun code-barre ni QR code trouvé.").font(.callout).foregroundStyle(Theme.text3)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(model.codes.enumerated()), id: \.element.id) { i, code in
                        LigneCode(code: code, choisi: model.selection == code.id, plusieursPages: (a?.nombrePages ?? 1) > 1) {
                            model.choisit(code.id, montre: true)
                        } copie: {
                            Presse.copie(code.valeur ?? "")
                            model.toasts.show("Valeur copiée")
                        }
                        .transition(.opacity.combined(with: .offset(y: 6)))
                        .animation(.spring(response: 0.45, dampingFraction: 0.85).delay(Double(i) * 0.04), value: model.revelation)
                    }
                }
                if a?.partiel == true {
                    Text("Seules les premières pages ont été lues.").font(.caption).foregroundStyle(Theme.text3)
                }
            }
        }
    }

    @State private var nouvelleCategorie = ""
    @State private var demandeNouvelle = false

    /// Classer l'etiquette : un classement a part, rien n'est ecrit dedans.
    private var categorie: some View {
        bloc("Catégorie") {
            HStack(spacing: 8) {
                Menu {
                    Button("Sans catégorie") { Task { await model.classe(nil) } }
                    if !model.categories.isEmpty { Divider() }
                    ForEach(model.categories) { c in
                        Button(c.nom) { Task { await model.classe(c.id) } }
                    }
                    Divider()
                    Button("Nouvelle catégorie…") { demandeNouvelle = true }
                } label: {
                    if let c = model.detail?.categorie { PuceCategorie(categorie: c) } else { Text("Sans catégorie").foregroundStyle(Theme.text2) }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Spacer()
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background(.black.opacity(0.25), in: .rect(cornerRadius: 11))
            .overlay { RoundedRectangle(cornerRadius: 11).strokeBorder(.white.opacity(0.09)) }
        }
        .alert("Nouvelle catégorie", isPresented: $demandeNouvelle) {
            TextField("Nom (ex. Retours)", text: $nouvelleCategorie)
            Button("Créer et classer") {
                let nom = nouvelleCategorie
                nouvelleCategorie = ""
                Task { await model.classe(nil, nouvelle: nom) }
            }
            Button("Annuler", role: .cancel) { nouvelleCategorie = "" }
        }
    }

    private var annotation: some View {
        bloc("Note") {
            TextEditor(text: $note)
                .font(.callout)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 56)
                .padding(6)
                .background(.black.opacity(0.25), in: .rect(cornerRadius: 11))
                .overlay { RoundedRectangle(cornerRadius: 11).strokeBorder(.white.opacity(0.09)) }
            if note.trimmingCharacters(in: .whitespacesAndNewlines) != (model.detail?.annotation?.texte ?? "") {
                Button {
                    Task { _ = await model.annote(note) }
                } label: { Label("Enregistrer la note", systemImage: "checkmark") }
                    .boutonVerre()
                    .transition(.opacity)
            }
        }
    }

    /// L'editeur et le comparateur : les pages du site, dans une fenetre de l'app
    private func ouvreSurLeSite(_ chemin: String, _ requete: [URLQueryItem]) {
        var c = URLComponents()
        c.path = chemin
        c.queryItems = requete
        PagesSite.ouvre(c.string ?? chemin)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let id = model.ouverteId {
                Button {
                    ouvreSurLeSite("/bordereaux/editeur", [URLQueryItem(name: "colis", value: String(id))])
                } label: { Label("Modifier dans l'éditeur", systemImage: "square.and.pencil") }
                    .boutonVerreFort()
                    .help("L'éditeur, dans une fenêtre de l'app : un document de travail par-dessus l'étiquette, jamais l'étiquette elle-même")
                Button {
                    ouvreSurLeSite("/bordereaux/comparer", [URLQueryItem(name: "a", value: String(id))])
                } label: { Label("Comparer", systemImage: "rectangle.split.2x1") }
                    .boutonVerre()
                    .help("Le comparateur, dans une fenêtre de l'app")
            }
            Button {
                Task { await model.lis(force: true) }
            } label: { Label("Relire les codes", systemImage: "arrow.clockwise") }
                .boutonVerre()
                .disabled(model.lectureEnCours)
            Button {
                enregistreOriginal()
            } label: { Label("Fichier d'origine", systemImage: "square.and.arrow.down") }
                .boutonVerre()
                .disabled(model.octets == nil)
        }
    }

    /// Une COPIE du fichier d'origine, la ou l'on veut (rien n'est modifie).
    private func enregistreOriginal() {
        guard let data = model.octets else { return }
        let panneau = NSSavePanel()
        let pdf = data.starts(with: Data("%PDF".utf8))
        panneau.nameFieldStringValue = model.resume?.fichier ?? (pdf ? "etiquette.pdf" : "etiquette")
        if pdf { panneau.allowedContentTypes = [.pdf] }
        panneau.begin { reponse in
            guard reponse == .OK, let url = panneau.url else { return }
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                Task { @MainActor in model.toasts.show(error.localizedDescription, style: .error) }
            }
        }
    }

    private func bloc<Contenu: View>(_ titre: String, compte: Int? = nil, detail: String? = nil, @ViewBuilder contenu: () -> Contenu) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(titre.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.9).foregroundStyle(Theme.text3)
                if let compte {
                    Text("\(compte)").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.violetPale)
                        .padding(.horizontal, 6).padding(.vertical, 1).background(Theme.violet.opacity(0.2), in: .capsule)
                }
                if let detail { Text(detail).font(.system(size: 10.5)).foregroundStyle(Theme.text3) }
            }
            contenu()
        }
    }
}

private struct LigneCode: View {
    let code: BordereauCode
    let choisi: Bool
    let plusieursPages: Bool
    let choisir: () -> Void
    let copie: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            Button(action: choisir) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 5) {
                        PuceFormat(code: code)
                        PuceRole(role: code.role)
                        if plusieursPages { Text("p. \(code.page)").font(.system(size: 10.5)).foregroundStyle(Theme.text3) }
                    }
                    if code.lisible {
                        Text(Visible.valeur(code.valeur ?? "", limite: 240))
                            .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                            .lineLimit(3)
                    } else {
                        Text(code.erreur ?? "illisible").font(.callout).foregroundStyle(Theme.warn)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            VStack(spacing: 4) {
                if code.lisible {
                    Button(action: copie) { Image(systemName: "doc.on.doc") }.buttonStyle(.plain).help("Copier la valeur")
                }
                if let lien = code.role == "lien" ? code.lien : (code.role == "suivi-probable" ? code.suivi?.lien ?? code.suivi?.page : nil),
                   lien.lowercased().hasPrefix("http"), let url = URL(string: lien) {
                    Link(destination: url) { Image(systemName: "arrow.up.right.square") }.help(code.role == "lien" ? "Ouvrir le lien" : "Ouvrir le suivi")
                }
            }
            .foregroundStyle(Theme.text2)
        }
        .padding(10)
        .background(choisi ? Theme.violet.opacity(0.14) : .white.opacity(0.025), in: .rect(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(choisi ? Theme.violetLight.opacity(0.5) : .white.opacity(0.07), style: StrokeStyle(lineWidth: 1, dash: code.lisible ? [] : [4, 3]))
        }
        .animation(.easeOut(duration: 0.2), value: choisi)
    }
}

// MARK: - Petits morceaux

private struct PuceFormat: View {
    let code: BordereauCode
    var body: some View {
        HStack(spacing: 4) {
            Text(code.nomFormat)
            Text(code.famille).font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.text3)
        }
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(Theme.text2)
        .padding(.horizontal, 6).padding(.vertical, 2.5)
        .background(.white.opacity(0.06), in: .rect(cornerRadius: 6))
    }
}

private struct PuceRole: View {
    let role: String
    private static let noms = [
        "suivi": "Numéro de suivi", "suivi-probable": "Numéro de suivi probable", "contient-suivi": "Contient le numéro",
        "lien": "Lien", "donnees": "Données structurées", "autre": "Autre code", "illisible": "Illisible",
    ]
    var body: some View {
        let couleur: Color = switch role {
        case "suivi", "suivi-probable", "contient-suivi": Theme.violetPale
        case "lien": Theme.info
        case "donnees": Theme.teal
        case "illisible": Theme.warn
        default: Theme.text2
        }
        Text(Self.noms[role] ?? "Code")
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(couleur)
            .padding(.horizontal, 6).padding(.vertical, 2.5)
            .background((role == "autre" ? Color.white : couleur).opacity(role == "suivi" ? 0.22 : 0.12), in: .rect(cornerRadius: 6))
    }
}

private struct Surface: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(Theme.surface.opacity(0.82))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(LinearGradient(colors: [.white.opacity(0.11), .white.opacity(0.03)], startPoint: .top, endPoint: .bottom), lineWidth: 0.7)
            }
            .shadow(color: .black.opacity(0.35), radius: 18, y: 10)
    }
}

/// Les separateurs invisibles des codes 2D (GS, RS, EOT) rendus visibles.
enum Visible {
    static func valeur(_ v: String, limite: Int) -> String {
        let remplacements: [Character: String] = ["\u{1D}": "␝", "\u{1E}": "␞", "\u{04}": "␄", "\n": "↵", "\r": "", "\t": "⇥"]
        var sortie = ""
        for c in v.prefix(limite) {
            if let r = remplacements[c] { sortie += r } else if let a = c.asciiValue, a < 32 { sortie += "·" } else { sortie.append(c) }
        }
        return v.count > limite ? sortie + "…" : sortie
    }
}

enum Presse {
    @MainActor static func copie(_ texte: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(texte, forType: .string)
    }
}

/// Dates du serveur (« 2026-11-17 14:32:05 », UTC) et petits textes.
enum DateBordereau {
    private static let lecture: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    private static let affichage: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "fr_FR")
        f.dateFormat = "d MMM · HH:mm"
        return f
    }()

    static func courte(_ s: String?) -> String {
        guard let s, let d = lecture.date(from: s) else { return "" }
        return affichage.string(from: d)
    }

    static func etape(_ e: String?) -> String? {
        switch e {
        case "a_imprimer": "À imprimer"
        case "imprime": "Imprimée"
        case "depose": "Déposée"
        default: nil
        }
    }

    /// La partie trouvee, en violet.
    static func surligne(_ norme: String, debut: Int?, fin: Int?) -> AttributedString {
        var texte = AttributedString(norme)
        texte.foregroundColor = Theme.text2
        guard let debut, let fin, fin > debut, fin <= norme.count else { return texte }
        let a = texte.index(texte.startIndex, offsetByCharacters: debut)
        let b = texte.index(texte.startIndex, offsetByCharacters: fin)
        texte[a..<b].foregroundColor = .white
        texte[a..<b].backgroundColor = Theme.violet.opacity(0.4)
        return texte
    }
}
#endif
