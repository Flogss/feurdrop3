#if os(macOS) && DEBUG
import AppKit
import WebKit
import ScreenCaptureKit

/// Verification en developpement d'une page du site dans sa fenetre de l'app
/// (l'editeur de bordereaux), sans toucher a la vraie souris ni au clavier :
/// `-DropScenario /chemin/scenario.json` joue, une fois la page chargee, des
/// etapes dans la VRAIE fenetre (evenements de souris et de clavier envoyes a
/// la fenetre, que WebKit traite comme les vrais), et la photographie.
///
///     { "etapes": [
///         { "attente": 1.5 },
///         { "js": "return document.title", "nom": "titre" },
///         { "glisse": "return [[x0, y0], [x1, y1]]", "pas": 14, "mod": ["shift"] },
///         { "clic": "return [x, y]", "mod": ["cmd"], "double": true },
///         { "touche": "z", "mod": ["cmd"] },
///         { "depose": { "fichier": "/tmp/image.png", "point": "return [x, y]" } },
///         { "photo": "/tmp/etape.png" } ] }
///
/// Les points sont en points de la page (origine en haut a gauche), calcules
/// par du JavaScript dans la page ; le journal est ecrit a cote du scenario.
@MainActor
enum ScenarioPage {
    private static var joue = false

    static func lanceSiDemande(_ vue: WKWebView) {
        guard !joue, let chemin = UserDefaults.standard.string(forKey: "DropScenario") else { return }
        joue = true
        // la fenetre de verification est souvent cachee par d'autres : WebKit
        // cesserait alors de dessiner (photos noires), ce qui n'arrive pas a
        // une fenetre qu'on regarde
        let reglage = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if vue.responds(to: reglage) { vue.perform(reglage, with: nil) } // nil : NO
        Task { @MainActor in await deroule(chemin, vue) }
    }

    private static func deroule(_ chemin: String, _ vue: WKWebView) async {
        var journal: [String] = []
        let ecrit = { try? journal.joined(separator: "\n").write(toFile: chemin + ".journal.txt", atomically: true, encoding: .utf8) }
        guard let donnees = FileManager.default.contents(atPath: chemin),
              let racine = try? JSONSerialization.jsonObject(with: donnees) as? [String: Any],
              let etapes = racine["etapes"] as? [[String: Any]] else {
            journal.append("scenario illisible")
            ecrit()
            return
        }
        try? await Task.sleep(for: .seconds(1.5))
        guard let fenetre = vue.window else { journal.append("pas de fenetre"); ecrit(); return }
        fenetre.makeKey()
        fenetre.makeFirstResponder(vue)
        for (i, etape) in etapes.enumerated() {
            do {
                let resultat = try await joue(etape, vue, fenetre)
                journal.append("\(i) ok \(etape["nom"] as? String ?? "") \(resultat)")
            } catch {
                journal.append("\(i) ECHEC \(error)")
            }
            ecrit()
        }
        journal.append("fini")
        ecrit()
    }

    private static func points(_ valeur: Any?, _ vue: WKWebView) async throws -> [CGPoint] {
        var brut = valeur
        if let code = valeur as? String { brut = try await vue.callAsyncJavaScript(code, contentWorld: .page) }
        if let p = brut as? [NSNumber], p.count == 2 { return [CGPoint(x: p[0].doubleValue, y: p[1].doubleValue)] }
        guard let liste = brut as? [[NSNumber]] else { throw NSError(domain: "scenario", code: 1, userInfo: [NSLocalizedDescriptionKey: "points illisibles : \(String(describing: brut))"]) }
        return liste.map { CGPoint(x: $0[0].doubleValue, y: $0[1].doubleValue) }
    }

    private static func modificateurs(_ etape: [String: Any]) -> NSEvent.ModifierFlags {
        var m: NSEvent.ModifierFlags = []
        for k in etape["mod"] as? [String] ?? [] {
            switch k {
            case "cmd": m.insert(.command)
            case "shift": m.insert(.shift)
            case "alt": m.insert(.option)
            case "ctrl": m.insert(.control)
            default: break
            }
        }
        return m
    }

