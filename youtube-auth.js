const express = require('express');
const { google } = require('googleapis');
const readline = require('readline');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = 3000;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("=== YouTube API OAuth 2.0 Setup ===");
console.log("To fully automate streams, we need your YouTube Channel's Refresh Token.");
console.log("1. Go to Google Cloud Console (https://console.cloud.google.com/)");
console.log("2. Create a Project and enable 'YouTube Data API v3'");
console.log("3. Configure the OAuth Consent Screen (External, Add Test User with your email)");
console.log("4. Go to Credentials -> Create Credentials -> OAuth client ID -> Web application");
console.log("5. Add 'http://localhost:3000/oauth2callback' as an Authorized redirect URI");
console.log("========================================================\n");

rl.question('Enter your Client ID: ', (clientId) => {
  rl.question('Enter your Client Secret: ', (clientSecret) => {
    
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      `http://localhost:${port}/oauth2callback`
    );

    const scopes = [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Required to receive a refresh token
      prompt: 'consent', // Required to force a refresh token
      scope: scopes
    });

    console.log(`\n\n>> Please open this URL in your browser to authorize <<\n\n${url}\n`);

    app.get('/oauth2callback', async (req, res) => {
      const { code } = req.query;
      if (!code) {
         return res.send('Failed: No code returned');
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        console.log("\n\n=== SUCCESS: Add these to your .env file ===");
        console.log(`YOUTUBE_CLIENT_ID=${clientId}`);
        console.log(`YOUTUBE_CLIENT_SECRET=${clientSecret}`);
        console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
        console.log("============================================\n");
        console.log(`Make sure to also copy your DATABASE_URL into the .env file.`);
        
        res.send('Success! You can close this tab and check your terminal.');
        process.exit(0);
      } catch (err) {
        console.error("Error retrieving tokens:", err);
        res.status(500).send('Error retrieving tokens.');
      }
    });

    app.listen(port, () => {
      console.log(`\nWaiting for authorization callback on port ${port}...`);
    });
  });
});
