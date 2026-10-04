import SwiftUI
import DropKit

/// L'onglet Imprime : les etiquettes a sortir, et celles deja sorties qui
/// attendent d'etre postees. Une liste native : on balaie une ligne pour
/// imprimer, dropper ou retirer ; on la touche pour la corriger.
struct PrintView: View {
    @Environment(AppModel.self) private var app
    @State private var edition: Parcel?
    @State private var aRetirer: Parcel?

    private var model: PrintModel { app.printing }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        PageHeader("Imprimé")
                        PrintHeader()
                    }
                    .tabArrival(.printing)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }

                if let notice = model.notice {
                    Section {
                        Label {
                            Text(notice).font(.subheadline)
                        } icon: {
                            Image(systemName: "bolt.fill").foregroundStyle(Theme.violetLight)
                        }
                        .onTapGesture { model.dismissNotice() }
                        .tabArrival(.printing)
                    }
                    .listRowBackground(Theme.violet.opacity(0.18))
                }

                if let erreur = model.loadError, model.pending == nil {
                    Section {
                        EmptyStateView(symbol: "exclamationmark.triangle", title: "Liste indisponible", subtitle: erreur)
                            .tabArrival(.printing)
                    }
                    .listRowBackground(Color.clear)
                } else if model.pending == nil {
                    Section {
                        ForEach(0..<3, id: \.self) { _ in SkeletonRow(height: 44).tabArrival(.printing) }
                    }
                    .listRowBackground(Color.clear)
                } else {
                    categories(model.pending, scope: .new, titre: "À imprimer")
                    categories(model.printed, scope: .printed, titre: "Déjà imprimées")
                }
            }
            .listeGroupee(espacement: 18)
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 0, for: .scrollContent)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .navigationTitle("Imprimé")
            .barreDeNavigationMasquee()
            .refreshable { await model.refresh() }
            .fondVivant()
            .sheet(item: $edition) { colis in
                ParcelEditSheet(parcel: colis)
            }
            .confirmationDialog("Retirer ce colis ?", isPresented: Binding(get: { aRetirer != nil }, set: { if !$0 { aRetirer = nil } }), titleVisibility: .visible, presenting: aRetirer) { colis in
                Button("Retirer", role: .destructive) { Task { await model.delete(colis) } }
                Button("Annuler", role: .cancel) {}
            } message: { _ in
                Text("Son fichier sera aussi effacé sur Telegram.")
            }
            .sensoryFeedback(.success, trigger: model.celebration)
        }
    }

    @ViewBuilder
    private func categories(_ resume: PrintSummary?, scope: PrintScope, titre: String) -> some View {
        Section {
            let liste = resume?.categories ?? []
            if liste.isEmpty {
                if scope == .new {
                    EmptyStateView(symbol: "checkmark", title: "Tout est imprimé", subtitle: "Les nouvelles étiquettes apparaîtront ici.", positive: true)
                        .tabArrival(.printing)
                } else {
                    EmptyStateView(symbol: "printer", title: "Aucune étiquette imprimée en attente")
                        .tabArrival(.printing)
                }
            } else {
                ForEach(liste) { cat in
                    CategoryGroup(category: cat, scope: scope, onEdit: { edition = $0 }, onDelete: { aRetirer = $0 })
                }
            }
        } header: {
            HStack {
                Text(titre)
                Spacer()
                if scope == .printed, let total = resume?.total {
                    Text(total > 0 ? Format.count(total, "étiquette", "étiquettes") : "Aucune")
                        .textCase(nil)
                }
            }
            .tabArrival(.printing)
        }
        .listRowBackground(Theme.surface.opacity(0.78))
    }
}

