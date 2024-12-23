const express = require('express');
const app = express();
const port = 4000;

const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');

const { v4: uuidv4 } = require('uuid');

// スコープを変更した場合はtoken.jsonを削除してください
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

// 最初のリクエスト以降、使い回す認証クライアント
let authClient = null;

/**
 * 既存の認証クレデンシャルを読み込む
 */
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH, 'utf8');
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

/**
 * 認証クライアントをファイルに保存する
 */
async function saveCredentials(client) {
    const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const payload = JSON.stringify({
        type: 'authorized_user',
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
    });
    await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Gmail API 呼び出しのために認証クライアントを取得する
 * - 初回リクエストで token.json がなければ作成
 * - 二回目以降は authClient を使い回す or token.json を利用
 */
async function getAuthClient() {
    // すでにグローバル変数に保持されている場合は使い回す
    if (authClient) {
        return authClient;
    }

    // token.json があるか試す
    let client = await loadSavedCredentialsIfExist();
    if (!client) {
        // token.json がなければ認証フローを走らせて作成
        client = await authenticate({
            scopes: SCOPES,
            keyfilePath: CREDENTIALS_PATH,
        });
        if (client.credentials) {
            await saveCredentials(client);
        }
    }

    // グローバル変数に保持して使い回せるようにする
    authClient = client;
    return client;
}

/**
 * Gmail API を使用して最新の10件のメールを取得する
 *
 * @param {google.auth.OAuth2} auth 認証済みのOAuth2クライアント
 * @param {string} name リクエストパラメータで受け取った名前
 * @returns {Promise<Array>} メールのリスト
 */
async function getLatestEmails(auth, name) {
    const service = google.gmail({ version: 'v1', auth });
    try {
        const res = await service.users.messages.list({
            userId: 'me',
            q: '-label:spam -label:trash -label:promotions -label:social {subject:入退館 subject:入館 subject:来社}',
            maxResults: 10,
        });

        const messages = res.data.messages;
        if (!messages || messages.length === 0) {
            console.log('No messages found.');
            return [];
        }

        const emailData = [];

        for (const message of messages) {
            try {
                const msg = await service.users.messages.get({
                    userId: 'me',
                    id: message.id,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'Date'],
                });

                // 件名の抽出
                const headers = msg.data.payload.headers;
                const subjectHeader = headers.find(header => header.name === 'Subject');
                const subject = subjectHeader ? subjectHeader.value : 'No Subject';

                // 日付の取得
                const dateHeader = headers.find(header => header.name === 'Date');
                let date = 'Unknown Date';
                if (dateHeader) {
                    const parsedDate = new Date(dateHeader.value);
                    date = parsedDate.toISOString();
                }

                emailData.push({
                    id: uuidv4(), // IDを生成
                    date: date,
                    place: "shibuya-OOOO", // 固定値、必要に応じて変更
                    person: name, // URLから読み取る
                    mail: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
                    "QR-data": "abcdefghijk0123456", // 固定値、必要に応じて変更
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
 * /qr/:name エンドポイント
 * 指定された名前に基づいてメールを取得し、JSON形式で返す
 */
app.get('/qr/:name', async (req, res) => {
    const name = req.params.name;

    try {
        // リクエストがあるたびに、必要なら認証クライアントを取得
        const auth = await getAuthClient();

        const emails = await getLatestEmails(auth, name);
        if (emails.length === 0) {
            return res.json([]); // メールがない場合は空の配列を返す
        }

        res.json(emails);
    } catch (error) {
        console.error('Error fetching emails:', error);
        res.status(500).json({
            message: 'Failed to fetch emails',
            error: error.message,
        });
    }
});

/**
 * サーバー起動
 * - ここでは認証を行わず、単にサーバーを起動するだけ
 */
app.listen(port, () => {
    console.log(`API server running at http://localhost:${port}`);
});