#if os(macOS)
import SwiftUI
import AppKit
import DropKit

/// L'onglet Imprime sur Mac, dans l'esprit du site : des cartes de categorie
/// qui se deplient d'un ressort, et pour chaque colis des actions qui
/// apparaissent au survol (et au clic droit). La liste de l'iPhone, faite pour
/// le doigt et les balayages, garde sa forme la-bas.
struct PrintViewMac: View {
    @Environment(AppModel.self) private var app
    @State private var edition: Parcel?
    @State private var aRetirer: Parcel?

    private var model: PrintModel { app.printing }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .bottom, spacing: 16) {
                    PageHeader("Imprimé")
                    Spacer()
                    toutImprimer
                }
                Text(sousTitre)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText())
                    .padding(.horizontal, 4)
                    .padding(.top, -8)

                if let notice = model.notice {
                    bandeau(symbole: "bolt.fill", texte: notice) { model.dismissNotice() }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                if let pdf = model.lastPDF {
                    dernierPDF(pdf)
                        .transition(.scale(scale: 0.96, anchor: .top).combined(with: .opacity))
                }

                if let erreur = model.loadError, model.pending == nil {
                    EmptyStateView(symbol: "exclamationmark.triangle", title: "Liste indisponible", subtitle: erreur)
                } else if model.pending == nil {
                    ForEach(0..<4, id: \.self) { _ in SkeletonRow(height: 58) }
                } else {
                    section("À imprimer", resume: model.pending, scope: .new)
                    section("Déjà imprimées", resume: model.printed, scope: .printed)
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 32)
            .frame(maxWidth: 1000)
            .frame(maxWidth: .infinity)
            .animation(Theme.spring, value: model.notice)
            .animation(Theme.spring, value: model.lastPDF)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .sheet(item: $edition) { colis in
            ParcelEditSheet(parcel: colis)
                .frame(minWidth: 480, minHeight: 540)
        }
        .confirmationDialog("Retirer ce colis ?", isPresented: Binding(get: { aRetirer != nil }, set: { if !$0 { aRetirer = nil } }), titleVisibility: .visible, presenting: aRetirer) { colis in
            Button("Retirer", role: .destructive) { Task { await model.delete(colis) } }
            Button("Annuler", role: .cancel) {}
        } message: { _ in
            Text("Son fichier sera aussi effacé sur Telegram.")
        }
        .sensoryFeedback(.success, trigger: model.celebration)
    }

    // MARK: En-tete

    private var toutImprimer: some View {
        let n = model.thermalCount
        let occupe = model.building.contains("*")
        return Button {
            Task { await model.print(.allNew, key: "*") }
        } label: {
            HStack(spacing: 10) {
                if occupe {
                    ProgressView().controlSize(.small).tint(.white)
                } else {
                    Image(systemName: "printer.fill")
                        .symbolEffect(.bounce, value: model.celebration)
                }
                Text(occupe ? "Préparation du PDF…" : "Tout imprimer")
                if n > 0, !occupe {
                    Text(Format.integer(n))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(.white.opacity(0.22), in: .capsule)
                        .contentTransition(.numericText(value: Double(n)))
                }
            }
            .font(.headline)
            .frame(height: 44)
            .padding(.horizontal, 8)
        }
        .boutonVerreFort()
        .disabled(n == 0 || occupe)
        .overlay { SparkBurst(trigger: model.celebration, count: 12).allowsHitTesting(false) }
        .padding(.bottom, 6)
    }

    private var sousTitre: String {
        guard let p = model.pending else { return "Chargement…" }
        guard p.total > 0 else { return "Rien en attente" }
        var texte = "\(Format.count(p.total, "étiquette", "étiquettes")) à imprimer"
        if p.noted > 0 { texte += " · \(Format.count(p.noted, "annotée", "annotées"))" }
        return texte
    }

    private func bandeau(symbole: String, texte: String, ferme: @escaping () -> Void) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbole).foregroundStyle(Theme.violetLight)
            Text(texte).font(.subheadline)
            Spacer()
            Button("Fermer", systemImage: "xmark", action: ferme)
                .labelStyle(.iconOnly)
                .boutonVerre(.rond)
        }
        .padding(14)
        .glassEffect(.regular.tint(Theme.violet.opacity(0.22)), in: .rect(cornerRadius: 18))
    }

    private func dernierPDF(_ pdf: PrintModel.LastPDF) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "doc.richtext.fill")
                .font(.title3)
                .foregroundStyle(Theme.violetLight)
            VStack(alignment: .leading, spacing: 1) {
                Text("Dernier PDF").font(.subheadline.weight(.semibold))
                Text(pdf.detail).font(.caption).foregroundStyle(Theme.text3)
            }
            Spacer()
            Button("Ouvrir", systemImage: "eye") { NSWorkspace.shared.open(pdf.file) }
                .boutonVerre()
            Button("Réimprimer", systemImage: "printer") { model.reprint() }
                .boutonVerre()
            ShareLink(item: pdf.file) {
                Label("Partager", systemImage: "square.and.arrow.up")
            }
            .boutonVerre()
        }
        .padding(14)
        .glassEffect(.regular.tint(Theme.violet.opacity(0.15)), in: .rect(cornerRadius: 18))
    }

    // MARK: Sections

    @ViewBuilder
    private func section(_ titre: String, resume: PrintSummary?, scope: PrintScope) -> some View {
        let liste = resume?.categories ?? []
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(titre).font(.title3.weight(.semibold))
                Spacer()
                if let total = resume?.total {
                    Text(total > 0 ? Format.count(total, "étiquette", "étiquettes") : "Aucune")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                        .contentTransition(.numericText())
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 8)

            if liste.isEmpty {
                Group {
                    if scope == .new {
                        EmptyStateView(symbol: "checkmark", title: "Tout est imprimé", subtitle: "Les nouvelles étiquettes apparaîtront ici.", positive: true)
                    } else {
                        EmptyStateView(symbol: "printer", title: "Aucune étiquette imprimée en attente")
                    }
                }
                .surfaceCard()
            } else {
                ForEach(liste) { cat in
                    CategorieCarte(category: cat, scope: scope, onEdit: { edition = $0 }, onDelete: { aRetirer = $0 })
                        .transition(.asymmetric(insertion: .opacity.combined(with: .move(edge: .top)), removal: .opacity.combined(with: .scale(scale: 0.96))))
                }
            }
        }
        .animation(Theme.spring, value: liste)
    }
}

