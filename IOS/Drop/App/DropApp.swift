import SwiftUI
import DropKit

@main
struct DropApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
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
    }
}
