import SwiftUI
import DropKit

/// Les tarifs de chaque expediteur (normal, LIT, BJ). Une valeur s'enregistre
/// en quittant le champ ; balayer une ligne supprime l'expediteur.
struct PricesView: View {
    @Environment(AppModel.self) private var app
    @State private var ajout = false
    @State private var aSupprimer: Sender?
    @State private var recherche = ""

    private var model: SettingsModel { app.settings }

    private var liste: [Sender] {
        recherche.isEmpty ? model.senders : model.senders.filter { $0.name.localizedCaseInsensitiveContains(recherche) }
    }

    var body: some View {
        List {
            if model.senders.isEmpty && model.loaded {
                EmptyStateView(symbol: "tag", title: "Aucun expéditeur", subtitle: "Ajoute le premier avec +.")
                    .listRowBackground(Color.clear)
            }
            ForEach(liste) { s in
                PriceRow(sender: s)
                    .swipeActions {
                        Button("Supprimer", systemImage: "trash", role: .destructive) { aSupprimer = s }
                    }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Prix")
        .searchable(text: $recherche, prompt: "Rechercher un expéditeur")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Ajouter", systemImage: "plus") { ajout = true }
            }
        }
        .sheet(isPresented: $ajout) { AddSenderSheet() }
        .task { if !model.loaded { await model.refresh() } }
        .confirmationDialog(
            "Supprimer \(aSupprimer?.name ?? "") ?",
            isPresented: Binding(get: { aSupprimer != nil }, set: { if !$0 { aSupprimer = nil } }),
            titleVisibility: .visible, presenting: aSupprimer
        ) { s in
            Button("Supprimer", role: .destructive) { Task { await model.delete(s) } }
            Button("Annuler", role: .cancel) {}
        } message: { _ in
            Text("Ses tarifs personnalisés seront perdus. Ses colis restent dans l'historique.")
        }
    }
}

private struct PriceRow: View {
    let sender: Sender

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                SenderAvatar(name: sender.name, size: 30)
                Text(sender.name).font(.body.weight(.medium)).lineLimit(1)
            }
            HStack(spacing: 8) {
                PriceInput(sender: sender, field: .price, color: Theme.violet)
                PriceInput(sender: sender, field: .litPrice, color: .carrier("LIT"))
                PriceInput(sender: sender, field: .bjPrice, color: .carrier("BJ"))
            }
        }
        .padding(.vertical, 4)
    }
}

/// Un prix : il s'enregistre a la sortie du champ et s'allume pour dire que
/// c'est fait (ou tremble si la valeur n'est pas valable).
private struct PriceInput: View {
    let sender: Sender
    let field: PriceField
    let color: Color

    @Environment(AppModel.self) private var app
    @State private var texte = ""
    @State private var enregistre = 0
    @State private var erreur = 0
    @FocusState private var focus: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 6, height: 6)
                Text(field.label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.text3)
            }
            HStack(spacing: 2) {
                TextField("0", text: $texte)
                    .clavier(.decimal)
                    .focused($focus)
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                Text("€").font(.caption).foregroundStyle(Theme.text3)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.white.opacity(0.06), in: .rect(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(focus ? color : .clear, lineWidth: 1)
            }
            .phaseAnimator([false, true, false], trigger: enregistre) { contenu, allume in
                contenu.shadow(color: Theme.violet.opacity(allume ? 0.9 : 0), radius: allume ? 10 : 0)
            }
            .keyframeAnimator(initialValue: 0.0, trigger: erreur) { contenu, x in
                contenu.offset(x: x)
            } keyframes: { _ in
                KeyframeTrack {
                    CubicKeyframe(-6, duration: 0.05)
                    CubicKeyframe(5, duration: 0.07)
                    CubicKeyframe(0, duration: 0.08)
                }
            }
        }
        .onAppear { texte = Self.format(field.value(in: sender)) }
        .onChange(of: sender) { if !focus { texte = Self.format(field.value(in: sender)) } }
        .onChange(of: focus) { _, actif in
            if !actif { Task { await valide() } }
        }
        .sensoryFeedback(.error, trigger: erreur)
    }

    private func valide() async {
        let saisi = texte.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let valeur = Double(saisi), valeur >= 0 else {
            erreur += 1
            texte = Self.format(field.value(in: sender))
            return
        }
        guard valeur != field.value(in: sender) else { return }
        if await app.settings.updatePrice(sender, field, valeur) {
            enregistre += 1
        } else {
            erreur += 1
            texte = Self.format(field.value(in: sender))
        }
    }

    static func format(_ v: Double) -> String {
        v.formatted(.number.locale(Locale(identifier: "fr_FR")).precision(.fractionLength(0...2)).grouping(.never))
    }
}

/// Ajouter un expediteur, en feuille.
struct AddSenderSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var nom = ""
    @State private var prix = ""
    @State private var prixLit = ""
    @State private var prixBJ = ""
    @State private var envoi = false
    @FocusState private var focusNom: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section("Nom") {
                    TextField("@pseudo ou nom", text: $nom)
                        .sansMajuscules()
                        .autocorrectionDisabled()
                        .focused($focusNom)
                }
                Section("Tarifs") {
                    champ("Normal", texte: $prix)
                    champ("LIT", texte: $prixLit)
                    champ("BJ", texte: $prixBJ)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Nouvel expéditeur")
            .titreCompact()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuler", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ajouter", systemImage: "checkmark") { Task { await ajoute() } }
                        .boutonVerreFort(Theme.violetDeep)
                        .disabled(nom.trimmingCharacters(in: .whitespaces).isEmpty || envoi)
                }
            }
            .onAppear { focusNom = true }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.ultraThinMaterial)
    }

    private func champ(_ titre: String, texte: Binding<String>) -> some View {
        HStack {
            Text(titre)
            Spacer()
            TextField("0", text: texte)
                .clavier(.decimal)
                .multilineTextAlignment(.trailing)
                .frame(width: 90)
            Text("€").foregroundStyle(Theme.text3)
        }
    }

    private func nombre(_ t: String) -> Double {
        Double(t.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")) ?? 0
    }

    private func ajoute() async {
        envoi = true
        defer { envoi = false }
        if await app.settings.addSender(name: nom, price: nombre(prix), litPrice: nombre(prixLit), bjPrice: nombre(prixBJ)) {
            dismiss()
        }
    }
}
