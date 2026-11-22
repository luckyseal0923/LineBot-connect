# LineBOT 接線站 / LineBOT Connect

依據 `LINE_Bot_Platform_Spec_v1.0.md` 開發的 LINE Bot 通知串接平台。

## 目前進度

這是第一階段的**介面預覽與資料庫基礎**，不是可投入使用的平台。總覽及導覽展示規劃中的使用流程，未連接真實資料。請勿輸入或提供 LINE 憑證、API Key 或個人資料。

已建立 Node.js 靜態預覽伺服器、Dockerfile，以及 Supabase PostgreSQL 帳號、管理員和稽核資料表的初步遷移。資料表尚未部署；帳號申請、Email 驗證、登入、審核、MFA、LINE 串接、佇列與發送 API 均尚未實作。遷移需要部署到有 Supabase Auth 的 PostgreSQL，並在正式使用前完成後端授權與安全測試。

## 本機啟動

需要 Node.js 20 以上，不需安裝套件：

```sh
node server.mjs
```

瀏覽 `http://localhost:3000`，以 Ctrl+C 停止。可設定 `PORT` 變更埠號。

## GitHub 與 Coolify

此資料夾可作為 GitHub repository 的來源。將程式推送到自己的 GitHub repository 後，在 Coolify 建立連接該 repository 的應用程式，選用 Dockerfile 建置並設定服務埠為 `3000`。正式部署需要另行設定網域、HTTPS、Supabase Auth、PostgreSQL、伺服器端密鑰與背景工作程序；目前 Docker 映像只提供介面預覽，不會傳送通知。

## 開發順序

1. 建立 Supabase Auth、Email 驗證、帳號申請及管理員 MFA 審核 API；完成權限隔離測試。
2. 實作 Bot 憑證加密、LINE API 憑證及 Webhook 驗證、配對流程。
3. 實作串接金鑰、發送 API、冪等、佇列、重試、停用及傳訊紀錄。
4. 完成部署、操作文件與雙帳號驗收。
