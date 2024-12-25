// server.js
const express = require('express');
const app = express();
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');  // ← 追加
const port = 4000; // Nginx の proxy_pass に合わせてポートを 5001 に変更

// 1. Google OAuth クライアント情報を読み込む
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
let credentials = null;

// credentials.json を同期的に読み込む（サーバー起動前に確実に読み込むため）
try {
    const data = fs.readFile(CREDENTIALS_PATH, 'utf8');
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
 * - まだ認証していない場合は access_token/refresh_token が無い状態
 * - 既に token-<name>.json があれば読み込んでセット
 */
async function createOAuth2ClientForUser(name) {
    // credentials.json の "web" または "installed" からクライアント情報を取得
    const { client_id, client_secret, redirect_uris } = credentials.web || credentials.installed;

    // Google Cloud Console に登録したリダイレクトURIと一致している必要がある
    const redirectUri = redirect_uris[0];
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    // すでにトークンファイルがあれば読み込み
    try {
        const tokenPath = getTokenPathForUser(name);
        const tokenJson = await fs.readFile(tokenPath, 'utf8');
        oAuth2Client.credentials = JSON.parse(tokenJson);
    } catch (e) {
        // ファイルが無ければ無視
    }

    return oAuth2Client;
}

/**
 * /authenticate/:name
 * ユーザーがアクセスすると -> Google の認証画面にリダイレクト
 */
app.get('/authenticate/:name', async (req, res) => {
    const userName = req.params.name;
    try {
        // OAuth2Client 生成
        const oAuth2Client = await createOAuth2ClientForUser(userName);

        // 認証URLを作成（state パラメータに userName を含める）
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',   // リフレッシュトークンを取得するために必要
            prompt: 'consent',        // 毎回同意画面が出るように (必須ではない)
            scope: SCOPES,
            state: userName,          // 追加
        });

        // Google認証画面へリダイレクト
        res.redirect(authUrl);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error generating auth URL.');
    }
});

/**
 * /callback
 * Google が code を付与してリダイレクトしてくるエンドポイント
 * - state パラメータからユーザー名を特定する
 */
app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    const state = req.query.state; // または req.query.name

    if (!code || !state) {
        return res.status(400).send('Missing code or state param.');
    }

    const userName = state; // state を userName として使用

    try {
        // ユーザー用クライアント生成
        const oAuth2Client = await createOAuth2ClientForUser(userName);

        // code を使ってトークン取得
        const { tokens } = await oAuth2Client.getToken(code);

        // トークンをクライアントに設定
        oAuth2Client.credentials = tokens;

        // token-<name>.json に保存
        const tokenPath = getTokenPathForUser(userName);
        await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
        console.log(`Token stored to ${tokenPath}`);

        // 終了: ユーザーにメッセージを返す
        res.send(`Authentication successful for ${userName}.<br>Token saved to ${tokenPath}`);
    } catch (error) {
        console.error('Error in /oauth2callback:', error);
        res.status(500).send('Error retrieving access token');
    }
});

/**
 * Gmail APIを使用してメールを取得し、整形して返す関数
 * - 最新10件のメールを取得
 * - -label:spam -label:trash -label:promotions -label:social
 * - subject に「入退館」「入館」「来社」が含まれるものを取得 (必要に応じて調整)
 */
async function getLatestEmails(auth, userName) {
    const gmail = google.gmail({ version: 'v1', auth });
    try {
        // メール一覧を取得 (最大10件)
        const listResp = await gmail.users.messages.list({
            userId: 'me',
            q: '-label:spam -label:trash -label:promotions -label:social subject:(入退館 OR 入館 OR 来社)',
            maxResults: 10,
        });

        const messages = listResp.data.messages;
        if (!messages || messages.length === 0) {
            console.log('No messages found.');
            return [];
        }

        // メールの詳細情報を取得
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

                // 必要に応じて加工
                emailData.push({
                    id: uuidv4(),
                    date: date,
                    place: 'shibuya-OOOO',  // 固定値をサンプルで入れています
                    person: userName,       // URLパラメータの名前を入れる
                    mail: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
                    'QR-data': 'abcdefghijk0123456',  // 固定値をサンプルで入れています
                    subject: subject,       // Subjectも返したい場合
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
 * - ユーザーの token-<name>.json を読み込み、Gmail メール一覧を取得してJSONで返す
 */
app.get('/qr/:name', async (req, res) => {
    const userName = req.params.name;
    try {
        // ユーザーごとのOAuthクライアントを生成
        const oAuth2Client = await createOAuth2ClientForUser(userName);

        // リフレッシュトークンなどが無ければ認証されていない可能性
        if (!oAuth2Client.credentials || !oAuth2Client.credentials.refresh_token) {
            return res.status(400).json({
                message: `User "${userName}" is not authenticated. Please visit /authenticate/${userName} first.`
            });
        }

        // 最新メールを取得して JSON で返す
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