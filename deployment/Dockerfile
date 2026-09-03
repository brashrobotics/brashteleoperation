FROM node:22.23-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY . .
RUN mkdir -p /var/lib/brash-teleoperation && chown -R node:node /var/lib/brash-teleoperation

USER node
ENV NODE_ENV=production
CMD ["npm", "run", "dev:control"]
