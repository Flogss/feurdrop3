import SwiftUI
import DropKit

/// « Choisir », a cote de « Tout imprimer » : on coche les transporteurs a
/// sortir, et ils partent dans une seule liasse (les annotees dessus). Les
/// LIT n'y sont pas : ils sortent sur le rouleau 210 mm, depuis leur
/// categorie. Le choix est retenu d'une fois sur l'autre. « Combien ? » :
/// chaque transporteur coche sort en entier par defaut, ou seulement ses n
/// premieres etiquettes (les annotees d'abord).
struct PrintChoixSheet: View {
    let categories: [PrintCategory]
    let imprimer: ([String], [String: Int]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Set<String>
    /// les transporteurs pris en partie ; absent : toutes
    @State private var quantites: [String: Int] = [:]

    init(categories: [PrintCategory], retenu: Set<String>, imprimer: @escaping ([String], [String: Int]) -> Void) {
        self.categories = categories
        self.imprimer = imprimer
        let codes = Set(categories.map(\.code))
        let garde = retenu.intersection(codes)
        _selection = State(initialValue: garde.isEmpty ? codes : garde)
    }

    private var pris: [PrintCategory] { categories.filter { selection.contains($0.code) } }

    private func quantite(_ c: PrintCategory) -> Int { min(c.count, max(1, quantites[c.code] ?? c.count)) }

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
                VStack(alignment: .leading, spacing: 16) {
                    FlowLayout(spacing: 8, lineSpacing: 8) {
                        ForEach(categories) { c in puce(c) }
                    }
                    if !pris.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("COMBIEN ?")
                                .font(.caption.weight(.semibold))
                                .kerning(1.2)
                                .foregroundStyle(Theme.text3)
                            ForEach(pris) { c in ligneQuantite(c) }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
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
                    let codes = categories.map(\.code).filter { selection.contains($0) }
                    // seulement les transporteurs pris en partie
                    var parties: [String: Int] = [:]
                    for c in pris where quantite(c) < c.count { parties[c.code] = quantite(c) }
                    dismiss()
                    imprimer(codes, parties)
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

    /// « La Poste   − 3 +   sur 6 » ; toucher « sur 6 » revient a toutes
    private func ligneQuantite(_ c: PrintCategory) -> some View {
        let n = quantite(c)
        let partiel = n < c.count
        let couleur = Color.carrier(c.code)
        return HStack(spacing: 8) {
            Circle().fill(couleur).frame(width: 8, height: 8)
            Text(c.label)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 4)
            HStack(spacing: 2) {
                pas("minus", desactive: n <= 1) { change(c, n - 1) }
                    .accessibilityLabel("Une \(c.label) de moins")
                Text(Format.integer(n))
                    .font(.body.weight(.bold).monospacedDigit())
                    .contentTransition(.numericText(value: Double(n)))
                    .frame(minWidth: 34)
                pas("plus", desactive: n >= c.count) { change(c, n + 1) }
                    .accessibilityLabel("Une \(c.label) de plus")
            }
            .padding(2)
            .background(.white.opacity(0.05), in: .capsule)
            .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 1))
            Button("sur \(Format.integer(c.count))") {
                Haptics.selection()
                withAnimation(Theme.spring) { _ = quantites.removeValue(forKey: c.code) }
            }
            .font(.footnote.weight(.semibold).monospacedDigit())
            .foregroundStyle(partiel ? Theme.violetLight : Theme.text3)
            .disabled(!partiel)
            .buttonStyle(.plain)
            .frame(minWidth: 48)
            .accessibilityLabel(partiel ? "Toutes les \(c.count)" : "Toutes")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(partiel ? couleur.opacity(0.08) : .white.opacity(0.03))
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(partiel ? couleur.opacity(0.45) : Theme.hairline, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(c.label) : \(n) sur \(c.count)")
        .accessibilityAdjustableAction { sens in
            switch sens {
            case .increment: change(c, n + 1)
            case .decrement: change(c, n - 1)
            @unknown default: break
            }
        }
    }

    private func pas(_ symbole: String, desactive: Bool, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.selection()
            action()
        } label: {
            Image(systemName: symbole)
                .font(.system(size: 13, weight: .bold))
                .frame(width: 32, height: 32)
                .contentShape(.circle)
        }
        .buttonStyle(PressScaleStyle(scale: 0.88))
        .foregroundStyle(desactive ? Theme.text3.opacity(0.5) : Theme.text)
        .disabled(desactive)
        .buttonRepeatBehavior(.enabled)
    }

    private func change(_ c: PrintCategory, _ n: Int) {
        let borne = min(c.count, max(1, n))
        withAnimation(Theme.spring) {
            if borne >= c.count { quantites.removeValue(forKey: c.code) } else { quantites[c.code] = borne }
        }
    }

    private var resume: some View {
        let count = pris.reduce(0) { $0 + quantite($1) }
        // les annotees sortent les premieres de leur file
        let notees = pris.reduce(0) { $0 + min($1.noted, quantite($1)) }
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
        .animation(Theme.spring, value: quantites)
    }
}
