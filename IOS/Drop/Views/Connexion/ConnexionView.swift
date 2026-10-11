import SwiftUI
import DropKit

/// L'ecran de connexion : le mot de passe du dashboard, une fois toutes les
/// 72 heures par appareil. Le mot de passe part au serveur (HTTPS) et n'est
/// garde nulle part ; seul le jeton de session recu va dans le trousseau.
///
/// La meme mise en scene que le site : un horizon violet, une carte de verre
/// qui entre en profondeur, un anneau de lumiere qui tourne autour du champ
/// quand il a le focus, une lueur qui respire a chaque frappe ; le bouton se
/// contracte en sphere pendant la verification. Refuse : le champ vibre a
/// peine et se teinte. Accepte : la sphere devient le coeur de la meteorite,
/// rejoint le centre (la place exacte de la roche du lancement), la carte s'y
/// dissout, et le dashboard reprend la sequence a cet instant. Les animations
/// ne decident de rien : seule la reponse du serveur ouvre le dashboard.
struct ConnexionView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var motDePasse = ""
    @State private var visible = false
    @State private var erreur: String?
    @State private var enCours = false
    @State private var secousse = 0
    @State private var frappe = 0
    @State private var entree = false
    @State private var sortie: Date?
    @State private var cadreBouton: CGRect = .zero
    @FocusState private var focus: Bool

    var body: some View {
        GeometryReader { geo in
            ZStack {
                AmbientBackground()
                Horizon(leve: entree)
                EtoileFilante()
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 40)
                        carte
                            .frame(maxWidth: 420)
                        Spacer(minLength: 40)
                    }
                    .frame(maxWidth: .infinity, minHeight: max(geo.size.height, 600))
                    .padding(.horizontal, 20)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollDisabled(sortie != nil)

                if let sortie {
                    Sortie(debut: sortie, depart: cadreBouton, taille: geo.size)
                        .allowsHitTesting(false)
                }
            }
            .coordinateSpace(.named("connexion"))
        }
        .ignoresSafeArea()
        .onAppear {
            focus = true
            withAnimation(.spring(response: 1.1, dampingFraction: 0.86).delay(0.1)) { entree = true }
        }
    }

    // MARK: La carte

    private var carte: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                MarqueDrop(cote: 32)
                    .clipShape(.rect(cornerRadius: 32 * ContourMarque.arrondi, style: .continuous))
                    .shadow(color: Theme.violet.opacity(0.7), radius: 10, y: 4)
                Text("DROP").font(.system(size: 18, weight: .heavy, design: .rounded))
                    + Text(".ctrl").font(.system(size: 14, weight: .medium, design: .monospaced)).foregroundStyle(Theme.text3)
            }
            .monte(entree, rang: 0)
            .padding(.bottom, 26)

            Cadenas(ouvert: sortie != nil)
                .monte(entree, rang: 1)
                .padding(.bottom, 16)

            Text("Connexion")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.numberGradient)
                .monte(entree, rang: 2)
            Text("Entre le mot de passe pour ouvrir le dashboard sur cet appareil.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .padding(.top, 6)
                .padding(.bottom, 20)
                .monte(entree, rang: 3)

            if let message = app.messageConnexion {
                Label(message, systemImage: "clock.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(Theme.warn)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.warn.opacity(0.1), in: .rect(cornerRadius: 12))
                    .padding(.bottom, 16)
            }

            Text("MOT DE PASSE")
                .font(.caption.weight(.semibold))
                .tracking(0.8)
                .foregroundStyle(focus ? Theme.violetLight : Theme.text3)
                .animation(.easeOut(duration: 0.3), value: focus)
                .padding(.bottom, 8)
                .monte(entree, rang: 4)
            champ
                .monte(entree, rang: 5)

            if let erreur {
                Label(erreur, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .padding(.top, 10)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            bouton
                .padding(.top, 20)
                .monte(entree, rang: 6)

            Text("Cet appareil restera connecté 72 heures, puis le mot de passe sera redemandé.")
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 16)
                .monte(entree, rang: 7)
            Text(app.serverURL.host() ?? app.serverURL.absoluteString)
                .font(.caption2.monospaced())
                .foregroundStyle(Theme.text3.opacity(0.7))
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
        }
        .padding(26)
        .glassEffect(.regular.tint(.black.opacity(0.3)), in: .rect(cornerRadius: Theme.Radius.card))
        .shadow(color: Theme.violet.opacity(0.25), radius: 60, y: 20)
        // l'entree : de la profondeur, un peu inclinee, floue, puis posee
        .rotation3DEffect(.degrees(entree ? 0 : 10), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
        .scaleEffect(entree ? 1 : 0.95)
        .offset(y: entree ? 0 : 34)
        .blur(radius: entree ? 0 : 10)
        .opacity(entree ? 1 : 0)
        // la sortie : la carte se dissout dans la sphere
        .scaleEffect(sortie == nil ? 1 : 0.92)
        .blur(radius: sortie == nil ? 0 : 12)
        .opacity(sortie == nil ? 1 : 0)
        .animation(.easeIn(duration: 0.6).delay(0.2), value: sortie)
        .animation(Theme.spring, value: erreur)
    }

    // MARK: Le champ

    private var champ: some View {
        HStack(spacing: 4) {
            Image(systemName: "key.horizontal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(erreur != nil ? Theme.danger : focus ? Theme.violetLight : Theme.text3)
                .scaleEffect(focus ? 1.08 : 1)
                .padding(.leading, 2)
            Group {
                if visible {
                    TextField("", text: $motDePasse)
                } else {
                    SecureField("", text: $motDePasse)
                }
            }
            .textFieldStyle(.plain)
            .textContentType(.password)
            .autocorrectionDisabled()
            .sansMajuscules()
            .submitLabel(.go)
            .focused($focus)
            .onSubmit(envoie)
            .font(.system(size: 17, weight: .medium))
            .tint(Theme.violetLight)
            .padding(.leading, 6)
            Button {
                visible.toggle()
            } label: {
                Image(systemName: visible ? "eye.slash" : "eye")
                    .contentTransition(.symbolEffect(.replace))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(visible ? "Masquer le mot de passe" : "Afficher le mot de passe")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(height: 56)
        .background(erreur != nil ? Theme.danger.opacity(0.07) : focus ? Theme.violet.opacity(0.07) : .black.opacity(0.25), in: .rect(cornerRadius: 17))
        .overlay {
            RoundedRectangle(cornerRadius: 17)
                .strokeBorder(erreur != nil ? Theme.danger.opacity(0.7) : Theme.hairline, lineWidth: 1)
        }
        .overlay { AnneauLumineux(actif: focus && erreur == nil && !reduceMotion) }
        // chaque frappe fait respirer la lueur
        .keyframeAnimator(initialValue: 0.0, trigger: frappe) { vue, lueur in
            vue.shadow(color: Theme.violet.opacity((focus ? 0.35 : 0) + lueur), radius: 14 + 10 * lueur)
        } keyframes: { _ in
            KeyframeTrack {
                LinearKeyframe(0.45, duration: 0.08)
                SpringKeyframe(0, duration: 0.3)
            }
        }
        // refuse : le champ vibre a peine, puis se calme
        .keyframeAnimator(initialValue: 0.0, trigger: secousse) { vue, x in
            vue.offset(x: x)
        } keyframes: { _ in
            KeyframeTrack {
                LinearKeyframe(-6, duration: 0.07)
                LinearKeyframe(5, duration: 0.07)
                LinearKeyframe(-3, duration: 0.07)
                LinearKeyframe(1.5, duration: 0.07)
                LinearKeyframe(0, duration: 0.07)
            }
        }
        .animation(.easeOut(duration: 0.3), value: focus)
        .onChange(of: motDePasse) { _, _ in
            frappe += 1
            if erreur != nil { withAnimation(Theme.spring) { erreur = nil } }
        }
    }

    // MARK: Le bouton

    private var bouton: some View {
        Button(action: envoie) {
            ZStack {
                if enCours || sortie != nil {
                    Sphere(tourne: enCours)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                } else {
                    HStack(spacing: 8) {
                        Text("Se connecter")
                        Image(systemName: "arrow.right")
                            .font(.system(size: 15, weight: .bold))
                    }
                    .transition(.opacity)
                }
            }
            .font(.headline)
            .frame(maxWidth: enCours || sortie != nil ? 52 : .infinity)
            .frame(height: 52)
        }
        .boutonVerreFort(Theme.violetDeep)
        .disabled(enCours || motDePasse.isEmpty || sortie != nil)
        .frame(maxWidth: .infinity)
        .opacity(sortie == nil ? 1 : 0)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("connexion")) } action: { cadreBouton = $0 }
        .animation(.spring(response: 0.52, dampingFraction: 0.8), value: enCours)
        .sensoryFeedback(.impact(weight: .light), trigger: enCours) { _, nouveau in nouveau }
    }

    private func envoie() {
        guard !enCours, sortie == nil, !motDePasse.isEmpty else { return }
        enCours = true
        withAnimation(Theme.spring) { erreur = nil }
        let debut = Date.now
        Task {
            let message = await app.seConnecte(motDePasse: motDePasse)
            // la sphere tourne au moins un instant : un refus instantane ne
            // doit pas donner l'impression que rien ne s'est passe
            let reste = 0.42 - Date.now.timeIntervalSince(debut)
            if reste > 0 { try? await Task.sleep(for: .seconds(reste)) }
            enCours = false
            if let message {
                withAnimation(Theme.spring) { erreur = message }
                secousse += 1
                focus = true
                Haptics.error()
                return
            }
            motDePasse = ""
            focus = false
            Haptics.success()
            if reduceMotion {
                app.entreApresConnexion()
                return
            }
            sortie = .now
            try? await Task.sleep(for: .seconds(1.05))
            app.entreApresConnexion()
        }
    }
}

// MARK: - Les pieces

private extension View {
    /// chaque ligne de la carte monte a son tour a l'entree
    func monte(_ entree: Bool, rang: Int) -> some View {
        self
            .opacity(entree ? 1 : 0)
            .offset(y: entree ? 0 : 12)
            .animation(.spring(response: 0.8, dampingFraction: 0.86).delay(0.25 + Double(rang) * 0.06), value: entree)
    }
}

/// le cadenas : son anse se souleve quand le mot de passe est accepte
private struct Cadenas: View {
    let ouvert: Bool

    var body: some View {
        Image(systemName: ouvert ? "lock.open.fill" : "lock.fill")
            .contentTransition(.symbolEffect(.replace))
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(Theme.violetPale)
            .frame(width: 54, height: 54)
            .background(LinearGradient(colors: [Theme.violet.opacity(0.32), Theme.violetDark.opacity(0.4)], startPoint: .top, endPoint: .bottom), in: .rect(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).strokeBorder(Theme.violetBright.opacity(ouvert ? 0.7 : 0.35), lineWidth: 1))
            .shadow(color: Theme.violet.opacity(ouvert ? 1 : 0.6), radius: ouvert ? 22 : 14, y: 6)
            .scaleEffect(ouvert ? 1.08 : 1)
            .animation(.spring(response: 0.4, dampingFraction: 0.6), value: ouvert)
    }
}

/// l'anneau de lumiere qui tourne autour du champ quand il a le focus
private struct AnneauLumineux: View {
    let actif: Bool

    var body: some View {
        TimelineView(.animation(paused: !actif)) { contexte in
            let angle = Angle.degrees(contexte.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3.4) / 3.4 * 360)
            RoundedRectangle(cornerRadius: 17)
                .strokeBorder(
                    AngularGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: Theme.violetLight, location: 0.14),
                            .init(color: .white, location: 0.2),
                            .init(color: Theme.violetBright, location: 0.26),
                            .init(color: .clear, location: 0.42),
                            .init(color: .clear, location: 0.56),
                            .init(color: Theme.violetBright.opacity(0.7), location: 0.72),
                            .init(color: .clear, location: 0.88),
                        ],
                        center: .center,
                        angle: angle
                    ),
                    lineWidth: 1.5
                )
        }
        .opacity(actif ? 1 : 0)
        .animation(.easeOut(duration: 0.4), value: actif)
        .allowsHitTesting(false)
    }
}

