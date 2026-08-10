# Production Dockerfile for Fly.io Deployment
FROM node:22-slim

# Install system dependencies: ffmpeg, python3, curl, ca-certificates
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary into system PATH
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

# Ensure temp directory exists
RUN mkdir -p temp bin

# Expose web ping port
EXPOSE 8080
ENV PORT=8080

# Start the Multi-Bot Engine
CMD ["npm", "start"]
