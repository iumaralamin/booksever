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

        // DEBUG: Log the entire uploadedFile object to see what we're working with
        console.log('DEBUG uploadedFile object:', JSON.stringify(uploadedFile, null, 2));
        console.log('DEBUG uploadedFile keys:', Object.keys(uploadedFile || {}));
        console.log('DEBUG uploadedFile.link:', uploadedFile?.link);
        console.log('DEBUG uploadedFile.nodeID:', uploadedFile?.nodeID);
        console.log('DEBUG uploadedFile.h:', uploadedFile?.h);

        // Generate public link for the uploaded file
        let bookUrl = null;
        try {
            // Try different ways to get the file handle/ID
            let fileHandle = uploadedFile?.nodeID || uploadedFile?.h || uploadedFile?.id;

            if (uploadedFile && uploadedFile.link) {
                bookUrl = uploadedFile.link;
                console.log('✓ Using uploadedFile.link');
            } else if (fileHandle) {
                // Construct a MEGA public link manually
                bookUrl = `https://mega.nz/file/${fileHandle}`;
                console.log('✓ Constructed MEGA link from handle:', fileHandle);
            }
            console.log('Generated bookUrl:', bookUrl);
        } catch (linkErr) {
            console.error('Error generating link:', linkErr);
        }

        if (!bookUrl) {
            console.error('ERROR: Could not generate bookUrl. Uploaded file object was:', uploadedFile);
            return res.status(500).json({
                success: false,
                error: 'File uploaded but could not generate download link'
            });
        }

        res.json({
            success: true,
            bookUrl: bookUrl
        });

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
