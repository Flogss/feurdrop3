#if os(macOS) && (DEBUG || PERF_HOOKS)
import AppKit
import ScreenCaptureKit
import CoreImage
import CoreMedia
import DropKit

/// Verification en developpement : `-DropCapture /chemin.png -DropPageMac stats`
/// photographie la fenetre de l'app (ses propres fenetres seulement, sans
/// autorisation d'enregistrement d'ecran) apres quelques secondes.
@MainActor
enum MacCapture {
    static func planifie() {
        let reglages = UserDefaults.standard
        if let dossier = reglages.string(forKey: "DropFilm") {
            Task { @MainActor in await filme(dossier) }
        }
        guard let chemin = reglages.string(forKey: "DropCapture") else { return }
        if let nom = reglages.string(forKey: "DropPageMac"), let page = MacPage(rawValue: nom) {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2.5))
                NotificationCenter.default.post(name: .dropAllerA, object: page)
            }
        }
        // `-DropDeplier printed:LP` deplie une categorie d'Imprime avant la photo
        if let cle = reglages.string(forKey: "DropDeplier") {
            let morceaux = cle.split(separator: ":").map(String.init)
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(4))
                if morceaux.count == 2, let scope = PrintScope(rawValue: morceaux[0]) {
                    AppModel.shared.printing.toggle(morceaux[1], scope)
                }
            }
        }
        let delai = reglages.double(forKey: "DropCaptureDelai")
        // `-DropArbre 1` : la hierarchie des vues AppKit de la fenetre, a cote de la photo
        if reglages.bool(forKey: "DropArbre") {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(max(delai - 1, 3)))
                var lignes: [String] = []
                @MainActor func parcours(_ v: NSView, _ n: Int) {
                    lignes.append(String(repeating: "  ", count: n) + "\(type(of: v)) \(v.frame)" + ((v as? NSScrollView).map { " [scroll doc=\(type(of: $0.documentView as Any)) flipped=\($0.documentView?.isFlipped ?? false)]" } ?? ""))
                    for s in v.subviews { parcours(s, n + 1) }
                }
                if let racine = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 600 })?.contentView?.superview { parcours(racine, 0) }
                try? lignes.joined(separator: "\n").write(toFile: chemin + ".arbre.txt", atomically: true, encoding: .utf8)
            }
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delai > 0 ? delai : 6))
            await photographie(chemin)
        }
    }

    /// `-DropFilm /dossier` : filme la fenetre des son apparition, 6 s --
    /// l'instant de chaque image que macOS compose vraiment (une saccade
    /// visible = un ecart de plus d'une image), et les images du debut.
    static func filme(_ dossier: String) async {
        var fenetre: SCWindow?
        for _ in 0..<120 {
            if let principale = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 600 && $0.frame.height > 400 }),
               let contenu = try? await SCShareableContent.currentProcess,
               let f = contenu.windows.first(where: { $0.windowID == CGWindowID(principale.windowNumber) }) {
                fenetre = f
                break
            }
            try? await Task.sleep(for: .milliseconds(25))
        }
        let trace = { (texte: String) in try? texte.write(toFile: dossier + "/film-etape.txt", atomically: true, encoding: .utf8) }
        guard let fenetre else { trace("pas de fenetre"); return }
        trace("fenetre \(fenetre.frame)")
        let config = SCStreamConfiguration()
        config.width = Int(fenetre.frame.width / 2)
        config.height = Int(fenetre.frame.height / 2)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
        config.queueDepth = 8
        config.showsCursor = false
        // `-DropFilmDebut 8 -DropFilmDuree 25` : filmer plus tard, plus longtemps
        // (les transitions de page du parcours `-DropTestPages`)
        let reglages = UserDefaults.standard
        let debut = reglages.double(forKey: "DropFilmDebut")
        let duree = reglages.double(forKey: "DropFilmDuree")
        if debut > 0 { try? await Task.sleep(for: .seconds(debut)) }
        let film = Film(dossier: dossier)
        let flux = SCStream(filter: SCContentFilter(desktopIndependentWindow: fenetre), configuration: config, delegate: nil)
        do {
            try flux.addStreamOutput(film, type: .screen, sampleHandlerQueue: film.file)
            try await flux.startCapture()
            trace("capture en cours")
            try? await Task.sleep(for: .seconds(duree > 0 ? duree : 6))
            try await flux.stopCapture()
        } catch {
            try? "erreur: \(error)".write(toFile: dossier + "/film-erreur.txt", atomically: true, encoding: .utf8)
        }
        film.ecrit()
    }

    nonisolated final class Film: NSObject, SCStreamOutput, @unchecked Sendable {
        let dossier: String
        let file = DispatchQueue(label: "drop.film")
        var images: [(temps: Double, statut: Int)] = []
        var photos: [(Int, CGImage)] = []
        let contexte = CIContext()
        init(dossier: String) { self.dossier = dossier }

        func stream(_ stream: SCStream, didOutputSampleBuffer tampon: CMSampleBuffer, of type: SCStreamOutputType) {
            guard let infos = CMSampleBufferGetSampleAttachmentsArray(tampon, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let info = infos.first, let brut = info[.status] as? Int else { return }
            let temps = CMSampleBufferGetPresentationTimeStamp(tampon).seconds
            images.append((temps, brut))
            // les images du debut (1,5 s), puis une sur dix
            guard brut == SCFrameStatus.complete.rawValue, let pixels = CMSampleBufferGetImageBuffer(tampon) else { return }
            let i = images.count - 1
            let debut = images.first?.temps ?? temps
            guard temps - debut < 1.5 || i % 10 == 0 else { return }
            let ci = CIImage(cvPixelBuffer: pixels)
            if let cg = contexte.createCGImage(ci, from: ci.extent) { photos.append((i, cg)) }
        }

        func ecrit() {
            file.sync {
                let debut = images.first?.temps ?? 0
                let completes = images.filter { $0.statut == SCFrameStatus.complete.rawValue }
                var lignes = images.map { String(format: "%.4f;%d", $0.temps - debut, $0.statut) }
                let ecarts = zip(completes.dropFirst(), completes).map { ($0.temps - $1.temps) * 1000 }
                let sauts = zip(completes.dropFirst(), ecarts).filter { $0.1 > 25 }.map { String(format: "%.2fs:%.0fms", $0.0.temps - debut, $0.1) }
                lignes.insert("# \(completes.count) images composees sur \(images.count) ; ecarts > 25 ms : \(sauts.count) \(sauts.joined(separator: " "))", at: 0)
                try? lignes.joined(separator: "\n").write(toFile: dossier + "/film.txt", atomically: true, encoding: .utf8)
                for (i, cg) in photos {
                    let rep = NSBitmapImageRep(cgImage: cg)
                    try? rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7])?
                        .write(to: URL(fileURLWithPath: dossier + String(format: "/f%03d.jpg", i)))
                }
            }
        }
    }

    /// photographie la fenetre principale de l'app (sans le curseur)
    static func photographie(_ chemin: String) async {
            do {
                let contenu = try await SCShareableContent.currentProcess
                let liste = contenu.windows.map { "\($0.windowID) \($0.title ?? "-") \($0.frame) layer=\($0.windowLayer) visible=\($0.isOnScreen)" }.joined(separator: "\n")
                try? liste.write(toFile: chemin + ".fenetres.txt", atomically: true, encoding: .utf8)
                let principale = NSApp.windows.first { $0.isVisible && $0.frame.width > 600 }
                guard let fenetre = contenu.windows.first(where: { $0.windowID == CGWindowID(principale?.windowNumber ?? -1) })
                        ?? contenu.windows.filter({ $0.windowLayer == 0 && $0.isOnScreen }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return }
                let filtre = SCContentFilter(desktopIndependentWindow: fenetre)
                let config = SCStreamConfiguration()
                config.width = Int(fenetre.frame.width * 2)
                config.height = Int(fenetre.frame.height * 2)
                config.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filtre, configuration: config)
                let rep = NSBitmapImageRep(cgImage: image)
                try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: chemin))
            } catch {
                try? "erreur: \(error)".write(toFile: chemin + ".txt", atomically: true, encoding: .utf8)
            }
    }
}
#endif


