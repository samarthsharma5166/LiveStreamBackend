const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createLiveStream, endLiveStream } = require('./src/youtube');
const { startStreaming } = require('./src/stream-manager');
const { createYogSaathiClass } = require('./src/yogsaathi-api');
require('dotenv').config();

const TIMEZONE = "Asia/Kolkata";
const SCHEDULE_FILE = path.join(__dirname, 'schedule.json');
const VIDEO_DIR = process.env.VIDEO_DIRECTORY || path.join(__dirname, 'videos');

const { PrismaClient } = require('@prisma/client');
const app = require('./src/api');

const prisma = new PrismaClient();

/**
 * Main routine that triggers a live stream.
 * 1. Checks if the class is marked isActive in schedule.json
 * 2. Creates YouTube Live Broadcast
 * 3. Notifies YogSaathi backend via API to create the class
 * 4. Pipes the video to YouTube via FFmpeg
 */
async function handleScheduledStream(timeSlotStr, scheduledItem) {
    console.log(`\n======================================================`);
    console.log(`[${new Date().toLocaleString()}] 🕒 Triggering scheduled stream for ${timeSlotStr}`);

    if (!scheduledItem.isActive) {
        console.log(`⏸️ This slot is marked as inactive in schedule.json. Skipping.`);
        return;
    }

    try {
        // Ensure videoPath is an absolute path before passing it to startStreaming
        const videoPath = path.join(VIDEO_DIR, scheduledItem.video);
        if (!fs.existsSync(videoPath)) {
            console.error(`❌ ERROR: Assigned video file not found: ${videoPath}`);
            return;
        }

        // 1. Create the YouTube live broadcast
        const videoTitle = `YogSaathi Live: ${scheduledItem.title || 'Yoga Class'}`;
        const videoDesc = `Join our live yoga class focusing on ${scheduledItem.focusArea || 'wellness'}.`;

        // 2. Notify YogSaathi Backend and YouTube to create the scheduled class accurately
        // Construct the Date object from "YYYY-MM-DD" and "HH:MM"
        // Note: The system runs in TIMEZONE Asia/Kolkata, but the simplest way is to parse ISO
        // Or assume the server's local time is also set appropriately.
        // For robustness, parse it explicitly using new Date(`${date}T${time}:00+05:30`) if it's IST
        const classDate = new Date(`${scheduledItem.date}T${scheduledItem.time}:00+05:30`);
        
        console.log(`▶️ Creating YouTube Live Broadcast at ${classDate.toLocaleString()}...`);
        const streamData = await createLiveStream(videoTitle, videoDesc, classDate);
        const videoLink = `https://youtu.be/${streamData.videoId}`;
        console.log(`🔗 YouTube Link Generated: ${videoLink}`);
        console.log(`🔑 Stream Key: ${streamData.streamKey}`);

        const yogSaathiClass = await createYogSaathiClass(
            scheduledItem.title,
            scheduledItem.focusArea,
            videoLink,
            classDate
        );

        if (!yogSaathiClass) {
            console.warn(`⚠️ Proceeding with stream, but warning: YogSaathi class creation failed.`);
        }

        // 3. Start streaming using FFmpeg
        console.log(`⏳ Waiting 10 seconds for YouTube Ingest servers to initialize...`);
        await new Promise(res => setTimeout(res, 10000));

        console.log(`📤 Pushing ${scheduledItem.video} to YouTube Ingest...`);
        // We pass streamData.streamKey specifically to the manager
        try {
            await startStreaming(videoPath, streamData.streamUrl, streamData.streamKey);
            console.log(`✅ Stream finished successfully for slot ${timeSlotStr}`);
        } finally {
            if (streamData?.videoId) {
                await endLiveStream(streamData.videoId);
            }
        }
    } catch (error) {
        console.error(`❌ Failed to handle stream for slot ${timeSlotStr}:`, error.message);
    }
    console.log(`======================================================\n`);
}

// Validation
if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    console.error("❌ CRITICAL ERROR: Application missing required .env variable (YOUTUBE_REFRESH_TOKEN).");
    console.error("Please run `node youtube-auth.js` to get your YouTube tokens first.");
    process.exit(1);
}
if (!process.env.YOGSAATHI_API_KEY) {
    console.error("❌ CRITICAL ERROR: Application missing YOGSAATHI_API_KEY. It needs this to tell the YogSaathi backend to create the class.");
    process.exit(1);
}

// Start Express API Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YogSaathi Streamer API running on port ${PORT}`);
});

console.log("=== 🧘 YogSaathi Independent Sub-Broadcaster ===");
console.log(`Starting main scheduler loop in timezone ${TIMEZONE}...`);

// Run loop every minute to check database for active streams
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date();
        
        // Get current date in YYYY-MM-DD
        const dateFormatter = new Intl.DateTimeFormat('en-CA', { 
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const currentDateStr = dateFormatter.format(now);

        // Get current time in HH:MM
        const timeFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: TIMEZONE,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit'
        });
        const currentTimeStr = timeFormatter.format(now);

        // Fetch active schedules matching current date and time
        const activeSchedules = await prisma.streamSchedule.findMany({
            where: {
                date: currentDateStr,
                time: currentTimeStr,
                isActive: true
            }
        });

        if (activeSchedules.length > 0) {
            console.log(`⏰ Found ${activeSchedules.length} active scheduled streams for ${currentTimeStr}`);
            for (const schedule of activeSchedules) {
                // Ensure the loop doesn't block concurrently failing items, run them asynchronously
                handleScheduledStream(schedule.time, schedule).catch(e => console.error(e));
            }
        }
    } catch (error) {
        console.error("❌ Error running database cron check:", error);
    }
}, {
    timezone: TIMEZONE
});

console.log("⏳ Waiting for next scheduled start time... Press Ctrl+C to exit.");
