// Verification automatique du code (npm run lint).
//
// L'essentiel est no-undef : un appel a une fonction qui n'existe pas
// (fail() dans routes/suivi.js) faisait tomber tout le serveur, et ce genre
// d'erreur se voit ici avant d'arriver en production.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "IOS/**", "data/**"] },
  js.configs.recommended,
  {
    // serveur, bot, agent d'impression, scripts et tests : CommonJS sur Node
    files: ["src/**/*.js", "agent/**/*.js", "scripts/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // le bot de suivi, repris tel quel de son projet d'origine : modules ES
    files: ["src/suivi/bot/**/*.js"],
    languageOptions: { sourceType: "module" },
  },
  {
    // le site : des scripts classiques qui partagent leurs declarations
    // d'un fichier a l'autre (voir public/index.html) -- no-undef n'y a pas
    // de sens fichier par fichier
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals.browser } },
    rules: { "no-undef": "off", "no-unused-vars": "off", "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["public/sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: ["public/particules.js", "public/lancement-worker.js", "public/lancement-rendu.js"],
    languageOptions: { globals: { ...globals.worker } },
  },
];
