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

## File Size Considerations

If your `.pck` files exceed Vercel's function size limit (50MB uncompressed):
- Split large `.pck` into smaller `.part00`, `.part01`, etc.
- Already supported by your code (uses `Machine Party.parts.json`)
- Vercel will handle multi-part assembly fine

## CORS & SharedArrayBuffer

The `vercel.json` headers replicate your original server's:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- These enable Godot Web threading & SharedArrayBuffer
