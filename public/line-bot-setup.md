---
name: line-bot-setup
description: 用繁體中文協助初學者開設 LINE 官方帳號。開發者登入後，由 AI 使用瀏覽器代填申請資料、啟用 Messaging API、設定聊天與群組邀請，並在需要時完成 LINEBOT 接線站的連線驗證。也適用於已有官方帳號的首次設定。
---

# LINE Bot 新手引導

用臺灣繁體中文和畫面上的名稱回報進度。使用者要實際設定時，從目前畫面接續，跳過已完成的動作。以使用者指定的官方帳號和數位平台為範圍。只需要文字引導時，每次給下一個可完成的步驟和成功條件。

## 代辦前確認 Computer Use

1. 開始代辦時，先檢查目前 AI 對話是否提供可操作瀏覽器的工具。使用該工具開啟指令中的接線站連結，或讀取已開啟的接線站分頁。能讀到頁面標題或登入畫面後，再告知開發者「這次對話已可操作瀏覽器」，接續登入或讀取預填資料。單純網頁搜尋、抓取文字或查看截圖不足以確認操作能力。
2. 若工具未開啟、未獲授權或無法連上瀏覽器，先暫停代辦並說明遇到的狀況。提示開發者「請在目前的 AI 對話開啟 Computer Use（瀏覽器操作），依畫面允許連線，再回覆『已開啟』。」收到回覆後重新用工具讀取接線站畫面。若該平台不支援，可請開發者將同一段指令貼到支援瀏覽器操作的 AI，或由開發者選擇改用手動引導。
3. 瀏覽器可用但接線站要求登入時，請開發者登入後交還控制，從同一步驟繼續。

## 瀏覽器操作

- 開發者在 LINE 頁面親自登入和完成身分驗證。登入後，使用可用的瀏覽器控制工具，依照可見畫面開頁、選帳號、代填一般欄位、設定與驗證。使用者已授權的一般操作直接完成。
- 送出申請、確認條款、啟用 Messaging API、固定綁定服務提供者、首次發行或換發憑證，以及變更其他系統正在使用的 Webhook 時，依當下工具規則確認具體動作和目標。需要使用者本人操作時，用瀏覽器交接功能讓使用者接手，待他交還控制再繼續。授權到位後，由 AI 執行工具允許的後續操作。
- 使用者授權時，AI 可將同一個 LINE 頻道的 Channel secret 和 Channel access token 從 LINE Developers 直接填到指定平台的正式接線站憑證表單。只讀取所需的欄位並暫存在同次瀏覽器操作記憶中，完成後只回報儲存和驗證狀態。顯示值受網站或工具限制時，依工具交接指引請本人貼入。
- 開發者選擇手動引導時，依回報的畫面逐步說明，並提醒遮蔽敏感值。

## 先讀取預填資料

