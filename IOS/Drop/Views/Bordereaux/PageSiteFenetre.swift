#if os(macOS)
import SwiftUI
import AppKit
import WebKit
import DropKit

/// Une page du site (l'editeur, le comparateur de bordereaux) dans une fenetre
/// de l'app : exactement ce que fait le site, sans quitter Drop. La fenetre a
/// sa propre session, obtenue par un code a usage unique (60 s) demande par
/// l'app -- jamais le mot de passe, et jamais plus longue que la session de
/// l'app. Les cookies restent dans cette fenetre (WebKit), pas ailleurs.
struct PageSiteFenetre: View {
    let chemin: String
    @Environment(AppModel.self) private var app
    @State private var titre = "Bordereaux"
    @State private var chargement = true
    @State private var erreur: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            if app.connecte {
                PageSite(chemin: chemin, serveur: app.serverURL, api: app.api, titre: $titre, chargement: $chargement, erreur: $erreur)
                    .ignoresSafeArea()
                if chargement {
                    ProgressView().controlSize(.large)
                }
                if let erreur {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle").font(.system(size: 26)).foregroundStyle(Theme.warn)
                        Text(erreur).multilineTextAlignment(.center).frame(maxWidth: 420)
                    }
                    .padding(24)
                    .glassEffect(.regular, in: .rect(cornerRadius: 20))
                }
            } else {
                Text("Connecte-toi dans la fenêtre Drop").font(.title3.weight(.semibold))
            }
        }
        .navigationTitle(titre)
        .frame(minWidth: 1000, minHeight: 640)
    }
}

private struct PageSite: NSViewRepresentable {
    let chemin: String
    let serveur: URL
    let api: DropAPI
    @Binding var titre: String
    @Binding var chargement: Bool
    @Binding var erreur: String?

    func makeCoordinator() -> Coordinateur { Coordinateur(self) }

    func makeNSView(context: Context) -> WKWebView {
        let reglages = WKWebViewConfiguration()
        // les cookies de cette fenetre durent (72 h au plus, fixe par le serveur)
        reglages.websiteDataStore = .default()
        reglages.preferences.isElementFullscreenEnabled = true
        let vue = WKWebView(frame: .zero, configuration: reglages)
        vue.navigationDelegate = context.coordinator
        vue.uiDelegate = context.coordinator
        vue.allowsMagnification = false
        vue.setValue(false, forKey: "drawsBackground")
        context.coordinator.vue = vue
        context.coordinator.observe(vue)
        context.coordinator.charge(chemin)
        return vue
    }

    func updateNSView(_ vue: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    @MainActor
    final class Coordinateur: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        var parent: PageSite
        weak var vue: WKWebView?
        /// la page voulue, et si le pont a deja ete tente pour elle
        private var voulu: String
        private var pontTente = false
        private var observations: [NSKeyValueObservation] = []
        private var destinations: [ObjectIdentifier: URL] = [:]

        init(_ parent: PageSite) {
            self.parent = parent
            self.voulu = parent.chemin
        }

        func observe(_ vue: WKWebView) {
            observations.append(vue.observe(\.title, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in
                    if let t = v.title, !t.isEmpty { self?.parent.titre = t.replacingOccurrences(of: " · DROP.ctrl", with: "") }
                }
            })
        }

        func charge(_ chemin: String) {
            voulu = chemin
            pontTente = false
            guard let url = URL(string: chemin, relativeTo: parent.serveur) else { return }
            vue?.load(URLRequest(url: url))
        }

        private func estDuSite(_ url: URL) -> Bool {
            url.host() == parent.serveur.host() && url.port == parent.serveur.port
        }

