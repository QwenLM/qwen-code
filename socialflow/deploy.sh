#!/bin/bash
# Deploy SocialFlow to various platforms

echo "🚀 SocialFlow Deployment Script"
echo "================================"

# Build the app
echo "📦 Building application..."
npm run build

if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
    echo ""
    echo "📁 Output in ./dist/"
    echo ""
    echo "📋 Deployment Options:"
    echo ""
    echo "1️⃣  VERCEL (Recommended)"
    echo "   npm i -g vercel && vercel"
    echo ""
    echo "2️⃣  NETLIFY"
    echo "   npm i -g netlify-cli && netlify deploy --prod"
    echo ""
    echo "3️⃣  GITHub Pages"
    echo "   npx gh-pages -d dist"
    echo ""
    echo "4️⃣  SURGE (Simplest)"
    echo "   npm i -g surge && npx surge dist"
    echo ""
    echo "5️⃣  LOCAL PREVIEW"
    echo "   npx serve dist"
    echo ""
    echo "📖 See HOSTING.md for detailed instructions"
else
    echo "❌ Build failed!"
    exit 1
fi