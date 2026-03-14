const { google } = require('googleapis');
require('dotenv').config();

// Initialize the Google API client
const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
);

auth.setCredentials({
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
});

const youtube = google.youtube({
    version: 'v3',
    auth: auth
});

/**
 * Creates a YouTube Live Broadcast and a Live Stream to attach to it.
 * @param {string} title Title of the stream
 * @param {string} description Description of the stream
 * @param {Date} scheduledStartTime Optional. The exact Date object to schedule the stream for.
 * @returns {Promise<{videoId: string, streamUrl: string, streamKey: string}>}
 */
async function createLiveStream(title, description, scheduledStartTime = null) {
    try {
        if (!scheduledStartTime) {
            scheduledStartTime = new Date();
            scheduledStartTime.setMinutes(scheduledStartTime.getMinutes() + 1); // Start slightly in future
        }

        // 1. Create the broadcast
        const broadcastResponse = await youtube.liveBroadcasts.insert({
            part: 'snippet,status,contentDetails',
            requestBody: {
                snippet: {
                    title: title,
                    description: description,
                    scheduledStartTime: scheduledStartTime.toISOString(),
                },
                status: {
                    privacyStatus: 'unlisted', // Recommended default to avoid accidental public streams during testing
                    selfDeclaredMadeForKids: false
                },
                contentDetails: {
                    enableAutoStart: true,
                    enableAutoStop: true,
                    recordFromStart: true,
                    monitorStream: {
                        enableMonitorStream: false
                    }
                }
            }
        });

        const broadcastId = broadcastResponse.data.id;

        // 2. Create the video stream key
        const streamResponse = await youtube.liveStreams.insert({
            part: 'snippet,cdn',
            requestBody: {
                snippet: {
                    title: `Stream for ${title}`
                },
                cdn: {
                    frameRate: '30fps',
                    ingestionType: 'rtmp',
                    resolution: '720p'
                }
            }
        });

        const streamId = streamResponse.data.id;
        const ingestionAddress = streamResponse.data.cdn.ingestionInfo.ingestionAddress;
        const streamKey = streamResponse.data.cdn.ingestionInfo.streamName;

        // 3. Bind the broadcast to the stream
        await youtube.liveBroadcasts.bind({
            part: 'id,contentDetails',
            id: broadcastId,
            streamId: streamId
        });

        return {
            videoId: broadcastId,
            streamUrl: ingestionAddress,
            streamKey: streamKey
        };
    } catch (error) {
        console.error("Error creating YouTube Live Stream:", error?.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    createLiveStream
};
