const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const mime = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".wasm": "application/wasm",
    ".pck": "application/octet-stream",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".css": "text/css",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml"
};

// Configuration: Point to your CDN or storage (set via env variable)
const CDN_URL = process.env.CDN_URL || "https://your-cdn.com/games/machine-party/";

module.exports = async (req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    urlPath = urlPath.replace(/^\/+/, "");

    if (urlPath.startsWith("api/")) {
        urlPath = urlPath.replace("api/", "");
    }

    const isSplitPck = urlPath.match(/\.pck\.part\d+$/);
    const isWasm = urlPath.endsWith(".wasm");

    // CORS & Godot headers for all responses
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");

    // Handle OPTIONS for CORS preflight
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }

    // If .pck.part or .wasm, proxy from CDN (keeps Vercel under 50MB limit)
    if (isSplitPck || isWasm) {
        const cdnUrl = CDN_URL + urlPath;
        return proxyCdnFile(cdnUrl, req, res, urlPath);
    }

    // Small files (HTML, JS, JSON, images) served from /public
    let filePath = path.join(process.cwd(), "public", urlPath);

    if (!urlPath) {
        filePath = path.join(process.cwd(), "public", "index.html");
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.status(404).send("404 - File not found");
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", mime[ext] || "application/octet-stream");

    try {
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Length", stat.size);
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    } catch (err) {
        console.error(err);
        if (!res.headersSent) {
            res.status(500).send("500 - Server error");
        }
    }
};

// Proxy large files from CDN with range request support
function proxyCdnFile(cdnUrl, req, res, filename) {
    const protocol = cdnUrl.startsWith("https") ? https : http;

    const proxyReq = protocol.get(cdnUrl, (proxyRes) => {
        const ext = path.extname(filename).toLowerCase();
        res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
        res.setHeader("Content-Length", proxyRes.headers["content-length"]);
        res.setHeader("Accept-Ranges", "bytes");

        // Forward cache headers from CDN
        if (proxyRes.headers["cache-control"]) {
            res.setHeader("Cache-Control", proxyRes.headers["cache-control"]);
        }

        res.writeHead(proxyRes.statusCode);
        proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
        console.error(`CDN fetch failed for ${cdnUrl}:`, err);
        if (!res.headersSent) {
            res.status(502).send("502 - CDN unavailable");
        }
    });
}
