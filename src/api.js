const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fse = require('fs-extra');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
const VIDEO_DIR = process.env.VIDEO_DIRECTORY || path.join(__dirname, '..', 'videos');

// Ensure videos directory exists
const TEMP_DIR = path.join(VIDEO_DIR, 'temp');
if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean up stale temp directories older than 2 hours to save space
const cleanupStaleUploads = () => {
    try {
        if (!fs.existsSync(TEMP_DIR)) return;
        const now = Date.now();
        const dirs = fs.readdirSync(TEMP_DIR);
        for (const dir of dirs) {
            const dirPath = path.join(TEMP_DIR, dir);
            const stat = fs.statSync(dirPath);
            // If directory is older than 2 hours (2 * 60 * 60 * 1000)
            if (now - stat.mtimeMs > 7200000) {
                fse.removeSync(dirPath);
                console.log(`Cleaned up stale upload directory: ${dir}`);
            }
        }
    } catch (err) {
        console.error('Error cleaning up stale uploads:', err);
    }
};
setInterval(cleanupStaleUploads, 3600000); // Run every hour


// Set up multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, VIDEO_DIR);
    },
    filename: (req, file, cb) => {
        // Sanitize filename to avoid weird characters, keep original extension
        const uniqueName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());

// --- Authentication --- //
const APP_PASSWORD = process.env.APP_PASSWORD || 'default_password';
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-streamer-key';

app.get('/api/health', (req, res) => {
    res.json({ message: 'OK' });
});

// Login Endpoint
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Auth Middleware
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// API: Get all schedules
app.get('/api/schedule', requireAuth, async (req, res) => {
    try {
        const schedules = await prisma.streamSchedule.findMany({
            orderBy: { time: 'asc' }
        });
        res.json(schedules);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch schedules' });
    }
});

// API: Create a new schedule
app.post('/api/schedule', requireAuth, async (req, res) => {
    const { date, time, video, title, focusArea, isActive } = req.body;
    try {
        const newSchedule = await prisma.streamSchedule.create({
            data: { date, time, video, title, focusArea, isActive: isActive ?? true }
        });
        res.status(201).json(newSchedule);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create schedule' });
    }
});

// API: Update an existing schedule
app.put('/api/schedule/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { date, time, video, title, focusArea, isActive } = req.body;
    try {
        const updated = await prisma.streamSchedule.update({
            where: { id: Number(id) },
            data: { date, time, video, title, focusArea, isActive }
        });
        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to update schedule' });
    }
});

// API: Delete a schedule
app.delete('/api/schedule/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.streamSchedule.delete({
            where: { id: Number(id) }
        });
        res.json({ message: 'Deleted successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete schedule' });
    }
});

// API: Get all available video files
app.get('/api/videos', requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(VIDEO_DIR)
            .filter(file => file.endsWith('.mp4'))
            .map(file => {
                const stat = fs.statSync(path.join(VIDEO_DIR, file));
                return {
                    name: file,
                    size: stat.size,
                    createdAt: stat.birthtime
                };
            });
        res.json(files);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to read videos directory' });
    }
});

// API: Upload a video chunk
app.post('/api/upload/chunk', requireAuth, upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video chunk provided' });
    }
    const { uploadId, chunkIndex } = req.body;
    if (!uploadId || chunkIndex === undefined) {
         // Cleanup immediately if invalid request
         fs.unlinkSync(req.file.path);
         return res.status(400).json({ error: 'Missing uploadId or chunkIndex' });
    }

    try {
        const chunkDir = path.join(TEMP_DIR, uploadId);
        if (!fs.existsSync(chunkDir)) {
            fs.mkdirSync(chunkDir, { recursive: true });
        }
        
        // Move the uploaded chunk to the specific folder with its index as the filename
        const chunkPath = path.join(chunkDir, chunkIndex.toString());
        fs.renameSync(req.file.path, chunkPath);
        
        res.status(200).json({ message: `Chunk ${chunkIndex} uploaded successfully` });
    } catch (error) {
        console.error('Error saving chunk:', error);
        // Attempt cleanup 
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Failed to save chunk' });
    }
});

// API: Complete chunked upload
app.post('/api/upload/complete', requireAuth, async (req, res) => {
    const { uploadId, originalFilename, totalChunks } = req.body;
    
    if (!uploadId || !originalFilename || !totalChunks) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    const chunkDir = path.join(TEMP_DIR, uploadId);
    
    try {
        if (!fs.existsSync(chunkDir)) {
            return res.status(404).json({ error: 'Upload session not found' });
        }

        // Verify all chunks exist
        for (let i = 0; i < totalChunks; i++) {
            if (!fs.existsSync(path.join(chunkDir, i.toString()))) {
                 return res.status(400).json({ error: `Missing chunk ${i}` });
            }
        }

        // Create the final file
        const safeFilename = Date.now() + '-' + originalFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const finalPath = path.join(VIDEO_DIR, safeFilename);
        
        // Ensure final file is empty/created
        fs.writeFileSync(finalPath, '');

        // Append chunks in order
        for (let i = 0; i < totalChunks; i++) {
            const chunkPath = path.join(chunkDir, i.toString());
            const chunkData = fs.readFileSync(chunkPath);
            fs.appendFileSync(finalPath, chunkData);
        }

        // Cleanup temp directory
        fse.removeSync(chunkDir);

        res.status(201).json({
            message: 'Video upload completed successfully',
            filename: safeFilename
        });

    } catch (error) {
        console.error('Error completing upload:', error);
        // Attempt cleanup
        try {
             fse.removeSync(chunkDir);
        } catch(e) {}
        res.status(500).json({ error: 'Failed to stitch video' });
    }
});

// API: Abort an upload and clean up parts
app.post('/api/upload/abort', requireAuth, (req, res) => {
     const { uploadId } = req.body;
     if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });
     
     const chunkDir = path.join(TEMP_DIR, uploadId);
     try {
         if (fs.existsSync(chunkDir)) {
             fse.removeSync(chunkDir);
         }
         res.status(200).json({ message: 'Upload aborted and cleaned up' });
     } catch(e) {
         console.error('Error aborting upload:', e);
         res.status(500).json({ error: 'Failed to cleanup upload' });
     }
});

// API: Delete a video
app.delete('/api/videos/:filename', requireAuth, (req, res) => {
    const { filename } = req.params;
    try {
        const filePath = path.join(VIDEO_DIR, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ message: 'Video deleted successfully' });
        } else {
            res.status(404).json({ error: 'Video not found' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});

// Serve videos statically for preview (protected by query token)
app.use('/videos', requireAuth, express.static(VIDEO_DIR));

// Serve frontend in production (Commented out because backend is hosted separately)
// const frontendBuildPath = path.join(__dirname, '..', 'frontend', 'dist');
// app.use(express.static(frontendBuildPath));
// app.use((req, res) => {
//     res.sendFile(path.join(frontendBuildPath, 'index.html'));
// });

module.exports = app;
