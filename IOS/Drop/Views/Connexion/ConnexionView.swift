import SwiftUI
import DropKit

/// L'ecran de connexion : le mot de passe du dashboard, une fois toutes les
/// 72 heures par appareil. Le mot de passe part au serveur (HTTPS) et n'est
/// garde nulle part ; seul le jeton de session recu va dans le trousseau.
struct ConnexionView: View {
    @Environment(AppModel.self) private var app
    @State private var motDePasse = ""
    @State private var visible = false
    @State private var erreur: String?
    @State private var enCours = false
    @State private var secousse = 0
    @FocusState private var focus: Bool

    var body: some View {
        ZStack {
            AmbientBackground()
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 40)
                    carte
                        .frame(maxWidth: 420)
                    Spacer(minLength: 40)
                }
                .frame(maxWidth: .infinity, minHeight: 600)
                .padding(.horizontal, 20)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .onAppear { focus = true }
    }

    private var carte: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                MarqueDrop(cote: 32)
                    .clipShape(.rect(cornerRadius: 32 * ContourMarque.arrondi, style: .continuous))
                    .shadow(color: Theme.violet.opacity(0.7), radius: 10, y: 4)
                Text("DROP").font(.system(size: 18, weight: .heavy, design: .rounded))
                    + Text(".ctrl").font(.system(size: 14, weight: .medium, design: .monospaced)).foregroundStyle(Theme.text3)
            }
            .padding(.bottom, 26)

            Image(systemName: "lock.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.violetPale)
                .frame(width: 52, height: 52)
                .background(LinearGradient(colors: [Theme.violet.opacity(0.32), Theme.violetDark.opacity(0.4)], startPoint: .top, endPoint: .bottom), in: .rect(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.violetBright.opacity(0.35), lineWidth: 1))
                .shadow(color: Theme.violet.opacity(0.6), radius: 14, y: 6)
                .padding(.bottom, 16)

            Text("Connexion")
                .font(.system(size: 30, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.numberGradient)
            Text("Entre le mot de passe pour ouvrir le dashboard sur cet appareil.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .padding(.top, 6)
                .padding(.bottom, 20)

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
                .foregroundStyle(Theme.text3)
                .padding(.bottom, 8)
            HStack(spacing: 4) {
                Group {
                    if visible {
                        TextField("", text: $motDePasse)
                    } else {
                        SecureField("", text: $motDePasse)
                    }
                }
                .textContentType(.password)
                .autocorrectionDisabled()
                .sansMajuscules()
                .submitLabel(.go)
                .focused($focus)
                .onSubmit(envoie)
                .font(.body)
                Button {
                    visible.toggle()
                } label: {
                    Image(systemName: visible ? "eye.slash" : "eye")
                        .foregroundStyle(Theme.text3)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(visible ? "Masquer le mot de passe" : "Afficher le mot de passe")
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .frame(height: 52)
            .background(.white.opacity(0.05), in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(erreur == nil ? Theme.hairline : Theme.danger.opacity(0.6), lineWidth: 1))

            if let erreur {
                Text(erreur)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .padding(.top, 10)
                    .transition(.opacity)
            }

            Button(action: envoie) {
                Group {
                    if enCours { ProgressView().tint(.white) } else { Text("Se connecter") }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
            }
            .boutonVerreFort(Theme.violetDeep)
            .disabled(enCours || motDePasse.isEmpty)
            .padding(.top, 18)

            Text("Cet appareil restera connecté 72 heures, puis le mot de passe sera redemandé.")
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.top, 16)
            Text(app.serverURL.host() ?? app.serverURL.absoluteString)
                .font(.caption2.monospaced())
                .foregroundStyle(Theme.text3.opacity(0.7))
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
        }
        .padding(26)
        .glassEffect(.regular.tint(.black.opacity(0.3)), in: .rect(cornerRadius: Theme.Radius.card))
        .keyframeAnimator(initialValue: 0.0, trigger: secousse) { vue, x in
            vue.offset(x: x)
        } keyframes: { _ in
            KeyframeTrack {
                LinearKeyframe(-9, duration: 0.07)
                LinearKeyframe(8, duration: 0.07)
                LinearKeyframe(-5, duration: 0.07)
                LinearKeyframe(3, duration: 0.07)
                LinearKeyframe(0, duration: 0.07)
            }
        }
        .animation(Theme.spring, value: erreur)
    }

    private func envoie() {
        guard !enCours, !motDePasse.isEmpty else { return }
        enCours = true
        erreur = nil
        Task {
            let message = await app.seConnecte(motDePasse: motDePasse)
            enCours = false
            if let message {
                erreur = message
                secousse += 1
                Haptics.error()
            } else {
                motDePasse = ""
                Haptics.success()
            }
        }
    }
}
