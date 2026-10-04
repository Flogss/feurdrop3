import SwiftUI
import DropKit

/// Prix, transporteur, note : les trois choses qu'on corrige a la main. On
/// n'envoie que ce qui a change (renvoyer le prix tel quel le figerait contre
/// les futurs changements de tarif de l'expediteur).
struct ParcelEditSheet: View {
    let parcel: Parcel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var prix: String
    @State private var transporteur: String?
    @State private var note: String
    @State private var envoi = false
    @State private var secousse = 0
    @FocusState private var focus: Champ?

    private enum Champ { case prix, note }

    init(parcel: Parcel) {
        self.parcel = parcel
        _prix = State(initialValue: Self.texte(parcel.price))
        _transporteur = State(initialValue: parcel.carrier)
        _note = State(initialValue: parcel.note ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Expéditeur", value: parcel.sender)
                    if let special = parcel.special {
                        LabeledContent("Spécial", value: "#\(special.numero)\(special.code ? "" : " · code manquant")")
                    }
                } header: {
                    Text(parcel.displayName).textCase(nil).lineLimit(2)
                }

                Section("Prix") {
                    HStack {
                        TextField("0,00", text: $prix)
                            .clavier(.decimal)
                            .focused($focus, equals: .prix)
                            .font(.title3.weight(.semibold).monospacedDigit())
                        Text("€").foregroundStyle(Theme.text3)
                    }
                    .keyframeAnimator(initialValue: 0.0, trigger: secousse) { contenu, x in
                        contenu.offset(x: x)
                    } keyframes: { _ in
                        KeyframeTrack {
                            CubicKeyframe(-10, duration: 0.06)
                            CubicKeyframe(9, duration: 0.08)
                            CubicKeyframe(-6, duration: 0.08)
                            CubicKeyframe(0, duration: 0.1)
                        }
                    }
                }

                Section {
                    Picker("Transporteur", selection: $transporteur) {
                        Text("— non reconnu —").tag(String?.none)
                        ForEach(app.printing.carriers) { t in
                            HStack {
                                Text(t.label)
                            }
                            .tag(Optional(t.code))
                        }
                    }
                    .choixEnPage()
                } footer: {
                    Text("Corriger un transporteur l'apprend au bot, comme /transporteur.")
                }

                Section("Note") {
                    TextField("fragile, avant 14h…", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($focus, equals: .note)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Modifier le colis")
            .titreCompact()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annuler", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Enregistrer", systemImage: "checkmark") { Task { await enregistre() } }
                        .buttonStyle(.glassProminent)
                        .tint(Theme.violetDeep)
                        .disabled(envoi)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(.ultraThinMaterial)
        .sensoryFeedback(.error, trigger: secousse)
    }

    private func enregistre() async {
        let saisi = prix.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let valeur = Double(saisi), valeur >= 0 else {
            secousse += 1
            focus = .prix
            return
        }
        var patch = ParcelPatch()
        if abs(valeur - parcel.price) > 0.0001 { patch.price = valeur }
        if transporteur != parcel.carrier { patch.carrier = .some(transporteur) }
        let propre = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if propre != (parcel.note ?? "") { patch.note = propre }
        guard !patch.isEmpty else {
            dismiss()
            return
        }
        envoi = true
        defer { envoi = false }
        if await app.printing.save(parcel, patch: patch) { dismiss() }
    }

    private static func texte(_ prix: Double) -> String {
        prix.formatted(.number.locale(Locale(identifier: "fr_FR")).precision(.fractionLength(0...2)).grouping(.never))
    }
}
