# 虛擬教具借用平台

線上版提供三種示範教具、借用申請與借用審核。每個瀏覽器各有獨立的試用借用單，資料保存在服務的記憶體內，試用工作區四小時後到期，服務重啟時重新開始。

## 本機啟動

~~~powershell
node equipment-web.mjs
~~~

開啟 [本機借用平台](http://127.0.0.1:39301/)。部署版本使用 `Dockerfile.equipment`，公開網址由 `EQUIPMENT_PUBLIC_ORIGIN` 設定，容器內監聽 3000。

## 核准事件

`equipment-web.mjs` 的 `createEquipmentServer({ publicOrigin, onApproved })` 接受伺服器端事件處理函式。借用單第一次由待核准變成已核准時，會收到 `loan.approved` 事件，內容包括 `id`、`number`、`equipment`、`unit`、`purpose` 與 `approvedAt`。同一筆借用單重複核准時沿用同一個狀態與事件識別。
