const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');

async function parsePdf(pdfBuffer) {
  const form = new FormData();
  form.append('input', pdfBuffer, { filename: 'paper.pdf', contentType: 'application/pdf' });

  const res = await axios.post(
    `${config.grobidUrl}/api/processFulltextDocument`,
    form,
    { headers: form.getHeaders(), timeout: 60000 }
  );

  return res.data; // TEI XML
}

module.exports = { parsePdf };
