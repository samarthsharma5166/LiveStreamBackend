const axios = require('axios');
require('dotenv').config();

const YOGSAATHI_API_URL = process.env.YOGSAATHI_API_URL || "http://localhost:8000/api";
const YOGSAATHI_API_KEY = process.env.YOGSAATHI_API_KEY;

/**
 * Creates a YogaClass on the YogSaathi backend via API call.
 * 
 * @param {string} title - The title of the yoga class
 * @param {string} focusArea - The focus area
 * @param {string} videoLink - The YouTube live video link
 * @param {Date} date - The scheduled date and time of the class
 */
async function createYogSaathiClass(title, focusArea, videoLink, date) {
    if (!YOGSAATHI_API_KEY) {
        console.error("❌ ERROR: YOGSAATHI_API_KEY is not set in .env. Cannot create class in YogSaathi backend.");
        return null;
    }

    try {
        console.log(`\n☁️  Sending API request to YogSaathi backend to create live class...`);
        const response = await axios.post(
            `${YOGSAATHI_API_URL}/yogaClasses`,
            {
                title,
                focusArea,
                videoLink,
                date: date.toISOString()
            },
            {
                headers: {
                    "x-api-key": YOGSAATHI_API_KEY,
                    "Content-Type": "application/json"
                }
            }
        );

        if (response.data && response.data.success) {
            console.log(`✅ YogSaathi Class created successfully! ID: ${response.data.data.id}`);
            return response.data.data;
        } else {
            console.error("⚠️ Failed to create YogSaathi class:", response.data);
            return null;
        }
    } catch (error) {
        console.error("❌ Error calling YogSaathi API:");
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data:`, error.response.data);
        } else {
            console.error(error.message);
        }
        return null;
    }
}

module.exports = {
    createYogSaathiClass
};
