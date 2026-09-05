# Vercel Migration Guide

## Project Structure
```
project-root/
├── api/
│   └── index.js           (serverless handler)
├── public/                (all static files)
│   ├── index.html
│   ├── Machine Party.wasm
│   ├── Machine Party.pck.part01
│   ├── Machine Party.pck.part02
│   └── ... (all other game files)
├── vercel.json            (deployment config)
├── package.json
└── server.js              (keep for local dev)
```

## Setup Steps

1. **Move all game files to `public/` folder**
   - index.html
   - All `.wasm` files
   - All `.pck.partXX` files
   - All `.js` files
   - All images (`.png`, `.jpg`, etc.)
   - `.parts.json` file

2. **Copy provided files to root**
   - `api/index.js` → handles all requests
   - `vercel.json` → deployment config
   - `package.json` → dependencies & scripts

3. **Deploy to Vercel**
   ```bash
   npm install -g vercel
   vercel
   ```

## Key Differences from Node.js Server

- **No streaming**: Vercel reads entire file into memory (fine for Godot games <50MB)
- **CORS headers set at Vercel level** in `vercel.json`
- **Automatic routing**: All requests → `/api` which serves from `/public`
- **Cold starts**: First request has ~1-2s delay, then instant

## Local Testing

Run the original server locally:
```bash
node server.js
```

Test Vercel build locally:
```bash
vercel dev
```

## File Size Considerations ⚠️

Your `.pck` files are **98MB each** — exceeds Vercel's 50MB limit.

### Solution: Store on CDN, Proxy via Vercel

1. **Upload `.pck.partXX` and `.wasm` files to CDN** (not Vercel):
   - Bunny CDN, Cloudflare R2, AWS S3, or similar
   - Set CDN URL in Vercel environment variable

2. **Set CDN_URL env variable in Vercel**:
   ```bash
   vercel env add CDN_URL https://your-cdn.com/games/machine-party/
   ```
   
   Example with Bunny CDN:
   ```
   CDN_URL=https://yourbundle.b-cdn.net/machine-party/
   ```

3. **How it works**:
   - Client requests `https://your-vercel-app.vercel.app/Machine Party.pck.part00`
   - Vercel API proxies request to CDN
   - CDN streams the 98MB file to client
   - Vercel function stays under 50MB (no binary stored)

### Storage on CDN

Upload these to your CDN:
- `Machine Party.wasm`
- `Machine Party.side.wasm`
- `Machine Party.pck.part00` through `Machine Party.pck.part06`

Keep in `/public` on Vercel:
- `index.html`
- `Machine Party.js`
- `Machine Party.audio.worklet.js`
- `Machine Party.audio.position.worklet.js`
- `Machine Party.parts.json`
- Images (`.png`, `.jpg`, `.ico`, `.svg`)

### Free CDN Options

- **jsDelivr** (free, fast) — use GitHub repo as source
- **Bunny CDN** (~$0.01/GB) — cheapest paid option
- **Cloudflare R2** ($0.015/GB) — free tier limited

## CORS & SharedArrayBuffer

The `vercel.json` headers replicate your original server's:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- These enable Godot Web threading & SharedArrayBuffer
