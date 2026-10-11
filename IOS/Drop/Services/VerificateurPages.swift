#if os(macOS)
import AppKit
import SwiftUI
import WebKit
import DropKit

/// La part du Mac dans le controle des depots : lire les pages de suivi
/// officielles (Mondial Relay, GLS, et DHL tant que sa cle d'API n'est pas
/// posee) depuis la connexion de ce Mac.
///
/// Tout seul, tant que l'app est ouverte (meme fenetre fermee) :
/// - toutes les 10 s, l'app se signale au serveur (le site et l'iPhone voient
///   « Mac en ligne ») et demande s'il y a des pages a lire : une campagne
///   « Tout vérifier » lancee d'ailleurs, ou la file des numeros dont l'heure
///   est venue ;
/// - le serveur donne un petit lot de numeros d'un meme transporteur (avec un
///   bail : un Mac qui s'endort les rend a la file) ;
/// - une seule page WebKit (le moteur de Safari), reutilisee, avec un profil
///   garde (cookies, consentement) : chaque numero s'y ouvre a son tour, on
///   attend que le suivi s'affiche (sinon un rechargement, un seul), on prend
///   le texte visible, on l'envoie -- le serveur le lit lui-meme et range le
///   resultat sous CE numero ;
/// - une pause entre deux pages, propre a chaque site (le rythme d'une
///   personne, pas d'un robot).
///
/// La lecture en fond se fait hors de l'ecran ; « Tout vérifier » lance depuis
/// ce Mac l'affiche dans une fenetre. Un bandeau de cookies est accepte (le
/// choix est garde dans le profil) ; ce n'est pas une protection. Une
/// verification anti-robot, si : on s'arrete pour ce transporteur (le serveur
/// le met en pause et marque ses colis « Vérification bloquée ») et la fenetre
/// s'affiche, sans rien tenter. Pas de faux navigateur, pas de resolution de
/// CAPTCHA, pas de rotation d'adresses.
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
    /// le dernier signal accepte par le serveur
    private(set) var signaleLe: Date?

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private var tache: Task<Void, Never>?
    @ObservationIgnored private var veilleTache: Task<Void, Never>?
    @ObservationIgnored private var activite: NSObjectProtocol?
    @ObservationIgnored private var fenetre: NSPanel?
    /// la fenetre hors de l'ecran qui porte la page pendant une lecture en fond
    @ObservationIgnored private var horsEcran: NSWindow?
    /// la place de la page dans la fenetre visible
    @ObservationIgnored private let conteneur = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 600))
    @ObservationIgnored private(set) var vue: WKWebView?
    @ObservationIgnored private var attenteNavigation: CheckedContinuation<Void, Error>?
    @ObservationIgnored private var jetonNavigation: UUID?
    /// la lecture en cours a ete demandee ici (fenetre visible)
    @ObservationIgnored private var visible = false

    /// le nom de ce Mac, tel que le serveur l'affiche
    let agent: String = "Mac · \(Host.current().localizedName ?? "Mac")"

    init(app: AppModel) {
        self.app = app
        super.init()
    }

    // MARK: La veille (au niveau de l'app)

    /// Lancee au demarrage de l'app (AppDelegate), pour toute sa vie : le
    /// signal toutes les 10 s, et la lecture des qu'il y a des pages.
    func veille() {
        guard veilleTache == nil else { return }
        // une lecture de fond ne doit pas etre endormie par App Nap (la mise en
        // veille du Mac, elle, reste permise)
        activite = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep],
            reason: "Lecture des pages de suivi officielles pour le contrôle des dépôts"
        )
        veilleTache = Task { [weak self] in
            while !Task.isCancelled {
                await self?.signale()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private func signale() async {
        guard app.connecte else { return }
        guard let signal = try? await app.api.signaleAgent(nom: agent) else { return }
        signaleLe = .now
        if signal.aLire > 0, !enCours { demarre(visible: false) }
    }

    /// Lit les pages dues. `visible` : la fenetre s'affiche (une demande faite
    /// sur ce Mac) ; sinon la lecture se fait hors de l'ecran.
    func demarre(visible: Bool = false) {
        if visible {
            self.visible = true
            if enCours { ouvreFenetre() }
        }
        guard tache == nil else { return }
        if !visible { self.visible = false }
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
            if case .bloque = etat {} else {
                etat = .repos
                fermeFenetre()
            }
            rangeHorsEcran()
        }
        var vides = 0
        while !Task.isCancelled {
            let lot: DepotTravail
            do {
                lot = try await app.api.travailCampagne(agent: agent, lot: 6)
            } catch {
                message = "Serveur injoignable : nouvel essai dans 10 s"
                vides += 1
                if vides > 6 { break }
                try? await Task.sleep(for: .seconds(10))
                continue
            }
            if lot.items.isEmpty {
                // plus rien pour le Mac (ou tout est deja pris) : un dernier coup
                // d'oeil, puis la veille reprend la main
                guard let signal = try? await app.api.signaleAgent(nom: agent), signal.aLire > 0 else { break }
                etat = .attente
                message = "En attente…"
                vides += 1
                if vides > 15 { break }
                try? await Task.sleep(for: .seconds(4))
                continue
            }
            vides = 0
            if visible { ouvreFenetre() } else { installeHorsEcran() }
            let pause = Double(lot.pauseMs ?? 3000) / 1000
            var bloque = false
            for (i, item) in lot.items.enumerated() {
                if Task.isCancelled { break }
                etat = .lecture(nom: item.nom, numero: item.numero)
                message = "\(item.nom) · \(item.numero)"
                let page = await lis(item)
                let reponse = try? await app.api.envoieResultats(agent: agent, [page])
                pagesLues += 1
                // la page du controle suit (si elle est ouverte)
                Task { await app.depots.relisCampagne() }
                if reponse?.resultats.first?.etat == "bloque" {
                    // une protection : arret pour ce transporteur, la fenetre s'affiche
                    etat = .bloque(nom: item.nom)
                    message = "\(item.nom) affiche une vérification anti-robot : arrêt pour ce transporteur, rien n'est tenté. Elle reprendra plus tard, ou à la prochaine « Tout vérifier »."
                    montreFenetre()
                    bloque = true
                    break
                }
                if i < lot.items.count - 1 { try? await Task.sleep(for: .seconds(pause)) }
            }
            // apres un blocage, le serveur ne redonne plus ce transporteur : les
            // autres continuent
            if !bloque { try? await Task.sleep(for: .seconds(pause)) }
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
        var lu: (titre: String, texte: String, url: String)?
        // le suivi s'affiche apres le chargement (les sites le dessinent en
        // JavaScript) : on attend qu'il soit la ; sinon un rechargement, un seul
        for essai in 0..<2 {
            do {
                try await charge(url, dans: vue)
            } catch {
                if essai == 0 { continue }
                return erreur("page non chargée (\(error.localizedDescription))")
            }
            if let l = await attendsSuivi(vue, transporteur: item.transporteur) {
                lu = l
                if Self.pret(l.texte, l.titre, transporteur: item.transporteur) { break }
            }
        }
        guard let lu else { return erreur("page vide") }
        // (une page sans suivi part quand meme : le serveur la lit comme
        // « incomplète », une erreur technique, jamais un statut)
        return DepotPageLue(numero: item.numero, transporteur: item.transporteur, url: lu.url, titre: lu.titre, texte: String(lu.texte.prefix(30_000)), erreur: nil)
    }

    /// 15 s au plus : le suivi (ou « numero inconnu », ou une protection), ou
    /// a defaut un texte stable
    private func attendsSuivi(_ vue: WKWebView, transporteur: String) async -> (titre: String, texte: String, url: String)? {
        var dernier = -1
        var stable = 0
        var lu: (titre: String, texte: String, url: String)?
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(500))
            if Task.isCancelled { break }
            // un bandeau de cookies : accepte (le choix reste dans le profil)
            _ = try? await vue.evaluateJavaScript(Self.consentement)
            guard let l = await texteVisible(vue) else { continue }
            lu = l
            if Self.pret(l.texte, l.titre, transporteur: transporteur) { break }
            if l.texte.count == dernier { stable += 1 } else { stable = 0; dernier = l.texte.count }
            if stable >= 6, l.texte.count > 200 { break }
        }
        return lu
    }

    /// le suivi est la (ou une protection, ou « numero inconnu ») : inutile d'attendre
    static func pret(_ texte: String, _ titre: String, transporteur: String) -> Bool {
        let t = texte.lowercased(), ti = titre.lowercased()
        if ti.contains("just a moment") || ti.contains("attention required") || ti.contains("access denied") { return true }
        switch transporteur {
        case "MR": return t.contains("suivi détaillé de mon colis") || t.contains("aucun colis portant")
        // (le formulaire et la FAQ s'affichent avant le suivi : seul un texte
        // stable dit que le suivi d'un colis reel est la)
        case "DHL": return t.contains("tentative de suivi a échoué") || t.contains("tracking attempt")
        case "GLS": return t.contains("no results") || t.contains("aucun résultat")
        default: return false
        }
    }

    /// Accepte un bandeau de cookies, et seulement lui : le bouton « Accepter »
    /// d'un bandeau de consentement connu (Didomi chez Mondial Relay, OneTrust
    /// chez DHL, consentmanager chez GLS -- verifie sur leurs pages --, Axeptio,
    /// Cookiebot, TrustArc, Usercentrics) ou d'un bloc dont le nom dit
    /// « cookie » ou « consent ». Jamais dans une page de verification.
    static let consentement = """
    (() => {
      if (/just a moment|attention required|access denied/i.test(document.title)) return 'defi';
      const ids = ['#onetrust-accept-btn-handler', '#didomi-notice-agree-button', '#axeptio_btn_acceptAll',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
        '#truste-consent-button', '[data-testid="uc-accept-all-button"]'];
      for (const s of ids) { const b = document.querySelector(s); if (b && b.offsetParent !== null) { b.click(); return 'cmp'; } }
      // consentmanager (GLS), Usercentrics : le bandeau vit dans un shadow DOM
      for (const hote of document.querySelectorAll('#cmpwrapper, #usercentrics-root, #usercentrics-cmp-ui')) {
        const racine = hote.shadowRoot || hote;
        const b = racine.querySelector('.cmpboxbtnyes, [data-testid="uc-accept-all-button"]');
        if (b && b.getClientRects().length) { b.click(); return 'cmp'; }
      }
      { const b = document.querySelector('.cmpboxbtnyes'); if (b && b.offsetParent !== null) { b.click(); return 'cmp'; } }
      const bandeaux = [...document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [role="dialog"]')]
        .filter((e) => /cookie|traceur|consentement|consent/i.test(e.innerText || ''));
      for (const bandeau of bandeaux) {
        const b = [...bandeau.querySelectorAll('button, a[role="button"], [role="button"]')]
          .find((x) => /^\\s*(tout accepter|accepter( tout| et fermer| & fermer| les cookies)?|j.accepte|accept( all)?( cookies)?|allow all|ok)\\s*$/i.test(x.innerText || ''));
        if (b && b.offsetParent !== null) { b.click(); return 'bandeau'; }
      }
      return '';
    })()
    """

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

    // MARK: La page et ses fenetres

    /// la page WebKit, une seule, reutilisee, avec le profil garde de l'app
    /// (cookies et consentement restent d'une lecture a l'autre)
    private func vueWeb() -> WKWebView {
        if let vue { return vue }
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()
        let v = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 900), configuration: conf)
        v.navigationDelegate = self
        v.autoresizingMask = [.width, .height]
        vue = v
        return v
    }

    /// une lecture en fond : la page dans une fenetre hors de l'ecran (rien ne
    /// s'affiche, la page se dessine normalement)
    private func installeHorsEcran() {
        let v = vueWeb()
        if fenetre?.isVisible == true { return }
        if horsEcran == nil {
            let w = NSWindow(contentRect: NSRect(x: -6000, y: 0, width: 1100, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            w.ignoresMouseEvents = true
            w.collectionBehavior = [.transient, .ignoresCycle, .stationary]
            w.hasShadow = false
            horsEcran = w
        }
        if v.superview !== horsEcran?.contentView {
            v.removeFromSuperview()
            horsEcran?.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 1100, height: 900))
            v.frame = horsEcran?.contentView?.bounds ?? v.frame
            horsEcran?.contentView?.addSubview(v)
        }
        horsEcran?.orderBack(nil)
    }

    private func rangeHorsEcran() {
        horsEcran?.orderOut(nil)
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
            panneau.contentView = NSHostingView(rootView: FenetreVerification(verificateur: self, conteneur: conteneur))
            if let ecran = NSScreen.main?.visibleFrame {
                panneau.setFrameOrigin(NSPoint(x: ecran.maxX - 580, y: ecran.minY + 20))
            }
            fenetre = panneau
        }
        // la page passe dans la fenetre visible
        let v = vueWeb()
        if v.superview !== conteneur {
            v.removeFromSuperview()
            v.frame = conteneur.bounds
            conteneur.addSubview(v)
        }
        rangeHorsEcran()
        // devant, sans prendre le clavier ni l'activite en cours
        fenetre?.orderFront(nil)
    }

    private func montreFenetre() {
        ouvreFenetre()
        // une lecture demandee ici : la fenetre passe devant ; en fond, elle
        // s'affiche sans voler le clavier
        if visible {
            fenetre?.makeKeyAndOrderFront(nil)
            NSApp.activate()
        }
    }

    private func fermeFenetre() {
        fenetre?.orderOut(nil)
    }
}

/// La fenetre : la page officielle en cours de lecture, et ou en est la verification.
private struct FenetreVerification: View {
    let verificateur: VerificateurPages
    let conteneur: NSView

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
            PageWeb(conteneur: conteneur)
        }
        .frame(minWidth: 420, minHeight: 480)
    }
}

private struct PageWeb: NSViewRepresentable {
    let conteneur: NSView
    func makeNSView(context: Context) -> NSView {
        conteneur.autoresizesSubviews = true
        return conteneur
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
#endif
