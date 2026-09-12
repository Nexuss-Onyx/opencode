# Use a stable Node.js slim image for a smaller footprint
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Vite frontend and bundle the Express backend with esbuild
RUN npm run build

# Set the environment variable to production
ENV NODE_ENV=production

# The Express server binds to port 3000
EXPOSE 3000

# Start the Node.js server
CMD ["npm", "run", "start"]
