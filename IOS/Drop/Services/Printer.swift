#if canImport(UIKit)
import UIKit

/// AirPrint : la feuille d'impression native d'iOS (choix de l'imprimante,
/// copies, apercu). C'est l'equivalent du PDF ouvert dans un onglet sur le site.
/// `termine(true)` : l'impression est partie ; `false` : annulee ou en echec --
/// les etiquettes ne doivent alors pas etre marquees imprimees.
@MainActor
enum Printer {
    static func present(_ file: URL, name: String, termine: @escaping (Bool) -> Void = { _ in }) {
        let controleur = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = name
        controleur.printInfo = info
        controleur.printingItem = file
        controleur.present(animated: true) { _, imprime, erreur in
            termine(imprime && erreur == nil)
        }
    }
}

#else
import AppKit
import PDFKit

/// Sur Mac : la fenetre d'impression du systeme, avec le PDF des etiquettes.
/// `termine(true)` : l'impression est partie ; `false` : annulee.
@MainActor
enum Printer {
    static func present(_ file: URL, name: String, termine: @escaping (Bool) -> Void = { _ in }) {
        guard let document = PDFDocument(url: file) else { return termine(false) }
        let info = NSPrintInfo.shared
        info.jobDisposition = .spool
        guard let operation = document.printOperation(for: info, scalingMode: .pageScaleToFit, autoRotate: true) else { return termine(false) }
        operation.jobTitle = name
        if let fenetre = NSApp.keyWindow {
            let suivi = Suivi(termine)
            Suivi.enCours = suivi
            operation.runModal(for: fenetre, delegate: suivi, didRun: #selector(Suivi.fini(_:reussi:contexte:)), contextInfo: nil)
        } else {
            termine(operation.run())
        }
    }

    /// recoit la fin de la fenetre d'impression (AppKit appelle ce selecteur)
    private final class Suivi: NSObject {
        static var enCours: Suivi?
        let termine: (Bool) -> Void
        init(_ termine: @escaping (Bool) -> Void) { self.termine = termine }

        @objc func fini(_ operation: NSPrintOperation, reussi: Bool, contexte: UnsafeMutableRawPointer?) {
            termine(reussi)
            Suivi.enCours = nil
        }
    }
}
#endif
