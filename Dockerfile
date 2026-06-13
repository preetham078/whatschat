FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-optional
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
