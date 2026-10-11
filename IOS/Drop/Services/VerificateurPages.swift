#if os(macOS)
import AppKit
import SwiftUI
import WebKit
import DropKit

/// « Tout vérifier », la part du Mac : lire les pages de suivi officielles
/// (Mondial Relay, DHL, FedEx, GLS) depuis la connexion de ce Mac.
///
/// Comment :
/// - le serveur donne un petit lot de numeros d'un meme transporteur (avec un
///   bail : un Mac qui s'endort les rend a la file) ;
/// - une seule page WebKit (le moteur de Safari), reutilisee : chaque numero
///   s'y ouvre a son tour, on attend que le suivi s'affiche, on prend le texte
///   visible, on l'envoie au serveur -- qui le lit lui-meme et range le
///   resultat sous CE numero ;
/// - une pause de quelques secondes entre deux pages : le rythme d'une
///   personne, pas d'un robot ;
/// - la page est visible, dans une fenetre « Vérification des dépôts ». Si un
///   site affiche une verification anti-robot, on s'arrete pour ce
///   transporteur (le serveur le met en pause et marque ses colis
///   « Vérification bloquée ») et la fenetre passe devant : on peut resoudre
///   soi-meme le defi, puis relancer « Tout vérifier ».
///
/// Rien n'est contourne : pas de faux navigateur, pas de resolution de
/// CAPTCHA, pas de rotation d'adresses ; le bandeau de cookies n'est pas
/// touche (le suivi se lit sans).
@Observable
final class VerificateurPages: NSObject, WKNavigationDelegate {
    enum Etat: Equatable {
        case repos
        case lecture(nom: String, numero: String)
        case attente
        case bloque(nom: String)
    }

    private(set) var etat: Etat = .repos
    private(set) var enCours = false
    private(set) var pagesLues = 0
    /// ce que la fenetre affiche sous la page
    private(set) var message = "Prêt"

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var tache: Task<Void, Never>?
    @ObservationIgnored private var fenetre: NSPanel?
    @ObservationIgnored private(set) var vue: WKWebView?
    @ObservationIgnored private var attenteNavigation: CheckedContinuation<Void, Error>?
    @ObservationIgnored private var jetonNavigation: UUID?

    /// le nom de ce Mac, tel que le serveur l'affiche
    let agent: String = "Mac · \(Host.current().localizedName ?? "Mac")"

    init(app: AppModel) {
        self.app = app
        super.init()
    }

    func demarre() {
        guard tache == nil else { return }
        tache = Task { [weak self] in
            await self?.boucle()
            self?.tache = nil
        }
    }

    func arrete() {
        tache?.cancel()
    }

    // MARK: La boucle

    private func boucle() async {
        enCours = true
        pagesLues = 0
        defer {
            enCours = false
            if case .bloque = etat {} else { etat = .repos; fermeFenetre() }
        }
        var vides = 0
        while !Task.isCancelled {
            let lot: DepotTravail
            do {
                lot = try await app.api.travailCampagne(agent: agent, lot: 6)
            } catch {
                message = "Serveur injoignable : nouvel essai dans 10 s"
                try? await Task.sleep(for: .seconds(10))
                vides += 1
                if vides > 6 { break }
                continue
            }
            guard lot.campagne != nil else { break }
            if lot.items.isEmpty {
                // plus rien pour le Mac : l'API La Poste finit peut-etre ses
                // colis ; si la campagne n'attend plus le Mac, on s'arrete
                let etatCampagne = try? await app.api.campagne()
                if etatCampagne?.attendMac != true { break }
                etat = .attente
                message = "En attente…"
                vides += 1
                if vides > 20 { break }
                try? await Task.sleep(for: .seconds(4))
                continue
            }
            vides = 0
            ouvreFenetre()
            let pause = Double(lot.pauseMs ?? 2500) / 1000
            for (i, item) in lot.items.enumerated() {
                if Task.isCancelled { break }
                etat = .lecture(nom: item.nom, numero: item.numero)
                message = "\(item.nom) · \(item.numero)"
                let page = await lis(item)
                let reponse = try? await app.api.envoieResultats(agent: agent, [page])
                pagesLues += 1
                // la page de suivi du colis est rangee : la page du dashboard suit
                Task { await app.depots.relisCampagne() }
                if reponse?.resultats.first?.etat == "bloque" {
                    // une protection : arret pour ce transporteur, la fenetre passe devant
                    etat = .bloque(nom: item.nom)
                    message = "\(item.nom) affiche une vérification anti-robot : arrêt pour ce transporteur. Tu peux la résoudre ici, puis relancer « Tout vérifier »."
                    montreFenetre()
                    break
                }
                if i < lot.items.count - 1 { try? await Task.sleep(for: .seconds(pause)) }
            }
            try? await Task.sleep(for: .seconds(pause))
        }
        await app.depots.relisCampagne()
    }

    // MARK: Lire une page

