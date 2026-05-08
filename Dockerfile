FROM mcr.microsoft.com/playwright:v1.59.1-noble AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
RUN mkdir -p data && chown -R pwuser:pwuser /app

USER pwuser

CMD ["npm", "start"]