        // sans session (ou session expiree), le site renvoie a sa page de
        // connexion : la fenetre demande alors un code a l'app, une fois
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if action.shouldPerformDownload { return .download }
            if !estDuSite(url) {
                // un lien exterieur (suivi d'un transporteur...) : le navigateur
                if action.navigationType == .linkActivated || action.targetFrame == nil { NSWorkspace.shared.open(url) }
                return url.scheme == "about" || url.scheme == "blob" ? .allow : .cancel
            }
            if url.path() == "/connexion" {
                guard !pontTente else {
                    parent.erreur = "La session de l'app a expiré : reconnecte-toi dans la fenêtre Drop."
                    parent.chargement = false
                    return .cancel
                }
                pontTente = true
                Task { await traverse() }
                return .cancel
            }
            return .allow
        }

        private func traverse() async {
            do {
                let lien = try await parent.api.pont(vers: voulu)
                guard let url = URL(string: lien, relativeTo: parent.serveur) else { return }
                vue?.load(URLRequest(url: url))
            } catch {
                parent.erreur = error.localizedDescription
                parent.chargement = false
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor reponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            // une piece jointe (« Fichier d'origine », un PDF exporte) : telechargee
            if let http = reponse.response as? HTTPURLResponse,
               (http.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment") {
                return .download
            }
            return reponse.canShowMIMEType ? .allow : .download
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.chargement = false
            if webView.url?.path() != "/connexion" { parent.erreur = nil }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { echec(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { echec(error) }

        private func echec(_ error: Error) {
            let code = (error as NSError).code
            // annulee par nous (le pont), ou devenue un telechargement : rien a dire
            if code == NSURLErrorCancelled || code == 102 { return }
            parent.chargement = false
            parent.erreur = error.localizedDescription
        }

        // target="_blank" : une page du site s'ouvre dans cette fenetre, le reste dans le navigateur
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if estDuSite(url) {
                    let chemin = url.path() + (url.query().map { "?\($0)" } ?? "")
                    if chemin.hasPrefix("/bordereaux") {
                        PagesSite.ouvre(chemin)
                    } else {
                        webView.load(URLRequest(url: url))
                    }
                } else {
                    NSWorkspace.shared.open(url)
                }
            }
            return nil
        }

        // les boites de dialogue du site (confirmer, demander un nom)
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
            let alerte = NSAlert()
            alerte.messageText = message
            alerte.runModal()
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
            let alerte = NSAlert()
            alerte.messageText = message
            alerte.addButton(withTitle: "Confirmer")
            alerte.addButton(withTitle: "Annuler")
            return alerte.runModal() == .alertFirstButtonReturn
        }

        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
            let alerte = NSAlert()
            alerte.messageText = prompt
            let champ = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
            champ.stringValue = defaultText ?? ""
            alerte.accessoryView = champ
            alerte.addButton(withTitle: "OK")
            alerte.addButton(withTitle: "Annuler")
            alerte.window.initialFirstResponder = champ
            return alerte.runModal() == .alertFirstButtonReturn ? champ.stringValue : nil
        }

        // --- telechargements : dans « Téléchargements », puis montres dans le Finder

        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            let dossier = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
            let nom = (suggestedFilename as NSString).lastPathComponent
            let base = (nom as NSString).deletingPathExtension
            let ext = (nom as NSString).pathExtension
            var cible = dossier.appendingPathComponent(nom)
            var n = 2
            while FileManager.default.fileExists(atPath: cible.path) {
                cible = dossier.appendingPathComponent("\(base) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"))
                n += 1
            }
            destinations[ObjectIdentifier(download)] = cible
            return cible
        }

        func downloadDidFinish(_ download: WKDownload) {
            if let cible = destinations.removeValue(forKey: ObjectIdentifier(download)) {
                NSWorkspace.shared.activateFileViewerSelecting([cible])
            }
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            destinations.removeValue(forKey: ObjectIdentifier(download))
            parent.erreur = "Téléchargement impossible : \(error.localizedDescription)"
        }
    }
}

/// Les fenetres des pages du site : une par page ouverte (l'editeur d'une
/// etiquette, le comparateur...), de vraies fenetres du Mac.
@MainActor
enum PagesSite {
    private static var ouvertes: [NSWindow] = []

    static func ouvre(_ chemin: String) {
        // deja ouverte : elle passe devant
        if let deja = ouvertes.first(where: { $0.identifier?.rawValue == chemin }) {
            deja.makeKeyAndOrderFront(nil)
            return
        }
        let vue = PageSiteFenetre(chemin: chemin)
            .environment(AppModel.shared)
            .preferredColorScheme(.dark)
            .tint(Theme.violet)
        let fenetre = NSWindow(contentViewController: NSHostingController(rootView: vue))
        fenetre.identifier = NSUserInterfaceItemIdentifier(chemin)
        fenetre.title = chemin.contains("comparer") ? "Comparer des bordereaux" : chemin.contains("editeur") ? "Éditeur de bordereau" : "Bordereaux"
        fenetre.styleMask.insert([.titled, .closable, .miniaturizable, .resizable])
        // une barre fine et sombre, sans titre : la page prend toute la fenetre
        fenetre.titlebarAppearsTransparent = true
        fenetre.titleVisibility = .hidden
        fenetre.backgroundColor = NSColor(Theme.background)
        fenetre.isReleasedWhenClosed = false
        fenetre.setContentSize(NSSize(width: 1480, height: 920))
        fenetre.center()
        fenetre.setFrameAutosaveName("drop.page-site")
        fenetre.makeKeyAndOrderFront(nil)
        ouvertes.append(fenetre)
        let id = ObjectIdentifier(fenetre)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: fenetre, queue: .main) { _ in
            MainActor.assumeIsolated {
                ouvertes.removeAll { ObjectIdentifier($0) == id }
            }
        }
    }
}
#endif
