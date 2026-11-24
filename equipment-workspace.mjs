import { randomUUID } from 'node:crypto';

const equipment = [
  { id: 'resuscitation-model', name: '成人 CPR 訓練模型', label: '急救訓練', location: '教學器材室 A' },
  { id: 'injection-arm', name: '靜脈注射訓練手臂', label: '臨床技能', location: '技術練習室 B' },
  { id: 'blood-pressure', name: '電子血壓計', label: '生命徵象', location: '技術練習室 B' }
];
const sendInProgress = new Set(['queued', 'sending']);

export function createStationClient(origin) {
  function hub(path, key, data, eventKey) {
    return fetch(new URL(path, origin), {
      method: data ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + key,
        ...(data && { 'Content-Type': 'application/json', 'Idempotency-Key': eventKey })
      },
      body: data && JSON.stringify(data),
      redirect: 'error',
      signal: AbortSignal.timeout(4000)
    });
  }

  async function updateReceipt(receipt, connection) {
    if (receipt && connection?.id === receipt.connectionId && sendInProgress.has(receipt.status)) {
      try {
        const response = await hub('/api/v1/messages/' + receipt.messageId, connection.key);
        if (response.ok) {
          const { status } = await response.json();
          if (sendInProgress.has(receipt.status)) receipt.status = status;
        }
      } catch { /* A later status request can recover. */ }
    }
    return receipt?.status;
  }

  async function enqueueApproval({ id, number, item }, connection) {
    const label = item ? '（' + item.name + '）' : '';
    const message = `測試借用單 ${number}${label}已核准，請至教具借用平台查看。`;
    const response = await hub('/api/v1/send', connection.key, { message }, 'loan-approved-' + id);
    if (!response.ok) {
      return { error: response.status === 401 || response.status === 403
        ? '接線站的連接已失效。請回接線站重新連接。'
        : '借用單已核准，通知暫時未送入接線站。請按「重試送出通知」。' };
    }
    const { messageId, status } = await response.json();
    return { messageId, status, message, connectionId: connection.id };
  }
  return { updateReceipt, enqueueApproval };
}

export function createEquipmentWorkspace({ station, hubHref, receivedText, onQueued, onApproved, persist, initialLoans = [], standalone = false, maxLoans = Infinity }) {
  const requests = new Map(initialLoans.map(request => [request.id, request]));
  let nextNumber = initialLoans.reduce((max, request) => Math.max(max, Number(request.number.slice(4)) || 0), 0);

  async function state(connection) {
    const loans = await Promise.all([...requests.values()].reverse().map(async request => {
      const { id, number, item, unit, purpose, createdAt, approvedAt, receipt } = request;
      const status = receipt && await station.updateReceipt(receipt, connection);
      const message = receipt && receivedText?.(receipt.messageId);
      const current = Boolean(connection && connection.id === request.attemptedConnection);
      const notice = status || request.notice;
      return {
        id, number, item, unit, purpose, createdAt, approvedAt,
        notice: message ? 'accepted' : !current && ['retry', 'queued', 'sending'].includes(notice) ? 'disconnected' : notice,
        message,
        canRetry: request.notice === 'retry' && current
      };
    }));
    return { equipment, loans, hubHref, connected: Boolean(connection), standalone };
  }

  async function add(data, connection) {
    const item = equipment.find(entry => entry.id === data?.itemId);
    const unit = typeof data?.unit === 'string' ? data.unit.trim() : '';
    const purpose = typeof data?.purpose === 'string' ? data.purpose.trim() : '';
    if (!item || !unit || unit.length > 40 || purpose.length > 120) {
      return [422, { error: '請選擇教具並確認借用單位及用途。' }];
    }
    if (requests.size >= maxLoans) {
      const finished = [...requests.values()].find(entry => entry.approvedAt &&
        !['enqueuing', 'retry'].includes(entry.notice) && !sendInProgress.has(entry.receipt?.status));
      if (!finished) return [409, { error: '試用區的借用單已滿，請先處理待審借用單。' }];
      requests.delete(finished.id);
    }
    const request = {
      id: randomUUID(),
      number: 'LAB-' + String(++nextNumber).padStart(3, '0'),
      item, unit, purpose, createdAt: new Date().toISOString(), approvedAt: null
    };
    if (persist) persist([...requests.values(), request], request);
    requests.set(request.id, request);
    return [201, { ...(await state(connection)), created: request.number }];
  }

  async function approve(data, connection, retry = false) {
    const request = requests.get(data?.id);
    if (!request) return [404, { error: '找不到這筆借用單。' }];
    if (retry) {
      if (request.notice !== 'retry' || !connection || request.attemptedConnection !== connection.id) {
        return [409, { error: '這筆通知目前無法重試，請確認連接狀態。' }];
      }
    } else {
      if (request.approvedAt) return [200, await state(connection)];
      request.approvedAt = new Date().toISOString();
      try { if (persist) persist([...requests.values()]); }
      catch (error) { request.approvedAt = null; throw error; }
      if (!connection) {
        request.notice = 'unconnected';
        if (onApproved) {
          try {
            await onApproved({
              event: 'loan.approved',
              id: request.id, number: request.number, equipment: request.item.name,
              unit: request.unit, purpose: request.purpose, approvedAt: request.approvedAt
            });
          } catch {
            request.notice = 'event_failed';
          }
        }
        return [200, await state(connection)];
      }
    }
    request.notice = 'enqueuing';
    request.attemptedConnection = connection.id;
    try {
      const receipt = await station.enqueueApproval(request, connection);
      if (receipt.error) {
        request.notice = 'retry';
      } else {
        request.notice = receipt.status;
        request.receipt = receipt;
        onQueued?.(connection, receipt.messageId);
      }
    } catch {
      request.notice = 'retry';
    }
    return [200, await state(connection)];
  }

  return { state, add, approve };
}
