require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// CORS — allow Shopify store
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

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

// ── GENERATE ENDPOINT ──
app.post('/generate', upload.single('photo'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;

  try {
    if (!filePath) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    // 1. Upload original photo to fal.ai as base64
    const imageBuffer = fs.readFileSync(filePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64Image}`;

    // 2. Call fal.ai — face swap / image compositing
    const falResponse = await axios.post(
      'https://fal.run/fal-ai/face-to-sticker',
      {
        image_url: dataUri,
        prompt: 'a magical kids puzzle portrait, colorful, whimsical, fantasy art style, high quality',
        negative_prompt: 'blurry, low quality, dark, scary',
        num_inference_steps: 20,
        guidance_scale: 7.5
      },
      {
        headers: {
          'Authorization': `Key ${process.env.FAL_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000
      }
    );

    const generatedUrl = falResponse.data?.images?.[0]?.url || falResponse.data?.image?.url;

    if (!generatedUrl) {
      throw new Error('No image returned from fal.ai');
    }

    // 3. Download generated image
    const imgResponse = await axios.get(generatedUrl, { responseType: 'arraybuffer' });
    const imgBuffer = Buffer.from(imgResponse.data);

    // 4. Create watermarked version using sharp
    const watermarkedBuffer = await sharp(imgBuffer)
      .composite([{
        input: Buffer.from(
          `<svg width="800" height="800">
            <text x="50%" y="50%" font-family="Arial" font-size="60" font-weight="bold"
              fill="rgba(255,255,255,0.4)" text-anchor="middle" dominant-baseline="middle"
              transform="rotate(-35, 400, 400)">PREVIEW ONLY</text>
            <text x="50%" y="65%" font-family="Arial" font-size="30"
              fill="rgba(255,255,255,0.3)" text-anchor="middle" dominant-baseline="middle"
              transform="rotate(-35, 400, 500)">puzzleforkids.com</text>
          </svg>`
        ),
        gravity: 'center'
      }])
      .jpeg({ quality: 85 })
      .toBuffer();

    // 5. Upload both to Cloudinary
    const timestamp = Date.now();

    // Upload print (clean) version
    const printUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'puzzle-portraits/print', public_id: `print_${timestamp}`, resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(imgBuffer);
    });

    // Upload watermarked version
    const watermarkUpload = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'puzzle-portraits/preview', public_id: `preview_${timestamp}`, resource_type: 'image' },
        (error, result) => error ? reject(error) : resolve(result)
      ).end(watermarkedBuffer);
    });

    // 6. Cleanup temp file
    fs.unlinkSync(filePath);

    // 7. Return both URLs
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
