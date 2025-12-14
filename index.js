  const Mega = require('megajs');

let storage = null;
let storageReady = false;

async function initMega() {
  const email = process.env.MEGA_EMAIL;
  const password = process.env.MEGA_PASSWORD;
  if (!email || !password) throw new Error('Missing MEGA_EMAIL or MEGA_PASSWORD');

  storage = Mega({ email, password });

  await new Promise((resolve, reject) => {
    const onReady = () => {
      storageReady = true;
      console.log('MEGA storage ready');
      cleanup();
      resolve();
    };
    const onError = (err) => {
      console.error('MEGA init error', err);
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      storage.removeListener('ready', onReady);
      storage.removeListener('error', onError);
    };
    storage.on('ready', onReady);
    storage.on('error', onError);
    // timeout
    setTimeout(() => {
      cleanup();
      reject(new Error('MEGA init timeout'));
    }, 20000);
  });
}

app.get('/health', (req, res) => {
  if (storageReady) return res.json({ ok: true });
  return res.status(503).json({ ok: false, message: 'storage not ready' });
});

// in upload route:
if (!storageReady) return res.status(503).json({ success: false, error: 'storage not ready' });
