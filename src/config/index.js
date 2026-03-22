require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5002,
  wsPort: process.env.WS_PORT || 751,
  origin: process.env.ORIGIN || 'http://34.64.85.65:3000',
  mongoUrl: process.env.MONGODB_URI || 'mongodb+srv://admin:0423504564@gx-mongo.eau3o.mongodb.net',
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'ap-northeast-2',
    s3Bucket: process.env.AWS_S3_BUCKET || 'garden-of-papers',
  },
  grobidUrl: process.env.GROBID_URL || 'http://localhost:8070',
  s2ApiKey: process.env.S2_API_KEY || '',
  serpApiKey: process.env.SERPAPI_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
};
