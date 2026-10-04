import SwiftUI
import DropKit

/// Les revenus par semaine : les barres montent l'une apres l'autre avec de
/// l'inertie (elles depassent un peu, puis se posent), leur valeur compte en
/// meme temps. La meilleure semaine brille ; la semaine en cours est en
/// pointilles, puisqu'elle n'est pas finie.
struct WeeklyBarsChart: View {
    let weeks: [WeekRevenue]
    let reveal: Int
    @Binding var range: String

    @State private var montee = false
    @State private var dejaVu = -1
    @State private var visible = false
    @State private var selection: String?

    static let spacing: CGFloat = 62
    static let height: CGFloat = 220
    private let padTop: CGFloat = 34
    private let padBottom: CGFloat = 28

    var body: some View {
        GeometryReader { geo in
            let largeur = max(geo.size.width, CGFloat(weeks.count) * Self.spacing)
            let plafond = max(weeks.map(\.value).max() ?? 0, 1) * 1.1
            let meilleure = weeks.max(by: { $0.value < $1.value })?.id
            ScrollView(.horizontal) {
                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(Array(weeks.enumerated()), id: \.element.id) { i, w in
                        Barre(
                            week: w,
                            fraction: w.value / plafond,
                            hauteurUtile: Self.height - padTop - padBottom,
                            montee: montee,
                            retard: Double(max(0, i - (weeks.count - 8))) * 0.075,
                            record: w.id == meilleure && w.value > 0,
                            enCours: i == weeks.count - 1,
                            choisie: selection == w.id
                        )
                        .frame(width: largeur / CGFloat(max(weeks.count, 1)))
                        .onTapGesture {
                            Haptics.selection()
                            withAnimation(Theme.bouncy) { selection = selection == w.id ? nil : w.id }
                        }
                        #if os(macOS)
                        .onHover { dedans in
                            guard montee else { return }
                            withAnimation(.snappy(duration: 0.22)) {
                                if dedans { selection = w.id } else if selection == w.id { selection = nil }
                            }
                        }
                        #endif
                    }
                }
                .frame(width: largeur, height: Self.height, alignment: .bottom)
                .background(alignment: .top) { grille }
            }
            .sansIndicateurs()
            .defaultScrollAnchor(.trailing)
            .tirerPourDefiler()
            .bordsEstompes()
            .onScrollGeometryChange(for: ClosedRange<Int>.self) { g in
                visibles(offset: g.contentOffset.x, largeur: g.containerSize.width, total: largeur)
            } action: { _, r in
                range = texte(r)
            }
        }
        .frame(height: Self.height)
        // plus bas dans la page : on attend d'etre vraiment a l'ecran
        .onScrollVisibilityChange(threshold: 0.45) { vu in
            visible = vu
            if vu { rejoue() }
        }
        .onChange(of: reveal) {
            if visible { rejoue() } else { montee = false }
        }
    }

    private var grille: some View {
        VStack(spacing: 0) {
            ForEach(0..<3) { k in
                Rectangle()
                    .fill(.white.opacity(k == 2 ? 0.1 : 0.05))
                    .frame(height: 1)
                if k < 2 { Spacer() }
            }
        }
        .padding(.top, padTop)
        .padding(.bottom, padBottom)
    }

    private func rejoue() {
        guard reveal != dejaVu || !montee else { return }
        dejaVu = reveal
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { montee = false }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(120))
            montee = true
        }
    }

    private func visibles(offset: CGFloat, largeur: CGFloat, total: CGFloat) -> ClosedRange<Int> {
        guard !weeks.isEmpty else { return 0...0 }
        let pas = total / CGFloat(weeks.count)
        let a = min(max(Int((offset / pas).rounded(.down)), 0), weeks.count - 1)
        let b = min(max(Int(((offset + largeur) / pas).rounded(.up)) - 1, a), weeks.count - 1)
        return a...b
    }

    private func texte(_ r: ClosedRange<Int>) -> String {
        guard !weeks.isEmpty else { return "—" }
        return "\(ServerDate.dayMonth(weeks[r.lowerBound].start)) – \(ServerDate.dayMonth(weeks[r.upperBound].end))"
    }
}

private struct Barre: View {
    let week: WeekRevenue
    let fraction: Double
    let hauteurUtile: CGFloat
    let montee: Bool
    let retard: Double
    let record: Bool
    let enCours: Bool
    let choisie: Bool

    @State private var valeur: Double = 0

    var body: some View {
        VStack(spacing: 6) {
            Spacer(minLength: 0)
            VStack(spacing: 2) {
                if record {
                    Text("Record")
                        .font(.system(size: 9, weight: .heavy))
                        .foregroundStyle(Theme.violetBright)
                }
                CountingText(value: valeur, format: Format.euroGraphe)
                    .font(.system(size: record || choisie ? 11 : 9.5, weight: .bold).monospacedDigit())
                    .foregroundStyle(record || choisie ? Theme.violetPale : Theme.text3)
                    .lineLimit(1)
                    .fixedSize()
            }
            .opacity(montee ? 1 : 0)

            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(remplissage)
                .overlay {
                    if enCours {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(Theme.violetLight.opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
                    }
                }
                .shadow(color: record || choisie ? Theme.violet.opacity(0.9) : .clear, radius: 12)
                .frame(width: 30, height: max(4, hauteurUtile * fraction))
                .scaleEffect(x: 1, y: montee ? 1 : 0.001, anchor: .bottom)

            Text(ServerDate.dayMonth(week.start))
                .font(.system(size: 10, weight: enCours ? .bold : .medium))
                .foregroundStyle(enCours ? Theme.violetLight : Theme.text3)
                .lineLimit(1)
                .fixedSize()
                .frame(height: 16)
        }
        .padding(.bottom, 4)
        .animation(.spring(response: 0.75, dampingFraction: 0.58).delay(retard), value: montee)
        .contentShape(.rect)
        .onChange(of: montee, initial: true) {
            if montee {
                withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 1.1).delay(retard)) { valeur = week.value }
            } else {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { valeur = 0 }
            }
        }
        .onChange(of: week.value) {
            withAnimation(.smooth(duration: 0.8)) { valeur = week.value }
        }
    }

    private var remplissage: AnyShapeStyle {
        if record || choisie {
            return AnyShapeStyle(LinearGradient(colors: [Theme.violetPale, Theme.violetBright, Theme.violetDeep], startPoint: .top, endPoint: .bottom))
        }
        return AnyShapeStyle(LinearGradient(colors: [Theme.violet.opacity(0.85), Theme.violetDark.opacity(0.7)], startPoint: .top, endPoint: .bottom))
    }
}
