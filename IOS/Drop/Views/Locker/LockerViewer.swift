import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
import DropKit

/// Devant le locker : on prend un colis, on lit le "#3" imprime sur son
/// etiquette, le telephone montre le code-barre #3. Plein ecran, luminosite
/// au maximum, ecran qui ne s'eteint pas ; on balaie pour passer au suivant.
struct LockerViewer: View {
    let startIndex: Int
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var index: Int?
    @State private var arme = false
    @State private var flash = 0
    @State private var envoi = false
    @State private var luminositeAvant: CGFloat = 0.5

    private var paires: [LockerPair] { app.locker.pairs }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(paires) { p in
                        CodePage(pair: p)
                            .containerRelativeFrame(.horizontal)
                            .scrollTransition(axis: .horizontal) { contenu, phase in
                                contenu
                                    .opacity(phase.isIdentity ? 1 : 0.3)
                                    .scaleEffect(phase.isIdentity ? 1 : 0.86)
                                    .blur(radius: phase.isIdentity ? 0 : 6)
                            }
                            .id(p.id)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: Binding(get: { courant?.id }, set: { id in
                index = paires.firstIndex { $0.id == id }
            }))
            .ignoresSafeArea(edges: .horizontal)

            // l'eclair blanc d'un depot reussi
            Color.white
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .keyframeAnimator(initialValue: 0.0, trigger: flash) { contenu, o in
                    contenu.opacity(o)
                } keyframes: { _ in
                    KeyframeTrack {
                        LinearKeyframe(0.55, duration: 0.06)
                        CubicKeyframe(0, duration: 0.5)
                    }
                }
        }
        .safeAreaInset(edge: .top) { haut }
        .safeAreaInset(edge: .bottom) { bas }
        #if os(iOS)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        #endif
        .sensoryFeedback(.selection, trigger: index)
        .sensoryFeedback(.success, trigger: flash)
        .onAppear {
            index = min(startIndex, max(paires.count - 1, 0))
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = true
            if let ecran = ecran {
                luminositeAvant = ecran.brightness
                ecran.brightness = 1
            }
            #endif
        }
        .onDisappear {
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = false
            ecran?.brightness = luminositeAvant
            #endif
            Task { await app.locker.refresh() }
        }
        .onChange(of: index) { arme = false }
    }

    #if os(iOS)
    private var ecran: UIScreen? {
        (UIApplication.shared.connectedScenes.first { $0 is UIWindowScene } as? UIWindowScene)?.screen
    }
    #endif

    private var courant: LockerPair? {
        guard let index, paires.indices.contains(index) else { return paires.first }
        return paires[index]
    }

    // MARK: Barres

    private var haut: some View {
        HStack {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).frame(width: 44, height: 44)
            }
            .boutonVerre(.rond)
            .accessibilityLabel("Fermer")
            Spacer()
            if let courant {
                Text("#\(courant.numero)")
                    .font(.system(size: 34, weight: .heavy, design: .rounded))
                    .foregroundStyle(Theme.special)
                    .contentTransition(.numericText(value: Double(courant.numero)))
                    .animation(Theme.bouncy, value: courant.numero)
            }
            Spacer()
            Text("\((index ?? 0) + 1) / \(paires.count)")
                .font(.subheadline.weight(.semibold).monospacedDigit())
                .foregroundStyle(.white.opacity(0.7))
                .contentTransition(.numericText())
                .frame(width: 60, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private var bas: some View {
        VStack(spacing: 12) {
            if let courant {
                VStack(spacing: 3) {
                    Text(courant.colis?.fileName ?? (courant.seul ? "Code seul — aucun colis" : "PDF pas encore arrivé"))
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    let sous = [courant.sender, courant.colis?.note.map { "Note : \($0)" }].compactMap { $0 }.joined(separator: " · ")
                    if !sous.isEmpty {
                        Text(sous).font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(2)
                    }
                }
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
                .animation(.smooth, value: courant.id)
            }
            GlassEffectContainer(spacing: 12) {
                HStack(spacing: 12) {
                    navigation(-1, symbole: "chevron.left")
                    depot
                    navigation(1, symbole: "chevron.right")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private func navigation(_ pas: Int, symbole: String) -> some View {
        let cible = (index ?? 0) + pas
        return Button {
            guard paires.indices.contains(cible) else { return }
            withAnimation(Theme.spring) { index = cible }
        } label: {
            Image(systemName: symbole).font(.system(size: 18, weight: .bold)).frame(width: 56, height: 56)
        }
        .boutonVerre(.rond)
        .disabled(!paires.indices.contains(cible))
    }

    /// "Deposé" en deux appuis : un drop ne s'annule pas, et devant un locker
    /// on a vite fait de toucher le mauvais bouton.
    private var depot: some View {
        let p = courant
        let seul = p?.seul == true && p?.colis == nil
        return Button {
            guard let p, p.canComplete else { return }
            if !arme {
                Haptics.warning()
                withAnimation(Theme.bouncy) { arme = true }
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(3))
                    withAnimation(Theme.spring) { arme = false }
                }
                return
            }
            arme = false
            Task { await depose(p) }
        } label: {
            HStack(spacing: 8) {
                if envoi {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: arme ? "exclamationmark.circle.fill" : "checkmark")
                        .contentTransition(.symbolEffect(.replace))
                }
                Text(arme ? "Confirmer ?" : (seul ? "Fait" : "Déposé"))
                    .contentTransition(.interpolate)
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .frame(height: 56)
        }
        .boutonVerreFort(arme ? Theme.warn : Theme.violetDeep)
        .disabled(!(p?.canComplete ?? false) || envoi)
        .scaleEffect(arme ? 1.04 : 1)
    }

    private func depose(_ p: LockerPair) async {
        envoi = true
        defer { envoi = false }
        let position = index ?? 0
        guard await app.locker.complete(p) else { return }
        flash += 1
        if paires.isEmpty {
            app.toasts.show("Locker terminé, tout est déposé")
            dismiss()
            return
        }
        // le colis quitte la liste : on reste a la meme place, qui montre le suivant
        withAnimation(Theme.spring) { index = min(position, paires.count - 1) }
    }
}

/// Une page : le code, aussi grand que possible. Un code-barre, plus large
/// que haut, est tourne d'un quart de tour quand le telephone est tenu droit :
/// il court alors sur toute la hauteur, a peu pres deux fois plus grand.
private struct CodePage: View {
    let pair: LockerPair
    @Environment(AppModel.self) private var app

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if let image = app.locker.images[pair.id] {
                    let ratio = image.size.width / max(image.size.height, 1)
                    let tourner = ratio > 1.15 && geo.size.height > geo.size.width
                    let longueur = tourner ? geo.size.height - 24 : geo.size.width - 24
                    let epaisseur = tourner ? geo.size.width - 24 : geo.size.height - 24
                    let w = min(longueur, epaisseur * ratio)
                    Image(platformImage: image)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: w, height: w / ratio)
                        .padding(12)
                        .background(.white, in: .rect(cornerRadius: 16))
                        .rotationEffect(.degrees(tourner ? 90 : 0))
                        .transition(.opacity.combined(with: .scale(scale: 0.95)))
                } else if pair.code {
                    ProgressView().tint(.white).controlSize(.large)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "key.slash").font(.system(size: 44))
                        Text("Code pas encore arrivé").font(.headline)
                    }
                    .foregroundStyle(Theme.danger)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .task(id: pair.id) { await app.locker.image(for: pair) }
    }
}
