# Nixpacks ignorait la demande de poppler-utils : le serveur recadrait donc les
# etiquettes a l'aveugle, sur le contenu du PDF au lieu du rendu. Un Dockerfile
# rend l'installation explicite et verifiable.
FROM node:22-slim

# pdftoppm sert a mesurer ce qui s'imprime vraiment (voir src/rasterInk.js).
# fontconfig lui evite de rendre les etiquettes sans polices.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && pdftoppm -v

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

CMD ["node", "src/server.js"]
