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

# Memoire (facturee a la minute par Railway) : sans limite, Node regle son
# tas sur les 8 Go du conteneur et ne fait le menage que rarement -- la
# memoire montait par paliers (jusqu'a ~600 Mo) sans jamais redescendre. Une
# jeune generation de 4 Mo et un tas plafonne a 384 Mo (le serveur en utilise
# ~30 au repos, les PDF passent largement) le gardent compact ; deux zones
# d'allocation native au lieu d'une par fil (glibc) evitent la memoire
# liberee mais gardee. Mesure en local : ~200 Mo apres 40 lectures de la page
# du controle, au lieu de 365 a 600.
ENV MALLOC_ARENA_MAX=2

CMD ["node", "--max-semi-space-size=4", "--max-old-space-size=384", "src/server.js"]
