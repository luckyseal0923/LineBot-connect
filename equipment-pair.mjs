import { pair } from './source-notifications.mjs';
const directory = process.env.EQUIPMENT_DATA_DIR;
if (!directory) throw new Error('請設定 EQUIPMENT_DATA_DIR 為來源後端的持久化私有目錄。');
await pair({ directory });