#if os(macOS) && DEBUG
/// Verification en developpement, sans toucher a la vraie souris : des
/// evenements de souris envoyes a la fenetre de l'app.
/// `-DropTestSouris survol -DropSurvol 400,300` : le pointeur va a (x, y)
/// (en points depuis le haut a gauche) ; `-DropTestSouris tirer` : tire le
/// premier graphique horizontal de 300 points vers la droite.
@MainActor
enum TestSouris {
    static func planifie() {
        let reglages = UserDefaults.standard
        guard let quoi = reglages.string(forKey: "DropTestSouris") else { return }
        let sortie = reglages.string(forKey: "DropTestSortie") ?? "/tmp/drop-test-souris.txt"
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(reglages.double(forKey: "DropTestDelai").nonZero ?? 5))
            guard let fenetre = NSApp.windows.first(where: { $0.isVisible && $0.frame.width > 600 }),
                  let racine = fenetre.contentView else { return }
            let hauteur = racine.bounds.height
            @MainActor func envoie(_ type: NSEvent.EventType, _ x: CGFloat, _ yHaut: CGFloat) {
                guard let e = NSEvent.mouseEvent(with: type, location: CGPoint(x: x, y: hauteur - yHaut), modifierFlags: [],
                                                 timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: fenetre.windowNumber,
                                                 context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1) else { return }
                fenetre.sendEvent(e)
            }
            switch quoi {
            case "balayage":
                // une photo sans pointeur, puis une a chaque point (x,y;x,y...)
                let dossier = reglages.string(forKey: "DropTestSortie") ?? "/tmp"
                let points = (reglages.string(forKey: "DropBalayage") ?? "").split(separator: ";").compactMap { paire -> CGPoint? in
                    let n = paire.split(separator: ",").compactMap { Double($0) }
                    return n.count == 2 ? CGPoint(x: n[0], y: n[1]) : nil
                }
                await MacCapture.photographie(dossier + "/survol-ref.png")
                var precedent = CGPoint(x: 10, y: 40)
                for (i, p) in points.enumerated() {
                    for k in 1...8 {
                        let f = CGFloat(k) / 8
                        envoie(.mouseMoved, precedent.x + (p.x - precedent.x) * f, precedent.y + (p.y - precedent.y) * f)
                        try? await Task.sleep(for: .milliseconds(25))
                    }
                    precedent = p
                    try? await Task.sleep(for: .milliseconds(700))
                    await MacCapture.photographie(dossier + "/survol-\(i).png")
                }
                try? "fini".write(toFile: dossier + "/survol-fini.txt", atomically: true, encoding: .utf8)
            case "survol":
                let morceaux = (reglages.string(forKey: "DropSurvol") ?? "400,300").split(separator: ",").compactMap { Double($0) }
                guard morceaux.count == 2 else { return }
                for k in 0...12 {
                    let f = CGFloat(k) / 12
                    envoie(.mouseMoved, 40 + (morceaux[0] - 40) * f, 40 + (morceaux[1] - 40) * f)
                    try? await Task.sleep(for: .milliseconds(30))
                }
            case "tirer":
                var trouvee: NSScrollView?
                @MainActor func cherche(_ v: NSView) {
                    if trouvee == nil, let sv = v as? NSScrollView, let doc = sv.documentView,
                       doc.frame.width > sv.contentView.bounds.width + 1, doc.frame.height <= sv.contentView.bounds.height + 1 { trouvee = sv; return }
                    v.subviews.forEach(cherche)
                }
                cherche(racine)
                guard let sv = trouvee else { try? "pas de graphique".write(toFile: sortie, atomically: true, encoding: .utf8); return }
                let cadre = sv.convert(sv.bounds, to: nil)
                let x0 = cadre.midX, y0 = hauteur - cadre.midY
                let avant = sv.contentView.bounds.origin.x
                envoie(.leftMouseDown, x0, y0)
                for k in 1...15 {
                    try? await Task.sleep(for: .milliseconds(16))
                    envoie(.leftMouseDragged, x0 + CGFloat(k) * 20, y0)
                }
                let pendant = sv.contentView.bounds.origin.x
                envoie(.leftMouseUp, x0 + 300, y0)
                try? await Task.sleep(for: .seconds(1.2))
                let apres = sv.contentView.bounds.origin.x
                try? "avant \(avant)  apres le glisser \(pendant)  apres l'elan \(apres)".write(toFile: sortie, atomically: true, encoding: .utf8)
            default: break
            }
        }
    }
}
#endif
