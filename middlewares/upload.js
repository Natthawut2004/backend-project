
const multer = require('multer');

const { CloudinaryStorage } = require('multer-storage-cloudinary');

const cloudinary = require('../config/cloudinary');

const imageStorage = new CloudinaryStorage({

  cloudinary: cloudinary,

  params: {

    folder: 'sornserm/images',

    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],

    resource_type: 'image',

  },

});

const videoStorage = new CloudinaryStorage({

  cloudinary: cloudinary,

  params: {

    folder: 'sornserm/videos',

    allowed_formats: ['mp4', 'mov', 'avi', 'webm'],

    resource_type: 'video',

  },

});

const uploadImage = multer({ storage: imageStorage, limits: { fileSize: 10 * 1024 * 1024 } });

const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 100 * 1024 * 1024 } });

const documentStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'sornserm/documents',
    resource_type: 'raw',   // สำหรับไฟล์ที่ไม่ใช่รูป/วิดีโอ เช่น PDF, DOCX, PPTX
  },
});

const uploadDocument = multer({ storage: documentStorage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

module.exports = { uploadImage, uploadVideo, uploadDocument };

