---
name: line-login-setup
description: 協助接線站開發者以瀏覽器在現有 Bot 的 Provider 設定 LINE Login 與 LIFF，建立收件者掃碼登記頁。
---

# 接線站收件者 LINE 登入頁

使用臺灣繁體中文。此流程從已啟用的 Bot 開始，目標是讓指定平台的「收件對象」顯示邀請 QR Code。

## 讀取本平台的開設資料

1. 先用這次對話的 Computer Use 工具開啟指令提供的接線站平台連結。工具不可用時，提示開發者啟用瀏覽器操作並授權。由開發者親自登入及完成身分驗證，再接回控制。
2. 在「收件對象 → 邀請收件者 → 製作 LINE 登入頁」讀取「AI 協助設定」內已儲存的管理單位、地區、頻道名稱、登入頁名稱、聯絡信箱及用途。核對目前平台名稱、公開 Bot ID，以及「手動設定」中的 Endpoint URL。若已有 QR Code 及 LIFF ID，回報可直接使用；只有使用者要求修正或替換時才繼續修改。
3. 將有值的欄位帶入對應申請表。缺少資料時先完成可填項目，再一次詢問。信箱空白、格式不完整或顯示遮蔽標記時，請本人在 LINE 補填，再交還控制。將信箱留在表單內。

## 建立或接續 LINE Login

1. 開啟 [LINE Developers Console](https://developers.line.biz/console/)，用 Bot 名稱及公開 ID 核對其所屬 Provider。在同一 Provider 下找此平台專用的 LINE Login 頻道，優先接續既有進度；遇到多個候選或與其他 Bot 的既有連結時，先確認目標。
2. 若需建立，選 Create a new channel → LINE Login，依預填資料填寫服務地區、頻道名稱、用途及聯絡信箱，App types 勾選 Web app。LINE 若拒絕名稱，依錯誤提示請開發者選擇替代名稱。涉及服務條款時依瀏覽器工具規則在送出前取得當次確認。
3. 在登入頻道的 Basic settings → Linked LINE Official Account 選擇已核對的 Bot 並儲存，再於這個登入頻道開啟 LIFF。參考 [LINE 官方帳號連結說明](https://developers.line.biz/en/docs/line-login/web/link-a-bot/)。

## 連接收件者登記頁

1. 先查既有 LIFF 的 Endpoint URL。若已指向本平台登記頁就沿用。新增 LIFF 時採用預填登入頁名稱、Full、接線站顯示的完整 Endpoint URL、profile 權限及加入好友 On (normal)。保留其他平台的 LIFF 設定。
2. 向開發者說明 profile 用於辨識登入者，發布後一般 LINE 使用者可登入。在工具要求確認的步驟取得明確同意，再建立 LIFF 及將登入頻道改為 Published。已是 Published 的頻道可直接接續。
3. 回到同一平台的「製作 LINE 登入頁 → 手動設定」，儲存此 LIFF ID，查看 QR Code 與邀請連結。只回報實際完成的狀態。手機試登或傳送測試通知依使用者要求另行操作。