/// la sphere du bouton pendant la verification : un anneau qui tourne
private struct Sphere: View {
    let tourne: Bool
    @State private var angle = 0.0

    var body: some View {
        Circle()
            .trim(from: 0.1, to: 0.75)
            .stroke(AngularGradient(colors: [.clear, .white], center: .center), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            .frame(width: 24, height: 24)
            .rotationEffect(.degrees(angle))
            .onAppear {
                withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) { angle = 360 }
            }
    }
}

/// l'horizon : le bord d'une planete eclairee de violet, en bas de l'ecran
private struct Horizon: View {
    let leve: Bool

    var body: some View {
        GeometryReader { geo in
            let d = max(geo.size.width, geo.size.height) * 1.7
            Circle()
                .fill(Color(red: 0.039, green: 0.031, blue: 0.063))
                .overlay(Circle().stroke(Theme.violetLight.opacity(0.4), lineWidth: 1.5))
                .shadow(color: Theme.violet.opacity(0.45), radius: 28)
                .shadow(color: Theme.violet.opacity(0.25), radius: 90)
                .frame(width: d, height: d)
                .position(x: geo.size.width / 2, y: geo.size.height + d * 0.5 - geo.size.height * 0.2)
                .offset(y: leve ? 0 : geo.size.height * 0.08)
                .opacity(leve ? 1 : 0)
                .animation(.spring(response: 1.6, dampingFraction: 0.9), value: leve)
        }
        .allowsHitTesting(false)
    }
}

