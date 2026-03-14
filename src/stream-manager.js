const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = 'ffmpeg'; // Use system ffmpeg installed in Docker
require('dotenv').config();

const VIDEO_DIR = process.env.VIDEO_DIRECTORY || path.join(__dirname, '..', 'videos');

/**
 * Gets a video file based on the current day of the year.
 * This ensures the same video is selected all day, but changes tomorrow.
 */
function getDailyVideo() {
    if (!fs.existsSync(VIDEO_DIR)) {
        throw new Error(`Video directory ${VIDEO_DIR} does not exist.`);
    }

    const files = fs.readdirSync(VIDEO_DIR).filter(file => file.endsWith('.mp4'));

    if (files.length === 0) {
        throw new Error(`No .mp4 files found in ${VIDEO_DIR}`);
    }

    // Calculate day of year
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);

    // Pick video consistently for this day
    const videoIndex = dayOfYear % files.length;
    const selectedFile = files[videoIndex];

    // Return the absolute path so ffmpeg can find it from anywhere
    return path.join(path.resolve(VIDEO_DIR), selectedFile);
}

/**
 * Spawns an FFmpeg process to stream the selected video to the RTMP URL.
 * 
 * @param {string} videoPath Path to local video
 * @param {string} rtmpUrl Full RTMP URL
 * @param {string} streamKey YouTube Stream Key
 */
function startStreaming(videoPath, rtmpUrl, streamKey = '') {
    return new Promise((resolve, reject) => {
        // The rtmpUrl usually needs the stream key appended
        const fullDestination = rtmpUrl.endsWith('/') ? `${rtmpUrl}${streamKey}` : `${rtmpUrl}/${streamKey}`;

        console.log(`\nstarting FFmpeg Stream...`);
        console.log(`Video: ${videoPath}`);
        console.log(`Destination: ${fullDestination}`);

        // Check if the video already has an audio stream
        let hasAudio = false;
        try {
            const output = require('child_process').execSync(`ffprobe -i "${videoPath}" -show_streams -select_streams a -loglevel error`);
            hasAudio = output.toString().trim().length > 0;
        } catch (e) {
            console.error('Error probing video for audio:', e);
        }

        console.log(`Video has audio stream: ${hasAudio}`);

        let ffmpegArgs = [];

        if (hasAudio) {
            // Standard stream, use the video's own audio
            ffmpegArgs = [
                '-re',
                '-i', videoPath,
                '-vf', 'scale=-2:1440',  // Force 1440p (2K) height, auto-calculate width preserving aspect ratio
                '-r', '30',              // Force 30fps to keep bandwidth stable
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-threads', '0',
                '-maxrate', '9000k',     // 9 Mbps required for 1440p
                '-bufsize', '18000k',    // 2x maxrate size for smoother streaming
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'flv',
                fullDestination
            ];
        } else {
            // Inject silent audio track to prevent YouTube ingest errors
            ffmpegArgs = [
                '-re',
                '-i', videoPath,
                '-f', 'lavfi',
                '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-vf', 'scale=-2:1440',
                '-r', '30',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-threads', '0',
                '-maxrate', '9000k',
                '-bufsize', '18000k',
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-shortest',
                '-f', 'flv',
                fullDestination
            ];
        }

        const ffmpegProcess = spawn(ffmpeg, ffmpegArgs);

        ffmpegProcess.stderr.on('data', (data) => {
            // FFmpeg outputs progress to stderr natively
            console.log(`ffmpeg: ${data}`);
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`FFmpeg process finished with code ${code}`);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpegProcess.on('error', (err) => {
            console.error('Failed to start FFmpeg process.', err);
            reject(err);
        });
    });
}

module.exports = {
    getDailyVideo,
    startStreaming
};
