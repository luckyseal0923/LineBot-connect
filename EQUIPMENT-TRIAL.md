# 虛擬教具借用平台

線上版提供三種示範教具、借用申請與借用審核。每個瀏覽器各有獨立的試用借用單，資料保存在服務的記憶體內，試用工作區四小時後到期，服務重啟時重新開始。

## 本機啟動

~~~powershell
node equipment-web.mjs
~~~

開啟 [本機借用平台](http://127.0.0.1:39301/)。部署版本使用 `Dockerfile.equipment`，公開網址由 `EQUIPMENT_PUBLIC_ORIGIN` 設定，容器內監聽 3000。

## 核准事件

`equipment-web.mjs` 的 `createEquipmentServer({ publicOrigin, onApproved })` 接受伺服器端事件處理函式。借用單第一次由待核准變成已核准時，會收到 `loan.approved` 事件，內容包括 `id`、`number`、`equipment`、`unit`、`purpose` 與 `approvedAt`。同一筆借用單重複核准時沿用同一個狀態與事件識別。

## 借用申請通知

部署需掛載僅供此應用使用、可由 node 使用者寫入的持久化 Docker 卷至 `/data`，且僅使用單一執行個體。借用單及通知事件一起保存，四小時工作區期限維持不變。事件使用固定的識別碼和訊息，重試沿用原值。事件專屬網址與金鑰分別以 `EQUIPMENT_LINEBOT_ENDPOINT`、`EQUIPMENT_LINEBOT_API_KEY` 提供，兩者必須來自同一事件。金鑰不可放入版本庫。切換金鑰或事件網址後，舊連接的未完成事件不會發送給新連接的收件者。

這是公開試用網站，訪客送出有效的示範申請就可能觸發通知。這個網站不具備正式借用平台所需的身分、權限、備份及完整審核管理，不應輸入真實個資。通知接線站受理不代表 LINE 收件者已收到。
