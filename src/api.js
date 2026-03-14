const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const prisma = new PrismaClient();
const app = express();
const VIDEO_DIR = process.env.VIDEO_DIRECTORY || path.join(__dirname, '..', 'videos');

// Ensure videos directory exists
if (!fs.existsSync(VIDEO_DIR)) {
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

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

app.use(cors("*"));
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

// API: Upload a new video
app.post('/api/upload', requireAuth, upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file provided' });
    }
    res.status(201).json({
        message: 'Video uploaded successfully',
        filename: req.file.filename
    });
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
