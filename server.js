const http = require("http");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const port = 8080;

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

http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);

    // Remove leading /
    urlPath = urlPath.replace(/^\/+/, "");

    let filePath = path.join(root, urlPath);

    // If requesting the root, serve index.html
    if (!urlPath) {
        filePath = path.join(root, "index.html");
    }

    // Prevent directories from being passed to createReadStream
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, {
            "Content-Type": "text/plain"
        });
        res.end("404 - File not found");
        return;
    }

    // Required for Godot Web threading / SharedArrayBuffer
    res.setHeader(
        "Cross-Origin-Opener-Policy",
        "same-origin"
    );

    res.setHeader(
        "Cross-Origin-Embedder-Policy",
        "require-corp"
    );

    const ext = path.extname(filePath).toLowerCase();

    res.setHeader(
        "Content-Type",
        mime[ext] || "application/octet-stream"
    );

    const stream = fs.createReadStream(filePath);

    stream.on("error", (err) => {
        console.error(err);
        if (!res.headersSent) {
            res.writeHead(500);
        }
        res.end("500 - Server error");
    });

    stream.pipe(res);

}).listen(port, () => {
    console.log(`Godot game running at http://localhost:${port}`);
});