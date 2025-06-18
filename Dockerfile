# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Install additional nginx modules if needed
RUN apk add --no-cache nginx-mod-http-headers-more

# Copy built app from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Create nginx config for WebGPU/WASM support
RUN echo 'server {\
    listen 27027;\
    root /usr/share/nginx/html;\
    index index.html;\
\
    gzip on;\
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript application/wasm;\
\
    location ~* \\.wasm$ {\
        add_header Content-Type application/wasm;\
    }\
\
    location / {\
        try_files $uri $uri/ /index.html;\
    }\
\
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|wasm)$ {\
        expires 1y;\
        add_header Cache-Control "public, immutable";\
    }\
}' > /etc/nginx/conf.d/default.conf

# Expose port 27027
EXPOSE 27027

# Start nginx
CMD ["nginx", "-g", "daemon off;"]