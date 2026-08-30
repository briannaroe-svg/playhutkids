// Shared Cloudinary config and upload helpers.
// Credentials come from env vars (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
// CLOUDINARY_API_SECRET) — set in Render's dashboard, never hardcoded here.
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a PDF buffer to Cloudinary.
 * @param {Buffer} fileBuffer - the raw PDF file content
 * @param {string} publicId - desired filename/path within Cloudinary (no extension)
 * @param {string} folder - Cloudinary folder, e.g. 'little-playhut/handbooks'
 * @returns {Promise<string>} the secure_url of the uploaded file
 */
function uploadPdfBuffer(fileBuffer, publicId, folder = 'little-playhut/misc') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw', // PDFs go up as 'raw', not 'image'
        folder,
        public_id: publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    stream.end(fileBuffer);
  });
}

/**
 * Upload a base64-encoded image (e.g. a signature capture) to Cloudinary.
 * @param {string} base64Data - full data URI, e.g. "data:image/png;base64,...."
 * @param {string} publicId
 * @param {string} folder
 * @returns {Promise<string>} the secure_url
 */
function uploadBase64Image(base64Data, publicId, folder = 'little-playhut/signatures') {
  return cloudinary.uploader
    .upload(base64Data, { folder, public_id: publicId, overwrite: true })
    .then((result) => result.secure_url);
}

/**
 * Upload a base64-encoded file of ANY type (PDF or image) to Cloudinary,
 * letting Cloudinary auto-detect the resource type from the data URI's MIME
 * type. Used for child document uploads (immunization records, health forms)
 * where the admin could pick either a PDF or a photo of a paper form —
 * unlike uploadPdfBuffer (always PDF) or uploadBase64Image (always image),
 * this one doesn't assume which.
 * @param {string} base64Data - full data URI, e.g. "data:application/pdf;base64,...." or "data:image/jpeg;base64,...."
 * @param {string} publicId
 * @param {string} folder
 * @returns {Promise<string>} the secure_url
 */
function uploadBase64File(base64Data, publicId, folder = 'little-playhut/documents') {
  return cloudinary.uploader
    .upload(base64Data, { folder, public_id: publicId, overwrite: true, resource_type: 'auto' })
    .then((result) => result.secure_url);
}

module.exports = { cloudinary, uploadPdfBuffer, uploadBase64Image, uploadBase64File };
