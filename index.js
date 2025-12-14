 const express = require('express');
const multer = require('multer');
const { Storage } = require('megajs');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Load environment variables
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

// Basic check
if (!MEGA_EMAIL || !MEGA_PASSWORD) {
    console.error('ERROR: Set MEGA_EMAIL and MEGA_PASSWORD in .env file!');
}

let megaClient = null;

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

// Download endpoint - stream file directly to client
app.get('/download/:fileHandle', async (req, res) => {
    const fileHandle = req.params.fileHandle;

    if (!fileHandle) {
        return res.status(400).json({ success: false, error: 'File handle required' });
    }

    try {
        const client = await getMegaClient();

        // Find file by handle in the client's storage mapping
        let file = null;
        if (client.files && client.files[fileHandle]) {
            file = client.files[fileHandle];
        } else if (client.files) {
            // Try to find by matching nodeId/h/id in values
            file = Object.values(client.files).find(f => f && (f.nodeId === fileHandle || f.h === fileHandle || f.id === fileHandle));
        }

        if (!file) {
            console.warn('File not found in client.files for handle:', fileHandle);
            return res.status(404).json({ success: false, error: 'File not found' });
        }

        console.log('Streaming file:', file.name, 'nodeId:', file.nodeId);

        // Set headers for download
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
        res.setHeader('Cache-Control', 'no-cache');

        // Create read stream and pipe to response
        const stream = file.download();
        stream.pipe(res);

        stream.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Download failed' });
            }
        });
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
