import SwiftUI
#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

// Le peu qui differe entre l'iPhone et le Mac, rassemble ici : les ecrans
// partages n'ont pas a s'en soucier.

extension Image {
    init(platformImage: PlatformImage) {
        #if canImport(UIKit)
        self.init(uiImage: platformImage)
        #else
        self.init(nsImage: platformImage)
        #endif
    }
}

enum Platform {
    static var isMac: Bool {
        #if os(macOS)
        true
        #else
        false
        #endif
    }

    /// l'app est-elle au premier plan ? (sur iPhone, l'ecran ne se rafraichit
    /// que dans ce cas ; sur Mac, la fenetre peut etre visible derriere une
    /// autre app : ce n'est pas "vu")
    static var isFrontmost: Bool {
        #if os(macOS)
        NSApp.isActive
        #else
        true
        #endif
    }

    static func copy(_ texte: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = texte
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(texte, forType: .string)
        #endif
    }

    /// Les reglages de notifications du systeme (pour reautoriser Drop).
    static func openNotificationSettings() {
        #if canImport(UIKit)
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        #else
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
        #endif
    }

    /// Une image decodee hors du fil principal quand le systeme le permet.
    static func prepared(_ image: PlatformImage) async -> PlatformImage {
        #if canImport(UIKit)
        await image.byPreparingForDisplay() ?? image
        #else
        image
        #endif
    }
}

/// Les claviers a l'ecran (iPhone) ; sans effet sur le Mac.
enum Clavier { case nombre, decimal, url }

extension View {
    @ViewBuilder
    func clavier(_ type: Clavier) -> some View {
        #if os(iOS)
        switch type {
        case .nombre: self.keyboardType(.numberPad)
        case .decimal: self.keyboardType(.decimalPad)
        case .url: self.keyboardType(.URL).textInputAutocapitalization(.never)
        }
        #else
        self
        #endif
    }

    @ViewBuilder
    func sansMajuscules() -> some View {
        #if os(iOS)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }

    /// titre de barre de navigation discret (iPhone)
    @ViewBuilder
    func titreCompact() -> some View {
        #if os(iOS)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// pas de barre de navigation au-dessus de l'en-tete maison (iPhone)
    @ViewBuilder
    func barreDeNavigationMasquee() -> some View {
        #if os(iOS)
        self.toolbarVisibility(.hidden, for: .navigationBar)
        #else
        self
        #endif
    }

    /// la liste groupee en cartes (iPhone), sa version Mac
    @ViewBuilder
    func listeGroupee(espacement: CGFloat? = nil) -> some View {
        #if os(iOS)
        if let espacement {
            self.listStyle(.insetGrouped).listSectionSpacing(espacement)
        } else {
            self.listStyle(.insetGrouped)
        }
        #else
        self.listStyle(.inset)
        #endif
    }

    /// le fond vivant derriere une page (et ses pages suivantes sur iPhone)
    @ViewBuilder
    func fondVivant() -> some View {
        #if os(iOS)
        self.containerBackground(for: .navigation) { AmbientBackground() }
        #else
        self.background { AmbientBackground() }
        #endif
    }

    /// un choix dans une liste : page suivante sur iPhone, menu sur Mac
    @ViewBuilder
    func choixEnPage() -> some View {
        #if os(iOS)
        self.pickerStyle(.navigationLink)
        #else
        self.pickerStyle(.menu)
        #endif
    }
}
