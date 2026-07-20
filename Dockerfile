FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Install Python dependencies for CF bypass
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt && rm requirements.txt

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3456
EXPOSE 3456

CMD ["node", "index.cjs"]
