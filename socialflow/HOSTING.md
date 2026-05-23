# SocialFlow - Hosting Guide

Your AI-powered social media publishing app is ready! Here's how to host it:

## 🚀 Quick Deploy Options

### 1. **Vercel** (Recommended - Free, Easy)
```bash
npm i -g vercel
cd socialflow
vercel
```
- Just drag & drop the `dist` folder to Vercel dashboard
- Auto-deploys from GitHub

### 2. **Netlify** (Free, Easy)
```bash
npm i -g netlify-cli
cd socialflow
netlify deploy --prod
```
- Drag `dist` folder to netlify.com/drop

### 3. **GitHub Pages** (Free)
1. Push code to GitHub
2. Settings → Pages → Deploy from main branch
3. Add CNAME for custom domain

### 4. **Railway** (Free tier, Node.js backend)
```bash
npm i -g railway
cd socialflow
railway login
railway init
railway up
```

## 📁 Build for Production

```bash
cd /workspace/project/qwen-code/socialflow
npm run build
```

This creates a `dist` folder with static files ready to host anywhere.

## 🖥️ Self-Host Options

### Using a VPS (DigitalOcean, Linode, AWS)
```bash
# SSH into your server
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Copy files and run
cd /path/to/socialflow
npm install
npm run build

# Serve with nginx or PM2
pm2 start npm --name "socialflow" -- start
```

### Nginx Configuration
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    root /var/www/socialflow/dist;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 🐳 Docker Deployment

Create `Dockerfile`:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npx", "serve", "-s", "dist", "-l", "3000"]
```

Build & Run:
```bash
docker build -t socialflow .
docker run -p 3000:3000 socialflow
```

## 📱 Static vs Dynamic

- **Static Hosting** (Vercel, Netlify, GitHub Pages): Frontend only, free
- **With Backend**: Needs Node.js server for:
  - Real website scraping
  - Social media API authentication
  - Database storage

## 🌐 Custom Domain Setup

1. Buy domain (Namecheap, Google Domains)
2. Point DNS to your host:
   - Vercel: Add domain in dashboard
   - Netlify: Domain settings → Add custom domain
   - Self-hosted: Update nginx config + DNS A record

## ⚡ Quick Start (Local Development)

```bash
cd /workspace/project/qwen-code/socialflow
npm install
npm run dev
# Opens at http://localhost:3000
```

## 📦 Production Build

```bash
npm run build      # Creates dist/ folder
npm run preview    # Preview production build locally
```

## 🔧 Environment Variables (For Backend)

If adding a backend later:
```env
OPENAI_API_KEY=your_key
TWITTER_API_KEY=your_key
FACEBOOK_API_KEY=your_key
DATABASE_URL=your_db_url
```

## 🎯 Recommended Stack

| Need | Solution |
|------|----------|
| Quickest | Vercel (5 min deploy) |
| Free + Custom Domain | GitHub Pages |
| With Backend API | Railway + Vercel |
| Enterprise | AWS Amplify / Google Cloud |

## 📊 Hosting Comparison

| Platform | Free Tier | Custom Domain | SSL | Backend |
|----------|-----------|---------------|-----|---------|
| Vercel | ✅ 100GB | ✅ | ✅ | Add-on |
| Netlify | ✅ 100GB | ✅ | ✅ | Functions |
| GitHub Pages | ✅ | ✅ | ✅ | ❌ |
| Railway | ✅ 500hrs | ✅ | ✅ | ✅ |
| Render | ✅ 750hrs | ✅ | ✅ | ✅ |

## 🆘 Need Help?

1. Check the `dist/` folder is being deployed
2. Ensure `index.html` is in the root
3. Configure redirect rules for SPA routing

---

**Current URL:** `http://localhost:3000` (running locally)

**To deploy now:** Use the `dist` folder with any static hosting provider!