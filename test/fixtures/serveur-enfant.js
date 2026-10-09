// Le dashboard dans un processus a part : un test peut ainsi constater qu'une
// requete fait tomber le processus, sans faire tomber le lanceur de tests.
const { environnementDeTest, demarreApp } = require("../aide");

environnementDeTest();
demarreApp().then(({ base }) => {
  process.stdout.write(`PRET ${base}\n`);
});