/// Une categorie : sa ligne (survolable, cliquable pour deplier), et ses
/// colis charges a la demande.
private struct CategorieCarte: View {
    let category: PrintCategory
    let scope: PrintScope
    let onEdit: (Parcel) -> Void
    let onDelete: (Parcel) -> Void
    @Environment(AppModel.self) private var app
    @State private var survol = false

    private var cle: String { PrintModel.key(category.code, scope) }

    var body: some View {
        let model = app.printing
        let ouverte = model.expanded.contains(cle)
        let couleur = Color.carrier(category.code)
        VStack(spacing: 0) {
            Button {
                Haptics.selection()
                model.toggle(category.code, scope)
            } label: {
                HStack(spacing: 14) {
                    CarrierDot(color: couleur, size: 10)
                        .frame(width: 20)
                    Text(category.label)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(category.noted > 0 ? Color(red: 1, green: 0.82, blue: 0.84) : Theme.text)
                    if category.roll {
                        Text("210 mm")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(Theme.teal)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Theme.teal.opacity(0.15), in: .capsule)
                    }
                    if category.noted > 0 {
                        Label("\(category.noted)", systemImage: "note.text")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.danger)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Theme.danger.opacity(0.14), in: .capsule)
                    }
                    Spacer()
                    Text(Format.integer(category.count))
                        .font(.system(size: 13, weight: .bold).monospacedDigit())
                        .foregroundStyle(couleur)
                        .frame(minWidth: 30, minHeight: 26)
                        .padding(.horizontal, 4)
                        .background(couleur.opacity(0.14), in: .capsule)
                        .contentTransition(.numericText(value: Double(category.count)))
                    Button {
                        Task { await model.print(.category(category.code, scope: scope), key: cle) }
                    } label: {
                        Group {
                            if model.building.contains(cle) {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "printer.fill").foregroundStyle(Theme.violetLight)
                            }
                        }
                        .frame(width: 34, height: 34)
                    }
                    .boutonVerre(.rond)
                    .disabled(model.building.contains(cle))
                    .help("Imprimer \(category.label)")
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(ouverte ? couleur : Theme.text3)
                        .rotationEffect(.degrees(ouverte ? 180 : 0))
                }
                .padding(.horizontal, 18)
                .frame(minHeight: 60)
                .background(survol ? Color.white.opacity(0.03) : .clear)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .onHover { dedans in withAnimation(.easeOut(duration: 0.15)) { survol = dedans } }

            if ouverte {
                VStack(spacing: 6) {
                    if model.loadingCategories.contains(cle) {
                        SkeletonRow(height: 52)
                    } else if let colis = model.parcels[cle], !colis.isEmpty {
                        ForEach(colis) { c in
                            LigneColis(parcel: c, scope: scope, onEdit: onEdit, onDelete: onDelete)
                                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(x: -14)), removal: .opacity.combined(with: .offset(x: 40))))
                        }
                    } else {
                        Text("Vide").font(.footnote).foregroundStyle(Theme.text3).padding(.vertical, 8)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(
                    LinearGradient(colors: [couleur.opacity(ouverte ? 0.08 : 0), .clear], startPoint: .top, endPoint: .center)
                )
                .background(Theme.surface.opacity(0.8), in: .rect(cornerRadius: 22))
        }
        .clipShape(.rect(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(
                    category.noted > 0 ? Theme.danger.opacity(0.32) : (ouverte ? couleur.opacity(0.35) : Theme.hairline),
                    lineWidth: ouverte ? 1 : 0.8
                )
        }
        .lumiereSurvol(22)
        .shadow(color: ouverte ? couleur.opacity(0.35) : .black.opacity(0.25), radius: ouverte ? 22 : 12, y: 10)
        .animation(.spring(response: 0.42, dampingFraction: 0.82), value: ouverte)
        .animation(Theme.spring, value: model.parcels[cle])
    }
}

