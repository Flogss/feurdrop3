import SwiftUI
import DropKit

/// Regrouper les petits expediteurs en « Autre » : on coche, on confirme.
/// Les gros (protege) ne se cochent pas.
struct MergeOtherView: View {
    @Environment(AppModel.self) private var app
    @State private var choisis: Set<Int> = []
    @State private var confirme = false

    private var model: SettingsModel { app.settings }

    var body: some View {
        List {
            Section {
                if model.candidates.isEmpty {
                    EmptyStateView(symbol: "square.stack.3d.up", title: "Aucun expéditeur pour le moment")
                        .listRowBackground(Color.clear)
                }
                ForEach(model.candidates) { c in
                    Button {
                        guard c.mergeable else { return }
                        Haptics.selection()
                        withAnimation(Theme.bouncy) {
                            if choisis.contains(c.id) { choisis.remove(c.id) } else { choisis.insert(c.id) }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: choisis.contains(c.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(choisis.contains(c.id) ? Theme.violet : Theme.text3)
                                .contentTransition(.symbolEffect(.replace))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.name).foregroundStyle(Theme.text)
                                Text("\(Format.count(c.colisCount, "colis", "colis")) · \(Int((c.pct * 100).rounded())) % du CA\(c.mergeable ? "" : " · protégé")")
                                    .font(.caption)
                                    .foregroundStyle(Theme.text3)
                            }
                            Spacer()
                            if !c.mergeable {
                                Image(systemName: "lock.fill").foregroundStyle(Theme.text3)
                            }
                        }
                    }
                    .disabled(!c.mergeable)
                }
            } footer: {
                Text("Leur historique de colis sera regroupé sous « Autre ». Irréversible.")
            }
        }
        .scrollContentBackground(.hidden)
        .navigationTitle("Regrouper")
        .safeAreaInset(edge: .bottom) {
            Button {
                Haptics.warning()
                confirme = true
            } label: {
                Text(choisis.isEmpty ? "Choisis des expéditeurs" : "Regrouper \(Format.count(choisis.count, "expéditeur", "expéditeurs"))")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .contentTransition(.numericText())
            }
            .buttonStyle(.glassProminent)
            .tint(Theme.violetDeep)
            .disabled(choisis.isEmpty)
            .padding(.horizontal, 20)
            .padding(.bottom, 90)
            .animation(Theme.spring, value: choisis)
        }
        .confirmationDialog("Regrouper \(Format.count(choisis.count, "expéditeur", "expéditeurs")) en « Autre » ?", isPresented: $confirme, titleVisibility: .visible) {
            Button("Regrouper", role: .destructive) {
                Task {
                    if await model.mergeIntoOther(choisis) { choisis = [] }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Leur historique de colis sera regroupé. Cette action est irréversible.")
        }
        .task { await model.refresh() }
    }
}
