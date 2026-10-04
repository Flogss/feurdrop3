import SwiftUI
import DropKit

@main
struct DropApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #else
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    #endif
    @State private var app = AppModel.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        #if os(iOS)
        WindowGroup {
            RootView()
                .environment(app)
                #if DEBUG
                .onAppear { PerfProbe.shared.start() }
                #endif
                .preferredColorScheme(.dark)
                .tint(Theme.violet)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                BackgroundRefresh.schedule()
                BackgroundListener.shared.start()
            case .active:
                BackgroundListener.shared.stop()
            default:
                break
            }
        }
        // Le filet de securite : quand iOS reveille l'app (au mieux toutes les
        // 15 minutes), elle regarde aussi s'il y a du nouveau.
        .backgroundTask(.appRefresh(BackgroundRefresh.identifier)) {
            await BackgroundRefresh.run()
        }
        #else
        // La fenetre principale : une seule, rouverte depuis le Dock ou la barre
        // des menus.
        Window("Drop", id: MacWindow.principale) {
            MacRootView()
                .environment(app)
                .preferredColorScheme(.dark)
                .tint(Theme.violet)
                .frame(minWidth: 940, minHeight: 640)
        }
        .defaultSize(width: 1280, height: 860)
        .windowToolbarStyle(.unified)
        .commands { DropCommands(app: app) }

        // Reglages : Drop > Reglages... (Cmd ,)
        Settings {
            MacSettingsView()
                .environment(app)
                .preferredColorScheme(.dark)
                .tint(Theme.violet)
        }

        // Le compteur dans la barre des menus
        MenuBarExtra {
            MenuBarPanel()
                .environment(app)
                .preferredColorScheme(.dark)
                .tint(Theme.violet)
        } label: {
            MenuBarLabel(app: app)
        }
        .menuBarExtraStyle(.window)
        #endif
    }
}