/// une etoile filante de temps en temps
private struct EtoileFilante: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60)) { contexte in
            let t = contexte.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 9) - 2.4
            Canvas { ctx, taille in
                guard t > 0, t < 0.55 else { return }
                let f = t / 0.55
                let depart = CGPoint(x: taille.width * 0.68, y: taille.height * 0.12)
                let longueur = max(taille.width, taille.height) * 0.46
                let tete = CGPoint(x: depart.x - longueur * f * 0.88, y: depart.y + longueur * f * 0.47)
                let queue = CGPoint(x: tete.x + 150 * (1 - f * 0.5) * 0.88, y: tete.y - 150 * (1 - f * 0.5) * 0.47)
                var trait = Path()
                trait.move(to: queue)
                trait.addLine(to: tete)
                let alpha = sin(.pi * f)
                ctx.addFilter(.shadow(color: Theme.violet, radius: 6))
                ctx.stroke(trait, with: .linearGradient(Gradient(colors: [.clear, Theme.violetLight.opacity(0.8 * alpha), .white.opacity(alpha)]), startPoint: queue, endPoint: tete), lineWidth: 1.5)
            }
        }
        .allowsHitTesting(false)
    }
}

/// La sortie : la sphere du bouton rejoint le centre (la place exacte de la
/// roche du lancement) en arc, en grandissant ; la matiere de la carte y est
/// aspiree ; l'ecran s'eteint sur le graphite du lancement.
private struct Sortie: View {
    let debut: Date
    let depart: CGRect
    let taille: CGSize

