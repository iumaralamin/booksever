const express = require('express');
const multer = require('multer');
const { Storage } = require('megajs');
const fs = require('fs');
const path = require('path');

const cors = require('cors');
const app = express();
app.use(cors());
const upload = multer({ dest: 'uploads/' });

// Load environment variables
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

// Basic check
if (!MEGA_EMAIL || !MEGA_PASSWORD) {
    console.error('ERROR: Set MEGA_EMAIL and MEGA_PASSWORD in .env file!');
}

let megaClient = null;
// Keep a short-lived in-memory map of recent uploads to guarantee lookup
// Stores { file: MutableFile, expiresAt: number }
const recentUploads = new Map();
const UPLOAD_CACHE_TTL_MS = parseInt(process.env.UPLOAD_CACHE_TTL_MS || String(15 * 60 * 1000), 10);

async function getMegaClient() {
    // Fail fast if credentials are missing
    if (!MEGA_EMAIL || !MEGA_PASSWORD) {
        throw new Error('MEGA credentials are not configured in server environment variables.');
    }

    if (!megaClient) {
        try {
            console.log('Attempting to connect to MEGA...');
            megaClient = new Storage({
                email: MEGA_EMAIL,
                password: MEGA_PASSWORD,
                allowUploadBuffering: true  // Enable buffering as fallback
            });
            await megaClient.ready;
            console.log('Connected to MEGA successfully');
        } catch (connectionError) {
            console.error('FAILED to connect to MEGA:', connectionError.message);
            megaClient = null;
            throw new Error(`MEGA connection failed: ${connectionError.message}`);
        }
    }
    return megaClient;
}

// Upload endpoint
app.post('/upload-book', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    try {
        const client = await getMegaClient();

        const filePath = req.file.path;
        const originalName = req.body.filename || req.file.originalname || 'book.pdf';
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');

        // Get file size
        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;
        const stream = fs.createReadStream(filePath);

        // Pass file size in upload options (FIXES THE ERROR)
        const uploadTask = client.upload({
            name: safeName,
            size: fileSize  // This is the crucial addition
        }, stream);

        const uploadedFile = await uploadTask.complete;

        // Debug: log all properties to see what's available
        console.log('DEBUG uploadedFile keys:', Object.keys(uploadedFile || {}));
        console.log('DEBUG uploadedFile.h:', uploadedFile?.h);
        console.log('DEBUG uploadedFile.nodeID:', uploadedFile?.nodeID);
        console.log('DEBUG uploadedFile.id:', uploadedFile?.id);
        console.log('DEBUG uploadedFile.name:', uploadedFile?.name);
        console.log('DEBUG uploadedFile type:', typeof uploadedFile);

        // Try to extract handle from different possible properties
        // megajs returns the node id as `nodeId` on the MutableFile object
        let fileHandle = uploadedFile?.nodeId || uploadedFile?.h || uploadedFile?.nodeID || uploadedFile?.id;

        // If still not found, try looking through client files
        if (!fileHandle && client.files) {
            console.log('Searching through client.files for uploaded file...');
            for (const f of Object.values(client.files)) {
                if (f && f.name === safeName) {
                    fileHandle = f.nodeId || f.h || f.nodeID || f.id;
                    console.log('Found file in client.files:', fileHandle);
                    break;
                }
            }
        }

        if (!fileHandle) {
            console.error('ERROR: Could not extract file handle. uploadedFile:', uploadedFile);
            return res.status(500).json({ success: false, error: 'File uploaded but could not extract handle' });
        }

        // Cache uploaded file object for immediate retrieval during downloads
        try {
            const entry = { file: uploadedFile, expiresAt: Date.now() + UPLOAD_CACHE_TTL_MS };
            recentUploads.set(fileHandle, entry);
            // Schedule eviction
            setTimeout(() => {
                recentUploads.delete(fileHandle);
                console.log('Evicted recent upload from cache:', fileHandle);
            }, UPLOAD_CACHE_TTL_MS + 1000);
        } catch (e) {
            console.warn('Could not cache recent upload:', e && e.message ? e.message : e);
        }

        // Return a direct download URL via the proxy
        const downloadUrl = `https://booksever-1.onrender.com/download/${fileHandle}`;
        console.log('Upload successful, download URL:', downloadUrl);

        // Clean up temp file
        fs.unlink(filePath, (err) => {
            if (err) console.error('Cleanup error:', err);
        });

        return res.json({ success: true, bookUrl: downloadUrl });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Upload failed'
        });
    }
});

