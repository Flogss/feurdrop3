import UIKit

/// AirPrint : la feuille d'impression native d'iOS (choix de l'imprimante,
/// copies, apercu). C'est l'equivalent du PDF ouvert dans un onglet sur le site.
@MainActor
enum Printer {
    static func present(_ file: URL, name: String) {
        let controleur = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = name
        controleur.printInfo = info
        controleur.printingItem = file
        controleur.present(animated: true)
    }
}