    private struct Grain {
        let x0: CGFloat, y0: CGFloat, tourne: CGFloat, retard: Double, duree: Double
    }

    private let grains: [Grain] = (0..<34).map { i in
        func tirage(_ k: Int) -> Double {
            let x = sin(Double(i) * 12.9898 + Double(k) * 78.233) * 43758.5453
            return x - x.rounded(.down)
        }
        return Grain(x0: tirage(1), y0: tirage(2), tourne: (tirage(3) < 0.8 ? 1 : -1) * (0.25 + 0.25 * tirage(4)), retard: 0.24 + 0.26 * tirage(5), duree: 0.5 + 0.3 * tirage(6))
    }

    var body: some View {
        TimelineView(.animation) { contexte in
            let t = contexte.date.timeIntervalSince(debut)
            Canvas { ctx, _ in
                let w = taille.width, h = taille.height
                let petit = min(w, h)
                let cote = min(max(petit * 0.3, 96), 150)
                let cible = CGPoint(x: 0.5 * w, y: (w > h ? 0.47 : 0.42) * h)
                // l'ecran s'eteint sur le graphite du lancement
                let noir = min(max((t - 0.38) / 0.64, 0), 1)
                ctx.fill(Path(CGRect(origin: .zero, size: taille)), with: .color(Color(red: 0.021, green: 0.019, blue: 0.032).opacity(noir * noir)))

                // la matiere de la carte, aspiree dans la sphere
                let carte = CGRect(x: w / 2 - min(w - 40, 420) / 2, y: h * 0.18, width: min(w - 40, 420), height: h * 0.62)
                for g in grains {
                    let f = min(max((t - g.retard) / g.duree, 0), 1)
                    guard f > 0, f < 1 else { continue }
                    let e = f * f * (3 - 2 * f)
                    let x0 = carte.minX + g.x0 * carte.width, y0 = carte.minY + g.y0 * carte.height
                    let dx = cible.x - x0, dy = cible.y - y0
                    let s = sin(.pi * e) * g.tourne
                    let p = CGPoint(x: x0 + dx * e - dy * s, y: y0 + dy * e + dx * s)
                    let r = 2.2 * (1.4 - e)
                    var c = ctx
                    c.addFilter(.shadow(color: Theme.violet, radius: 4))
                    c.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)), with: .color(Theme.violetPale.opacity(sin(.pi * f))))
                }

