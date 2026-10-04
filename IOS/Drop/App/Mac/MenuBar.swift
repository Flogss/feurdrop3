#if os(macOS)
import SwiftUI
import AppKit
import DropKit

/// Dans la barre des menus : le nombre de colis a dropper.
struct MenuBarLabel: View {
    let app: AppModel

    var body: some View {
        if let n = app.dashboard.stats?.pendingCount {
            Label(Format.integer(n), systemImage: "shippingbox.fill")
                .labelStyle(.titleAndIcon)
        } else {
            Image(systemName: "shippingbox.fill")
        }
    }
}

/// Le panneau ouvert depuis la barre des menus : l'essentiel d'un coup d'oeil.
struct MenuBarPanel: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let s = app.dashboard.stats
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Drop")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.numberGradient)
                Spacer()
                LivePill(online: app.isOnline)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("À dropper").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.integer(s?.pendingCount ?? 0))
                        .font(.system(size: 40, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Theme.numberGradient)
                        .contentTransition(.numericText(value: Double(s?.pendingCount ?? 0)))
                    Text("colis").font(.headline).foregroundStyle(Theme.text3)
                }
                Text("≈ \(Format.euro(s?.pendingValue ?? 0))")
                    .font(.headline)
                    .foregroundStyle(Theme.moneyGradient)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(Theme.violetDark.opacity(0.4)), in: .rect(cornerRadius: 18))

            HStack(spacing: 10) {
                chiffre("Aujourd'hui", Format.euroCompact(s?.todayValue ?? 0))
                chiffre("À imprimer", Format.integer(s?.aImprimer ?? 0))
            }

            HStack(spacing: 10) {
                Button {
                    openWindow(id: MacWindow.principale)
                    NSApp.activate()
                } label: {
                    Label("Ouvrir Drop", systemImage: "macwindow")
                        .frame(maxWidth: .infinity)
                }
                .boutonVerreFort()
                Button("Quitter", systemImage: "power") { NSApp.terminate(nil) }
                    .labelStyle(.iconOnly)
                    .boutonVerre(.rond)
                    .help("Quitter Drop")
            }
        }
        .padding(16)
        .frame(width: 300)
        .task { await app.dashboard.refresh() }
    }

    private func chiffre(_ titre: String, _ valeur: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(titre).font(.caption.weight(.semibold)).foregroundStyle(Theme.text3)
            Text(valeur).font(.title3.weight(.bold).monospacedDigit())
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
    }
}
#endif
