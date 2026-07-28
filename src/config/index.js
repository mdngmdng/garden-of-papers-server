require('dotenv').config();
const fs = require('fs');

function resolveGrobidUrl(value) {
  const configured = value || 'http://localhost:8070';
  try {
    const url = new URL(configured);
    // docker-compose service names only resolve from inside the container
    // network. The development server is commonly run directly on macOS.
    if (url.hostname === 'grobid' && !fs.existsSync('/.dockerenv')) {
      url.hostname = '127.0.0.1';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return configured;
  }
  return configured.replace(/\/$/, '');
}

module.exports = {
  port: process.env.PORT || 5002,
  origin: process.env.ORIGIN || 'http://34.64.85.65:3000',
  mongoUrl: process.env.MONGODB_URI || 'mongodb+srv://admin:0423504564@gx-mongo.eau3o.mongodb.net',
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-northeast-2',
    s3Bucket: process.env.AWS_S3_BUCKET || 'garden-of-papers',
  },
  grobidUrl: resolveGrobidUrl(process.env.GROBID_URL),
  s2ApiKey: process.env.S2_API_KEY || '',
  serpApiKey: process.env.SERPAPI_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
};
