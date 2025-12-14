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

        // Clean up temp file
        fs.unlink(filePath, (err) => {
            if (err) console.error('Cleanup error:', err);
        });

        console.log('Upload successful:', safeName);

        // Avoid JSON.stringify(uploadedFile) because it may contain circular refs.
        // Log only specific, safe properties for diagnosis.
        try {
            console.log('DEBUG uploadedFile.name:', uploadedFile?.name);
            console.log('DEBUG uploadedFile.h (handle):', uploadedFile?.h);
            console.log('DEBUG uploadedFile.link:', uploadedFile?.link);
            console.log('DEBUG uploadedFile.nodeID:', uploadedFile?.nodeID);
        } catch (e) {
            console.warn('DEBUG logging uploadedFile failed:', e && e.message ? e.message : e);
        }

        // Generate public link for the uploaded file using available handle
        let bookUrl = null;
        try {
            // megajs exposes a file handle in different properties depending on version
            const handle = uploadedFile?.h || uploadedFile?.nodeID || uploadedFile?.id;
            if (uploadedFile && uploadedFile.link) {
                bookUrl = uploadedFile.link;
                console.log('Using uploadedFile.link');
            } else if (handle) {
                // Construct typical MEGA file link (note: may require key to be downloadable)
                bookUrl = `https://mega.nz/file/${handle}`;
                console.log('Constructed MEGA link from handle:', handle);
            }
        } catch (linkErr) {
            console.error('Error generating link:', linkErr && linkErr.message ? linkErr.message : linkErr);
        }

        if (!bookUrl) {
            console.error('ERROR: Could not generate bookUrl; uploadedFile lacked handle/link.');
            return res.status(500).json({ success: false, error: 'File uploaded but could not generate download link' });
        }

        res.json({ success: true, bookUrl });

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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