/// Le haut de l'onglet : combien d'etiquettes, et le grand bouton.
private struct PrintHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.printing
        let n = model.thermalCount
        VStack(alignment: .leading, spacing: 14) {
            Text(sousTitre)
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .contentTransition(.numericText())

            Button {
                Task { await model.print(.allNew, key: "*") }
            } label: {
                HStack(spacing: 10) {
                    if model.building.contains("*") {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "printer.fill")
                            .symbolEffect(.bounce, value: model.celebration)
                    }
                    Text(model.building.contains("*") ? "Préparation du PDF…" : "Tout imprimer")
                    if n > 0, !model.building.contains("*") {
                        Text(Format.integer(n))
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(.white.opacity(0.22), in: .capsule)
                            .contentTransition(.numericText(value: Double(n)))
                    }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .buttonStyle(.glassProminent)
            .tint(Theme.violetDeep)
            .disabled(n == 0 || model.building.contains("*"))
            .overlay { SparkBurst(trigger: model.celebration, count: 12).allowsHitTesting(false) }

            if let pdf = model.lastPDF {
                HStack(spacing: 10) {
                    Image(systemName: "doc.richtext.fill")
                        .foregroundStyle(Theme.violetLight)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Dernier PDF").font(.subheadline.weight(.semibold))
                        Text(pdf.detail).font(.caption).foregroundStyle(Theme.text3)
                    }
                    Spacer()
                    Button("Réimprimer", systemImage: "printer") { model.reprint() }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.glass)
                    ShareLink(item: pdf.file) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .buttonStyle(.glass)
                }
                .padding(12)
                .glassEffect(.regular.tint(Theme.violet.opacity(0.15)), in: .rect(cornerRadius: 18))
                .transition(.scale(scale: 0.9, anchor: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
        .animation(Theme.spring, value: model.lastPDF)
    }

    private var sousTitre: String {
        guard let p = app.printing.pending else { return "Chargement…" }
        guard p.total > 0 else { return "Rien en attente" }
        var texte = "\(Format.count(p.total, "étiquette", "étiquettes")) à imprimer"
        if p.noted > 0 { texte += " · \(Format.count(p.noted, "annotée", "annotées"))" }
        return texte
    }
}

/// Une categorie (transporteur) : on la deplie pour voir ses colis, charges
/// a la demande.
private struct CategoryGroup: View {
    let category: PrintCategory
    let scope: PrintScope
    let onEdit: (Parcel) -> Void
    let onDelete: (Parcel) -> Void
    @Environment(AppModel.self) private var app

    private var cle: String { PrintModel.key(category.code, scope) }

    var body: some View {
        let model = app.printing
        let ouvert = Binding(
            get: { model.expanded.contains(cle) },
            set: { _ in
                Haptics.selection()
                model.toggle(category.code, scope)
            }
        )
        DisclosureGroup(isExpanded: ouvert) {
            if model.loadingCategories.contains(cle) {
                SkeletonRow(height: 40)
            } else if let colis = model.parcels[cle], !colis.isEmpty {
                ForEach(colis) { c in
                    ParcelRow(parcel: c, scope: scope)
                        .tabArrival(.printing)
                        .contentShape(.rect)
                        .onTapGesture { onEdit(c) }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button("Imprimer", systemImage: "printer.fill") {
                                Task { await model.print(.parcels([c.id], scope: scope), key: "id:\(c.id)") }
                            }
                            .tint(Theme.violetDeep)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: scope == .printed) {
                            if scope == .printed {
                                Button("Drop", systemImage: "paperplane.fill") {
                                    Task { await model.drop(c, scope: scope) }
                                }
                                .tint(Theme.violet)
                            } else {
                                Button("Retirer", systemImage: "trash", role: .destructive) { onDelete(c) }
                                    .tint(Theme.danger)
                            }
                            Button("Modifier", systemImage: "pencil") { onEdit(c) }
                                .tint(Color(white: 0.35))
                        }
                        .contextMenu {
                            Button("Modifier", systemImage: "pencil") { onEdit(c) }
                            Button("Imprimer", systemImage: "printer") {
                                Task { await model.print(.parcels([c.id], scope: scope), key: "id:\(c.id)") }
                            }
                            if scope == .printed {
                                Button("Drop", systemImage: "paperplane") { Task { await model.drop(c, scope: scope) } }
                            } else {
                                Button("Retirer", systemImage: "trash", role: .destructive) { onDelete(c) }
                            }
                        }
                }
            } else {
                Text("Vide").font(.footnote).foregroundStyle(Theme.text3)
            }
        } label: {
            HStack(spacing: 12) {
                CarrierDot(color: .carrier(category.code), size: 9)
                    .frame(width: 18)
                Text(category.label)
                    .font(.body.weight(.medium))
                if category.roll {
                    Text("210 mm")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.teal)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.teal.opacity(0.15), in: .capsule)
                }
                if category.noted > 0 {
                    Label("\(category.noted)", systemImage: "note.text")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.warn)
                }
                Spacer()
                Text(Format.integer(category.count))
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText(value: Double(category.count)))
                Button {
                    Task { await model.print(.category(category.code, scope: scope), key: cle) }
                } label: {
                    Group {
                        if model.building.contains(cle) {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "printer.fill")
                                .foregroundStyle(Theme.violetLight)
                        }
                    }
                    .frame(width: 32, height: 32)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .disabled(model.building.contains(cle))
                .accessibilityLabel("Imprimer \(category.label)")
            }
            .tabArrival(.printing)
        }
        .tint(Theme.text3)
    }
}

/// Un colis : son fichier, son expediteur, son prix, sa note.
private struct ParcelRow: View {
    let parcel: Parcel
    let scope: PrintScope

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let special = parcel.special {
                    HStack(spacing: 2) {
                        Text("#\(special.numero)")
                        Image(systemName: "key.fill").font(.system(size: 9))
                        if !special.code { Text("?") }
                    }
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(special.code ? Theme.special : Theme.danger)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background((special.code ? Theme.special : Theme.danger).opacity(0.15), in: .capsule)
                }
                Text(parcel.displayName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Text([parcel.sender, Format.euro(parcel.price), parcel.kind == "image" ? "photo" : nil].compactMap { $0 }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(Theme.text3)
            if let note = parcel.note, !note.isEmpty {
                Label(note, systemImage: "note.text")
                    .font(.caption)
                    .foregroundStyle(Theme.warn)
            }
        }
        .padding(.vertical, 3)
    }
}