    private static func joue(_ etape: [String: Any], _ vue: WKWebView, _ fenetre: NSWindow) async throws -> String {
        let mods = modificateurs(etape)
        // un point de la page -> un point de la fenetre
        let fenetreDe = { (p: CGPoint) -> CGPoint in
            vue.convert(CGPoint(x: p.x, y: vue.isFlipped ? p.y : vue.bounds.height - p.y), to: nil)
        }
        let souris = { (type: NSEvent.EventType, p: CGPoint, clics: Int) in
            if let e = NSEvent.mouseEvent(with: type, location: fenetreDe(p), modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: fenetre.windowNumber, context: nil, eventNumber: 0, clickCount: clics,
                                          pressure: type == .leftMouseUp || type == .mouseMoved ? 0 : 1) {
                fenetre.sendEvent(e)
            }
        }
        // `"taille": [1100, 720]` : la fenetre a cette taille (points)
        if let t = etape["taille"] as? [NSNumber], t.count == 2 {
            fenetre.setContentSize(NSSize(width: t[0].doubleValue, height: t[1].doubleValue))
            try await Task.sleep(for: .milliseconds(600))
            return "\(t)"
        }
        if let s = etape["attente"] as? Double {
            try await Task.sleep(for: .seconds(s))
            return ""
        }
        if let code = etape["js"] as? String, etape["glisse"] == nil, etape["clic"] == nil {
            let r = try await vue.callAsyncJavaScript(code, contentWorld: .page)
            // `"fichier": "/tmp/x.pdf"` : le resultat (base64) ecrit sur le disque
            if let fichier = etape["fichier"] as? String, let b64 = r as? String, let donnees = Data(base64Encoded: b64) {
                try donnees.write(to: URL(fileURLWithPath: fichier))
                return "\(fichier) (\(donnees.count) octets)"
            }
            return String(describing: r ?? "nil")
        }
        if let chemin = etape["photo"] as? String {
            try await photographie(fenetre, chemin)
            return chemin
        }
        if let cible = etape["clicDroit"] {
            let p = try await points(cible, vue)[0]
            for type in [NSEvent.EventType.rightMouseDown, .rightMouseUp] {
                if let e = NSEvent.mouseEvent(with: type, location: fenetreDe(p), modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: fenetre.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .rightMouseDown ? 1 : 0) {
                    fenetre.sendEvent(e)
                }
                try await Task.sleep(for: .milliseconds(40))
            }
            return "\(p)"
        }
        if let cible = etape["clic"] {
            let p = try await points(cible, vue)[0]
            let fois = (etape["double"] as? Bool) == true ? 2 : 1
            for n in 1...fois {
                souris(.leftMouseDown, p, n)
                try await Task.sleep(for: .milliseconds(30))
                souris(.leftMouseUp, p, n)
                try await Task.sleep(for: .milliseconds(60))
            }
            return "\(p)"
        }
        if let chemin = etape["glisse"] {
            let liste = try await points(chemin, vue)
            guard let premier = liste.first else { return "vide" }
            let pas = etape["pas"] as? Int ?? 12
            souris(.mouseMoved, premier, 0)
            souris(.leftMouseDown, premier, 1)
            var precedent = premier
            for p in liste.dropFirst() {
                for k in 1...pas {
                    let f = CGFloat(k) / CGFloat(pas)
                    try await Task.sleep(for: .milliseconds(16))
                    souris(.leftMouseDragged, CGPoint(x: precedent.x + (p.x - precedent.x) * f, y: precedent.y + (p.y - precedent.y) * f), 1)
                }
                precedent = p
            }
            if let photo = etape["photoPendant"] as? String { try await photographie(fenetre, photo) }
            souris(.leftMouseUp, precedent, 1)
            return "\(liste)"
        }
        if let touche = etape["touche"] as? String {
            let codes: [String: UInt16] = ["z": 6, "y": 16, "d": 2, "a": 0, "0": 29, "=": 24, "-": 27, "v": 9, "escape": 53, "return": 36, "delete": 51]
            let caracteres = touche == "escape" ? "\u{1b}" : touche == "return" ? "\r" : touche == "delete" ? "\u{7f}" : touche
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                guard let e = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: fenetre.windowNumber, context: nil, characters: caracteres,
                                               charactersIgnoringModifiers: caracteres, isARepeat: false, keyCode: codes[touche] ?? 0) else { continue }
                // le chemin d'AppKit : equivalents clavier de la fenetre, puis
                // du menu, puis la vue qui a le clavier
                if type == .keyDown, mods.contains(.command) {
                    if fenetre.performKeyEquivalent(with: e) { continue }
                    if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return "menu" }
                }
                fenetre.sendEvent(e)
            }
            return touche
        }
        if let depot = etape["depose"] as? [String: Any], let fichier = depot["fichier"] as? String {
            // le Finder ne se pilote pas d'ici : le fichier arrive dans la page
            // comme un depot (memes evenements dragenter/dragover/drop)
            guard let octets = FileManager.default.contents(atPath: fichier) else { throw NSError(domain: "scenario", code: 2, userInfo: [NSLocalizedDescriptionKey: "fichier introuvable"]) }
            let p = try await points(depot["point"], vue)[0]
            let nom = (fichier as NSString).lastPathComponent
            let type = nom.lowercased().hasSuffix(".jpg") || nom.lowercased().hasSuffix(".jpeg") ? "image/jpeg" : "image/png"
            // le survol (le cadre vise s'allume), photographie, puis le lacher
            _ = try await vue.callAsyncJavaScript("""
                const brut = atob(b64); const o = new Uint8Array(brut.length);
                for (let i = 0; i < brut.length; i++) o[i] = brut.charCodeAt(i);
                const dt = new DataTransfer(); dt.items.add(new File([o], nom, { type }));
                const cible = document.elementFromPoint(x, y) || document.body;
                window.__depot = { dt, cible };
                for (const t of ["dragenter", "dragover"]) cible.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
                """, arguments: ["b64": octets.base64EncodedString(), "nom": nom, "type": type, "x": p.x, "y": p.y], contentWorld: .page)
            try await Task.sleep(for: .seconds(depot["survol"] as? Double ?? 0.2))
            if let photo = depot["photoSurvol"] as? String { try await photographie(fenetre, photo) }
            let r = try await vue.callAsyncJavaScript("""
                const { dt, cible } = window.__depot;
                cible.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
                return cible.className || cible.tagName;
                """, arguments: ["x": p.x, "y": p.y], contentWorld: .page)
            return "\(nom) -> \(String(describing: r ?? ""))"
        }
        return "etape inconnue"
    }

    /// la fenetre telle que macOS la compose (sans le curseur) ; ecran
    /// verrouille (rien n'est compose), l'instantane de la page par WebKit
    static func photographie(_ fenetre: NSWindow, _ chemin: String) async throws {
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any], session["CGSSessionScreenIsLocked"] as? Bool == true,
           let vue = trouveVue(fenetre.contentView) {
            let config = WKSnapshotConfiguration()
            config.afterScreenUpdates = true
            let image = try await vue.takeSnapshot(configuration: config)
            guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            try NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: chemin))
            return
        }
        try await photographieFenetre(fenetre, chemin)
    }

    private static func trouveVue(_ v: NSView?) -> WKWebView? {
        guard let v else { return nil }
        if let w = v as? WKWebView { return w }
        for s in v.subviews { if let w = trouveVue(s) { return w } }
        return nil
    }

    static func photographieFenetre(_ fenetre: NSWindow, _ chemin: String) async throws {
        let contenu = try await SCShareableContent.currentProcess
        guard let f = contenu.windows.first(where: { $0.windowID == CGWindowID(fenetre.windowNumber) }) else { return }
        let config = SCStreamConfiguration()
        config.width = Int(f.frame.width * 2)
        config.height = Int(f.frame.height * 2)
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: f), configuration: config)
        try NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: chemin))
    }
}
#endif