- 在已登入的正式接線站，開啟使用者指定平台的「LINE Bot 設定」→「填寫開設資料」（已連線的平台選「LINE 開設資料」）。讀取該平台已儲存的開設資料，再對照 LINE 的實際表單欄位。[LINEBOT 接線站](https://linebot-next.wfhai.org/#platforms)
- 將「LINE 機器人名稱」對應 LINE 的「帳號名稱」，將「可聯絡的電子郵件」對應「電子郵件帳號」。公司或事業者名稱、國家或地區、產業類別、產業細分類和使用目的依 LINE 畫面對照填寫。以 LINE 當下的下拉選項為準。只有預存平台名稱時，可在使用者同意後用它作為對外顯示的官方帳號名稱。缺少正式申請的必填項或選項不明時一次問齊。聯絡資料送往 LINE 前依工具規則確認。
- 儲存開設資料時必填「機器人管理單位（Provider）」，也就是管理這個機器人的個人或組織。到了啟用 Messaging API 的步驟，用這個名稱核對 LINE 的服務提供者，並依工具規則取得必要的確認。
- 開設資料是供代填的一般欄位。登入資訊由本人在 LINE 輸入，Bot 憑證依授權填入接線站的專用憑證表單。

## 建立 LINE 官方帳號並開通 Bot

1. 尚未建立官方帳號時，在 LINE 台灣開設頁的「LINE 官方帳號」區塊按「免費開設帳號」。開發者完成 LINE Business ID 登入後，由 AI 代填已提供的資料。正式送出依工具規則確認。已有官方帳號時，直接進入指定帳號。[LINE 台灣開設入口](https://tw.linebiz.com/account/)
2. 在官方帳號管理後台的「設定」→「Messaging API」按「啟用 Messaging API」。LINE 首次要求的開發者資料可依已提供資訊代填。選擇使用者指定的「服務提供者」（Provider），由 LINE 將此官方帳號固定綁定至該提供者。處理條款與最後一次「確定」前，核對目標帳號及提供者名稱。[LINE 官方開通說明](https://developers.line.biz/en/docs/messaging-api/getting-started/#step-one-enable-use-of-messaging-api)
3. 以同一個 LINE Business ID 開啟 LINE Developers Console，在指定 Provider 下核對官方帳號名稱和 Messaging API 頻道。[LINE Developers Console](https://developers.line.biz/console/)

## 完成 LINE 後台設定

1. 在 LINE 官方帳號管理後台的「設定」→「回應設定」，開啟「聊天」，再關閉「加入好友的歡迎訊息」。依畫面完成必要的儲存或確認，讀回兩個開關的實際狀態。[LINE 官方回應設定說明](https://tw.linebiz.com/manual/line-official-account/oa-manager/)
2. 在「設定」→「帳號設定」的「加入群組或多人聊天室」，選「接受邀請加入群組或多人聊天室」並核對已選取。若介面改版，從同一個 LINE Developers 頻道的「Messaging API」分頁找「Allow bot to join group chats」。[LINE 官方群組設定說明](https://developers.line.biz/en/docs/messaging-api/group-chats/)
3. 以上三項是整套新 Bot 設定的目標。使用者若指定只調整其中部分，照該範圍操作。若已連上接線站，設定完一併確認 Webhook 啟用狀態。

## 接上 LINEBOT 接線站

1. 在已核對的 LINE Developers 頻道，從「Basic settings」取得 Channel secret，從「Messaging API」取得 Channel access token (long-lived)。沿用已發行的有效權杖。首次發行時，確認目標 Bot 和接線站平台，取得所需確認後按「Issue」。換發既有憑證前先核對是否有其他服務使用。[LINE 官方權杖說明](https://developers.line.biz/en/docs/basics/channel-access-token/)
2. 在接線站選擇對應數位平台。每個數位平台對應一個 Bot。進入「LINE Bot 設定」→「開始手動設定」，把兩項憑證分別填進同名欄位，按「儲存並取得 Webhook」。接線站帳號待核准時，可先完成 LINE 的設定，核准後再續接。
3. 把接線站「LINE Bot 設定」頁的專屬 Webhook 網址填到 LINE Developers 的「Messaging API」→「Webhook URL」。確認是同一個頻道。若已有另一個網址，先與開發者確認原服務和切換時機。儲存後按「Verify」，確認顯示「Success」，開啟「Use webhook」，再到接線站按「檢查 LINE 驗證」並讀取「LINE 驗證通過」。[LINE 官方驗證說明](https://developers.line.biz/en/docs/messaging-api/verify-webhook-url/)
4. 使用者要求試收時，到「收件對象」為本人或已同意測試的人產生配對文字。由收件者加入 Bot 好友，並在一對一 LINE 聊天送出配對文字。AI 可查詢配對狀態、準備測試訊息並依授權發送。LINE 已受理後，再請收件者確認有收到。

「LINE Bot 設定」的 Webhook 用來讓接線站接收 LINE 事件。「事件串接」的 Webhook 用來讓外部數位平台觸發 LINE 通知。依使用者所在畫面辨認兩者。接線站現有的收件者配對使用一對一 LINE 聊天。群組邀請設定的驗收是 Bot 可接受邀請。

## 完成檢查

依實際頁面回報官方帳號、所屬數位平台、聊天開關、歡迎訊息開關、群組邀請與 Webhook 驗證狀態。若有步驟尚需開發者操作，只交代卡在哪個畫面、需要完成的那一步及交還控制後可接續的工作。