/// Un colis : ses informations, et au survol ses actions en boutons de verre.
private struct LigneColis: View {
    let parcel: Parcel
    let scope: PrintScope
    let onEdit: (Parcel) -> Void
    let onDelete: (Parcel) -> Void
    @Environment(AppModel.self) private var app
    @State private var survol = false

    var body: some View {
        let model = app.printing
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
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
                        .font(.system(size: 13.5, weight: .medium))
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
            Spacer(minLength: 8)
            GlassEffectContainer(spacing: 0) {
                HStack(spacing: 6) {
                    action("Modifier", "pencil") { onEdit(parcel) }
                    action("Imprimer", "printer") {
                        Task { await model.print(.parcels([parcel.id], scope: scope), key: "id:\(parcel.id)") }
                    }
                    if scope == .printed {
                        Button {
                            Task { await model.drop(parcel, scope: scope) }
                        } label: {
                            Label("Drop", systemImage: "paperplane.fill").font(.system(size: 12.5, weight: .bold))
                        }
                        .boutonVerreFort()
                    } else {
                        action("Retirer", "trash") { onDelete(parcel) }
                    }
                }
            }
            .opacity(survol ? 1 : 0.35)
            .scaleEffect(survol ? 1 : 0.96, anchor: .trailing)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.black.opacity(survol ? 0.32 : 0.22), in: .rect(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(parcel.note?.isEmpty == false ? Theme.danger.opacity(0.3) : Theme.hairline, lineWidth: 0.8)
        }
        .contentShape(.rect)
        .onHover { dedans in withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { survol = dedans } }
        .onTapGesture(count: 2) { onEdit(parcel) }
        .contextMenu {
            Button("Modifier", systemImage: "pencil") { onEdit(parcel) }
            Button("Imprimer", systemImage: "printer") {
                Task { await model.print(.parcels([parcel.id], scope: scope), key: "id:\(parcel.id)") }
            }
            if scope == .printed {
                Button("Drop", systemImage: "paperplane") { Task { await model.drop(parcel, scope: scope) } }
            } else {
                Button("Retirer", systemImage: "trash", role: .destructive) { onDelete(parcel) }
            }
        }
    }

    private func action(_ titre: String, _ symbole: String, faire: @escaping () -> Void) -> some View {
        Button(action: faire) {
            Image(systemName: symbole)
                .font(.system(size: 12.5, weight: .semibold))
                .frame(width: 30, height: 30)
        }
        .boutonVerre(.rond)
        .help(titre)
    }
}
#endif
