const fs = require('fs'); // promisesではなく通常のfsを使用
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const express = require('express');
const app = express();
const port = 5001; // Nginx の proxy_pass に合わせてポートを 5001 に設定

// 1. Google OAuth クライアント情報を読み込む
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
let credentials = null;

// credentials.json を同期的に読み込む
try {
    const data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    credentials = JSON.parse(data);
    console.log('Credentials loaded successfully.');
} catch (error) {
    console.error('Error loading credentials.json:', error);
    process.exit(1); // 読み込みに失敗した場合、アプリを終了
}

// スコープ例: Gmail の Read-Only
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * token-<name>.json ファイルパスを返す
 */
function getTokenPathForUser(name) {
    return path.join(__dirname, `token-${name}.json`);
}

/**
 * ユーザー用の OAuth2Client を生成
 */
async function createOAuth2ClientForUser(name) {
    const { client_id, client_secret, redirect_uris } = credentials.web || credentials.installed;

    const redirectUri = redirect_uris[0];
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    try {
        const tokenPath = getTokenPathForUser(name);
        const tokenJson = fs.readFileSync(tokenPath, 'utf8');
        oAuth2Client.credentials = JSON.parse(tokenJson);
    } catch (e) {
        // ファイルが無ければ無視
    }

    return oAuth2Client;
}

/**
 * /authenticate/:name
 */
app.get('/authenticate/:name', async (req, res) => {
    const userName = req.params.name;
    try {
        const oAuth2Client = await createOAuth2ClientForUser(userName);

        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: SCOPES,
            state: userName, // state パラメータに userName を含める
        });

        res.redirect(authUrl);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error generating auth URL.');
    }
});

/**
 * /callback
 */
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;

    if (!code || !state) {
        console.error('Missing code or state param.');
        return res.status(400).send('Missing code or state param.');
    }

    try {
        const oAuth2Client = await createOAuth2ClientForUser(state);

        // Exchange authorization code for access token
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Save the token for later use
        const tokenPath = getTokenPathForUser(state);
        fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
        console.log(`Token stored to ${tokenPath}`);

        res.send(`Authentication successful for ${state}. Token saved.`);
    } catch (error) {
        console.error('Error during OAuth2 callback:', error);
        res.status(500).send('Authentication failed.');
    }
});

/**
 * Gmail APIを使用してメールを取得し、整形して返す関数
 */
async function getLatestEmails(auth, userName) {
    const gmail = google.gmail({ version: 'v1', auth });
    try {
        const listResp = await gmail.users.messages.list({
            userId: 'me',
            q: '-label:spam -label:trash -label:promotions -label:social subject:(入退館 OR 入館 OR 来社 OR　来館　OR 訪問)',
            maxResults: 50,
        });

        const messages = listResp.data.messages;
        if (!messages || messages.length === 0) {
            console.log('No messages found.');
            return [];
        }

        const emailData = [];
        for (const message of messages) {
            try {
                const detailResp = await gmail.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'Date'],
                });

                const headers = detailResp.data.payload.headers;
                const subjectHeader = headers.find(header => header.name === 'Subject');
                const subject = subjectHeader ? subjectHeader.value : 'No Subject';

                const dateHeader = headers.find(header => header.name === 'Date');
                let date = 'Unknown Date';
                if (dateHeader) {
                    date = new Date(dateHeader.value).toISOString();
                }

                emailData.push({
                    id: uuidv4(),
                    date: date,
                    place: 'shibuya-OOOO', // 固定値
                    person: userName,
                    mail: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
                    'QR-data': 'abcdefghijk0123456', // 固定値
                    subject: subject,
                });
            } catch (err) {
                console.error(`Error fetching message ${message.id}:`, err);
            }
        }

        return emailData;
    } catch (err) {
        console.error('The API returned an error:', err);
        throw err;
    }
}

/**
 * /qr/:name
 */
app.get('/qr/:name', async (req, res) => {
    const userName = req.params.name;
    try {
        const oAuth2Client = await createOAuth2ClientForUser(userName);

        if (!oAuth2Client.credentials || !oAuth2Client.credentials.refresh_token) {
            return res.status(400).json({
                message: `User "${userName}" is not authenticated. Please visit /authenticate/${userName} first.`
            });
        }

        const emails = await getLatestEmails(oAuth2Client, userName);
        res.json(emails);

    } catch (error) {
        console.error('Error in /qr/:name:', error);
        res.status(500).json({
            message: 'Failed to fetch emails',
            error: error.message,
        });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});