app.get('/', (req, res) => {
    res.send('bookserver proxy is running! Ready for uploads.');
});

// Download endpoint - stream file directly to client with Range support
app.get('/download/:fileHandle', async (req, res) => {
    const fileHandle = req.params.fileHandle;

    if (!fileHandle) {
        return res.status(400).json({ success: false, error: 'File handle required' });
    }

    try {
        const client = await getMegaClient();

        // Find file by handle in recent uploads cache first, then client's storage mapping
        let cached = recentUploads.get(fileHandle) || null;
        let file = cached ? cached.file : null;
        if (!file && client.files) {
            if (client.files[fileHandle]) {
                file = client.files[fileHandle];
            } else {
                // Try to find by matching nodeId/h/id in values
                file = Object.values(client.files).find(f => f && (f.nodeId === fileHandle || f.h === fileHandle || f.id === fileHandle));
            }
        }

        if (!file) {
            console.warn('File not found in client.files for handle:', fileHandle);
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        const totalSize = Number(file.size) || 0;
        const rangeHeader = req.headers.range;
        const filename = file.name || 'file';

        // Helper to set common headers
        const setCommonHeaders = (length) => {
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Accept-Ranges', 'bytes');
            // Basic content-type detection
            const ext = (path.extname(filename) || '').toLowerCase();
            let contentType = 'application/octet-stream';
            if (ext === '.pdf') contentType = 'application/pdf';
            else if (ext === '.epub') contentType = 'application/epub+zip';
            else if (ext === '.txt') contentType = 'text/plain';
            res.setHeader('Content-Type', contentType);
            if (typeof length === 'number') res.setHeader('Content-Length', String(length));
        };

        if (!rangeHeader) {
            // No Range requested — send whole file
            setCommonHeaders(totalSize);
            const stream = file.download();
            stream.on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) res.status(500).json({ success: false, error: 'Download failed' });
            });
            stream.pipe(res);
            return;
        }

        // Parse Range header: bytes=start-end
        const matches = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (!matches) {
            return res.status(416).json({ success: false, error: 'Malformed Range header' });
        }

        let start = matches[1] ? parseInt(matches[1], 10) : 0;
        let end = matches[2] ? parseInt(matches[2], 10) : (totalSize - 1);

        if (isNaN(start) || isNaN(end) || start > end || start < 0) {
            return res.status(416).json({ success: false, error: 'Requested Range Not Satisfiable' });
        }

        end = Math.min(end, totalSize - 1);
        const chunkSize = (end - start) + 1;

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        setCommonHeaders(chunkSize);

        // Try to request a ranged stream from megajs. megajs exposes `download(start, end)` in some versions
        let stream = null;
        try {
            // Preferred: call with numeric args
            stream = file.download(start, end);
        } catch (err1) {
            try {
                // Alternative: object param
                stream = file.download({ start, end });
            } catch (err2) {
                console.warn('Ranged download not supported by megajs client, falling back to full stream');
                stream = file.download();
            }
        }

        stream.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) res.status(500).json({ success: false, error: 'Download failed' });
        });

        // If we had to fall back to full stream while a range was requested,
        // the client may receive the whole file. This is a best-effort fallback.
        stream.pipe(res);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ success: false, error: error.message || 'Download failed' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