    private func lis(_ item: DepotPageALire) async -> DepotPageLue {
        func erreur(_ texte: String) -> DepotPageLue {
            DepotPageLue(numero: item.numero, transporteur: item.transporteur, url: item.url, titre: nil, texte: nil, erreur: texte)
        }
        guard let url = URL(string: item.url), url.scheme == "https" else { return erreur("adresse invalide") }
        let vue = vueWeb()
        do {
            try await charge(url, dans: vue)
        } catch {
            return erreur("page non chargée (\(error.localizedDescription))")
        }
        // le suivi s'affiche apres le chargement (les sites le dessinent en
        // JavaScript) : on attend que le texte se stabilise, 15 s au plus
        var dernier = -1
        var stable = 0
        var lu: (titre: String, texte: String, url: String)?
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(500))
            if Task.isCancelled { break }
            guard let l = await texteVisible(vue) else { continue }
            lu = l
            if Self.pret(l.texte, l.titre, transporteur: item.transporteur) { break }
            if l.texte.count == dernier { stable += 1 } else { stable = 0; dernier = l.texte.count }
            if stable >= 4, l.texte.count > 200 { break }
        }
        guard let lu else { return erreur("page vide") }
        return DepotPageLue(numero: item.numero, transporteur: item.transporteur, url: lu.url, titre: lu.titre, texte: String(lu.texte.prefix(30_000)), erreur: nil)
    }

    /// le suivi est la (ou une protection, ou « numero inconnu ») : inutile d'attendre
    static func pret(_ texte: String, _ titre: String, transporteur: String) -> Bool {
        let t = texte.lowercased(), ti = titre.lowercased()
        if ti.contains("just a moment") || ti.contains("attention required") || ti.contains("access denied") { return true }
        switch transporteur {
        case "MR": return t.contains("suivi détaillé de mon colis") || t.contains("aucun colis portant")
        case "DHL": return t.contains("tentative de suivi a échoué") || t.contains("tracking attempt")
        case "GLS": return t.contains("no results") || t.contains("aucun résultat")
        case "FEDEX": return t.contains("duplicate results")
        default: return false
        }
    }

    private func texteVisible(_ vue: WKWebView) async -> (titre: String, texte: String, url: String)? {
        let js = "JSON.stringify({ titre: document.title || '', texte: (document.body && document.body.innerText) || '', url: location.href })"
        guard let brut = try? await vue.evaluateJavaScript(js) as? String,
              let data = brut.data(using: .utf8),
              let objet = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return nil }
        return (objet["titre"] ?? "", objet["texte"] ?? "", objet["url"] ?? "")
    }

    private func charge(_ url: URL, dans vue: WKWebView) async throws {
        termineNavigation(CancellationError())
        let jeton = UUID()
        jetonNavigation = jeton
        // 30 s au plus : une page qui ne finit pas de charger est une erreur
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard let self, self.jetonNavigation == jeton else { return }
            self.termineNavigation(URLError(.timedOut))
        }
        try await withCheckedThrowingContinuation { (suite: CheckedContinuation<Void, Error>) in
            attenteNavigation = suite
            vue.load(URLRequest(url: url, timeoutInterval: 25))
        }
    }

    private func termineNavigation(_ erreur: Error?) {
        guard let suite = attenteNavigation else { return }
        attenteNavigation = nil
        jetonNavigation = nil
        if let erreur { suite.resume(throwing: erreur) } else { suite.resume() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        termineNavigation(nil)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        termineNavigation((error as NSError).code == NSURLErrorCancelled ? nil : error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        termineNavigation((error as NSError).code == NSURLErrorCancelled ? nil : error)
    }

    // MARK: La fenetre

    /// la page WebKit, une seule, reutilisee (ses cookies sont gardes : un
    /// defi resolu une fois le reste)
    private func vueWeb() -> WKWebView {
        if let vue { return vue }
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()
        let v = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: conf)
        v.navigationDelegate = self
        vue = v
        return v
    }

    private func ouvreFenetre() {
        if fenetre == nil {
            let panneau = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
                styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panneau.title = "Vérification des dépôts"
            panneau.isFloatingPanel = false
            panneau.hidesOnDeactivate = false
            panneau.isReleasedWhenClosed = false
            panneau.contentView = NSHostingView(rootView: FenetreVerification(verificateur: self, page: vueWeb()))
            if let ecran = NSScreen.main?.visibleFrame {
                panneau.setFrameOrigin(NSPoint(x: ecran.maxX - 580, y: ecran.minY + 20))
            }
            fenetre = panneau
        }
        // devant, sans prendre le clavier ni l'activite en cours
        fenetre?.orderFront(nil)
    }

    private func montreFenetre() {
        ouvreFenetre()
        fenetre?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    private func fermeFenetre() {
        fenetre?.orderOut(nil)
    }
}

/// La fenetre : la page officielle en cours de lecture, et ou en est la verification.
private struct FenetreVerification: View {
    let verificateur: VerificateurPages
    let page: WKWebView

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Group {
                    switch verificateur.etat {
                    case .bloque: Image(systemName: "lock.fill").foregroundStyle(Theme.warn)
                    case .lecture: ProgressView().controlSize(.small)
                    default: Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.violetLight)
                    }
                }
                .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verificateur.message).font(.callout.weight(.semibold)).lineLimit(3)
                    Text("\(verificateur.pagesLues) page\(verificateur.pagesLues > 1 ? "s" : "") lue\(verificateur.pagesLues > 1 ? "s" : "") · une à la fois, depuis ce Mac")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if verificateur.enCours {
                    Button("Arrêter") { verificateur.arrete() }
                }
            }
            .padding(12)
            Divider()
            PageWeb(vue: page)
        }
        .frame(minWidth: 420, minHeight: 480)
    }
}

private struct PageWeb: NSViewRepresentable {
    let vue: WKWebView
    func makeNSView(context: Context) -> WKWebView { vue }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#endif
