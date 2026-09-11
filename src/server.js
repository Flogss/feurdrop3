require("dotenv").config();
const path = require("path");
const express = require("express");
const apiRouter = require("./routes/api");
const { startBot } = require("./bot");
const { getPrintToken } = require("./db");

const app = express();
app.use(express.json());
app.use("/api", apiRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  // necessaire pour configurer l'agent d'impression du Mac (voir agent/README.md)
  console.log(`[print] jeton de l'agent d'impression : ${getPrintToken()}`);
});

startBot();