                // la sphere : du bouton au centre, en arc, en grandissant
                let f = min(max((t - 0.18) / 0.76, 0), 1)
                let e = f < 0.5 ? 4 * f * f * f : 1 - pow(-2 * f + 2, 3) / 2
                let a = CGPoint(x: depart.midX, y: depart.midY)
                let centre = CGPoint(x: a.x + (cible.x - a.x) * e, y: a.y + (cible.y - a.y) * e - sin(.pi * f) * 70)
                let rayon = (26 + (cote * 0.25 - 26) * e) * (1 + 0.18 * sin(.pi * f))
                let eclat = 1 + 0.4 * sin(.pi * min(f * 1.15, 1))
                var halo = ctx
                halo.addFilter(.blur(radius: rayon * 0.9))
                halo.fill(Path(ellipseIn: CGRect(x: centre.x - rayon * 2.2, y: centre.y - rayon * 2.2, width: rayon * 4.4, height: rayon * 4.4)), with: .color(Theme.violet.opacity(0.55 * eclat)))
                ctx.fill(
                    Path(ellipseIn: CGRect(x: centre.x - rayon, y: centre.y - rayon, width: 2 * rayon, height: 2 * rayon)),
                    with: .radialGradient(
                        Gradient(colors: [.white, Theme.violetPale, Theme.violetBright, Theme.violetDeep]),
                        center: CGPoint(x: centre.x - rayon * 0.16, y: centre.y - rayon * 0.24), startRadius: 0, endRadius: rayon * 1.1
                    )
                )
            }
        }
        .ignoresSafeArea()
    }
}
