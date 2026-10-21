const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
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
 * Probes the total duration of the video in seconds using ffprobe.
 */
function getVideoDuration(videoPath) {
    try {
        const output = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
        );
        const duration = parseFloat(output.toString().trim());
        return isNaN(duration) ? 0 : duration;
    } catch (e) {
        console.error('Error probing video duration:', e.message);
        return 0;
    }
}

/**
 * Spawns a single FFmpeg instance with seek offset.
 * Resolves with { exitCode, streamedSeconds } when it closes.
 */
function spawnFFmpegInstance({ videoPath, fullDestination, hasAudio, streamHeight, streamBitrate, streamBufsize, seekOffset = 0 }) {
    return new Promise((resolve) => {
        const baseArgs = [];

        // If resuming after a connection drop, seek to the last streamed position
        if (seekOffset > 0) {
            baseArgs.push('-ss', seekOffset.toFixed(2));
        }

        baseArgs.push('-re', '-i', videoPath);

        let ffmpegArgs = [];

        if (hasAudio) {
            ffmpegArgs = [
                ...baseArgs,
                '-vf', `scale=-2:${streamHeight}`,
                '-r', '30',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-threads', '0',
                '-maxrate', streamBitrate,
                '-bufsize', streamBufsize,
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-max_muxing_queue_size', '1024',
                '-flvflags', 'no_duration_filesize',
                '-f', 'flv',
                fullDestination
            ];
        } else {
            ffmpegArgs = [
                ...baseArgs,
                '-f', 'lavfi',
                '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
                '-vf', `scale=-2:${streamHeight}`,
                '-r', '30',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-threads', '0',
                '-maxrate', streamBitrate,
                '-bufsize', streamBufsize,
                '-pix_fmt', 'yuv420p',
                '-g', '60',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-shortest',
                '-max_muxing_queue_size', '1024',
                '-flvflags', 'no_duration_filesize',
                '-f', 'flv',
                fullDestination
            ];
        }

        const ffmpegProcess = spawn(ffmpeg, ffmpegArgs);
        let lastStreamedTime = 0;
        const timeRegex = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;

        ffmpegProcess.stderr.on('data', (data) => {
            const str = data.toString();
            console.log(`ffmpeg: ${str.trim()}`);

            const match = str.match(timeRegex);
            if (match) {
                const hours = parseFloat(match[1]);
                const minutes = parseFloat(match[2]);
                const seconds = parseFloat(match[3]);
                lastStreamedTime = hours * 3600 + minutes * 60 + seconds;
            }
        });

        ffmpegProcess.on('close', (code) => {
            console.log(`FFmpeg instance closed with code ${code} (Streamed in this segment: ${Math.round(lastStreamedTime)}s)`);
            resolve({
                exitCode: code,
                streamedSeconds: lastStreamedTime
            });
        });

        ffmpegProcess.on('error', (err) => {
            console.error('Failed to spawn FFmpeg process:', err);
            resolve({
                exitCode: 1,
                streamedSeconds: lastStreamedTime
            });
        });
    });
}

/**
 * Streams the selected video to the RTMP URL with auto-reconnection.
 * If the connection drops (e.g. Connection reset by peer), it automatically
 * resumes streaming from the exact timestamp where it left off until the full
 * video duration is completed.
 * 
 * @param {string} videoPath Path to local video
 * @param {string} rtmpUrl Full RTMP URL
 * @param {string} streamKey YouTube Stream Key
 */
async function startStreaming(videoPath, rtmpUrl, streamKey = '') {
    const fullDestination = rtmpUrl.endsWith('/') ? `${rtmpUrl}${streamKey}` : `${rtmpUrl}/${streamKey}`;
    const totalDuration = getVideoDuration(videoPath);

    console.log(`\n==============================================`);
    console.log(`🚀 Starting Resilient FFmpeg Stream`);
    console.log(`Video: ${videoPath}`);
    console.log(`Total Duration: ${Math.round(totalDuration)}s (~${Math.round(totalDuration / 60)} mins)`);
    console.log(`Destination: ${fullDestination}`);
    console.log(`==============================================`);

    // Check if the video already has an audio stream
    let hasAudio = false;
    try {
        const output = execSync(`ffprobe -i "${videoPath}" -show_streams -select_streams a -loglevel error`);
        hasAudio = output.toString().trim().length > 0;
    } catch (e) {
        console.error('Error probing video for audio:', e);
    }
    console.log(`Video has audio stream: ${hasAudio}`);

    const streamHeight = process.env.STREAM_HEIGHT || '1080';
    const streamBitrate = process.env.STREAM_BITRATE || '4500k';
    const streamBufsize = process.env.STREAM_BUFSIZE || '9000k';

    let currentOffset = 0;
    const MAX_RETRIES = 10;
    let retryCount = 0;

    while (true) {
        // If we have already streamed within 5 seconds of the end of the video, consider it completed
        if (totalDuration > 0 && currentOffset >= totalDuration - 5) {
            console.log(`🎉 Stream successfully finished full video duration (${Math.round(currentOffset)}s / ${Math.round(totalDuration)}s).`);
            break;
        }

        console.log(`\n▶️ Starting FFmpeg from offset ${Math.round(currentOffset)}s / ${Math.round(totalDuration)}s...`);

        const result = await spawnFFmpegInstance({
            videoPath,
            fullDestination,
            hasAudio,
            streamHeight,
            streamBitrate,
            streamBufsize,
            seekOffset: currentOffset
        });

        // Add the seconds streamed in this run to our overall offset
        currentOffset += result.streamedSeconds;

        if (result.exitCode === 0) {
            console.log(`✅ FFmpeg exited cleanly with code 0.`);
            break;
        }

        // Check if it reached the end despite the exit code
        if (totalDuration > 0 && currentOffset >= totalDuration - 5) {
            console.log(`🎉 Stream reached the end of the video file (${Math.round(currentOffset)}s / ${Math.round(totalDuration)}s).`);
            break;
        }

        // Connection dropped or FFmpeg crashed prematurely
        retryCount++;
        if (retryCount > MAX_RETRIES) {
            throw new Error(`FFmpeg failed after ${MAX_RETRIES} reconnection attempts. Stream stopped at ${Math.round(currentOffset)}s / ${Math.round(totalDuration)}s.`);
        }

        // Rewind 2 seconds before the drop to ensure a smooth keyframe transition
        currentOffset = Math.max(0, currentOffset - 2);

        console.warn(`\n⚠️ [Auto-Reconnect] Connection lost at ~${Math.round(currentOffset)}s of ${Math.round(totalDuration)}s.`);
        console.log(`🔄 Reconnecting to YouTube Live in 3 seconds (Attempt ${retryCount}/${MAX_RETRIES})...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

module.exports = {
    getDailyVideo,
    startStreaming
};
