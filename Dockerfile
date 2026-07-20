FROM mcr.microsoft.com/playwright:v1.52.0-jammy
WORKDIR /app
COPY package*.json ./
RUN apt-get update -qq && apt-get install -y -qq python3-pip && pip3 install cloudscraper beautifulsoup4 --break-system-packages && npm install --omit=dev && npx playwright install chromium --with-deps
COPY . .
ENV PORT=3456
EXPOSE 3456
CMD ["node", "index.cjs"]
