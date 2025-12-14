const express = require('express');
const multer = require('multer');
const { Storage } = require('megajs');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Load from Glitch .env (secure!)
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

// Basic check—if not set, log error (helps debugging)
if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error('ERROR: Set MEGA_EMAIL and MEGA_PASSWORD in .env file!');
}

let megaClient = null;

async function getMegaClient() {
  if (!megaClient) {
    megaClient = new Storage({
      email: MEGA_EMAIL,
      password: MEGA_PASSWORD
    });
    await megaClient.ready;
    console.log('Connected to MEGA successfully');
  }
  return megaClient;
}

// Upload endpoint (same as before)
app.post('/upload-book', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  try {
    const client = await getMegaClient();

    const filePath = req.file.path;
    const originalName = req.body.filename || req.file.originalname || 'book.pdf';
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');

    const stream = fs.createReadStream(filePath);

    const uploadTask = client.upload({ name: safeName }, stream);
    const uploadedFile = await uploadTask.complete;

    fs.unlink(filePath, (err) => {
      if (err) console.error('Cleanup error:', err);
    });

    console.log('Upload successful:', safeName);

    res.json({
      success: true,
      bookUrl: uploadedFile.link
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
