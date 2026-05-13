require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// CORS
app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Puzzle Portrait Backend is running!' });
});

// GENERATE ENDPOINT
app.post('/generate', upload.single('photo'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;

  try {
    if (!filePath) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    // 1. Convert image to base64
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64Image}`;

    // 2. Call Replicate API
    const replicateResponse = await axios.post(
      'https://api.replicate.com/v1/predictions',
      {
        version: 'catacolabs/cartoonify:f109015d60170dfb20460f17da8cb863155823c85ece1115e1e9e4ec7ef51d3b',
        input: {
          image: dataUri
        }
      },
      {
        headers: {
          'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    // 3. Poll for result
    let prediction = replicateResponse.data;
    const predictionId = prediction.id;
    let generatedUrl = null;
    let attempts = 0;

    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 3000));
      const pollResponse = await axios.get(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        {
          headers: {
            'Authorization': `Token ${process.env.REPLICATE_API_TOKEN}`
          }
        }
      );
      prediction = pollResponse.data;

      if (prediction.status === 'succeeded') {
        generatedUrl = Array.isArray(prediction.output)
          ? prediction.output[0]
          : prediction.output;
        break;
      } else if (prediction.status === 'failed') {
        throw new Error('Replicate generation failed');
      }
      attempts++;
    }

    if (!generatedUrl) {
      throw new Error('Timeout waiting for image generation');
    }

    // 4. Download generated image
    const imgResponse = await axios.get(generatedUrl, { responseType: 'arraybuffer' });
    const imgBuffer = Buffer.from(imgResponse.data);

    // 5. Create watermarked version
    const watermarkedBuffer = await sharp(imgBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800">
            <text x="50%" y="50%" font-family="Arial" font-size="60" font-weight="bold"
              fill="rgba(255,255,255,0.45)" text-anchor="middle" dominant-baseline="middle"
              transform="rotate(-35, 400, 400)">PREVIEW ONLY</text>
            <text x="50%" y="65%" font-family="Arial" font-size="30"
              fill="rgba(255,255,255,0.35)" text-anchor="middle" dominant-baseline="middle"
              transform="rotate(-35, 400, 500)">puzzleforkids.com</text>
          </svg>`
        ),
        gravity: 'center'
      }])
      .jpeg({ quality: 85 })
      .toBuffer();

    // 6. Upload both to Cloudinary
    const timestamp = Date.now();

    const printUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'puzzle-portraits/print', public_id: `print_${timestamp}`, resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(imgBuffer);
    });

    const watermarkUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'puzzle-portraits/preview', public_id: `preview_${timestamp}`, resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(watermarkedBuffer);
    });

    // 7. Cleanup
    fs.unlinkSync(filePath);

    // 8. Return URLs
    res.json({
      success: true,
      watermarked_url: watermarkUpload.secure_url,
      print_url: printUpload.secure_url
    });

  } catch (error) {
    console.error('Generate error:', error?.response?.data || error.message);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
