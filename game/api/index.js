const fs = require("fs");
const path = require("path");

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

module.exports = (req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    urlPath = urlPath.replace(/^\/+/, "");

    // Redirect /api requests to public folder
    if (urlPath.startsWith("api/")) {
        urlPath = urlPath.replace("api/", "");
    }

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

    // Godot Web CORS headers
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", mime[ext] || "application/octet-stream");

    try {
        const fileContent = fs.readFileSync(filePath);
        res.status(200).send(fileContent);
    } catch (err) {
        console.error(err);
        res.status(500).send("500 - Server error");
    }
};
