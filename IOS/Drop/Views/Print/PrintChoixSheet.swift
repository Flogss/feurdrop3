import SwiftUI
import DropKit

/// « Choisir », a cote de « Tout imprimer » : on coche les transporteurs a
/// sortir, et ils partent dans une seule liasse (les annotees dessus). Les
/// LIT n'y sont pas : ils sortent sur le rouleau 210 mm, depuis leur
/// categorie. Le choix est retenu d'une fois sur l'autre.
struct PrintChoixSheet: View {
    let categories: [PrintCategory]
    let imprimer: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<String>

    init(categories: [PrintCategory], retenu: Set<String>, imprimer: @escaping ([String]) -> Void) {
        self.categories = categories
        self.imprimer = imprimer
        let codes = Set(categories.map(\.code))
        let garde = retenu.intersection(codes)
        _selection = State(initialValue: garde.isEmpty ? codes : garde)
    }

    private var pris: [PrintCategory] { categories.filter { selection.contains($0.code) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Quoi imprimer ?")
                    .font(.title3.weight(.bold))
                Spacer()
                Button(pris.count == categories.count ? "Aucun" : "Tout") {
                    Haptics.selection()
                    withAnimation(Theme.spring) {
                        selection = pris.count == categories.count ? [] : Set(categories.map(\.code))
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.violetLight)
                .buttonStyle(.plain)
            }
            .padding(.bottom, 16)

            ScrollView {
                FlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(categories) { c in puce(c) }
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
                    let codes = categories.map(\.code).filter { selection.contains($0) }
                    dismiss()
                    imprimer(codes)
                } label: {
                    Label("Imprimer", systemImage: "printer.fill")
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

    private func puce(_ c: PrintCategory) -> some View {
        let actif = selection.contains(c.code)
        let couleur = Color.carrier(c.code)
        return Button {
            withAnimation(Theme.spring) {
                if actif { selection.remove(c.code) } else { selection.insert(c.code) }
            }
        } label: {
            HStack(spacing: 7) {
                Circle()
                    .fill(couleur)
                    .frame(width: 8, height: 8)
                    .shadow(color: couleur.opacity(actif ? 0.9 : 0), radius: 4)
                    .opacity(actif ? 1 : 0.4)
                Text(c.label).font(.subheadline.weight(.semibold))
                Text(Format.integer(c.count)).font(.subheadline.weight(.bold).monospacedDigit()).opacity(0.75)
                if c.noted > 0 {
                    Image(systemName: "note.text").font(.caption).foregroundStyle(Theme.warn)
                }
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
        let notees = pris.reduce(0) { $0 + $1.noted }
        return Group {
            if pris.isEmpty {
                Text("Choisis au moins un transporteur.")
                    .foregroundStyle(Theme.text2)
            } else {
                Text("\(Text(Format.count(count, "étiquette", "étiquettes")).bold().foregroundStyle(Theme.text)) à imprimer\(notees > 0 ? " · \(Format.count(notees, "annotée", "annotées")) sur le dessus" : "")")
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText(value: Double(count)))
            }
        }
        .font(.subheadline)
        .animation(Theme.spring, value: selection)
    }
}
