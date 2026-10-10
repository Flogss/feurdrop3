import SwiftUI
import DropKit

/// L'historique, sur sa propre page (bouton « Historique » du dashboard) :
/// ce qui est arrive aux colis (recus, dropes, imprimes, retires, modifies...),
/// du plus recent au plus ancien, groupe par jour. L'icone et sa couleur
/// disent la nature ; a droite, le montant, l'heure et d'ou vient l'action
/// (Telegram, site, app).
struct HistoriqueView: View {
    var body: some View {
        ScrollView {
            HistoriqueCard(avecTitre: false)
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle("Historique")
        .refreshable { await AppModel.shared.journal.refresh() }
    }
}

struct HistoriqueCard: View {
    /// sur sa page, le titre est celui de la page
    var avecTitre = true
    @Environment(AppModel.self) private var app

    private var model: JournalModel { app.journal }

    var body: some View {
        @Bindable var model = app.journal
        VStack(alignment: .leading, spacing: 12) {
            if avecTitre { SectionHeader("Historique") }
            filtres($model.filtre)

            if !model.loaded {
                VStack(spacing: 8) {
                    SkeletonRow(height: 48)
                    SkeletonRow(height: 48)
                    SkeletonRow(height: 48)
                }
            } else if model.entrees.isEmpty {
                Text("Rien pour l'instant.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            } else {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(jours, id: \.cle) { jour in
                        Text(jour.titre.uppercased())
                            .font(.caption2.weight(.semibold).monospaced())
                            .tracking(0.8)
                            .foregroundStyle(Theme.text3)
                            .padding(.top, jour.cle == jours.first?.cle ? 0 : 12)
                            .padding(.bottom, 4)
                        ForEach(jour.entrees) { e in
                            LigneJournal(entree: e)
                                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(x: -14)), removal: .opacity))
                        }
                    }
                }
                .animation(Theme.spring, value: model.entrees)

                if model.suite {
                    Button {
                        Task { await model.chargeLaSuite() }
                    } label: {
                        Group {
                            if model.chargeSuite { ProgressView().controlSize(.small) } else { Text("Voir plus") }
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .frame(height: 36)
                    }
                    .boutonVerre()
                    .padding(.top, 4)
                }
            }
        }
        .surfaceCard()
        .task { if !model.loaded { await model.refresh() } }
    }

    /// les filtres, en pastilles qu'on fait defiler si l'ecran est etroit
    private func filtres(_ filtre: Binding<FiltreJournal>) -> some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(FiltreJournal.allCases) { f in
                    let actif = filtre.wrappedValue == f
                    Button {
                        Haptics.selection()
                        withAnimation(Theme.spring) { filtre.wrappedValue = f }
                    } label: {
                        Text(f.label)
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
        // les pastilles restent dans la carte : celles qui depassent
        // s'estompent a droite (on voit qu'on peut faire defiler)
        .mask {
            HStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 26)
            }
        }
        .padding(.vertical, -8)
    }

    private struct Jour {
        let cle: String
        let titre: String
        var entrees: [EntreeJournal]
    }

    /// les entrees regroupees par jour (heure locale)
    private var jours: [Jour] {
        var resultat: [Jour] = []
        let calendrier = Calendar.current
        for e in model.entrees {
            let date = ServerDate.parse(e.at) ?? .now
            let composants = calendrier.dateComponents([.year, .month, .day], from: date)
            let cle = "\(composants.year ?? 0)-\(composants.month ?? 0)-\(composants.day ?? 0)"
            if resultat.last?.cle == cle {
                resultat[resultat.count - 1].entrees.append(e)
            } else {
                resultat.append(Jour(cle: cle, titre: Self.titreJour(date), entrees: [e]))
            }
        }
        return resultat
    }

    private static func titreJour(_ date: Date) -> String {
        let calendrier = Calendar.current
        if calendrier.isDateInToday(date) { return "Aujourd'hui" }
        if calendrier.isDateInYesterday(date) { return "Hier" }
        return date.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "fr_FR")))
    }
}

/// Une ligne de l'historique.
private struct LigneJournal: View {
    let entree: EntreeJournal

    var body: some View {
        let (symbole, couleur) = apparence
        HStack(spacing: 12) {
            Image(systemName: symbole)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(couleur)
                .frame(width: 34, height: 34)
                .background(couleur.opacity(0.14), in: .rect(cornerRadius: 11, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(couleur.opacity(0.25), lineWidth: 0.8))
                .shadow(color: couleur.opacity(0.35), radius: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(entree.texte)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let detail = entree.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 3) {
                if let valeur = entree.valeur, valeur != 0 {
                    Text(Format.euro(valeur))
                        .font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(entree.kind == "drop" && !annule ? Theme.teal : Theme.text2)
                }
                Text(meta)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .combine)
    }

    private var annule: Bool { entree.kind == "drop" && entree.texte.hasPrefix("Drop annulé") }

    private var meta: String {
        let sources = ["telegram": "Telegram", "site": "Site", "app": "App", "imprimante": "Impression auto"]
        let heure = ServerDate.time(entree.at)
        guard let source = entree.source else { return heure }
        return "\(heure) · \(sources[source] ?? source)"
    }

    private var apparence: (String, Color) {
        if annule { return ("arrow.uturn.backward", Theme.warn) }
        switch entree.kind {
        case "recu": return ("arrow.down.to.line", Theme.violetBright)
        case "ajout": return ("plus", Theme.violetBright)
        case "drop": return ("paperplane.fill", Theme.teal)
        case "impression": return ("printer.fill", Theme.info)
        case "retrait": return ("trash", Theme.danger)
        case "modif": return ("pencil", Theme.warn)
        case "note": return ("note.text", Theme.warn)
        case "tournee": return ("box.truck.fill", Theme.violetLight)
        case "paiement": return ("eurosign.circle.fill", Color(red: 120 / 255, green: 220 / 255, blue: 150 / 255))
        case "stock": return ("shippingbox", Color(white: 0.75))
        case "expediteur": return ("person.crop.circle", Color(white: 0.75))
        case "reglage": return ("gearshape", Color(white: 0.75))
        case "fusion": return ("square.on.square", Color(white: 0.75))
        default: return ("circle", Color(white: 0.75))
        }
    }
}
