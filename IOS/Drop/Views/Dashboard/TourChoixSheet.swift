import SwiftUI
import DropKit

/// Le depart en tournee : on coche les transporteurs qu'on va poster. Les
/// speciaux et les LIT ont leur categorie : la toucher prend (ou laisse) tous
/// ses transporteurs, chacun restant decochable. Seul ce qui est coche part
/// dans le sac -- compteurs, retour de tournee et suivi des expediteurs.
struct TourChoixSheet: View {
    let choix: TourChoix
    let partir: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<String>

    init(choix: TourChoix, partir: @escaping ([String]) -> Void) {
        self.choix = choix
        self.partir = partir
        _selection = State(initialValue: Set(choix.groupes.flatMap { $0.transporteurs.map(\.cle) }))
    }

    private var tous: [TourTransporteur] { choix.groupes.flatMap(\.transporteurs) }
    private var pris: [TourTransporteur] { tous.filter { selection.contains($0.cle) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Qu'est-ce que tu postes ?")
                    .font(.title3.weight(.bold))
                Spacer()
                Button(pris.count == tous.count ? "Aucun" : "Tout") {
                    Haptics.selection()
                    withAnimation(Theme.spring) {
                        selection = pris.count == tous.count ? [] : Set(tous.map(\.cle))
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.violetLight)
                .buttonStyle(.plain)
            }
            .padding(.bottom, 16)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(choix.groupes) { groupe in
                        VStack(alignment: .leading, spacing: 10) {
                            tete(groupe)
                            FlowLayout(spacing: 8, lineSpacing: 8) {
                                ForEach(groupe.transporteurs) { t in puce(t) }
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .sansIndicateurs()
            .scrollBounceBehavior(.basedOnSize)

            Divider().overlay(Theme.hairline).padding(.vertical, 14)
            resume
                .padding(.bottom, 14)

            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    Text("Annuler")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerre()
                Button {
                    let cles = tous.map(\.cle).filter { selection.contains($0) }
                    dismiss()
                    partir(cles)
                } label: {
                    Label("C'est parti", systemImage: "box.truck.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                }
                .boutonVerreFort(Theme.violetDeep)
                .disabled(pris.isEmpty)
            }
        }
        .padding(22)
        .sensoryFeedback(.selection, trigger: selection)
    }

    // MARK: Morceaux

    @ViewBuilder
    private func tete(_ groupe: TourGroupe) -> some View {
        if groupe.id == "normal" {
            Text(groupe.nom.uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(Theme.text3)
        } else {
            let cles = groupe.transporteurs.map(\.cle)
            let n = cles.filter { selection.contains($0) }.count
            let teinte = groupe.id == "lit" ? Theme.teal : Theme.special
            let total = groupe.transporteurs.reduce(0) { $0 + $1.count }
            Button {
                withAnimation(Theme.spring) {
                    if n == cles.count { selection.subtract(cles) } else { selection.formUnion(cles) }
                }
            } label: {
                HStack(spacing: 8) {
                    ZStack {
                        Circle().strokeBorder(n == 0 ? Theme.text3 : teinte, lineWidth: 1.5)
                        if n > 0 {
                            Circle().fill(teinte)
                            Image(systemName: n == cles.count ? "checkmark" : "minus")
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(Theme.background)
                                .transition(.scale.combined(with: .opacity))
                        }
                    }
                    .frame(width: 22, height: 22)
                    Text(groupe.nom).font(.subheadline.weight(.semibold))
                    Text(Format.integer(total)).font(.subheadline.weight(.bold).monospacedDigit()).opacity(0.7)
                }
                .foregroundStyle(n == 0 ? Theme.text2 : Theme.text)
                .padding(.leading, 7)
                .padding(.trailing, 14)
                .frame(height: 38)
                .background(teinte.opacity(n == 0 ? 0 : 0.13), in: .capsule)
                .overlay(Capsule().strokeBorder(n == 0 ? Theme.hairline : teinte.opacity(0.5), lineWidth: 1))
                .contentShape(.capsule)
            }
            .buttonStyle(PressScaleStyle(scale: 0.95))
            .accessibilityValue(n == cles.count ? "tout" : n == 0 ? "rien" : "en partie")
        }
    }

    private func puce(_ t: TourTransporteur) -> some View {
        let actif = selection.contains(t.cle)
        let couleur = Color.carrier(t.code)
        return Button {
            withAnimation(Theme.spring) {
                if actif { selection.remove(t.cle) } else { selection.insert(t.cle) }
            }
        } label: {
            HStack(spacing: 7) {
                Circle()
                    .fill(couleur)
                    .frame(width: 8, height: 8)
                    .shadow(color: couleur.opacity(actif ? 0.9 : 0), radius: 4)
                    .opacity(actif ? 1 : 0.4)
                Text(t.nom).font(.subheadline.weight(.semibold))
                Text(Format.integer(t.count)).font(.subheadline.weight(.bold).monospacedDigit()).opacity(0.75)
            }
            .foregroundStyle(actif ? Theme.text : Theme.text3)
            .padding(.horizontal, 13)
            .frame(height: 38)
            .background {
                Capsule().fill(LinearGradient(colors: [couleur.opacity(actif ? 0.22 : 0), couleur.opacity(actif ? 0.08 : 0)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(Capsule().strokeBorder(actif ? couleur.opacity(0.55) : Theme.hairline, lineWidth: 1))
            .contentShape(.capsule)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityAddTraits(actif ? .isSelected : [])
    }

    private var resume: some View {
        let count = pris.reduce(0) { $0 + $1.count }
        let prets = pris.reduce(0) { $0 + $1.prets }
        let value = pris.reduce(0) { $0 + $1.value }
        return VStack(alignment: .leading, spacing: 3) {
            if pris.isEmpty {
                Text("Choisis au moins un transporteur.")
                    .foregroundStyle(Theme.text2)
            } else {
                Text("\(Text(Format.count(count, "colis", "colis")).bold().foregroundStyle(Theme.text)) dans le sac · \(Format.euro(value))")
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText(value: Double(count)))
                if count > prets {
                    Text("\(Format.count(count - prets, "pas encore imprimé restera", "pas encore imprimés resteront")) en attente")
                        .font(.footnote)
                        .foregroundStyle(Theme.warn)
                }
            }
        }
        .font(.subheadline)
        .animation(Theme.spring, value: selection)
    }
}
