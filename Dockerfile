# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.59.1-noble AS deps

WORKDIR /app

ENV npm_config_update_notifier=false


COPY package.json package-lock.json ./
RUN npm ci


FROM deps AS build

WORKDIR /app

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data \
  && chown -R pwuser:pwuser /app

USER pwuser

VOLUME ["/app/data"]
EXPOSE 3001

CMD ["node", "dist/index.js"]
