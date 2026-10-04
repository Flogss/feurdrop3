import UserNotifications
#if canImport(UIKit)
import UIKit

/// Le relais UIKit : notifications au premier plan et jeton de push.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // Une notification qui arrive pendant qu'on a l'app sous les yeux s'affiche
    // quand meme, en banniere : c'est une vraie notification, pas une alerte.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    // Toucher la notification ouvre l'app sur le dashboard (rien a router de plus).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {}

    // MARK: Push distant -- pret pour le jour ou le serveur saura envoyer en APNs

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushRegistrar.shared.didFail(error)
    }
}
#else
import AppKit

/// Le relais AppKit : notifications, veille des nouveaux colis, et l'app qui
/// reste ouverte (barre des menus, notifications) quand on ferme sa fenetre.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        MacWatcher.shared.start()
        // la molette d'une souris glisse au lieu de sauter, comme dans un navigateur
        DefilementDoux.shared.demarre()
        #if DEBUG
        MacCapture.planifie()
        TestSouris.planifie()
        if let chemin = UserDefaults.standard.string(forKey: "DropTestDefilement") {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(UserDefaults.standard.double(forKey: "DropTestDelai").nonZero ?? 6))
                await DefilementDoux.shared.testeDefilement(chemin: chemin)
            }
        }
        #endif
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    // cliquer la notification ramene la fenetre de Drop
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run { NSApp.activate() }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.didRegister(token: deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushRegistrar.shared.didFail(error)
    }
}
#endif
