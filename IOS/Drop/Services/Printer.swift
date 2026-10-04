#if canImport(UIKit)
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

#else
import AppKit
import PDFKit

/// Sur Mac : la fenetre d'impression du systeme, avec le PDF des etiquettes.
@MainActor
enum Printer {
    static func present(_ file: URL, name: String) {
        guard let document = PDFDocument(url: file) else { return }
        let info = NSPrintInfo.shared
        info.jobDisposition = .spool
        guard let operation = document.printOperation(for: info, scalingMode: .pageScaleToFit, autoRotate: true) else { return }
        operation.jobTitle = name
        if let fenetre = NSApp.keyWindow {
            operation.runModal(for: fenetre, delegate: nil, didRun: nil, contextInfo: nil)
        } else {
            operation.run()
        }
    }
}
#endif
