FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
RUN chmod +x start.sh
ENV HOST=0.0.0.0
ENV PORT=80
EXPOSE 80
CMD ["sh", "start.sh"]
